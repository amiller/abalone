// Fresh-process CLI fixture: the real `bin/abalone.mjs credit session --credit <id> --mode rpc`, run twice over
// one persisted credit, with a selected synthetic PDF through the normal curated @mention path; then plain `abalone`
// over one, two and only-expired saved credits.
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
import { OUT_OF_DATE_TRIAL_POLICY } from "../lib/coupon-near.mjs";
import { coupon, id, sha, credential, provider, connect, pace, issuer, bundle, terms } from "./lib/credit-fixture.mjs";
import { creditId } from "../lib/credit-store.mjs";

const root = path.resolve(import.meta.dirname, "..");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "abalone-credit-cli-"));
const [state, home, xdg, work, tmp] = ["state", "home", "x", "work", "tmp"].map((n) => { const d = path.join(base, n); fs.mkdirSync(d, { mode: 0o700 }); return d; });
const log = path.join(base, "synthetic-near.jsonl"), hook = path.join(root, "tests/fixtures/near/synthetic-near-hook.mjs");
const pass = (name) => console.log(`PASS ${name}`);
const warnings = (err) => err.split("\n").filter((l) => /warning|⚠|INTEL-SA|out ?of ?date/i.test(l)); // the usability gate's rule (tests/usability/live.mjs)

// Saves one synthetic gift into dir (redeemed unless expiresAt overrides its claim window) and relabels it
// testing:false so the real CLI opens it. policy overrides the delivered NEAR provider policy.
async function saved(dir, code, expiresAt, policy = provider.policy) {
  const server = await issuer(undefined, code), manager = createCreditManagerForTesting({ directory: dir, connect });
  if (expiresAt) server.state.offer = bundle({ ...terms(server.host.peerId.toString(), undefined, code), claim_expires_at: expiresAt });
  const offer = await manager.inspect(code, { ...server.admission, provider: { ...provider, policy } }); await pace();
  if (!expiresAt) await manager.redeem(creditId(code), { offerHash: offer.offerHash });
  await server.host.stop();
  const store = creditStore(dir), record = store.read(creditId(code)), unlock = store.lock(record.id);
  try { store.write({ ...record, testing: false }); } finally { unlock(); }
  return { server, record };
}
const { server, record } = await saved(path.join(state, "credit"), coupon);
const claims = server.frames.filter((f) => f.op === "claim").length;
const recordFile = path.join(state, "credit", `${id}.json`), recordBytes = fs.readFileSync(recordFile);

fs.copyFileSync(path.join(root, "tests/fixtures/docs/tenancy-renewal.pdf"), path.join(work, "tenancy-renewal.pdf"));
const env = { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: home, ABALONE_DIR: state, XDG_RUNTIME_DIR: xdg, TMPDIR: tmp, ABALONE_SYNTHETIC_NEAR_LOG: log };

