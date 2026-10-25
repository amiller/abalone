// Chutes offline: the instance verifier and the E2EE envelope (lib/chutes.mjs) against one recorded live instance
// (tests/fixtures/chutes/attestation.json, from tools/record-chutes-fixture.mjs). Network is cut; Intel PCS and NVIDIA
// fetches are served from the recording. The untouched recording verifies and its recorded sealed reply opens; each
// tampered copy is refused naming the failed check. Intel collateral expires about 30 days after recording.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { test } from "node:test";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { ROOT } from "../lib/config.mjs";

globalThis.fetch = (url) => { throw new Error(`network is cut in this test: ${url}`); };
const { anchor, checkEvidence, open, pick, seal, strip } = await import("../lib/chutes.mjs");
const { verifications } = await import("../lib/status.mjs");
const fx = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/chutes/attestation.json"), "utf8"));
// Exact signed driver/VBIOS collateral, retrieved by public GET; fixture clock remains unchanged.
fx.http.push(...JSON.parse(fs.readFileSync(new URL('./fixtures/chutes/local-rim.json',import.meta.url))).http);
const realNow = Date.now;
Date.now = () => Date.parse(fx.recorded);
const replay = (edit = (r) => r) => async (url, init = {}) => {
  const r = fx.http.find((h) => h.url === String(url) && h.method === (init.method ?? "GET") && (h.request ?? null) === (init.body ?? null));
  if (!r) throw new Error(`no recorded response for ${init.method ?? "GET"} ${url}`);
  const e = edit({ ...r, body: Buffer.from(r.body, "base64") });
  return new Response(e.body, { status: e.status, headers: e.headers });
};
const check = ({ ev = fx.evidence, nonce = fx.nonce, inst = fx.instance, policy = fx.policy, http = replay(), revocation = 'skip' } = {}) => {
 const old=process.env.ABALONE_GPU_REVOCATION;
 if(revocation==='required')delete process.env.ABALONE_GPU_REVOCATION;else process.env.ABALONE_GPU_REVOCATION=revocation;
 return checkEvidence(ev,nonce,inst,policy,http).finally(()=>{if(old===undefined)delete process.env.ABALONE_GPU_REVOCATION;else process.env.ABALONE_GPU_REVOCATION=old;});
};
const b64flip = (s, i) => { const b = Buffer.from(s, "base64"); b[i] ^= 1; return b.toString("base64"); };
const otherKey = Buffer.from(ml_kem768.keygen().publicKey).toString("base64");
const jwksCert = () => JSON.parse(Buffer.from(fx.http.find((h) => h.url.endsWith("/jwks.json")).body, "base64")).keys[0].x5c[0];
test("explicit revocation-skip control: recorded instance verifies locally offline", async () => {
  const p = await check();
  assert.equal(p.instance_id, fx.instance.instance_id);
  assert.deepEqual(p.model_tcb_statuses, ["UpToDate"]);
  assert.match(p.measurement, /^8x\S+ .* v\d+\.\d+\.\d+ \(anchor captured 2026-10-12\)$/);
  assert.match(p.gpu, /^GPU: 8× verified locally/);
  assert.match(p.gpu,/certificate revocation NOT checked/);
  assert.equal(p.gateway_tcb, null);
  const v = verifications([{ type: "custom", customType: "chutes-attestation", timestamp: fx.recorded, data: { ...p, provider: "chutes", model: fx.model } }]);
  assert.deepEqual([v[`chutes/${fx.model}`].flag, v[`chutes/${fx.model}`].brief], ["tcb:up-to-date", "tcb:ok"]);
  const ood = verifications([{ type: "custom", customType: "chutes-attestation", timestamp: fx.recorded, data: { ...p, model_tcb: ["OutOfDate INTEL-SA-1"], provider: "chutes", model: fx.model } }])[`chutes/${fx.model}`];
  assert.deepEqual([ood.flag, ood.brief], ["tcb:out-of-date (1 Intel advisory)", "tcb:ood"]);
});

