// G8 offline: the NEAR verifier (lib/near.mjs checkReport) against one recorded live attestation
// (tests/fixtures/near/attestation.json, from tools/record-near-fixture.mjs). Network is cut: the global fetch throws,
// and the verifier's fetches (NRAS, Intel PCS) are served only from the recording. The untouched recording verifies;
// each tampered copy is refused with an error naming the failed check, before any prompt could be encrypted to it.
// Intel collateral expires about 30 days after recording; then the positive control fails and the fixture must be re-recorded.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { ROOT } from "../lib/config.mjs";

globalThis.fetch = (url) => { throw new Error(`network is cut in this test: ${url}`); };
const { checkReport } = await import("../lib/near.mjs");
const { tcbFlag } = await import("../lib/status.mjs");
const fx = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/near/attestation.json"), "utf8"));
// The NRAS token lives an hour: the verifier's clock is the recording's (a test moves it to show expiry is refused).
const realNow = Date.now, at = (t) => (Date.now = () => t);
at(Date.parse(fx.recorded));
const replay = (edit = (r) => r) => async (url, init = {}) => {
  const r = fx.http.find((h) => h.url === String(url) && h.method === (init.method ?? "GET") && (h.request ?? null) === (init.body ?? null));
  if (!r) throw new Error(`no recorded response for ${init.method ?? "GET"} ${url}`);
  const e = edit({ ...r, body: Buffer.from(r.body, "base64") });
  return new Response(e.body, { status: e.status, headers: e.headers });
};
const check = (rep, http = replay(), nonce = fx.nonce, policy = fx.policy) => checkReport(rep, nonce, fx.baseUrl, fx.model, policy, http);
const copy = (f) => { const r = structuredClone(fx.report); f(r); return r; };
const flipHex = (h, i) => h.slice(0, i) + (h[i] === "0" ? "1" : "0") + h.slice(i + 1);
const nrasFalse = (r) => {
  if (!r.url.includes("/attest/gpu")) return r;
  const j = JSON.parse(r.body), [h, p, s] = j[0][1].split(".");
  j[0][1] = [h, Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url")), "x-nvidia-overall-att-result": false })).toString("base64url"), s].join(".");
  return { ...r, body: JSON.stringify(j) };
};

test("positive control: the recording verifies offline, the NRAS token's signature included", async () => {
  const v = await check(fx.report);
  assert.equal(v.profile.model_signing_address, fx.report.model_attestations[0].signing_address);
  assert.equal(v.profile.gpu, "GPU: NVIDIA verdict (signature checked)");
  assert.equal(tcbFlag(v.profile), "tcb:up-to-date, gw-tcb:out-of-date", "the recorded gateway is OutOfDate, its model TEE UpToDate");
});
test("NVIDIA's JWKS unreachable: the verdict is shown as not checked, with the reason, never as checked", async () => {
  const v = await check(fx.report, replay((r) => (r.url.endsWith("/jwks.json") ? { ...r, status: 503 } : r)));
  assert.equal(v.profile.gpu, "GPU: NVIDIA verdict (signature not checked: https://nras.attestation.nvidia.com JWKS: HTTP 503)");
});
test("selected coupon profile requires NVIDIA signature even when the ordinary profile reports unavailable JWKS", async () => {
  await assert.rejects(checkReport(fx.report, fx.nonce, fx.baseUrl, fx.model, { ...fx.policy, gpuSignature: "required" },
    replay((r) => (r.url.endsWith("/jwks.json") ? { ...r, status: 503 } : r))), /NVIDIA verdict signature is required/);
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
const nrasToken = (f) => (r) => { if (!r.url.includes("/attest/gpu")) return r; const j = JSON.parse(r.body); j[0][1] = f(j[0][1].split(".")).join("."); return { ...r, body: JSON.stringify(j) }; };
const claims = (edit) => nrasToken(([h, p, s]) => [h, Buffer.from(JSON.stringify(edit(JSON.parse(Buffer.from(p, "base64url"))))).toString("base64url"), s]);
for (const [name, run, why] of [
  ["a nonce that is not ours", () => check(fx.report, replay(), "00".repeat(32)), /report_data does not carry our nonce/],
  ["gateway without a TLS binding", () => check(copy((r) => delete r.gateway_attestation.tls_cert_fingerprint)), /gateway attestation has no TLS binding/],
  ["gateway TLS key swapped", () => check(copy((r) => (r.gateway_attestation.tls_cert_fingerprint = flipHex(r.gateway_attestation.tls_cert_fingerprint, 0)))), /gateway report_data does not bind its signing address/],
  ["model name changed", () => check(copy((r) => (r.model_attestations[0].model_name = "other/model"))), /model attestation is for other\/model/],
  ["model signing key swapped", () => check(copy((r) => (r.model_attestations[0].signing_public_key = flipHex(r.model_attestations[0].signing_public_key, 10)))), /signing_public_key does not hash to signing_address/],
  ["no model attestation", () => check(copy((r) => (r.model_attestations = []))), /no model attestation/],
  ["NRAS verdict false (a tampered token)", () => check(fx.report, replay(nrasFalse)), /NRAS token signature does not verify/],
  ["NRAS token signature byte flipped", () => check(fx.report, replay(nrasToken(([h, p, s]) => [h, p, Buffer.from(Buffer.from(s, "base64url").map((b, i) => (i === 5 ? b ^ 1 : b))).toString("base64url")]))), /NRAS token signature does not verify/],
  ["NRAS token naming a key NVIDIA's JWKS lacks", () => check(fx.report, replay(nrasToken(([h, p, s]) => [Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(h, "base64url")), kid: "nv-eat-kid-forged" })).toString("base64url"), p, s]))), /key nv-eat-kid-forged is not in NVIDIA's JWKS/],
  ["NRAS token with alg none", () => check(fx.report, replay(nrasToken(([h, p, s]) => [Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(h, "base64url")), alg: "none" })).toString("base64url"), p, s]))), /algorithm none is not ES384/],
  ["NRAS token from another issuer", () => check(fx.report, replay(claims((c) => ({ ...c, iss: "https://evil.example" })))), /issuer https:\/\/evil.example/],
  ["NRAS token expired", async () => { at(Date.parse(fx.recorded) + 2 * 3600e3); try { return await check(fx.report); } finally { at(Date.parse(fx.recorded)); } }, /NRAS token is not valid now/],
  ["NRAS unavailable", () => check(fx.report, replay((r) => (r.url.includes("nras") ? { ...r, status: 503 } : r))), /NVIDIA NRAS answered HTTP 503/],
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
    [fx.report, fx.nonce, replay(nrasFalse), /NRAS token signature/],
    [fx.report, fx.nonce, replay(r => r.url.endsWith("/jwks.json") ? { ...r, status: 503 } : r), /signature is required/],
  ]) await assert.rejects(checkReport(rep, nonce, fx.baseUrl, fx.model, policy, http), failure);
});
