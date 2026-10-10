// runnerFetch's delivery retry: a connection the runner closes before any response byte is sent again (3 attempts at
// most, each logged, then a loud failure naming the URL); once a response byte has arrived nothing is retried.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abr-")), sock = path.join(dir, "egress.sock");
process.env.ABALONE_RUNNER_SOCK = sock;
const { runnerFetch } = await import("../lib/macrunner.mjs");
let mode = { drop: 0, half: false }, seen = 0;
const server = net.createServer((s) => {
  seen++;
  if (mode.drop > 0) { mode.drop--; return s.destroy(); }
  s.once("data", () => s.end(mode.half ? "HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nabc" : "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok"));
});
await new Promise((r) => server.listen(sock, r));
const logs = [], orig = console.error;
console.error = (m) => logs.push(m);

test("two zero-byte closes, then an answer: sent 3 times, 2 retries logged", async () => {
  mode = { drop: 2 }; seen = 0; logs.length = 0;
  const r = await runnerFetch("http://cloud-api.near.ai/v1/models");
  assert.equal(await r.text(), "ok");
  assert.equal(seen, 3);
  assert.equal(logs.filter((l) => /closed with no response byte \(attempt [12] of 3\)/.test(l) && l.includes("http://cloud-api.near.ai/v1/models")).length, 2);
});
test("three zero-byte closes: fails loudly with the URL", async () => {
  mode = { drop: 3 }; seen = 0;
  await assert.rejects(runnerFetch("http://cloud-api.near.ai/v1/models"), /GET http:\/\/cloud-api.near.ai\/v1\/models: the runner closed the connection before any response byte, 3 times/);
  assert.equal(seen, 3);
});
test("a response cut off after its first bytes is not retried", async () => {
  mode = { drop: 0, half: true }; seen = 0;
  const r = await runnerFetch("http://cloud-api.near.ai/v1/models");
  await assert.rejects(r.text(), /response body cut off/);
  assert.equal(seen, 1);
});
test.after(() => { console.error = orig; server.close(); fs.rmSync(dir, { recursive: true }); });