// prompts: how many prompts to send, each after the previous one settles.
function session(marker, { credit = id, extra = {}, prompts = 1 } = {}) {
  const argv = ["--import", hook, path.join(root, "bin/abalone.mjs"), "credit", "session", "--credit", credit, "--mode", "rpc"];
  const child = spawn(process.execPath, argv, { cwd: work, env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
  let settled = 0;
  const events = []; let out = "", err = "", buf = "";
  child.stderr.on("data", (d) => { err += d; });
  child.stdout.on("data", (d) => {
    out += d; buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0;) {
      const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); events.push(ev);
      if (ev.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(ev.method)) { child.kill(); throw new Error(`unexpected ${ev.method} dialog`); }
      if (ev.type === "agent_settled") ++settled < prompts ? ask(settled + 1) : child.stdin.end();
    }
  });
  const ask = (n) => child.stdin.write(JSON.stringify({ id: `p${n}`, type: "prompt", message: `${marker} In one line, what does @tenancy-renewal.pdf offer?` }) + "\n");
  for (const c of ["/coupon", "/status"]) child.stdin.write(JSON.stringify({ id: c, type: "prompt", message: c }) + "\n");
  ask(1);
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, events, out, err, argv })));
}
const answer = (events) => events.filter((e) => e.type === "message_end" && e.message.role === "assistant").flatMap((e) => e.message.content).filter((c) => c.type === "text").map((c) => c.text).join("");
const markers = [];
for (const run of [1, 2]) {
  const marker = `SYNTHETIC-CLI-${crypto.randomBytes(6).toString("hex").toUpperCase()}`; markers.push(marker);
  const r = await session(marker);
  assert.equal(r.code, 0, r.err.slice(-2000));
  assert.ok(answer(r.events).includes(`SYNTHETIC FIXTURE ANSWER for ${marker}`), `run ${run}: ${r.err.slice(-1500)}`);
  for (const text of ["SYNTHETIC FIXTURE: NEAR attestation verdict", "Nominal cap $5.00 from the offer", "Usage: not reported.", "Sponsor can revoke the credential or change its limits",
      "separately bounded to 4096 output tokens", "staging operator can access the credential", "Saved credit remains available for a fresh process"]) assert.ok(r.err.includes(text), `run ${run} stderr lacks: ${text}`);
  assert.deepEqual(fs.readdirSync(work), ["tenancy-renewal.pdf"], "no decoy file is planted");
  const notes = r.events.filter((e) => e.type === "extension_ui_request" && e.method === "notify").map((e) => e.message);
  const shown = notes.find((m) => m.startsWith("Coupon: ")), status = notes.find((m) => m.startsWith("This session: "));
  assert.ok(shown?.includes("Each request: at most 4096 output tokens. Balance: unknown; usage: ") && shown.includes("; provider expiry: unknown. Sponsor may revoke or change limits.") && !shown.includes("NEAR firmware"), `run ${run} /coupon: ${shown}`);
  assert.ok(status?.includes("usage: not reported") && status.includes("Verified: the launcher checks") && !/\$0\.0000|private reader|--keep-trace|No verifier output/.test(status), `run ${run} /status: ${status}`);
  assert.ok(!/\$5 |\$5\/|5 trial/.test(r.err), "no fixed $5 trial text");
  assert.deepEqual(warnings(r.err), [], `run ${run}: an UpToDate admission prints no warning line`);
  for (const secret of [coupon, credential, record.noiseSeed, record.recipientKey]) assert.ok(!r.out.includes(secret) && !r.err.includes(secret) && !r.argv.join(" ").includes(secret));
  pass(`run ${run}: fresh CLI process answers through the saved credit, discloses amount/balance/sponsor/request facts separately, /coupon answers from the launcher, shows no secret`);
}
const requests = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert.equal(requests.length, 2);
requests.forEach((q, i) => {
  assert.equal(q.marker, markers[i]); assert.equal(q.credentialSha256, sha(credential)); assert.equal(q.model, provider.model); assert.equal(q.maxTokens, 4096); assert.deepEqual(q.chatTemplateKwargs, { enable_thinking: false });
  assert.equal(q.url, "https://cloud-api.near.ai/v1/chat/completions"); assert.equal(q.pdfText, true); assert.equal(q.plaintextInBody, false);
});
pass("each fresh process uses the original saved credential; the selected synthetic PDF reaches the model only inside the encrypted request");
const usageOnly = () => { const { usage, ...rest } = JSON.parse(fs.readFileSync(recordFile, "utf8")); assert.deepEqual(rest, JSON.parse(recordBytes)); return usage; };
assert.deepEqual(usageOnly(), { responses: 2, reported: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }); assert.equal(fs.statSync(recordFile).mode & 0o777, 0o600);
assert.equal(server.frames.filter((f) => f.op === "claim").length, claims);
pass("the persisted credit is unchanged after both sessions except its 0600 usage total, and no claim was made");

