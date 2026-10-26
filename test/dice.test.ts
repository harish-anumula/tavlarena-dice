import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  bytesToHex,
  bytesToUuid,
  canonicalJson,
  commitment,
  hashSettings,
  hexToBytes,
  roll,
  rollBlock,
  secureBytes32,
  uuidToBytes,
  verifyTranscript,
  type DiceTranscript,
  type JsonValue,
} from "../src/index";
const vectors = JSON.parse(
  readFileSync(new URL("../vectors/v1.json", import.meta.url), "utf8"),
) as {
  canonical: { input: JsonValue; expected: string }[];
  cases: {
    name: string;
    canonicalSettings: string;
    settingsHash: string;
    blocks: { counter: number; block: number; hmac: string }[];
    proof: DiceTranscript;
  }[];
};
const base = vectors.cases[0].proof;
const input = (proof = base) => ({
  gameId: proof.gameId,
  seed: hexToBytes(proof.seed, 32),
  contributions: proof.contributions.map((value) =>
    hexToBytes(value as string, 32),
  ) as [Uint8Array, Uint8Array],
});
afterEach(() => vi.unstubAllGlobals());

describe("independent Python normative vectors", () => {
  it.each(vectors.cases)(
    "matches settings, commitment, every HMAC block and all dice: $name",
    async (vector) => {
      expect(canonicalJson(vector.proof.settings)).toBe(
        vector.canonicalSettings,
      );
      expect(await hashSettings(vector.proof.settings)).toBe(
        vector.settingsHash,
      );
      expect(
        await commitment({
          ...input(vector.proof),
          playerIds: vector.proof.playerIds,
          settings: vector.proof.settings,
        }),
      ).toBe(vector.proof.commitment);
      for (const block of vector.blocks)
        expect(
          bytesToHex(
            await rollBlock({
              ...input(vector.proof),
              counter: block.counter,
              block: block.block,
            }),
          ),
        ).toBe(block.hmac);
      for (const expected of vector.proof.rolls)
        expect(
          await roll({ ...input(vector.proof), counter: expected.index }),
        ).toEqual(expected.dice);
      expect(
        await verifyTranscript(vector.proof, {
          expectedCommitment: vector.proof.commitment,
        }),
      ).toEqual({
        ok: true,
        rollsVerified: 8,
        commitment: vector.proof.commitment,
      });
    },
  );
  it("rejects the actual vector's first digest byte rather than reducing it modulo six", async () => {
    const vector = vectors.cases.find((v) => v.name === "first-byte-rejected");
    if (!vector) throw new Error("missing vector");
    expect(hexToBytes(vector.blocks[0].hmac)[0]).toBeGreaterThanOrEqual(252);
    expect(await roll({ ...input(vector.proof), counter: 0 })).toEqual(
      vector.proof.rolls[0].dice,
    );
  });
  it("documents UTF16 key sorting independently of Unicode code-point ordering", () => {
    for (const vector of vectors.canonical)
      expect(canonicalJson(vector.input)).toBe(vector.expected);
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 }, minusZero: -0 })).toBe(
      '{"a":{"c":3,"d":4},"b":2,"minusZero":0}',
    );
  });
});
describe("input validation and encoding", () => {
  it("round-trips UUID network byte order, uppercase hex and nil UUID", () => {
    expect(bytesToHex(uuidToBytes(base.gameId))).toBe(
      base.gameId.replaceAll("-", ""),
    );
    expect(bytesToUuid(uuidToBytes(base.gameId.toUpperCase()))).toBe(
      base.gameId,
    );
    expect(bytesToUuid(new Uint8Array(16))).toBe(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(bytesToHex(hexToBytes("A0FF"))).toBe("a0ff");
  });
  it.each([
    NaN,
    Infinity,
    -Infinity,
    1.25,
    Number.MAX_SAFE_INTEGER + 1,
    undefined,
    BigInt(3),
    () => 1,
    new Date(),
    "\ud800",
  ])("rejects noncanonical settings input %s", (value) =>
    expect(() => canonicalJson(value as JsonValue)).toThrow("invalid_settings"),
  );
  it("rejects cycles, sparse arrays, getters and undefined properties without evaluating getters", () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => canonicalJson(cycle as JsonValue)).toThrow("invalid_settings");
    expect(() => canonicalJson(Array(2))).toThrow("invalid_settings");
    expect(() =>
      canonicalJson({ a: undefined } as unknown as JsonValue),
    ).toThrow("invalid_settings");
    const getter = vi.fn(() => 1);
    const value = {};
    Object.defineProperty(value, "x", { get: getter, enumerable: true });
    expect(() => canonicalJson(value)).toThrow("invalid_settings");
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([-1, 1.5, NaN, Infinity, 4294967296])(
    "never truncates counter/block %s",
    async (value) => {
      await expect(
        rollBlock({ ...input(), counter: value, block: 0 }),
      ).rejects.toMatchObject({ code: "invalid_counter" });
      await expect(
        rollBlock({ ...input(), counter: 0, block: value }),
      ).rejects.toMatchObject({ code: "invalid_block" });
    },
  );
  it("rejects malformed UUIDs, hex and byte sizes", async () => {
    for (const value of [
      "",
      base.gameId.replaceAll("-", ""),
      `${base.gameId} `,
      "zzzzzzzz-0000-0000-0000-000000000000",
    ])
      expect(() => uuidToBytes(value)).toThrow("invalid_uuid");
    for (const value of ["0", "gg", " 00", "0x00"])
      expect(() => hexToBytes(value)).toThrow("invalid_hex");
    expect(() => hexToBytes("00", 32)).toThrow("invalid_bytes");
    expect(() => bytesToUuid(new Uint8Array(15))).toThrow("invalid_bytes");
    await expect(
      commitment({
        ...input(),
        playerIds: base.playerIds,
        settings: base.settings,
        seed: new Uint8Array(31),
      }),
    ).rejects.toMatchObject({ code: "invalid_bytes" });
  });
  it("generates fresh 32-byte cryptographic values", () => {
    const a = secureBytes32(),
      b = secureBytes32();
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(a).not.toBe(b);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });
  it("advances HMAC block counters when all bytes are rejected, accepting 251 but not 252", async () => {
    const original = globalThis.crypto;
    const blocks: number[] = [];
    vi.stubGlobal("crypto", {
      getRandomValues: original.getRandomValues.bind(original),
      subtle: {
        importKey: original.subtle.importKey.bind(original.subtle),
        sign: async (_algorithm: unknown, _key: unknown, data: Uint8Array) => {
          const block = new DataView(
            data.buffer,
            data.byteOffset,
            data.byteLength,
          ).getUint32(data.length - 4, false);
          blocks.push(block);
          return (
            block === 0
              ? new Uint8Array(32).fill(255)
              : Uint8Array.from([252, 251, 250, ...Array(29).fill(0)])
          ).buffer;
        },
      },
    });
    expect(await roll({ ...input(), counter: 4294967295 })).toEqual([6, 5]);
    expect(blocks).toEqual([0, 1]);
  });
});
describe("strict transcript verification", () => {
  it.each([
    [
      "seed",
      (p: DiceTranscript) => {
        p.seed = "ff".repeat(32);
      },
      "commitment_mismatch",
    ],
    [
      "game ID",
      (p: DiceTranscript) => {
        p.gameId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      },
      "commitment_mismatch",
    ],
    [
      "seat order",
      (p: DiceTranscript) => {
        p.playerIds.reverse();
      },
      "commitment_mismatch",
    ],
    [
      "duplicate players",
      (p: DiceTranscript) => {
        p.playerIds[1] = p.playerIds[0];
      },
      "duplicate_player_ids",
    ],
    [
      "settings",
      (p: DiceTranscript) => {
        p.settings = { different: true };
      },
      "commitment_mismatch",
    ],
    [
      "contribution",
      (p: DiceTranscript) => {
        p.contributions[0] = "ff".repeat(32);
      },
      "dice_mismatch",
    ],
    [
      "dice",
      (p: DiceTranscript) => {
        p.rolls[0].dice = [(p.rolls[0].dice[0] % 6) + 1, p.rolls[0].dice[1]];
      },
      "dice_mismatch",
    ],
    [
      "counter gap",
      (p: DiceTranscript) => {
        p.rolls.splice(1, 1);
      },
      "counter_gap",
    ],
    [
      "counter replay",
      (p: DiceTranscript) => {
        p.rolls[1].index = 0;
      },
      "counter_gap",
    ],
    [
      "counter overflow",
      (p: DiceTranscript) => {
        p.rolls[0].index = 4294967296;
      },
      "invalid_counter",
    ],
    [
      "missing contribution",
      (p: DiceTranscript) => {
        p.contributions[1] = null;
      },
      "missing_contribution",
    ],
    [
      "unknown roll kind",
      (p: DiceTranscript) => {
        Object.assign(p.rolls[0], { kind: "undo" });
      },
      "invalid_transcript",
    ],
    [
      "extra field",
      (p: DiceTranscript) => {
        Object.assign(p, { extra: true });
      },
      "invalid_transcript",
    ],
  ] as const)("detects corrupt %s", async (_label, mutate, code) => {
    const proof = structuredClone(base);
    mutate(proof);
    expect(await verifyTranscript(proof)).toMatchObject({
      ok: false,
      errorCode: code,
    });
  });
  it("binds the user's independently observed commitment", async () => {
    expect(
      await verifyTranscript(base, { expectedCommitment: "00".repeat(32) }),
    ).toMatchObject({ ok: false, errorCode: "observed_commitment_mismatch" });
  });
  it.each([
    [null, null],
    [base.contributions[0], null],
    [null, base.contributions[1]],
  ] as const)(
    "allows incomplete contributions only for a zero-roll canceled game",
    async (a, b) => {
      const proof = structuredClone(base);
      proof.rolls = [];
      proof.contributions = [a, b];
      expect(await verifyTranscript(proof)).toMatchObject({
        ok: true,
        rollsVerified: 0,
      });
    },
  );
  it("snapshots caller input before asynchronous crypto", async () => {
    const proof = structuredClone(base);
    const checking = verifyTranscript(proof);
    proof.rolls[0].dice = [6, 6];
    proof.settings = { changed: true };
    proof.seed = "ff".repeat(32);
    expect(await checking).toMatchObject({ ok: true, rollsVerified: 8 });
    const params = {
      ...input(),
      playerIds: [...base.playerIds] as [string, string],
      settings: structuredClone(base.settings),
    };
    const pending = commitment(params);
    params.seed.fill(255);
    params.playerIds.reverse();
    params.settings = { changed: true };
    expect(await pending).toBe(base.commitment);
  });
  it("does not claim cryptographic protection for unbound phase labels", async () => {
    const proof = structuredClone(base);
    proof.rolls[0].kind = "discard";
    expect(await verifyTranscript(proof)).toMatchObject({ ok: true });
  });
});
