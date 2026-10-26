import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import ts from "typescript";
let directory: string;
const vectors = JSON.parse(
  readFileSync(new URL("../vectors/v1.json", import.meta.url), "utf8"),
);
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "tavlarena-dice-cli-"));
  mkdirSync(join(directory, "bin"));
  mkdirSync(join(directory, "dist"));
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  const source = readFileSync(
    new URL("../src/index.ts", import.meta.url),
    "utf8",
  );
  writeFileSync(
    join(directory, "dist/index.js"),
    ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
      },
    }).outputText,
  );
  copyFileSync(
    new URL("../bin/verify.mjs", import.meta.url),
    join(directory, "bin/verify.mjs"),
  );
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const run = (args: string[], input?: string) =>
  spawnSync(process.execPath, [join(directory, "bin/verify.mjs"), ...args], {
    input,
    encoding: "utf8",
  });
describe("independent verifier CLI", () => {
  it("accepts the documented `verify` subcommand and the site's downloaded record", () => {
    const proof = vectors.cases[0].proof;
    // The website download saves exactly JSON.stringify(proof, null, 2).
    const ok = run(["verify", "-", "--json"], JSON.stringify(proof, null, 2));
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).ok).toBe(true);
    // Extra keys are still rejected on purpose (strict transcript).
    const extra = run(
      ["verify", "-", "--json"],
      JSON.stringify({ encoding: "v1", ...proof }),
    );
    expect(extra.status).toBe(1);
  });
  it("verifies stdin and the separately observed commitment without printing the seed", () => {
    const proof = vectors.cases[0].proof;
    const output = run(
      ["--json", "--expected-commitment", proof.commitment, "-"],
      JSON.stringify(proof),
    );
    expect(output.status).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({
      ok: true,
      rollsVerified: 8,
    });
    expect(output.stdout).not.toContain(proof.seed);
  });
  it("reads a local file and provides Turkish help and result text", () => {
    const path = join(directory, "proof.json");
    writeFileSync(path, JSON.stringify(vectors.cases[0].proof));
    const output = run(["--lang", "tr", path]);
    expect(output.status).toBe(0);
    expect(output.stdout).toContain("eşleşiyor");
    expect(output.stdout).toContain("kanıtlanmaz");
    expect(run(["--lang", "tr", "--help"]).stdout).toContain("Kullanım:");
  });
  it("uses distinct proof-failure and malformed-input exit statuses", () => {
    const bad = structuredClone(vectors.cases[0].proof);
    bad.rolls[1].index = 0;
    const verification = run(["--json", "-"], JSON.stringify(bad));
    expect(verification.status).toBe(1);
    expect(JSON.parse(verification.stdout)).toMatchObject({
      ok: false,
      errorCode: "counter_gap",
    });
    const malformed = run(["--json", "-"], "not json");
    expect(malformed.status).toBe(2);
    expect(JSON.parse(malformed.stdout)).toEqual({
      ok: false,
      errorCode: "invalid_json",
    });
    expect(run(["--unknown"]).status).toBe(2);
  });
});