// An OutOfDate trial credit admitted on OutOfDate firmware, over two requests: one warning line, from the admission.
const ood = path.join(base, "ood"), oodCode = "f".repeat(43), oodMarker = `SYNTHETIC-CLI-${crypto.randomBytes(6).toString("hex").toUpperCase()}`; markers.push(oodMarker);
await saved(path.join(ood, "credit"), oodCode, undefined, { ...provider.policy, gatewayTcb: OUT_OF_DATE_TRIAL_POLICY, modelTcb: OUT_OF_DATE_TRIAL_POLICY });
const o = await session(oodMarker, { credit: creditId(oodCode), extra: { ABALONE_DIR: ood, ABALONE_SYNTHETIC_NEAR_OUT_OF_DATE: "1" }, prompts: 2 });
assert.equal(o.code, 0, o.err.slice(-2000));
assert.equal(o.events.filter((e) => e.type === "message_end" && e.message.role === "assistant").length, 2);
assert.deepEqual(warnings(o.err), ["⚠ NEAR firmware out of date (2 Intel advisories); synthetic input only"], o.err);
assert.equal(o.err.split("Coupon session: installed.").length - 1, 1, o.err);
assert.equal(JSON.parse(fs.readFileSync(path.join(ood, "credit", `${creditId(oodCode)}.json`), "utf8")).usage.responses, 2);
pass("an OutOfDate trial credit session prints one warning line (the admission's firmware line) and one installed line over two requests");

// Plain `abalone`: one saved credit opens its session; several are listed; none points to the redeem page.
function plain(dir) {
  const child = spawn(process.execPath, ["--import", hook, path.join(root, "bin/abalone.mjs")], { cwd: work, env: { ...env, ABALONE_DIR: dir }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; if (err.includes("Fresh incognito conversation")) child.stdin.end(); });
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, out, err })));
}
const one = await plain(state);
assert.equal(one.code, 0, one.err.slice(-2000));
for (const text of ["Saved credit:", "Nominal cap $5.00 from the offer", "Fresh incognito conversation", "Saved credit remains available for a fresh process"]) assert.ok(one.err.includes(text), `plain abalone stderr lacks: ${text}`);
assert.ok(!one.err.includes("no canaries") && !one.err.includes("bubblewrap")); assert.deepEqual(fs.readdirSync(work), ["tenancy-renewal.pdf"], "no decoy file is planted");
assert.equal(usageOnly().responses, 2); assert.equal(server.frames.filter((f) => f.op === "claim").length, claims);
pass("plain abalone with one saved credit opens that credit's session, like credit session --credit <id>");
const two = path.join(base, "two"), second = "d".repeat(43);
await saved(path.join(two, "credit"), second);
fs.copyFileSync(recordFile, path.join(two, "credit", `${id}.json`)); fs.chmodSync(path.join(two, "credit", `${id}.json`), 0o600);
const several = await plain(two);
assert.equal(several.code, 1);
assert.ok(several.err.includes("You have 2 saved credits. Open one with:\n"), several.err);
for (const each of [id, creditId(second)]) assert.ok(several.err.includes(`  abalone credit session --credit ${each}   (${provider.model}, $5.00 nominal cap)`), several.err);
assert.ok(!several.err.includes("Saved credit:"), "no session opened");
pass("plain abalone with several saved credits lists each with its session command and opens none");
const late = path.join(base, "late"), lapsed = "e".repeat(43);
await saved(path.join(late, "credit"), lapsed, "2026-01-01T00:00:00Z");
const waiting = await plain(late);
assert.equal(waiting.code, 1);
assert.ok(waiting.err.includes(`No saved credit is ready to use yet:\n  ${creditId(lapsed)}  expired: Claim window closed; the deadline was 2026-01-01 00:00 UTC. This gift can no longer be redeemed: ask the sponsor for a new gift.\n`), waiting.err);
assert.ok(waiting.err.includes("https://amiller.github.io/abalone/redeem/"));
pass("plain abalone with only an expired offer says so, with the deadline and 'ask the sponsor for a new gift'");
const leftovers = [];
const scan = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name);
  if (e.isDirectory()) scan(p); else if (e.isFile() && p !== log && markers.some((m) => fs.readFileSync(p).includes(m))) leftovers.push(path.relative(base, p)); } };
scan(base);
const shm = `/dev/shm/abalone-${process.getuid()}`; if (fs.existsSync(shm)) scan(shm);
assert.deepEqual(leftovers, [], "no conversation text in state, home, runtime, temp, workspace or tmpfs memory");
pass("no default conversation file remains after close");
fs.rmSync(base, { recursive: true, force: true });
console.log("credit-cli-session: PASS");
