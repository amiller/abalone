// G8 offline: the NEAR verifier (lib/near.mjs checkReport) against one recorded live attestation
// (tests/fixtures/near/nvidia-local-attestation.json, from tools/record-near-fixture.mjs). Network is cut: the global fetch throws,
// and the verifier's fetches (NVIDIA RIM/OCSP, Intel PCS) are served only from the recording. The untouched recording verifies;
// each tampered copy is refused with an error naming the failed check, before any prompt could be encrypted to it.
// Intel collateral expires about 30 days after recording; then the positive control fails and the fixture must be re-recorded.
import crypto from "node:crypto";
import { replayer, recordedOcspNonce } from "./lib/replay-nvidia.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT } from "../lib/config.mjs";

globalThis.fetch = (url) => { throw new Error(`network is cut in this test: ${url}`); };
const { checkReport: realCheckReport } = await import("../lib/near.mjs");
const { tcbFlag } = await import("../lib/status.mjs");
const fx = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/near/nvidia-local-attestation.json"), "utf8"));
// Verify collateral at its recorded time; no live requests.
const originalRevocation=process.env.ABALONE_GPU_REVOCATION;delete process.env.ABALONE_GPU_REVOCATION;
const realNow = Date.now, at = (t) => (Date.now = () => t);
at(Date.parse(fx.recorded));
const replay = replayer(fx);
// Inject only the recorded 32-byte OCSP challenges for this offline recording.
// Responses are still matched byte-for-byte and signatures/nonces remain checked.
async function checkReport(...args) {
  const original = crypto.randomBytes, seen=new Set(), nonces=[], nonceFor=recordedOcspNonce(fx);
  const add=certs=>{for(const cert of certs){if(!seen.has(cert.fingerprint256)){seen.add(cert.fingerprint256);nonces.push(nonceFor(cert));}}};
  const devices=JSON.parse(fx.report.model_attestations[0].nvidia_payload).evidence_list.map(g=>Buffer.from(g.certificate,'base64').toString().match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g).map(p=>new crypto.X509Certificate(p)));
  add(devices[0].slice(1,-1));
  // The verifier starts driver and then VBIOS RIM validation, independent of recording fetch order.
  const rims=fx.http.filter(h=>h.url.includes('/v1/rim/')).sort((a,b)=>a.url.localeCompare(b.url));
  for(const r of rims){const xml=Buffer.from(JSON.parse(Buffer.from(r.body,'base64')).rim,'base64').toString();const certs=[...xml.matchAll(/<(?:\w+:)?X509Certificate[^>]*>([\s\S]*?)<\/(?:\w+:)?X509Certificate>/g)].map(m=>new crypto.X509Certificate(Buffer.from(m[1],'base64')));assert.ok(certs.length);add(certs.slice(0,-1));}
  for(const certs of devices.slice(1))add(certs.slice(1,-1));
  crypto.randomBytes = size => { assert.equal(size,32); assert.ok(nonces.length); return Buffer.from(nonces.shift()); };
  try { return await realCheckReport(...args); } finally { crypto.randomBytes = original; }
}
const check = (rep, http = replay(), nonce = fx.nonce, policy = fx.policy) => checkReport(rep, nonce, fx.baseUrl, fx.model, policy, http);
const copy = (f) => { const r = structuredClone(fx.report); f(r); return r; };
const flipHex = (h, i) => h.slice(0, i) + (h[i] === "0" ? "1" : "0") + h.slice(i + 1);
test("positive: local GPU signatures, RIMs and recorded OCSP verify without NRAS", async () => {
  const v=await check(fx.report);
  assert.match(v.profile.gpu,/verified locally/);assert.equal(v.profile.gpu_revocation,'checked');
  assert.equal(v.profile.model_signing_address,fx.report.model_attestations[0].signing_address);
  assert.equal(tcbFlag(v.profile),'tcb:up-to-date, gw-tcb:out-of-date');
  await v.transport.close();
});
test("default refuses unavailable revocation; no NRAS or implicit skip",async()=>{
  await assert.rejects(check(fx.report,replay(r=>r.url.includes('ocsp.ndis')?{...r,status:503}:r)),/503/);
});
test("explicit skip retains signatures and separately reports unchecked revocation",async()=>{
  const old=process.env.ABALONE_GPU_REVOCATION;process.env.ABALONE_GPU_REVOCATION='skip';
  try { const v=await check(fx.report,replay(r=>{assert.ok(!r.url.includes('ocsp.ndis'));return r;}));assert.equal(v.profile.gpu_revocation,'not checked');assert.match(v.profile.gpu,/revocation NOT checked/);await v.transport.close(); }
  finally { if(old===undefined)delete process.env.ABALONE_GPU_REVOCATION;else process.env.ABALONE_GPU_REVOCATION=old; }
});
test("an unknown gatewayTcb or modelTcb policy value is refused, not read as \"admit every status\"", async () => {
  await assert.rejects(check(fx.report, replay(), fx.nonce, { ...fx.policy, gatewayTcb: "reportd" }), /gateway TCB policy "reportd" is not UpToDate, reported or UpToDate-or-OutOfDate-with-warning/);
  await assert.rejects(check(fx.report, replay(), fx.nonce, { ...fx.policy, modelTcb: "Reported" }), /model TCB policy "Reported" is not/);
});
test("selected coupon profile refuses a gateway TCB the ordinary profile merely reports", async () => {
  await assert.rejects(checkReport(fx.report, fx.nonce, fx.baseUrl, fx.model,
    { gatewayTcb: "UpToDate", modelTcb: "UpToDate", gpuSignature: "required", composeRegistry: { rpc: "https://mainnet.base.org", chainId: 8453 } },
    replay()), /gateway TCB status OutOfDate is not UpToDate/);
});
for (const [name, run, why] of [
  ["a nonce that is not ours", () => check(fx.report, replay(), "00".repeat(32)), /report_data does not carry our nonce/],
  ["gateway without a TLS binding", () => check(copy((r) => delete r.gateway_attestation.tls_cert_fingerprint)), /gateway attestation has no TLS binding/],
  ["gateway TLS key swapped", () => check(copy((r) => (r.gateway_attestation.tls_cert_fingerprint = flipHex(r.gateway_attestation.tls_cert_fingerprint, 0)))), /gateway report_data does not bind its signing address/],
  ["model name changed", () => check(copy((r) => (r.model_attestations[0].model_name = "other/model"))), /model attestation is for other\/model/],
  ["model signing key swapped", () => check(copy((r) => (r.model_attestations[0].signing_public_key = flipHex(r.model_attestations[0].signing_public_key, 10)))), /signing_public_key does not hash to signing_address/],
  ["no model attestation", () => check(copy((r) => (r.model_attestations = []))), /no model attestation/],
  ["model compose not allowed by its DstackApp on Base", () => check(fx.report, replay((r) => (r.request?.includes("eth_call") && JSON.parse(r.request).params[0].to === fx.report.model_attestations[0].info.app_id.replace(/^(?!0x)/, "0x") ? { ...r, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(r.request).id, result: "0x" + "0".repeat(64) })) } : r))), /model compose .* is not allowed by its DstackApp/],
  ["compose registry unreachable", () => check(fx.report, replay((r) => { if (r.request?.includes("eth_chainId")) throw new Error("connect ECONNREFUSED"); return r; })), /compose registry RPC .* is unreachable/],
  ["gateway quote byte flipped", () => check(copy((r) => (r.gateway_attestation.intel_quote = flipHex(r.gateway_attestation.intel_quote, 1000)))), /signature is invalid/],
]) test(`refused: ${name}`, async () => { await assert.rejects(run(), why); });

