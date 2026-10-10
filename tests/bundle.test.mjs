// abalone-task-bundle/1 verifier (lib/bundle.mjs), offline. Two sources:
//   fixture/          FIXTURE in Track C's bundle layout (dev worker and runner keys, real test run), from make-fixture.mjs;
//   recorded-runner/  a real Mac runner boot (evidence node-20261008T201145): Apple App Attest enrollment and 31 receipts.
// Each tamper rewrites bundle.json too, as a tamperer would, so the check that catches it is the signed commitment.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { verifyBundle, runnerChain, taskBoot, settlement } from "../lib/bundle.mjs";
import { h } from "../lib/contracts/task-v1.mjs";

const dir = path.join(import.meta.dirname, "fixtures/bundle"), FIX = path.join(dir, "fixture");
const auth = JSON.parse(fs.readFileSync(path.join(dir, "authorization.json")));
const admitted = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../providers.json"))).peers.admit;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

// A copy of the fixture with edits applied ({path: (text) => text}) and bundle.json rehashed.
const tmps = [];
after(() => tmps.forEach((d) => fs.rmSync(d, { recursive: true })));
function tampered(edits = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-"));
  tmps.push(d);
  fs.cpSync(FIX, d, { recursive: true });
  for (const [p, f] of Object.entries(edits)) fs.writeFileSync(path.join(d, p), f(fs.readFileSync(path.join(d, p), "utf8")));
  const idx = JSON.parse(fs.readFileSync(path.join(d, "bundle.json")));
  idx.files = Object.fromEntries(walk(d).map((f) => path.relative(d, f)).filter((p) => !["bundle.json", "FIXTURE"].includes(p)).sort().map((p) => [p, sha(fs.readFileSync(path.join(d, p)))]));
  fs.writeFileSync(path.join(d, "bundle.json"), JSON.stringify(idx));
  return d;
}
const run = (d, o = {}) => verifyBundle(d, { admit: admitted, expect: auth, ...o });
const has = (r, re) => assert.ok(r.failures.some((f) => re.test(f)), `expected a failure matching ${re}; got:\n${r.failures.join("\n")}`);
const json = (f) => (t) => JSON.stringify(f(JSON.parse(t)));
const DEV = ["execution: the completion is signed by the worker's PeerId key only (peer-ed25519): a bare host signature, not attested execution",
  "execution: the task VM's runner was not attested (dev): nothing ties its receipt key to a measured binary"];

test("fixture: integrity and outcome hold; claim 2 is refused because both signers are dev keys", () => {
  const r = run(FIX);
  assert.deepEqual(r.failures, DEV);
  assert.match(r.outcome.join("\n"), /exited 0 .* none of them test files\. This is evidence the tests ran .* not that the change is correct/);
  assert.ok(r.unknowns.some((u) => u.startsWith("FIXTURE")));
  assert.ok(r.outcome[0].startsWith("Paid (gift credit): reserved 500000 µ$; execution 61 s × 167 µ$/s = 10187 µ$ (runner measured 61 s)"));
  assert.ok(r.integrity.some((l) => l.startsWith("settlement adds up")));
});

test("an unchanged rehash is still clean (the harness itself does not trip checks)", () => assert.deepEqual(run(tampered()).failures, DEV));

test("tampered output is rejected", () => {
  has(run(tampered({ "outputs/files/add.mjs": (t) => t.replace("+", "*") })), /^integrity: output files\/add\.mjs has been altered/);
});

test("tampered output with the completion edited to match: the completion signature fails", () => {
  const d = tampered({ "outputs/files/add.mjs": (t) => t.replace("+", "*") });
  const c = JSON.parse(fs.readFileSync(path.join(d, "completion.json")));
  c.outputs.find((o) => o.path === "files/add.mjs").sha256 = sha(fs.readFileSync(path.join(d, "outputs/files/add.mjs")));
  const r = run(tampered({ "completion.json": () => JSON.stringify(c), "outputs/files/add.mjs": (t) => t.replace("+", "*") }));
  has(r, /^integrity: completion\.sig is not over this completion/);
  has(r, /^integrity: guest\/out\.tar is not the output the runner hashed at exit|output files\/add\.mjs is not what the task VM left in \/out/);
});

test("tampered receipt field (runner exit code) is rejected by its signature", () => {
  has(run(tampered({ "guest/receipts.jsonl": (t) => t.replace('\\"exit_code\\":0', '\\"exit_code\\":1') })), /^integrity: runner receipt 4: signature does not verify/);
});

