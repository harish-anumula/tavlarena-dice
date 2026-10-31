// tavlarena-dice by the TavlArena team · MIT · https://github.com/harish-anumula/tavlarena-dice
/** MIT licensed; independent of the proprietary TavlArena application. */
export const COMMIT_CONTEXT = "tavlarena-dice-commit-v1";
export const ROLL_CONTEXT = "tavlarena-dice-roll-v1";
export const MAX_TRANSCRIPT_ROLLS = 100_000;
const U32_MAX = 0xffff_ffff;
const utf8 = new TextEncoder();
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type DiceErrorCode =
  | "invalid_json"
  | "invalid_settings"
  | "invalid_uuid"
  | "invalid_hex"
  | "invalid_bytes"
  | "invalid_counter"
  | "invalid_block"
  | "invalid_transcript"
  | "duplicate_player_ids"
  | "missing_contribution"
  | "counter_gap"
  | "commitment_mismatch"
  | "observed_commitment_mismatch"
  | "dice_mismatch"
  | "roll_limit_exceeded"
  | "crypto_unavailable"
  | "crypto_failed"
  | "rejection_limit_exceeded";
export class DiceError extends Error {
  constructor(
    readonly code: DiceErrorCode,
    readonly rollIndex?: number,
  ) {
    super(code);
    this.name = "DiceError";
  }
}
export interface DiceRoll {
  index: number;
  dice: [number, number];
  kind: "opening" | "reroll" | "turn" | "discard";
}
export interface DiceTranscript {
  version: 1;
  gameId: string;
  playerIds: [string, string];
  settings: JsonValue;
  commitment: string;
  contributions: [string | null, string | null];
  seed: string;
  rolls: DiceRoll[];
}
export type VerificationResult =
  | { ok: true; rollsVerified: number; commitment: string }
  | { ok: false; errorCode: DiceErrorCode; rollIndex?: number };
export interface CommitmentInput {
  gameId: string;
  playerIds: readonly [string, string];
  settings: JsonValue;
  seed: Uint8Array;
}
export interface RollInput {
  gameId: string;
  seed: Uint8Array;
  contributions: readonly [Uint8Array, Uint8Array];
  counter: number;
}

