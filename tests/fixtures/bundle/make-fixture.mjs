// FIXTURE, not a production run: writes tests/fixtures/bundle/fixture/ in the abalone-task-bundle/1 layout
// (task-v1.md "The bundle"). Simulated: the worker (dev peer-ed25519 completion signature), the runner (a dev P-256
// receipt key, attested:false, guest/attest.json type dev) and the agent (a hand-written one-line fix) and the ledger line the settlement cites. Real: the
// device signature, every hash and chain, and the test run (`node --test` on a two-file repo). `abalone verify` refuses
// claim 2 on it by design. Replace with a bundle collected from a real Track C run once one exists.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { V, h, canonical, completionData, offerId, check } from "../../../lib/contracts/task-v1.mjs";
import { pubHex, sign } from "../../../lib/gift.mjs";

// `make-fixture.mjs cancelled` writes fixture-cancelled/: no check authorized, stopped by the client, so no test.log.
const cancelled = process.argv[2] === "cancelled", status = cancelled ? "cancelled" : "completed", reason = cancelled ? "stopped by the client" : "agent settled";
const B = path.join(import.meta.dirname, cancelled ? "fixture-cancelled" : "fixture"), sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
fs.rmSync(B, { recursive: true, force: true });
const put = (p, x) => { fs.mkdirSync(path.dirname(path.join(B, p)), { recursive: true }); fs.writeFileSync(path.join(B, p), typeof x === "string" || Buffer.isBuffer(x) ? x : JSON.stringify(x, null, 1)); };
const tar = (dir) => spawnSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--format=ustar", "-C", dir, "-cf", "-", "."], { maxBuffer: 1 << 26 }).stdout;

// The task, run for real: a repo with a bug, the fix, the unchanged test.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-fixture-")), repo = path.join(tmp, "repo"), out = path.join(tmp, "out");
fs.mkdirSync(repo); fs.mkdirSync(out);
const files = { "add.mjs": "export const add = (a, b) => a - b;\n", "add.test.mjs": 'import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from \x22./add.mjs\x22;\ntest("add", () => assert.equal(add(2, 3), 5));\n' };
for (const [p, c] of Object.entries(files)) fs.writeFileSync(path.join(repo, p), c);
const inputsTar = tar(repo);
fs.writeFileSync(path.join(repo, "add.mjs"), "export const add = (a, b) => a + b;\n");
const check_ = cancelled ? undefined : "node --test --test-reporter=tap add.test.mjs";
const t = cancelled ? { status: "not run" } : spawnSync("/bin/sh", ["-c", check_], { cwd: repo, encoding: "utf8" });
const patch = spawnSync("diff", ["-u", "--label", "a/add.mjs", "--label", "b/add.mjs", "-", path.join(repo, "add.mjs")], { input: files["add.mjs"] }).stdout.toString();
for (const [p, c] of [["patch.diff", `diff --git a/add.mjs b/add.mjs\n${patch}`], ["files/add.mjs", fs.readFileSync(path.join(repo, "add.mjs"))], ...(cancelled ? [] : [["test.log", `$ ${check_}\n${t.stdout}${t.stderr}\nexit ${t.status}\n`]]), ["finish.json", JSON.stringify({ reason })]]) {
  fs.mkdirSync(path.dirname(path.join(out, p)), { recursive: true }); fs.writeFileSync(path.join(out, p), c);
}
fs.renameSync(out, path.join(tmp, "o")); fs.mkdirSync(out); fs.renameSync(path.join(tmp, "o"), path.join(out, "out"));
const outTar = tar(out);
const OUT = path.join(out, "out");
const outputs = ["files/add.mjs", "finish.json", "patch.diff", ...(cancelled ? [] : ["test.log"])].map((p) => { const d = fs.readFileSync(path.join(OUT, p)); return { path: p, sha256: sha(d), bytes: d.length }; });
for (const o of outputs) put(`outputs/${o.path}`, fs.readFileSync(path.join(OUT, o.path)));
fs.rmSync(tmp, { recursive: true });

