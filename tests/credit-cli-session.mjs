// Fresh-process CLI fixture: the real `bin/abalone.mjs credit session --credit <id> --mode rpc`, run twice over
// one persisted credit, with a selected synthetic PDF through the normal curated @mention path.
// Explicit synthetic boundaries, nothing else substituted:
//  - the credit is created over the real v4 protocol against the loopback synthetic issuer, then relabelled
//    testing:false under the record lock, because the real CLI opens no testing record and cannot redeem against
//    synthetic evidence; the record carries the explicitly signed recipient-v1 approval like a real durable credit;
//  - tests/fixtures/near/synthetic-near-hook.mjs replaces only the NEAR verdict and transport in the CLI process.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createCreditManagerForTesting } from "../lib/credit.mjs";
import { creditStore } from "../lib/credit-store.mjs";
import { coupon, id, sha, credential, provider, connect, pace, issuer } from "./lib/credit-fixture.mjs";

const root = path.resolve(import.meta.dirname, "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "abalone-credit-cli-"));
const [state, home, xdg, work, tmp] = ["state", "home", "x", "work", "tmp"].map((n) => { const d = path.join(base, n); fs.mkdirSync(d, { mode: 0o700 }); return d; });
const log = path.join(base, "synthetic-near.jsonl"), hook = path.join(root, "tests/fixtures/near/synthetic-near-hook.mjs");
const pass = (name) => console.log(`PASS ${name}`);

const server = await issuer();
const manager = createCreditManagerForTesting({ directory: path.join(state, "credit"), connect });
const offer = await manager.inspect(coupon, server.admission); await pace();
await manager.redeem(id, { offerHash: offer.offerHash });
await server.host.stop();
const claims = server.frames.filter((f) => f.op === "claim").length;
const store = creditStore(path.join(state, "credit")), record = store.read(id), unlock = store.lock(id);
try { store.write({ ...record, testing: false }); } finally { unlock(); }
const recordFile = path.join(state, "credit", `${id}.json`), recordBytes = fs.readFileSync(recordFile);

fs.copyFileSync(path.join(root, "tests/fixtures/docs/tenancy-renewal.pdf"), path.join(work, "tenancy-renewal.pdf"));
const env = { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: home, ABALONE_DIR: state, XDG_RUNTIME_DIR: xdg, TMPDIR: tmp, ABALONE_SYNTHETIC_NEAR_LOG: log };
// No manual canary step: credit session prepares the owned-host workspace and plants canaries itself.

function session(marker) {
  const argv = ["--import", hook, path.join(root, "bin/abalone.mjs"), "credit", "session", "--credit", id, "--mode", "rpc"];
  const child = spawn(process.execPath, argv, { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
  const events = []; let out = "", err = "", buf = "";
  child.stderr.on("data", (d) => { err += d; });
  child.stdout.on("data", (d) => {
    out += d; buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0;) {
      const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); events.push(ev);
      if (ev.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(ev.method)) { child.kill(); throw new Error(`unexpected ${ev.method} dialog`); }
      if (ev.type === "agent_settled") child.stdin.end();
    }
  });
  child.stdin.write(JSON.stringify({ id: "p1", type: "prompt", message: `${marker} In one line, what does @tenancy-renewal.pdf offer?` }) + "\n");
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, events, out, err, argv })));
}
const answer = (events) => events.filter((e) => e.type === "message_end" && e.message.role === "assistant").flatMap((e) => e.message.content).filter((c) => c.type === "text").map((c) => c.text).join("");
const markers = [];
for (const run of [1, 2]) {
  const marker = `SYNTHETIC-CLI-${crypto.randomBytes(6).toString("hex").toUpperCase()}`; markers.push(marker);
  const r = await session(marker);
  assert.equal(r.code, 0, r.err.slice(-2000));
  assert.ok(answer(r.events).includes(`SYNTHETIC FIXTURE ANSWER for ${marker}`), `run ${run}: ${r.err.slice(-1500)}`);
  for (const text of ["SYNTHETIC FIXTURE: NEAR attestation verdict", "Nominal cap $5.00 from the offer", "Balance: unknown.", "Sponsor can revoke the credential or change its limits",
      "separately bounded to 4096 output tokens", "staging operator can access the credential", "Saved credit remains available for a fresh process"]) assert.ok(r.err.includes(text), `run ${run} stderr lacks: ${text}`);
  if (run === 1) assert.ok(fs.readdirSync(work).length > 1, "canaries were planted automatically");
  assert.ok(!/\$5 |\$5\/|5 trial/.test(r.err), "no fixed $5 trial text");
  for (const secret of [coupon, credential, record.noiseSeed, record.recipientKey]) assert.ok(!r.out.includes(secret) && !r.err.includes(secret) && !r.argv.join(" ").includes(secret));
  pass(`run ${run}: fresh CLI process answers through the saved credit, discloses amount/balance/sponsor/request facts separately, shows no secret`);
}
const requests = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert.equal(requests.length, 2);
requests.forEach((q, i) => {
  assert.equal(q.marker, markers[i]); assert.equal(q.credentialSha256, sha(credential)); assert.equal(q.model, provider.model); assert.equal(q.maxTokens, 4096); assert.deepEqual(q.chatTemplateKwargs, { enable_thinking: false });
  assert.equal(q.url, "https://cloud-api.near.ai/v1/chat/completions"); assert.equal(q.pdfText, true); assert.equal(q.plaintextInBody, false);
});
pass("each fresh process uses the original saved credential; the selected synthetic PDF reaches the model only inside the encrypted request");
assert.ok(fs.readFileSync(recordFile).equals(recordBytes)); assert.equal(server.frames.filter((f) => f.op === "claim").length, claims);
pass("the persisted credit is byte-identical after both sessions and no claim was made");
const leftovers = [];
const scan = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name);
  if (e.isDirectory()) scan(p); else if (e.isFile() && p !== log && markers.some((m) => fs.readFileSync(p).includes(m))) leftovers.push(path.relative(base, p)); } };
scan(base);
const shm = `/dev/shm/abalone-${process.getuid()}`; if (fs.existsSync(shm)) scan(shm);
assert.deepEqual(leftovers, [], "no conversation text in state, home, runtime, temp, workspace or tmpfs memory");
pass("no default conversation file remains after close");
fs.rmSync(base, { recursive: true, force: true });
console.log("credit-cli-session: PASS");
