/** MIT. Run after Playwright Chromium installation; real page and dedicated-worker WebCrypto. */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import ts from "typescript";
const source = ts.transpileModule(
  await readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  },
).outputText;
const vectors = JSON.parse(
  await readFile(new URL("../vectors/v1.json", import.meta.url), "utf8"),
);
const parity = `import * as dice from '/index.js';
export async function check(vectors) {
  let checks=0;
  function equal(actual,expected){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('browser_vector_mismatch');checks++;}
  for(const vector of vectors.cases){
    const proof=vector.proof;
    const input={gameId:proof.gameId,seed:dice.hexToBytes(proof.seed,32),contributions:proof.contributions.map(value=>dice.hexToBytes(value,32))};
    equal(await dice.hashSettings(proof.settings),vector.settingsHash);
    equal(await dice.commitment({...input,playerIds:proof.playerIds,settings:proof.settings}),proof.commitment);
    for(const block of vector.blocks)equal(dice.bytesToHex(await dice.rollBlock({...input,counter:block.counter,block:block.block})),block.hmac);
    for(const roll of proof.rolls)equal(await dice.roll({...input,counter:roll.index}),roll.dice);
    equal(await dice.verifyTranscript(proof,{expectedCommitment:proof.commitment}),{ok:true,rollsVerified:8,commitment:proof.commitment});
  }
  for(const vector of vectors.canonical)equal(dice.canonicalJson(vector.input),vector.expected);
  return {cases:vectors.cases.length,checks};
}`;
const worker = `import {check} from '/parity.js';self.onmessage=async({data})=>{try{self.postMessage({ok:true,result:await check(data)});}catch{self.postMessage({ok:false});}};`;
const server = createServer((request, response) => {
  const script = {
    "/index.js": source,
    "/parity.js": parity,
    "/worker.js": worker,
  }[request.url];
  response.writeHead(200, {
    "content-type": script ? "text/javascript" : "text/html",
    "cache-control": "no-store",
  });
  response.end(
    script ??
      "<!doctype html><html lang=en><title>Dice WebCrypto parity</title><body>Independent verifier checks</body></html>",
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("missing_test_address");
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const result = await page.evaluate(async (data) => {
    const { check } = await import("/parity.js");
    const pageResult = await check(data);
    const workerResult = await new Promise((resolve, reject) => {
      const worker = new Worker("/worker.js", { type: "module" });
      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error("worker_timeout"));
      }, 10000);
      worker.onerror = () => {
        clearTimeout(timeout);
        worker.terminate();
        reject(new Error("worker_failed"));
      };
      worker.onmessage = ({ data }) => {
        clearTimeout(timeout);
        worker.terminate();
        data.ok
          ? resolve(data.result)
          : reject(new Error("worker_vector_mismatch"));
      };
      worker.postMessage(data);
    });
    return { page: pageResult, worker: workerResult };
  }, vectors);
  assert.deepEqual(result.page, { cases: 3, checks: 61 });
  assert.deepEqual(result.worker, result.page);
  console.log(
    `Passed ${result.page.checks} independent-vector checks in Chromium page and ${result.worker.checks} in its dedicated Worker (browser ${browser.version()}).`,
  );
} finally {
  await browser?.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
