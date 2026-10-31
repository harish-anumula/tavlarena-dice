#!/usr/bin/env node
// tavlarena-dice by the TavlArena team · MIT · https://github.com/harish-anumula/tavlarena-dice
// MIT. A local verifier only: no network, credentials or application dependencies.
import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { verifyTranscript } from "../dist/index.js";
const maximum = 16 * 1024 * 1024;
const messages = {
  en: {
    help: "Usage: tavlarena-dice [verify] [--lang en|tr] [--json] [--expected-commitment HEX] FILE|-\nVerifies encoding-v1 transcript consistency. Use - to read standard input.\nThis does not prove publication time or that an operator never peeked.\n",
    success: (count) =>
      `Transcript matches the revealed seed and inputs (${count} rolls). Publication timing and operator non-peeking are not proved.`,
    failure: (code) => `Verification failed: ${code}`,
  },
  tr: {
    help: "Kullanım: tavlarena-dice [verify] [--lang en|tr] [--json] [--expected-commitment HEX] DOSYA|-\nV1 kodlamalı zar dökümünün tutarlılığını doğrular. Standart girdi için - kullan.\nYayımlama zamanını veya işletmecinin sonuçlara önceden bakmadığını kanıtlamaz.\n",
    success: (count) =>
      `Döküm, açıklanan tohum ve girdilerle eşleşiyor (${count} zar atışı). Yayımlama zamanı veya işletmecinin sonuçlara önceden bakmadığı kanıtlanmaz.`,
    failure: (code) => `Doğrulama başarısız: ${code}`,
  },
};
let locale = "en",
  json = process.argv.includes("--json");
function fail(errorCode, exit = 2) {
  const result = { ok: false, errorCode };
  if (json) console.log(JSON.stringify(result));
  else console.error(messages[locale].failure(errorCode));
  process.exitCode = exit;
}
async function readInput(path) {
  const chunks = [];
  let length = 0;
  const file = path === "-" ? null : await open(path, "r");
  try {
    if (file && (await file.stat()).size > maximum)
      throw new Error("input_too_large");
    const input = file
      ? file.createReadStream({ autoClose: false })
      : process.stdin;
    for await (const chunk of input) {
      length += chunk.length;
      if (length > maximum) throw new Error("input_too_large");
      chunks.push(chunk);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } finally {
    await file?.close();
  }
}
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      lang: { type: "string", default: "en" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
      "expected-commitment": { type: "string" },
    },
  });
  json = values.json;
  if (!Object.hasOwn(messages, values.lang))
    throw new Error("invalid_arguments");
  locale = values.lang;
  // `tavlarena-dice verify FILE` and `tavlarena-dice FILE` are the same.
  if (positionals[0] === "verify") positionals.shift();
  if (values.help) console.log(messages[locale].help);
  else if (positionals.length !== 1) fail("invalid_arguments");
  else {
    let input;
    try {
      input = await readInput(positionals[0]);
    } catch (error) {
      fail(
        error.message === "input_too_large"
          ? "input_too_large"
          : "input_unreadable",
      );
    }
    if (input !== undefined) {
      let proof;
      try {
        proof = JSON.parse(input);
      } catch {
        fail("invalid_json");
      }
      if (proof !== undefined) {
        const result = await verifyTranscript(proof, {
          expectedCommitment: values["expected-commitment"],
        });
        if (json) console.log(JSON.stringify(result));
        else if (result.ok)
          console.log(
            messages[locale].success(
              new Intl.NumberFormat(locale).format(result.rollsVerified),
            ),
          );
        else console.error(messages[locale].failure(result.errorCode));
        process.exitCode = result.ok ? 0 : 1;
      }
    }
  }
} catch {
  fail("invalid_arguments");
}