test("tampered completion field (usage) is rejected by the completion signature", () => {
  has(run(tampered({ "completion.json": json((c) => ({ ...c, usage: { ...c.usage, charged: 1 } })) })), /^integrity: completion\.sig is not over this completion/);
});

test("tampered signatures are rejected (completion and runner receipt)", () => {
  has(run(tampered({ "completion.sig": json((s) => ({ ...s, sig: s.sig.replace(/^../, s.sig.startsWith("00") ? "11" : "00") })) })), /does not verify under the worker's PeerId key/);
  has(run(tampered({ "guest/receipts.jsonl": (t) => t.replace(/"sig":"30/, '"sig":"31') })), /^integrity: runner receipt 1: signature does not verify/);
});

test("dropped worker event breaks the chain", () => {
  has(run(tampered({ "events.jsonl": (t) => t.split("\n").filter((_, i) => i !== 2).join("\n") })), /event 3: chain broken/);
});

test("wrong task binding: not the authorization the client issued, or another authorization swapped in", () => {
  has(run(FIX, { expect: { ...auth, task_id: "0".repeat(32) } }), /is not the one you issued/);
  const other = { ...auth, task: { ...auth.task, prompt: "something else" } };
  has(run(tampered({ "authorization.json": json((a) => ({ ...a, authorization: other })) }), { expect: undefined }), /^integrity: the completion is for authorization .*, not the bundled one/);
});

test("wrong input binding: other inputs in the authorization, or another task's compose labels", () => {
  const inputs = auth.inputs.map((i) => ({ ...i, sha256: sha("other") })), other = { ...auth, inputs, inputs_root: h(inputs) };
  has(run(tampered({ "authorization.json": json((a) => ({ ...a, authorization: other })) }), { expect: undefined }), /the completion is for authorization/);
  has(run(tampered({ "guest/app-compose.json": (t) => t.replace(auth.inputs_root, "0".repeat(64)) })), /the task VM's compose, boot record and the completion disagree/);
});

test("replayed authorization: a second, different execution of an accepted task_id is rejected", () => {
  const r0 = run(FIX);
  has(run(FIX, { seen: [{ task_id: auth.task_id, record: "04" + "ab".repeat(64) }] }), /already has an accepted execution with a different record: this authorization was replayed/);
  assert.deepEqual(run(FIX, { seen: [r0.record] }).failures, DEV, "re-verifying the same execution is not a replay");
});

test("a patch that edits a test file is called out", () => {
  const r = run(tampered({ "outputs/patch.diff": (t) => t + "diff --git a/add.test.mjs b/add.test.mjs\n+++ b/add.test.mjs\n" }));
  assert.match(r.outcome.join("\n"), /INCLUDING TEST FILES: add\.test\.mjs/);
});

test("cancelled task with no check: absent tests are 'no test was requested' under the outcome, not a failure", () => {
  const C = path.join(dir, "fixture-cancelled"), a = JSON.parse(fs.readFileSync(path.join(C, "authorization.json"))).authorization;
  assert.equal(a.task.check, undefined);
  const r = run(C, { expect: a });
  assert.deepEqual(r.failures, DEV);
  assert.match(r.outcome.join("\n"), /no test was requested \(the authorization names no check\), so none ran/);
  assert.ok(r.integrity.some((l) => /status cancelled \(stopped by the client\)/.test(l)));
});

test("a check was authorized but no test.log came back: that is a failure", () => {
  const d = tampered(); fs.rmSync(path.join(d, "outputs/test.log"));
  has(run(d), /^outcome: the authorization asked for `node --test --test-reporter=tap add\.test\.mjs`, but there is no outputs\/test\.log/);
});

test("a recorded bundle from before the settlement field (TUI run, cancelled) is reported, not a crash", () => {
  const B = path.join(dir, "pre-settlement/bundle"), r = run(B, { expect: undefined });
  assert.deepEqual(r.failures.filter((f) => /settlement/.test(f)), ["integrity: completion has no settlement (bundle predates receipt-v1 settlement)"]);
  assert.match(r.outcome.join("\n"), /charged \d+ µ\$ by the worker's usage report, with no settlement record/);
  const out = spawnSync(path.join(import.meta.dirname, "../bin/abalone"), ["verify", B], { encoding: "utf8" });
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stdout, /^abalone verify: REJECTED/);
});

test("settlement consistency: each inconsistency is refused, naming what disagrees", () => {
  const rd = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f))), c0 = rd("completion.json"), offer = rd("offer.json");
  const evs = fs.readFileSync(path.join(FIX, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)), exit = { wall_seconds: 61 };
  const S = (f, e = evs, x = exit) => { const c = structuredClone(c0); f(c); return () => settlement(c, auth, offer, e, x); };
  assert.match(S(() => {})(), /^settlement adds up: reserved 500000 = charged 11499 \+ released 488501/);
  assert.throws(S((c) => { c.settlement.released += 1; }), /charged 11499 \+ released 488502 ≠ reserved 500000/);
  assert.throws(S((c) => { c.settlement.reserved = c.usage.reserved = 400000; }), /is not the authorization's cap 500000/);
  assert.throws(S((c) => { c.usage.inference.charge += 1; }), /execution 10187 \+ inference 1313 µ\$ ≠ charged 11499/);
  assert.throws(S(() => {}, evs.filter((e) => e.data.idem !== `task:${auth.task_id}:exec:2`)), /charge events in events\.jsonl do not add up/);
  assert.throws(S((c) => { c.usage.sponsored = true; }), /not priced by the offer's tariff/);
  assert.throws(S((c) => { c.usage.execution.seconds = 50; }), /execution charge 10187 µ\$ exceeds 50 s × 167/);
  assert.throws(S(() => {}, evs, { wall_seconds: 40 }), /billed 61 s of execution, but the runner measured 40 s/);
  assert.throws(S((c) => { c.settlement.entry = "task:other:settle"; }), /cites no task-settle entry for this task/);
});

// The real runner boot: real receipts and real App Attest. It is a peer boot, so its assertion is guest-requested.
const rec = path.join(dir, "recorded-runner"), ev = JSON.parse(fs.readFileSync(path.join(rec, "attest.json")));
const boot = Buffer.from(ev.bootClientData, "base64"), lines = fs.readFileSync(path.join(rec, "receipts.jsonl"), "utf8").trim().split("\n");
const compose = sha(fs.readFileSync(path.join(rec, "app-compose.json")));

test("recorded runner: 31 real receipts verify under the attested boot's receipt key; a tampered one does not", () => {
  const b = runnerChain(lines, JSON.parse(boot).receipt_pub, compose);
  assert.equal(b.length, 31);
  assert.equal(b[29].tokens_charged, 1589);
  const bad = [...lines]; bad[29] = bad[29].replace('\\"tokens_charged\\":1589', '\\"tokens_charged\\":1');
  assert.throws(() => runnerChain(bad, JSON.parse(boot).receipt_pub, compose), /runner receipt 30: signature does not verify/);
});

test("recorded runner: the Apple chain verifies as of enrollment, and a peer /attest assertion cannot vouch for a task boot", () => {
  // The peer's own /attest output, presented as a task binding: Apple chain, CDHash, peer compose and signature all pass.
  // The recording's own runner build is admitted here, independent of what providers.json currently admits.
  const admit = { ...admitted, macrunner: { ...admitted.macrunner, cdhashes: ["b495dd9011dd0c2ebc52706fc636eee89ced119b6dad4b8f844300ff0e5a9102"], composeHashes: ["624296c23299cb0f99aee75327a2a47b9638416d8851db36aef0b5bc616f4a97"] } };
  const asserted = Buffer.from(ev.assertClientData, "base64");
  assert.throws(() => taskBoot(ev, asserted, admit), /assertion is over a mac-compose-assert\/1 record, not mac-compose-task-boot\/1/);
  assert.throws(() => taskBoot(ev, asserted, { ...admit, macrunner: { ...admit.macrunner, cdhashes: ["00".repeat(32)] } }), /CDHash b495dd9011dd0c2e… is not admitted/);
  assert.throws(() => taskBoot(ev, asserted, { ...admit, macrunner: { ...admit.macrunner, composeHashes: [] } }), /enrolled peer compose 624296c23299… is not admitted/);
});

test("abalone verify in a fresh process prints the three claims and exits 1 on the fixture", () => {
  const r = spawnSync(path.join(import.meta.dirname, "../bin/abalone"), ["verify", FIX, "--expect", path.join(dir, "authorization.json")], { encoding: "utf8" });
  assert.equal(r.status, 1, r.stderr);
  for (const l of ["abalone verify: REJECTED [FIXTURE]", "1. Integrity (signatures and content): holds", "2. An admitted execution produced this record: NOT established",
    "3. Task outcome (evidence, not a proof of correctness): recorded", "Freshness (separate from historical verification)"]) assert.ok(r.stdout.includes(l), `missing "${l}" in\n${r.stdout}`);
});