for (const [name, args, why] of [
  ["a nonce that is not ours", { nonce: "00".repeat(32) }, /report_data does not bind our nonce and this e2e_pubkey/],
  ["another ML-KEM key presented for the instance", { inst: { ...fx.instance, e2e_pubkey: otherKey } }, /report_data does not bind our nonce and this e2e_pubkey/],
  ["a key that is not ML-KEM-768", { inst: { ...fx.instance, e2e_pubkey: Buffer.alloc(32).toString("base64") } }, /not an ML-KEM-768 key/],
  ["another certificate in the evidence", { ev: { ...fx.evidence, certificate: jwksCert() } }, /does not bind the evidence certificate's key/],
  ["quote byte flipped", { ev: { ...fx.evidence, quote: b64flip(fx.evidence.quote, 200) } }, /signature is invalid|Invalid/i],
  ["no GPU evidence", { ev: { ...fx.evidence, gpu_evidence: [] } }, /no GPU evidence/],
  ["GPU architecture absent", {ev:{...fx.evidence,gpu_evidence:fx.evidence.gpu_evidence.map(({arch,...g})=>g)}}, /architecture undefined/],
  ["GPUs of mixed architecture", { ev: { ...fx.evidence, gpu_evidence: fx.evidence.gpu_evidence.map((g, i) => (i ? { ...g, arch: "BLACKWELL" } : g)) } }, /mixed architecture/],
]) test(`refused: ${name}`, async () => { await assert.rejects(check(args), why); });

test("refused: measurements in no anchored row", async () => {
  const rows = anchor.rows, { rtmr3 } = await check();
  anchor.rows = rows.filter((r) => r.rtmr3 !== rtmr3);
  try { await assert.rejects(check(), /match no row of verifiers\/chutes\/chutes_measurements.json/); } finally { anchor.rows = rows; }
});

test("the recorded live reply opens with its one-request key; a flipped byte or another key is refused", () => {
  const blob = Buffer.from(fx.chat.reply, "base64"), sk = Buffer.from(fx.chat.sk, "base64");
  assert.equal(JSON.parse(open(blob, sk)).choices[0].message.content, "abalone-chutes-fixture");
  const bad = Buffer.from(blob); bad[bad.length - 1] ^= 1;
  assert.throws(() => open(bad, sk), /authenticate|auth/i);
  assert.throws(() => open(blob, ml_kem768.keygen().secretKey), /authenticate|auth/i);
});

test("the recorded request on the wire is ciphertext: ML-KEM ct || nonce || sealed gzip, no prompt bytes", () => {
  const blob = Buffer.from(fx.chat.blob, "base64"), prompt = fx.chat.request.messages[0].content;
  assert.ok(!blob.includes(prompt) && !blob.includes(fx.model) && !blob.includes("messages"));
  assert.ok(blob.length > 1088 + 12 + 16);
});

test("seal/open interoperate with an instance following Chutes' scheme (HKDF salt ct[:16], info labels, gzip)", () => {
  const instance = ml_kem768.keygen(), body = { model: "m", messages: [{ role: "user", content: "secret prompt" }], tools: [{ type: "function", function: { name: "t" } }] };
  const { blob, sk } = seal(Buffer.from(instance.publicKey).toString("base64"), body);
  const kdf = (ss, ct, info) => Buffer.from(crypto.hkdfSync("sha256", ss, ct.subarray(0, 16), info, 32));
  const aead = (dir, key, iv, data) => { const c = crypto[dir]("chacha20-poly1305", key, iv, { authTagLength: 16 }); if (dir === "createDecipheriv") { c.setAuthTag(data.subarray(data.length - 16)); return Buffer.concat([c.update(data.subarray(0, data.length - 16)), c.final()]); } return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]); };
  const ct = blob.subarray(0, 1088), got = JSON.parse(zlib.gunzipSync(aead("createDecipheriv", kdf(ml_kem768.decapsulate(ct, instance.secretKey), ct, "e2e-req-v1"), blob.subarray(1088, 1100), blob.subarray(1100))));
  assert.deepEqual({ ...got, e2e_response_pk: undefined }, { ...body, e2e_response_pk: undefined });
  assert.ok(!blob.includes("secret prompt"));
  const enc = ml_kem768.encapsulate(Buffer.from(got.e2e_response_pk, "base64")), iv = crypto.randomBytes(12);
  const reply = Buffer.concat([enc.cipherText, iv, aead("createCipheriv", kdf(enc.sharedSecret, Buffer.from(enc.cipherText), "e2e-resp-v1"), iv, zlib.gzipSync('{"ok":1}'))]);
  assert.equal(open(reply, sk), '{"ok":1}');
});