const at = 1791600000, ms = at * 1000;
const peerKey = await generateKeyPair("Ed25519"), worker = peerIdFromPrivateKey(peerKey).toString();
const device = crypto.generateKeyPairSync("ed25519");
const offer0 = { v: V, type: "offer", worker: { peer: worker, operator: "independent", label: "FIXTURE worker" }, evidence: { type: "dev" },
  runtime: { image: "docker.io/abalone/task@sha256:830b9921a7d0e176be4e0a54fc0ce644e0d039206604b1112c312f03d1f4ed7e", agent: "pi", tools: ["read", "bash", "edit", "write"] }, resources: [{ id: "small", cpus: 2, mem_mb: 2048, max_seconds: 1800, max_input_bytes: 20971520 }],
  network: { egress: [] }, inference: { route: "peer → runner proxy → NEAR", models: ["z-ai/glm-5.3-flash"], sees_plaintext: ["task guest", "peer", "runner proxy"] }, accepts: ["released", "open"],
  persistence: { continuation: "runs to terminal while the client is away", retention_ms: 86400000, after: "outputs and events deleted" },
  tariff: { version: "t1", execution_per_second: 167, interval_seconds: 15, inference: "NEAR list price × usage", storage: 0, sponsored: false }, expiry: ms + 3600e3 };
const offer = check("offer", { ...offer0, offer_id: offerId(offer0) });
const inputs = Object.entries(files).map(([p, c]) => ({ path: p, sha256: sha(c), bytes: c.length, label: "open" }));
const auth = check("authorization", { v: V, type: "authorization", task_id: "f1c7f1c7f1c7f1c7f1c7f1c7f1c7f1c7", account: sha("FIXTURE account"), device: pubHex(device.privateKey), worker, offer_id: offer.offer_id, tariff_version: "t1",
  task: { prompt: "add() is wrong; fix it without changing the test.", resource: "small", check: check_ }, inputs, inputs_root: h(inputs), model: "z-ai/glm-5.3-flash",
  capabilities: { tools: ["read", "bash", "edit", "write"], egress: [] }, cap: 500000, expires: ms + 3600e3, ts: ms });
const body = { authorization: auth, inputs: Object.entries(files).map(([p, c]) => ({ path: p, b64: Buffer.from(c).toString("base64") })) };
const request = { ts: ms, idem: auth.task_id, body_hash: h(body) };
request.sig = sign(device.privateKey, [V, "commission", auth.task_id, request.ts, request.idem, request.body_hash].join("\n"));

// Charges as lib/task.mjs makes them: execution every 15 s at 167 µ$/s, the remainder at the end, one inference call.
const id = auth.task_id, cap = auth.cap, debits = [[`task:${id}:infer:1`, "inference", 1312], ...[1, 2, 3, 4].map((k) => [`task:${id}:exec:${k}`, "execution", 167 * 15]), [`task:${id}:exec:final`, "execution", 167]];
let charged = 0, prev = "0".repeat(64);
const events = [["state", { state: "booting" }], ["state", { state: "running" }], ["agent", { kind: "assistant", text: "Fixed add(): it subtracted." }],
  ...debits.map(([idem, kind, amount]) => ["charge", { kind, idem, amount, charged: (charged += amount), cap }]), ["state", { state: status, charged, released: cap - charged }]].map(([kind, data], i) => {
  const e = { seq: i + 1, ts: ms + i * 1000, kind, data, prev }; e.hash = h(e); prev = e.hash; return e;
});
const settleLine = { ts: new Date(ms + 62e3).toISOString(), type: "task-settle", account: auth.account, slice: "FIXTURE", idem: `task:${id}:settle`, task: id, reserved: cap, charged, released: cap - charged, debits: debits.map((d) => d[0]) };