function requireValue(
  condition: unknown,
  code: DiceErrorCode,
): asserts condition {
  if (!condition) throw new DiceError(code);
}
function validUnicode(value: string) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
/** Sorted UTF-16 object keys; JSON escaping; safe integer numbers only; no whitespace. */
export function canonicalJson(value: JsonValue): string {
  const ancestors = new Set<object>();
  function visit(input: unknown, depth: number): string {
    requireValue(depth <= 64, "invalid_settings");
    if (input === null) return "null";
    if (typeof input === "boolean") return input ? "true" : "false";
    if (typeof input === "number") {
      requireValue(Number.isSafeInteger(input), "invalid_settings");
      return JSON.stringify(input); // -0 is canonicalized to 0.
    }
    if (typeof input === "string") {
      requireValue(validUnicode(input), "invalid_settings");
      return JSON.stringify(input);
    }
    requireValue(
      typeof input === "object" && input !== null,
      "invalid_settings",
    );
    requireValue(!ancestors.has(input), "invalid_settings");
    const prototype = Object.getPrototypeOf(input);
    requireValue(
      Array.isArray(input) ||
        prototype === Object.prototype ||
        prototype === null,
      "invalid_settings",
    );
    requireValue(
      Object.getOwnPropertySymbols(input).length === 0,
      "invalid_settings",
    );
    ancestors.add(input);
    let result: string;
    if (Array.isArray(input)) {
      requireValue(
        Object.keys(input).length === input.length,
        "invalid_settings",
      );
      const parts: string[] = [];
      for (let i = 0; i < input.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
        requireValue(descriptor && "value" in descriptor, "invalid_settings");
        parts.push(visit(descriptor.value, depth + 1));
      }
      result = `[${parts.join(",")}]`;
    } else {
      const keys = Object.keys(input).sort();
      requireValue(
        Object.getOwnPropertyNames(input).length === keys.length,
        "invalid_settings",
      );
      result = `{${keys
        .map((key) => {
          requireValue(validUnicode(key), "invalid_settings");
          const descriptor = Object.getOwnPropertyDescriptor(input, key);
          requireValue(descriptor && "value" in descriptor, "invalid_settings");
          return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`;
        })
        .join(",")}}`;
    }
    ancestors.delete(input);
    return result;
  }
  const result = visit(value, 0);
  requireValue(utf8.encode(result).length <= 1_048_576, "invalid_settings");
  return result;
}
export function hexToBytes(hex: string, expectedBytes?: number): Uint8Array {
  requireValue(
    typeof hex === "string" &&
      hex.length % 2 === 0 &&
      /^[0-9a-fA-F]*$/.test(hex),
    "invalid_hex",
  );
  if (expectedBytes !== undefined)
    requireValue(
      Number.isSafeInteger(expectedBytes) &&
        expectedBytes >= 0 &&
        hex.length === expectedBytes * 2,
      "invalid_bytes",
    );
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}
export function bytesToHex(bytes: Uint8Array): string {
  requireValue(bytes instanceof Uint8Array, "invalid_bytes");
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
export function uuidToBytes(uuid: string): Uint8Array {
  requireValue(
    typeof uuid === "string" &&
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        uuid,
      ),
    "invalid_uuid",
  );
  return hexToBytes(uuid.replaceAll("-", ""), 16);
}
export function bytesToUuid(bytes: Uint8Array): string {
  const hex = bytesToHex(fixedBytes(bytes, 16));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function fixedBytes(
  value: Uint8Array,
  length: number,
): Uint8Array<ArrayBuffer> {
  requireValue(
    value instanceof Uint8Array && value.length === length,
    "invalid_bytes",
  );
  return new Uint8Array(value); // Snapshot before the first await.
}
function concatenate(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
function u32be(value: number, code: "invalid_counter" | "invalid_block") {
  requireValue(Number.isInteger(value) && value >= 0 && value <= U32_MAX, code);
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}
function webCrypto(): Crypto {
  requireValue(
    globalThis.crypto?.subtle &&
      typeof globalThis.crypto.getRandomValues === "function",
    "crypto_unavailable",
  );
  return globalThis.crypto;
}
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const crypto = webCrypto();
  try {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  } catch {
    throw new DiceError("crypto_failed");
  }
}
export function secureBytes32(): Uint8Array {
  const crypto = webCrypto();
  try {
    return crypto.getRandomValues(new Uint8Array(32));
  } catch {
    throw new DiceError("crypto_failed");
  }
}
export async function hashSettings(settings: JsonValue): Promise<string> {
  return bytesToHex(await digest(utf8.encode(canonicalJson(settings))));
}
export async function commitment(input: CommitmentInput): Promise<string> {
  const gameId = uuidToBytes(input.gameId);
  requireValue(
    Array.isArray(input.playerIds) && input.playerIds.length === 2,
    "invalid_uuid",
  );
  const players = [
    uuidToBytes(input.playerIds[0]),
    uuidToBytes(input.playerIds[1]),
  ] as const;
  requireValue(
    bytesToHex(players[0]) !== bytesToHex(players[1]),
    "duplicate_player_ids",
  );
  const seed = fixedBytes(input.seed, 32);
  const settingsBytes = utf8.encode(canonicalJson(input.settings));
  const settingsHash = await digest(settingsBytes);
  return bytesToHex(
    await digest(
      concatenate(
        utf8.encode(COMMIT_CONTEXT),
        gameId,
        settingsHash,
        ...players,
        seed,
      ),
    ),
  );
}
function prepareRoll(input: RollInput) {
  const seed = fixedBytes(input.seed, 32),
    gameId = uuidToBytes(input.gameId);
  requireValue(
    Array.isArray(input.contributions) && input.contributions.length === 2,
    "missing_contribution",
  );
  const contributions = input.contributions.map((value) =>
    fixedBytes(value, 32),
  );
  const prefix = concatenate(
    utf8.encode(ROLL_CONTEXT),
    gameId,
    ...contributions,
    u32be(input.counter, "invalid_counter"),
  );
  return { seed, prefix };
}
async function importKey(seed: Uint8Array<ArrayBuffer>) {
  const crypto = webCrypto();
  try {
    return await crypto.subtle.importKey(
      "raw",
      seed,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new DiceError("crypto_failed");
  }
}
async function sign(key: CryptoKey, bytes: Uint8Array<ArrayBuffer>) {
  const crypto = webCrypto();
  try {
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  } catch {
    throw new DiceError("crypto_failed");
  }
}
export async function rollBlock(
  input: RollInput & { block: number },
): Promise<Uint8Array> {
  const prepared = prepareRoll(input),
    block = u32be(input.block, "invalid_block");
  const key = await importKey(prepared.seed);
  return sign(key, concatenate(prepared.prefix, block));
}
export async function roll(input: RollInput): Promise<[number, number]> {
  const prepared = prepareRoll(input),
    key = await importKey(prepared.seed),
    dice: number[] = [];
  for (let block = 0; block <= U32_MAX; block++) {
    const bytes = await sign(
      key,
      concatenate(prepared.prefix, u32be(block, "invalid_block")),
    );
    for (const byte of bytes) {
      if (byte < 252) dice.push((byte % 6) + 1);
      if (dice.length === 2) return [dice[0], dice[1]];
    }
  }
  throw new DiceError("rejection_limit_exceeded");
}
function exactObject(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  requireValue(
    input !== null && typeof input === "object" && !Array.isArray(input),
    "invalid_transcript",
  );
  const object = input as Record<string, unknown>;
  requireValue(
    Object.getPrototypeOf(object) === Object.prototype ||
      Object.getPrototypeOf(object) === null,
    "invalid_transcript",
  );
  requireValue(
    Object.getOwnPropertySymbols(object).length === 0 &&
      Object.getOwnPropertyNames(object).length === keys.length &&
      keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        return descriptor && "value" in descriptor && descriptor.enumerable;
      }),
    "invalid_transcript",
  );
  return object;
}
function tuple(input: unknown): unknown[] {
  requireValue(
    Array.isArray(input) &&
      input.length === 2 &&
      Object.keys(input).length === 2 &&
      [0, 1].every((index) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          input,
          String(index),
        );
        return descriptor && "value" in descriptor;
      }),
    "invalid_transcript",
  );
  return input;
}
/** Checks cryptographic consistency; does not prove when a commitment was published. */
export async function verifyTranscript(
  proof: unknown,
  options: { expectedCommitment?: string } = {},
): Promise<VerificationResult> {
  try {
    const object = exactObject(proof, [
      "version",
      "gameId",
      "playerIds",
      "settings",
      "commitment",
      "contributions",
      "seed",
      "rolls",
    ]);
    requireValue(object.version === 1, "invalid_transcript");
    const gameId = bytesToUuid(uuidToBytes(object.gameId as string));
    const playerIds = tuple(object.playerIds).map((id) =>
      bytesToUuid(uuidToBytes(id as string)),
    ) as [string, string];
    // Snapshot settings and every roll before the first asynchronous crypto call.
    const settings = JSON.parse(
      canonicalJson(object.settings as JsonValue),
    ) as JsonValue;
    const seed = hexToBytes(object.seed as string, 32);
    const committed = bytesToHex(hexToBytes(object.commitment as string, 32));
    if (options.expectedCommitment !== undefined) {
      const observed = bytesToHex(hexToBytes(options.expectedCommitment, 32));
      requireValue(observed === committed, "observed_commitment_mismatch");
    }
    const contributions = tuple(object.contributions).map((value) =>
      value === null ? null : hexToBytes(value as string, 32),
    );
    requireValue(Array.isArray(object.rolls), "invalid_transcript");
    requireValue(
      object.rolls.length <= MAX_TRANSCRIPT_ROLLS,
      "roll_limit_exceeded",
    );
    if (object.rolls.length)
      requireValue(
        contributions.every((value) => value !== null),
        "missing_contribution",
      );
    const rolls: DiceRoll[] = [];
    for (let index = 0; index < object.rolls.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(
        object.rolls,
        String(index),
      );
      requireValue(descriptor && "value" in descriptor, "invalid_transcript");
      const entry = exactObject(descriptor.value, ["index", "dice", "kind"]);
      requireValue(
        Number.isInteger(entry.index) &&
          (entry.index as number) >= 0 &&
          (entry.index as number) <= U32_MAX,
        "invalid_counter",
      );
      if (entry.index !== index) throw new DiceError("counter_gap", index);
      const dice = tuple(entry.dice);
      requireValue(
        dice.every(
          (value) =>
            Number.isInteger(value) &&
            (value as number) >= 1 &&
            (value as number) <= 6,
        ),
        "invalid_transcript",
      );
      requireValue(
        ["opening", "reroll", "turn", "discard"].includes(entry.kind as string),
        "invalid_transcript",
      );
      rolls.push({
        index,
        dice: [dice[0] as number, dice[1] as number],
        kind: entry.kind as DiceRoll["kind"],
      });
    }
    const computed = await commitment({ gameId, playerIds, settings, seed });
    requireValue(computed === committed, "commitment_mismatch");
    for (const entry of rolls) {
      const expected = await roll({
        gameId,
        seed,
        contributions: contributions as [Uint8Array, Uint8Array],
        counter: entry.index,
      });
      if (expected[0] !== entry.dice[0] || expected[1] !== entry.dice[1])
        throw new DiceError("dice_mismatch", entry.index);
    }
    return { ok: true, rollsVerified: rolls.length, commitment: computed };
  } catch (error) {
    const issue =
      error instanceof DiceError ? error : new DiceError("invalid_transcript");
    return {
      ok: false,
      errorCode: issue.code,
      ...(issue.rollIndex === undefined ? {} : { rollIndex: issue.rollIndex }),
    };
  }
}