test("an unknown policy.tcb is refused before any check, not read as \"admit every status\"", async () => {
  for (const tcb of ["reportd", "uptodate", ""]) await assert.rejects(check({ policy: { ...fx.policy, tcb } }), /policy\.tcb .* is not UpToDate or reported/);
  assert.deepEqual((await check({ policy: { ...fx.policy, tcb: "reported" } })).model_tcb_statuses, ["UpToDate"]);
});

test("private-work describes a verified Chutes instance as checked, with its own TCB and no NEAR gateway policy", async () => {
  const { route, verification } = await import("../lib/private-work.mjs");
  const r = route(`chutes/${fx.model}`);
  assert.doesNotMatch(r.text, /gatewayTcb|modelTcb|undefined|out-of-date/);
  assert.match(route("nearai/z-ai/glm-5.3-flash").text, /gatewayTcb "reported", modelTcb "reported"/);
  assert.equal(verification([], r), "remote, NOT verified (no verifier output in this session)");
  const p = await check(), e = { type: "custom", customType: "chutes-attestation", timestamp: fx.recorded, data: { ...p, provider: "chutes", model: fx.model, code: "c" } };
  assert.equal(verification([e], r), `remote, checked by abalone ${fx.recorded} (instance TDX, ${p.gpu}; instance ${p.instance_id.slice(0, 8)} is Chutes' label, not attested), tcb:up-to-date; code: c`);
});

test("the instance id is shown as Chutes' label, not as attested", async () => {
  const p = await check();
  assert.match(p.instance_id_source, /Chutes' label, not attested/);
  assert.match(strip({ ...p, model: fx.model }), new RegExp(`instance ${p.instance_id.slice(0, 8)} \\(Chutes' label\\)`));
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "providers.json"), "utf8")).admitted.find((a) => a.id === "chutes");
  assert.match(cfg.axes.hw, /instance id is Chutes' label, not attested/);
  assert.match(cfg.axes.hw, /unsigned \/servers\/tee\/measurements/);
});

test("a failed verification is not kept: the next listed instance is tried once, then the request is refused", async () => {
  const inst = (n) => ({ instance_id: `i${n}`, e2e_pubkey: "k" }), calls = [];
  const verify = (ok) => async (i) => { calls.push(i.instance_id); if (!ok.includes(i.instance_id)) throw new Error(`✗ refused: Chutes attestation: ${i.instance_id} bad`); return { id: i.instance_id }; };
  const verified = new Map();
  assert.deepEqual(await pick([inst(1), inst(2), inst(3)], verified, verify(["i2"])), [inst(2), { id: "i2" }]);
  assert.deepEqual([calls, [...verified.keys()]], [["i1", "i2"], ["i2k"]]);
  calls.length = 0;
  assert.deepEqual(await pick([inst(1), inst(2)], verified, verify([])), [inst(2), { id: "i2" }]);
  assert.deepEqual(calls, []);
  await assert.rejects(pick([inst(1), inst(3), inst(4)], new Map(), verify(["i4"])), { message: "✗ refused: Chutes attestation: i1 bad; next listed instance: Chutes attestation: i3 bad" });
  assert.deepEqual(calls, ["i1", "i3"]);
  calls.length = 0;
  assert.deepEqual(await pick([inst(1)], verified, verify(["i1"])), [inst(1), { id: "i1" }]);
  assert.deepEqual(calls, ["i1"]);
});

test.after(() => { Date.now = realNow; });

test('default required refuses missing recorded Chutes OCSP instead of silently skipping',async()=>{
 await assert.rejects(check({revocation:'required'}),/no recorded response for POST https:\/\/ocsp.ndis.nvidia.com/);
});
test('signed GPU report nonce tampering refuses even with explicit revocation skip',async()=>{
 const ev=structuredClone(fx.evidence);ev.gpu_evidence[0].evidence=b64flip(ev.gpu_evidence[0].evidence,5);
 await assert.rejects(check({ev}),/nonce|signature/);
});