test("explicit firmware trial still verifies recorded cryptography and warns verified statuses; tampering remains refused", async () => {
  const mode = "UpToDate-or-OutOfDate-with-warning";
  const policy = { gatewayTcb: mode, modelTcb: mode, gpuSignature: "required", composeRegistry: { rpc: "https://mainnet.base.org", chainId: 8453 } };
  const { couponNearAdmissionAdvisories } = await import("../lib/coupon-near.mjs");
  const verified = await checkReport(fx.report, fx.nonce, fx.baseUrl, fx.model, policy, replay());
  try {
    assert.equal(verified.profile.gateway_tcb_status, "OutOfDate");
    assert.ok(verified.profile.model_tcb_statuses.every(s => ["UpToDate", "OutOfDate"].includes(s)));
    assert.ok(couponNearAdmissionAdvisories(verified.profile, policy).every((id) => /^INTEL-SA-\d{5}$/.test(id)));
  } finally { await verified.transport.close(); }
  for (const [rep, nonce, http, failure] of [
    [fx.report, "00".repeat(32), replay(), /nonce/],
    [copy(r => r.gateway_attestation.intel_quote = flipHex(r.gateway_attestation.intel_quote, 1000)), fx.nonce, replay(), /signature is invalid/],
    [copy(r => r.model_attestations[0].signing_public_key = flipHex(r.model_attestations[0].signing_public_key, 10)), fx.nonce, replay(), /does not hash/],
  ]) await assert.rejects(checkReport(rep, nonce, fx.baseUrl, fx.model, policy, http), failure);
});

for (const [label,index,why] of [['nonce',5,/report does not carry our nonce/],['signature',-1,/signature/]]) test(`local signed GPU ${label} tampering refuses in full report admission`,async()=>{
 const rep=copy(r=>{const p=JSON.parse(r.model_attestations[0].nvidia_payload);const b=Buffer.from(p.evidence_list[0].evidence,'base64');b[index<0?b.length+index:index]^=1;p.evidence_list[0].evidence=b.toString('base64');r.model_attestations[0].nvidia_payload=JSON.stringify(p);});
 await assert.rejects(check(rep),why);
});
test.after(()=>{Date.now=realNow;if(originalRevocation===undefined)delete process.env.ABALONE_GPU_REVOCATION;else process.env.ABALONE_GPU_REVOCATION=originalRevocation;});
