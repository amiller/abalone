// The built-in Tor transport with a stub TorClient (no network): the sealed /fetch route goes through it, its state dir
// is 0700, its status reaches the strip, and a Tor failure is an error that never becomes a direct fetch.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { download } from "../lib/fetch.mjs";
import { torTransport } from "../lib/tor.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "abalone-tor-"));
const url = new URL("https://check.torproject.org/api/ip");

test("sealed /fetch goes through the Tor transport; state dir 0700; status bootstrapping then ready", async () => {
  const dir = tmp(), seen = [], statuses = [];
  const client = { ready: async () => {}, fetch: async (u) => (seen.push(u), new Response('{"IsTor":true,"IP":"185.220.101.1"}')), close: () => {} };
  const t = torTransport({ dataDir: path.join(dir, "tor"), client, onStatus: (s) => statuses.push(s) });
  const got = await download(url, "sealed", dir, t);
  assert.deepEqual(seen, [url.href]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, got.file), "utf8")).IsTor, true);
  assert.equal(got.via, "sealed (Tor (built in))");
  assert.equal(fs.statSync(path.join(dir, "tor")).mode & 0o777, 0o700);
  assert.deepEqual(statuses, ["bootstrapping", "ready"]);
});

test("a Tor failure is an error, nothing is saved, and nothing is fetched directly instead", async () => {
  const dir = tmp(), statuses = [];
  const client = { ready: async () => { throw new Error("no consensus"); }, fetch: async () => assert.fail("fetch after a failed bootstrap"), close: () => {} };
  const t = torTransport({ dataDir: path.join(dir, "tor"), client, onStatus: (s) => statuses.push(s) });
  process.env.ABALONE_FETCH_CURL_ARGS = '["--this-flag-would-make-curl-fail"]'; // curl is the direct route; it must not run
  await assert.rejects(download(url, "sealed", dir, t), /Tor failed: no consensus\. Nothing was sent, and nothing goes out on the direct route instead\./);
  assert.ok(!fs.existsSync(path.join(dir, "ip")));
  assert.deepEqual(statuses, ["bootstrapping", "failed"]);
});

test("a request through Tor that fails is reported as Tor's failure", async () => {
  const dir = tmp();
  const client = { ready: async () => {}, fetch: async () => { throw new Error("circuit closed"); }, close: () => {} };
  await assert.rejects(download(url, "sealed", dir, torTransport({ dataDir: path.join(dir, "tor"), client })), /Tor request failed: circuit closed\. Nothing goes out on the direct route instead\./);
});
