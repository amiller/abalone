// Synthetic contract tests only; these never establish Apple hardware admission.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { MAC_ISSUER_PROFILE, MAC_ISSUER_DOMAIN, macIssuerPolicyHash, macIssuerData, macIssuerPossessionMessage,
  createMacCouponIssuerVerifier, createMacCouponIssuerVerifierForTesting } from "../lib/mac-coupon-issuer.mjs";
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const issuer = "MacCouponIssuer00001", recipient = "MacCouponRecipient01", compose = '{"name":"SYNTHETIC MAC CONTRACT ONLY"}';
function fixture(overrides = {}) {
  let now = 1900000000000;
  const pair = crypto.generateKeyPairSync("ed25519"), publicKey = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const policy = { version: 1, profile: MAC_ISSUER_PROFILE, app_id: "DC9JH5DRMY.dev.dsmack.provider", challenge_ttl_ms: 30000,
    max_enrollment_age_seconds: 43200, approved_measurements: [{ cdhash: "ab".repeat(32), compose_sha256: sha(compose) }], custody: "operator-kms-readable" };
  const options = { policy, expectedPolicySha256: macIssuerPolicyHash(policy), expectedIssuancePolicySha256: "cd".repeat(32), now: () => now,
    syntheticRunnerVerifier: async (ev, pin) => { assert.equal(Buffer.from(ev.assertClientData, "base64").toString(), pin.expectData); return { cdhash: policy.approved_measurements[0].cdhash, compose_hash: sha(compose) }; }, ...overrides };
  const verifier = createMacCouponIssuerVerifierForTesting(options);
  const challenge = () => verifier.challenge({ remotePeer: issuer, recipientPeer: recipient, issuerPublicKeyHex: publicKey });
  const evidence = (binding) => ({ domain: MAC_ISSUER_DOMAIN, binding: structuredClone(binding), app_compose: compose,
    possession_signature_hex: crypto.sign(null, macIssuerPossessionMessage(binding), pair.privateKey).toString("hex"),
    runner_evidence: { type: "macrunner", attestation: "AA==", keyId: "AA==", assertion: "AA==",
      bootClientData: Buffer.from(JSON.stringify({ app: "SYNTHETIC-runtime-app", compose_hash: sha(compose) })).toString("base64"),
      assertClientData: Buffer.from(macIssuerData(binding)).toString("base64") } });
  return { options, policy, verifier, challenge, evidence, verify: (e) => verifier.verify(e, { remotePeer: issuer, recipientPeer: recipient }), advance: (ms) => { now += ms; } };
}
test("exact signer/peer/policy binding yields synthetic identity only and is consumed once", async () => {
  const f = fixture(), e = f.evidence(f.challenge());
  const result = await f.verify(e);
  assert.equal(result.evidenceStatus, "synthetic-only-not-hardware"); assert.equal(result.custody, "operator-kms-readable");
  assert.equal(result.privateIssuanceQualified, false); assert.equal(result.rollbackQualified, false);
  assert.equal(result.runtimeApp, "SYNTHETIC-runtime-app"); assert.equal(result.issuancePolicySha256, f.options.expectedIssuancePolicySha256);
  await assert.rejects(f.verify(e), /verification refused/); f.verifier.close();
});
test("changed issuer/recipient/signer/identity/issuance/nonce and unknown fields refuse", async () => {
  for (const change of [ { peer_id: "OtherMacIssuer00001" }, { recipient_peer_id: "OtherRecipient0001" }, { public_key_hex: "ef".repeat(32) },
    { identity_policy_sha256: "ef".repeat(32) }, { issuance_policy_sha256: "ef".repeat(32) }, { challenge_hex: "ef".repeat(32) }, { extra: true } ]) {
    const f = fixture(), e = f.evidence(f.challenge()); Object.assign(e.binding, change);
    await assert.rejects(f.verify(e), /verification refused/); f.verifier.close();
  }
});
test("invalid signature consumes challenge, deadline/close and policy snapshot remain strict", async () => {
  const f = fixture(), e = f.evidence(f.challenge()), valid = structuredClone(e); e.possession_signature_hex = "00".repeat(64);
  await assert.rejects(f.verify(e)); await assert.rejects(f.verify(valid));
  const expired = fixture(), late = expired.evidence(expired.challenge()); expired.advance(30000); await assert.rejects(expired.verify(late));
  const closed = fixture(), ce = closed.evidence(closed.challenge()); closed.verifier.close(); await assert.rejects(closed.verify(ce));
  const snap = fixture(), se = snap.evidence(snap.challenge()); snap.options.expectedIssuancePolicySha256 = "00".repeat(32); assert.equal((await snap.verify(se)).issuancePolicySha256, "cd".repeat(32));
});
test("compose bytes and paired measured code/compose cannot be mixed", async () => {
  const f = fixture(), e = f.evidence(f.challenge()); e.app_compose += " "; await assert.rejects(f.verify(e));
  const swapped = fixture({ syntheticRunnerVerifier: async () => ({ cdhash: "00".repeat(32), compose_hash: sha(compose) }) });
  await assert.rejects(swapped.verify(swapped.evidence(swapped.challenge())));
});
test("malformed/dev/evidence and permissive policy fields refuse; production cannot inject verdict", async () => {
  for (const modify of [(e) => { e.domain = "dsmack-coupon-issuer-identity-v2"; }, (e) => { e.runner_evidence.type = "dev"; },
    (e) => { e.runner_evidence.assertion = "AA"; }, (e) => { e.runner_evidence.extra = true; }, (e) => { e.extra = true; }]) {
    const f = fixture(), e = f.evidence(f.challenge()); modify(e); await assert.rejects(f.verify(e));
  }
  const f = fixture();
  for (const change of [{ custody: "enclave-private" }, { app_id: "different.app" }, { challenge_ttl_ms: 300001 }, { max_enrollment_age_seconds: 43201 }, { version: 2 }, { extra: true }])
    assert.throws(() => macIssuerPolicyHash({ ...f.policy, ...change }));
  assert.throws(() => createMacCouponIssuerVerifier(f.options));
  const genuine = createMacCouponIssuerVerifier({ policy: f.policy, expectedPolicySha256: macIssuerPolicyHash(f.policy), expectedIssuancePolicySha256: "cd".repeat(32) });
  const b = genuine.challenge({ remotePeer: issuer, recipientPeer: recipient, issuerPublicKeyHex: f.challenge().public_key_hex });
  await assert.rejects(genuine.verify(f.evidence(b), { remotePeer: issuer, recipientPeer: recipient })); genuine.close();
});