// The runner's record of the task VM, with a dev receipt key.
const compose = JSON.stringify({ manifest_version: 2, name: `abalone-task-${auth.task_id}`, runner: "docker-compose", kms_enabled: false,
  docker_compose_file: JSON.stringify({ services: { task: { image: offer.runtime.image, command: ["node", "/abalone/bin/task-guest.mjs"], labels: { "abalone.task_id": auth.task_id, "abalone.auth_hash": h(auth), "abalone.inputs_root": auth.inputs_root } } } }),
  egress: { max_requests: 0, max_tokens: 0, allow: [], tcp: [] }, task: { resource: "small" } });
const runner = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }), jwk = runner.publicKey.export({ format: "jwk" });
const receiptPub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("hex");
const clientData = canonical({ attested: false, compose_hash: sha(compose), domain: "mac-compose-task-boot/1", nonce: sha("FIXTURE nonce"), receipt_pub: receiptPub });
let rprev = "0".repeat(64);
const receipts = [{ event: "task-start", inputs_sha256: sha(inputsTar) }, { event: "attach" }, { event: "detach" }, { event: "exit", exit_code: 0, wall_seconds: 61, out_sha256: sha(outTar), reason: null }].map((e, i) => {
  const b = canonical({ ...e, compose_hash: sha(compose), domain: "mac-compose-receipt/1", seq: i + 1, prev: rprev });
  rprev = sha(b);
  return JSON.stringify({ body: b, sig: crypto.sign("sha256", Buffer.from(b), { key: runner.privateKey, dsaEncoding: "der" }).toString("hex") });
});
put("guest/app-compose.json", compose); put("guest/clientData.bin", clientData); put("guest/attest.json", { type: "dev", bootClientData: Buffer.from(canonical({ attested: false, compose_hash: sha("FIXTURE peer compose"), domain: "mac-compose-boot/1", enrolled_at: at })).toString("base64"), assertClientData: Buffer.from(clientData).toString("base64") });
put("guest/receipts.jsonl", receipts.join("\n") + "\n"); put("guest/out.tar", outTar);

const completion = check("completion", { v: V, type: "completion", task_id: auth.task_id, auth_hash: h(auth), offer_id: offer.offer_id, inputs_root: auth.inputs_root,
  worker: { peer: worker, operator: "independent" }, peer_evidence: { type: "dev" },
  guest: { image: offer.runtime.image, compose_hash: sha(compose), receipts: { count: receipts.length, head: sha(receipts.at(-1)) } },
  status, reason, events: { count: events.length, head: prev }, outputs,
  usage: { tariff_version: "t1", cap, reserved: cap, sponsored: false, execution: { seconds: 61, per_second: 167, charge: 167 * 61 }, inference: { calls: 1, prompt_tokens: 900, completion_tokens: 412, charge: 1312 }, storage: { charge: 0 }, charged, released: cap - charged, settled: true, ledger: [...settleLine.debits, settleLine.idem] },
  settlement: { ledger: `peer ${worker} slice FIXTURE`, entry: settleLine.idem, entry_sha256: sha(JSON.stringify(settleLine)), reserved: cap, charged, released: cap - charged, debits: settleLine.debits },
  retention: { until: ms + 86400e3, delete: "automatic at until" } });
const data = completionData(completion);
put("offer.json", offer); put("authorization.json", { authorization: auth, request }); put("completion.json", completion);
put("completion.sig", { type: "peer-ed25519", peer: worker, data, sig: Buffer.from(await peerKey.sign(Buffer.from(data))).toString("hex") });
put("events.jsonl", events.map((e) => JSON.stringify(e)).join("\n") + "\n");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
put("bundle.json", { v: "abalone-task-bundle/1", task_id: auth.task_id, files: Object.fromEntries(walk(B).map((f) => [path.relative(B, f), sha(fs.readFileSync(f))]).sort()) });
put("FIXTURE", `made by tests/fixtures/bundle/make-fixture.mjs${cancelled ? " cancelled" : ""}: dev worker and runner keys, hand-written fix, simulated ledger line, ${cancelled ? "a cancelled task with no check" : "real test run"}. Not evidence of a production run.\n`);
if (!cancelled) fs.writeFileSync(path.join(import.meta.dirname, "authorization.json"), JSON.stringify(auth));
console.log(`wrote ${B} (tests: exit ${t.status})`);
