# TavlArena dice encoding v1: specification

This is the normative description of how TavlArena commits to and derives dice, and what a proof file contains. `src/index.ts` implements it with WebCrypto; `vectors/generate.py` implements it again, independently, with Python's standard library, and `vectors/v1.json` holds the values both must agree on.

## Exact bytes

The domains are UTF-8 text without a terminator:

- `ctxCommit = "tavlarena-dice-commit-v1"`
- `ctxRoll = "tavlarena-dice-roll-v1"`

UUIDs are exactly 16 bytes in the order their hex digits appear after removing hyphens, **not** GUID little-endian field order. Both lowercase and uppercase canonical `8-4-4-4-12` UUID text are accepted; no particular UUID generation version is required. Player IDs are distinct and ordered by immutable seat index. Hex decoding accepts either case and rejects prefixes, whitespace, odd lengths and incorrect byte counts.

Canonical settings JSON recursively sorts object keys by **unsigned UTF-16 code units** (JavaScript's default string sort), emits no whitespace, preserves array order and uses JSON string escaping. Strings must contain valid Unicode scalar values; no Unicode normalization is performed. Encoding is UTF-8. Numbers must be finite safe integers (`−9007199254740991` through `9007199254740991`); negative zero becomes `0`. Fractional/unsafe numbers, getters, non-plain objects, cycles, undefined, symbols, sparse arrays and lone surrogates are rejected. Settings are limited to 64 nesting levels and 1 MiB canonical UTF-8. This is a deliberately restricted JSON encoding, **not a claim of general RFC 8785 support**.

The caller must include the rules version and **all** rules/match settings in the object being hashed, for example `{rulesVersion, rules: {...rules}}`. This generic package does not infer or supply omitted application rules.

```text
settingsHash = SHA-256(UTF8(canonicalJson(settings)))
commitment   = SHA-256(ctxCommit || gameId16 || settingsHash32 || seat0Id16 || seat1Id16 || seed32)
block(n, b)  = HMAC-SHA256(seed32, ctxRoll || gameId16 || contribution0_32 || contribution1_32 || u32be(n) || u32be(b))
```

For each roll, begin at block 0 and read its 32 digest bytes left to right. Reject bytes **252–255**; map each accepted byte to `byte % 6 + 1`. The first two accepted bytes are the ordered dice. If necessary, continue with block 1, 2, etc. The remaining bytes are discarded after obtaining the two dice. Counter and block values must be integers in `[0, 4294967295]`; values are never silently truncated or wrapped. Every consumed roll advances the counter, including opening ties, Tavla rerolls and visible discarded rolls. There is no pepper.

## Proof and verification

```ts
interface DiceTranscript {
  version: 1;
  gameId: string;
  playerIds: [string, string];
  settings: JsonValue;
  commitment: string;
  contributions: [string | null, string | null];
  seed: string;
  rolls: Array<{
    index: number;
    dice: [number, number];
    kind: "opening" | "reroll" | "turn" | "discard";
  }>;
}
```

The verifier rejects unknown fields, malformed inputs, noncontiguous/repeated counters, missing contributions when any roll exists, incorrect commitments and mismatching dice. Contributions may be null **only when zero rolls were consumed**, such as a canceled or forfeited start. Both non-null contributions are also valid with zero rolls. Up to 100,000 recorded rolls are accepted. The optional `expectedCommitment` must match the independently observed commitment as well as the recomputed hash. Verification returns `{ok:true, rollsVerified, commitment}` or `{ok:false, errorCode, rollIndex?}`; derivation functions throw `DiceError` with a stable `code`.

A successful check proves that the supplied seed/identities/settings match the supplied commitment and that the listed dice match the supplied contributions and contiguous counters. It does **not** prove publication timing, authentic player identity, contribution/acknowledgment timing, a complete game history or that the operator never peeked. `kind` is a display label and is not included in HMAC; this verifier does not validate game phases or legal moves. Removing a suffix of rolls cannot be detected without an independent observed final counter/history. For local play, the device owner has the seed and can inspect or restart it. Never describe local verification as preventing its owner's cheating.