test("actual Noise issuer/recipient binding and signed runtime app/CDHash admission precede any bearer", { timeout: 15000 }, async () => {
  const { servePeer } = await import("../lib/p2p.mjs");
  const { couponAttestedClientForTesting, COUPON_ISSUER_PROTOCOL, COUPON_ISSUER_FRAME_LIMIT } = await import("../lib/coupon-attested.mjs");
  const { canonicalCouponJson, MAC_COUPON_APPROVAL_DOMAIN } = await import("../lib/coupon-staging.mjs");
  const { syntheticBaseGuard } = await import("./fixtures/coupon/staging-signer.mjs");
  const f = fixture(), pub = f.challenge().public_key_hex, seen = [], root = crypto.generateKeyPairSync("ed25519");
  const info = { version: 2, issuer_public_key_hex: pub, identity_policy_sha256: macIssuerPolicyHash(f.policy), issuance_policy_sha256: "cd".repeat(32) };
  const host = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_ISSUER_PROTOCOL]: { maxDataLength: COUPON_ISSUER_FRAME_LIMIT, handle: async (_lp, send, recv, auth) => {
      const frame = await recv(); seen.push(frame); assert.ok(!Object.hasOwn(frame, "coupon"));
      if (frame.op === "info") return send({ id: frame.id, ok: true, result: info });
      assert.equal(frame.binding.peer_id, auth.localPeer); assert.equal(frame.binding.recipient_peer_id, auth.remotePeer);
      return send({ id: frame.id, ok: true, result: f.evidence(frame.binding) });
    } },
  } });
  const payload = { version: 2, profile: "debug-staging", issuer_profile: MAC_ISSUER_PROFILE, cdhash: "ab".repeat(32), app_id: "SYNTHETIC-runtime-app",
    compose_hash: sha(compose), identity_policy_sha256: info.identity_policy_sha256, issuance_policy_sha256: info.issuance_policy_sha256,
    issuer_public_key_sha256: sha(Buffer.from(pub, "hex")), provider_scope_commitment: "aa".repeat(32), guard: syntheticBaseGuard(),
    powers: ["operator-secret-access", "application-exec", "debugger", "host-clock"], prompt_policy: "synthetic-only", max_coupon_nano_usd: "1000000000",
    max_total_nano_usd: "5000000000", expires_at: "2099-01-01T00:00:00Z", generation: 1 };
  const approval = (changes = {}) => {
    const p = { ...payload, ...changes }, domain = MAC_COUPON_APPROVAL_DOMAIN;
    return { bytes: Buffer.from(canonicalCouponJson({ domain, payload: p, signature_hex: crypto.sign(null, Buffer.from(domain + "\0" + canonicalCouponJson(p)), root.privateKey).toString("hex") })),
      approvalRoot: root.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex") };
  };
  const options = { identityPolicy: f.policy, expectedIdentityPolicySha256: info.identity_policy_sha256, expectedIssuancePolicySha256: info.issuance_policy_sha256,
    expectedIssuerPublicKeySha256: sha(Buffer.from(pub, "hex")), syntheticRunnerVerifier: f.options.syntheticRunnerVerifier, stagingApproval: approval() };
  let client;
  try {
    client = await couponAttestedClientForTesting(String(host.getMultiaddrs()[0]), options);
    assert.equal(client.issuerProfile, MAC_ISSUER_PROFILE); assert.equal(client.identity.evidenceStatus, "synthetic-only-not-hardware");
    assert.equal(client.identity.recipientPeerId, client.localPeer); assert.equal(client.stagingAdmission.appId, payload.app_id);
    for (const change of [{ app_id: "different-runtime-app" }, { cdhash: "00".repeat(32) }, { compose_hash: "00".repeat(32) }])
      await assert.rejects(couponAttestedClientForTesting(String(host.getMultiaddrs()[0]), { ...options, stagingApproval: approval(change) }), { code: "staging_admission_refused" });
    assert.equal(seen.some((frame) => Object.hasOwn(frame, "coupon")), false);
  } finally { await client?.close(); await host.stop(); }
});

test("historical signed runtime app metadata is optional, never a fabricated attested app identity", async () => {
  const f = fixture(), e = f.evidence(f.challenge());
  e.runner_evidence.bootClientData = Buffer.from(JSON.stringify({ compose_hash: sha(compose) })).toString("base64");
  const verdict = await f.verify(e); assert.equal(verdict.runtimeAppAttested, false); assert.equal(Object.hasOwn(verdict, "runtimeApp"), false);
  assert.equal(Object.hasOwn(verdict, "appId"), false); assert.equal(verdict.appleAppId, "DC9JH5DRMY.dev.dsmack.provider");
  const invalid = fixture(), ie = invalid.evidence(invalid.challenge());
  ie.runner_evidence.bootClientData = Buffer.from(JSON.stringify({ app: null, compose_hash: sha(compose) })).toString("base64");
  await assert.rejects(invalid.verify(ie));
});
