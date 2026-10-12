// Signed staging admission against the exact service schema, using approval envelopes produced
// by the sibling service's own fixture (published test root — not the measured image root and
// not a staging authority). These are local synthetic results: no hardware, custody, provider
// or chain qualification.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { canonicalCouponJson, verifyCouponStagingAdmission, couponStagingApprovalHash, COUPON_STAGING_APPROVAL_DOMAIN, couponStagingGuardNotice } from "../lib/coupon-staging.mjs";
import { syntheticBaseGuard } from "./fixtures/coupon/staging-signer.mjs";

const dir = new URL("fixtures/coupon/staging/", import.meta.url);
const meta = JSON.parse(fs.readFileSync(new URL("meta.json", dir), "utf8"));
const approval = (name) => fs.readFileSync(new URL(`${name}/approval.json`, dir));
const root = meta.test_root_public_key_hex;

// The published test root is the public key of the service fixture's documented seed
// (0x99 x32, test_live_fixture.py); importing that seed lets budget-domain cases run
// under genuinely valid signatures instead of byte tampering.
const seedKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 0x99)]), format: "der", type: "pkcs8" });
const signedApproval = (changes) => {
  const payload = { ...JSON.parse(approval("valid").toString("utf8")).payload, ...changes };
  const message = Buffer.concat([Buffer.from(`${COUPON_STAGING_APPROVAL_DOMAIN}\0`, "ascii"), Buffer.from(canonicalCouponJson(payload), "ascii")]);
  const envelope = { domain: COUPON_STAGING_APPROVAL_DOMAIN, payload, signature_hex: crypto.sign(null, message, seedKey).toString("hex") };
  return Buffer.from(canonicalCouponJson(envelope), "ascii");
};

test("the service's signed approval verifies against the pinned test root with explicit debug powers", () => {
  const bytes = approval("valid");
  const verdict = verifyCouponStagingAdmission(bytes, { approvalRoot: root });
  const payload = JSON.parse(bytes.toString("utf8")).payload;
  assert.deepEqual(verdict, { domain: COUPON_STAGING_APPROVAL_DOMAIN, approval_sha256: meta.valid.approval_sha256,
    profile: "debug-staging", powers: ["operator-secret-access", "application-exec", "debugger", "host-clock"],
    promptPolicy: "synthetic-only", deliveryProfile: "x25519-aesgcm-session-only", nativeAuthority: false, operatorSecretAccess: true, privateIssuanceQualified: false,
    rollbackQualified: false, settlementApproval: false, appId: payload.app_id, composeHash: payload.compose_hash,
    guard: payload.guard, maxCouponNanoUsd: payload.max_coupon_nano_usd, maxTotalNanoUsd: payload.max_total_nano_usd,
    expiresAtMs: Date.parse(payload.expires_at), generation: payload.generation, payload });
  assert.equal(verdict.approval_sha256, couponStagingApprovalHash(payload));
  assert.ok(Object.isFrozen(verdict) && Object.isFrozen(verdict.payload) && Object.isFrozen(verdict.guard));
  // The same pinned root accepts a raw 32-byte key, and identity pins cross-check the manifest.
  assert.equal(verifyCouponStagingAdmission(bytes, { approvalRoot: Buffer.from(root, "hex"), now: Date.parse("2026-10-10T00:00:00Z") }).approval_sha256, meta.valid.approval_sha256);
  for (const pin of ["identityPolicySha256", "issuancePolicySha256", "issuerPublicKeySha256"]) {
    const pins = { [pin]: payload[pin === "identityPolicySha256" ? "identity_policy_sha256" : pin === "issuancePolicySha256" ? "issuance_policy_sha256" : "issuer_public_key_sha256"] };
    assert.equal(verifyCouponStagingAdmission(bytes, { approvalRoot: root, ...pins }).profile, "debug-staging");
    assert.throws(() => verifyCouponStagingAdmission(bytes, { approvalRoot: root, ...pins, [pin]: "00".repeat(32) }), /staging_admission_refused/);
  }
});

test("expired, altered-powers, production-profile and non-approval manifests refuse", () => {
  assert.throws(() => verifyCouponStagingAdmission(approval("expired"), { approvalRoot: root }), { code: "staging_approval_expired" });
  assert.throws(() => verifyCouponStagingAdmission(approval("powers-dropped"), { approvalRoot: root }), /staging_admission_refused/);
  assert.throws(() => verifyCouponStagingAdmission(approval("profile-production"), { approvalRoot: root }), /staging_admission_refused/);
  // The operator-side config manifest is a different domain and never verifies as an approval.
  assert.throws(() => verifyCouponStagingAdmission(fs.readFileSync(new URL("valid/config.json", dir)), { approvalRoot: root }), /staging_admission_refused/);
  // Each variant still hashes to exactly what the service computed for its own signature.
  for (const variant of meta.variants) assert.equal(couponStagingApprovalHash(JSON.parse(approval(variant.name).toString("utf8")).payload), variant.approval_sha256);
});

test("budget fields mirror the service's positive int63 decimal domain under valid signatures", () => {
  // The local signer reproduces the service's own signature over the unchanged payload…
  assert.equal(verifyCouponStagingAdmission(signedApproval({}), { approvalRoot: root }).approval_sha256, meta.valid.approval_sha256);
  // …so changed-field variants are refused by the schema, never by the signature check.
  const max = "9223372036854775807"; // 2**63 - 1: the service's largest admitted amount
  const verdict = verifyCouponStagingAdmission(signedApproval({ max_coupon_nano_usd: "1", max_total_nano_usd: max }), { approvalRoot: root });
  assert.equal(verdict.maxCouponNanoUsd, "1");
  assert.equal(verdict.maxTotalNanoUsd, max);
  for (const [field, value] of [["max_coupon_nano_usd", "0"], ["max_total_nano_usd", "0"],
    ["max_coupon_nano_usd", "01"], ["max_total_nano_usd", "09223372036854775807"],
    ["max_coupon_nano_usd", "9223372036854775808"], ["max_total_nano_usd", "9223372036854775808"],
    ["max_coupon_nano_usd", "9999999999999999999"], ["max_total_nano_usd", "10000000000000000000"]])
    assert.throws(() => verifyCouponStagingAdmission(signedApproval({ [field]: value }), { approvalRoot: root }), { code: "staging_admission_refused" }, `${field}=${value}`);
});

test("tampered bytes, wrong roots and non-canonical encodings refuse", () => {
  const bytes = approval("valid").toString("utf8");
  const flip = (text, from, to) => { const at = text.lastIndexOf(from); assert.ok(at > 0); return Buffer.from(text.slice(0, at) + to + text.slice(at + from.length), "utf8"); };
  assert.throws(() => verifyCouponStagingAdmission(flip(bytes, `"generation":1`, `"generation":2`), { approvalRoot: root }), /staging_admission_refused/);
  assert.throws(() => verifyCouponStagingAdmission(flip(bytes, `"profile":"debug-staging"`, `"profile":"debug-staginx"`), { approvalRoot: root }), /staging_admission_refused/);
  const signatureAt = bytes.lastIndexOf(`"signature_hex":"`);
  const tampered = bytes.slice(0, signatureAt + 17) + (bytes[signatureAt + 17] === "0" ? "1" : "0") + bytes.slice(signatureAt + 18);
  assert.throws(() => verifyCouponStagingAdmission(Buffer.from(tampered, "utf8"), { approvalRoot: root }), /staging_admission_refused/);
  assert.throws(() => verifyCouponStagingAdmission(approval("valid"), { approvalRoot: "11".repeat(32) }), /staging_admission_refused/);
  assert.throws(() => verifyCouponStagingAdmission(approval("valid"), { approvalRoot: crypto.randomBytes(32) }), /staging_admission_refused/);
  const envelope = JSON.parse(bytes);
  assert.throws(() => verifyCouponStagingAdmission(Buffer.from(JSON.stringify({ payload: envelope.payload, domain: envelope.domain, signature_hex: envelope.signature_hex })), { approvalRoot: root }), /staging_admission_refused/);
  for (const bad of [undefined, "not-hex", Buffer.from("00")]) assert.throws(() => verifyCouponStagingAdmission(approval("valid"), { approvalRoot: bad }), /staging_admission_refused/);
  assert.throws(() => verifyCouponStagingAdmission(Buffer.from([0xff, 0xfe])), /staging_admission_refused/);
  assert.throws(() => verifyCouponStagingAdmission(approval("valid"), { approvalRoot: root, now: Date.parse("2100-01-01T00:00:00Z") }), { code: "staging_approval_expired" });
});

test("Base mainnet requires the exact signed RPC-safe debug profile and $5 bounds; legacy stays unchanged", () => {
  const guard = syntheticBaseGuard();
  const verdict = verifyCouponStagingAdmission(signedApproval({ guard }), { approvalRoot: root });
  assert.deepEqual(verdict.guard, guard);
  assert.equal(verdict.rollbackQualified, false);
  assert.ok(Object.isFrozen(verdict.guard.confirmation));
  const notice = couponStagingGuardNotice(verdict.guard);
  assert.match(notice, /configured RPC.*safe block/);
  assert.match(notice, /recipient does not independently verify chain state/);
  assert.match(notice, /Ethereum L1 finality is not independently verified/);
  assert.match(notice, /earlier provider effect cannot be undone/);
  assert.match(notice, /host clock/);
  assert.equal(couponStagingGuardNotice(verifyCouponStagingAdmission(approval("valid"), { approvalRoot: root }).guard), "");
  const invalid = [
    { ...guard, chain_id: 84532 }, { ...guard, chain_id: "8453" }, { ...guard, chain_id: 11155111 },
    Object.fromEntries(Object.entries(guard).filter(([k]) => k !== "confirmation")), { ...guard, extra: true },
    ...Object.keys(guard.confirmation).map((field) => ({ ...guard, confirmation: Object.fromEntries(Object.entries(guard.confirmation).filter(([k]) => k !== field)) })),
    ...Object.entries({ version: 2, profile: "base-mainnet-finalized", block_tag: "latest", rpc_url: "https://evil.invalid",
      trust: "independent-proof", l1_finality_verified: true, reorg_action: "retry" }).map(([field, value]) => ({ ...guard, confirmation: { ...guard.confirmation, [field]: value } })),
    { ...guard, confirmation: { ...guard.confirmation, extra: true } },
  ];
  for (const changed of invalid) assert.throws(() => verifyCouponStagingAdmission(signedApproval({ guard: changed }), { approvalRoot: root }), { code: "staging_admission_refused" });
  for (const budgets of [{ max_coupon_nano_usd: "5000000001", max_total_nano_usd: "5000000001" }, { max_total_nano_usd: "5000000001" }])
    assert.throws(() => verifyCouponStagingAdmission(signedApproval({ guard, ...budgets }), { approvalRoot: root }), { code: "staging_admission_refused" });
  const unsignedChange = JSON.parse(approval("valid")); unsignedChange.payload.guard = guard;
  assert.throws(() => verifyCouponStagingAdmission(Buffer.from(canonicalCouponJson(unsignedChange)), { approvalRoot: root }), { code: "staging_admission_refused" });
});

// Separate Mac approval cannot be interpreted as a TDX approval under either signature domain.
test("Mac approval binds runtime app/CDHash and retains all debug caps and guard disclosure", async () => {
  const { MAC_COUPON_APPROVAL_DOMAIN } = await import("../lib/coupon-staging.mjs");
  const original = JSON.parse(approval("valid")).payload;
  const payload = { ...original, version: 2, issuer_profile: "mac-appattest-coupon-v1", app_id: "SYNTHETIC-runtime-app", cdhash: "ab".repeat(32), guard: syntheticBaseGuard() };
  const sign = (p, domain = MAC_COUPON_APPROVAL_DOMAIN) => Buffer.from(canonicalCouponJson({ domain, payload: p, signature_hex: crypto.sign(null, Buffer.concat([Buffer.from(domain + "\0"), Buffer.from(canonicalCouponJson(p))]), seedKey).toString("hex") }));
  const verdict = verifyCouponStagingAdmission(sign(payload), { approvalRoot: root });
  assert.equal(verdict.appId, payload.app_id); assert.equal(verdict.cdhash, payload.cdhash);
  assert.equal(verdict.issuerProfile, payload.issuer_profile); assert.equal(verdict.privateIssuanceQualified, false);
  assert.equal(verdict.approval_sha256, couponStagingApprovalHash(payload));
  for (const change of [{ version: 1 }, { issuer_profile: "dstack-tdx-coupon-v1" }, { cdhash: "00" }, { app_id: "bad app" }, { max_total_nano_usd: "5000000001" }, { powers: [] }])
    assert.throws(() => verifyCouponStagingAdmission(sign({ ...payload, ...change }), { approvalRoot: root }));
  assert.throws(() => verifyCouponStagingAdmission(sign(payload, COUPON_STAGING_APPROVAL_DOMAIN), { approvalRoot: root }));
  assert.throws(() => verifyCouponStagingAdmission(sign(original), { approvalRoot: root }));
});

// Producer → consumer: the dsmack service's own durable approval vector (tests/fixtures/coupon/durable/PROVENANCE.json).
const durableDir = new URL("fixtures/coupon/durable/", import.meta.url);
const durable = JSON.parse(fs.readFileSync(new URL("staging-approval-recipient-v1-vector.json", durableDir), "utf8"));
const RECIPIENT_V1 = "x25519-aesgcm-recipient-v1";

test("service-produced durable approval verifies with its explicit recipient-v1 profile and distinct hash; refused variants refuse", () => {
  const provenance = JSON.parse(fs.readFileSync(new URL("PROVENANCE.json", durableDir), "utf8"));
  for (const [name, file] of Object.entries(provenance.files)) assert.equal(crypto.createHash("sha256").update(fs.readFileSync(new URL(name, durableDir))).digest("hex"), file.sha256, name);
  assert.equal(durable.authority_public_key_hex, root, "same published test root");
  const verdict = verifyCouponStagingAdmission(Buffer.from(durable.approval.envelope, "utf8"), { approvalRoot: durable.authority_public_key_hex });
  assert.equal(verdict.deliveryProfile, RECIPIENT_V1);
  assert.equal(verdict.approval_sha256, durable.approval.sha256);
  assert.deepEqual(verdict.payload, durable.approval.payload);
  const { delivery_profile: _profile, ...legacyPayload } = durable.approval.payload;
  assert.equal(couponStagingApprovalHash(legacyPayload), durable.legacy_approval_sha256, "absence is the legacy approval");
  assert.notEqual(durable.approval.sha256, durable.legacy_approval_sha256);
  assert.equal(verifyCouponStagingAdmission(approval("valid"), { approvalRoot: root }).deliveryProfile, "x25519-aesgcm-session-only");
  for (const refused of durable.refused) assert.throws(() => verifyCouponStagingAdmission(Buffer.from(refused.envelope, "utf8"), { approvalRoot: root }), { code: "staging_admission_refused" }, refused.name);
  assert.throws(() => verifyCouponStagingAdmission(Buffer.from(durable.config.envelope, "utf8"), { approvalRoot: root }), { code: "staging_admission_refused" }, "operator config never verifies as an approval");
  const unsigned = JSON.parse(durable.approval.envelope); unsigned.payload.delivery_profile = "x25519-aesgcm-session-only";
  assert.throws(() => verifyCouponStagingAdmission(Buffer.from(canonicalCouponJson(unsigned)), { approvalRoot: root }), { code: "staging_admission_refused" });
  assert.throws(() => verifyCouponStagingAdmission(Buffer.from(durable.approval.envelope, "utf8"), { approvalRoot: "11".repeat(32) }), { code: "staging_admission_refused" });
  for (const pin of ["identityPolicySha256", "issuancePolicySha256", "issuerPublicKeySha256"])
    assert.throws(() => verifyCouponStagingAdmission(Buffer.from(durable.approval.envelope, "utf8"), { approvalRoot: root, [pin]: "00".repeat(32) }), { code: "staging_admission_refused" });
});

test("the optional profile field is strict on both approval domains under valid signatures", async () => {
  const { MAC_COUPON_APPROVAL_DOMAIN } = await import("../lib/coupon-staging.mjs");
  const sign = (payload, domain) => Buffer.from(canonicalCouponJson({ domain, payload, signature_hex: crypto.sign(null, Buffer.concat([Buffer.from(domain + "\0"), Buffer.from(canonicalCouponJson(payload))]), seedKey).toString("hex") }));
  const tdx = durable.approval.payload;
  const { delivery_profile: _p, ...base } = tdx;
  const mac = { ...base, version: 2, issuer_profile: "mac-appattest-coupon-v1", app_id: "SYNTHETIC-runtime-app", cdhash: "ab".repeat(32) };
  for (const [payload, domain] of [[base, COUPON_STAGING_APPROVAL_DOMAIN], [mac, MAC_COUPON_APPROVAL_DOMAIN]]) {
    assert.equal(verifyCouponStagingAdmission(sign(payload, domain), { approvalRoot: root }).deliveryProfile, "x25519-aesgcm-session-only");
    const selected = verifyCouponStagingAdmission(sign({ ...payload, delivery_profile: RECIPIENT_V1 }, domain), { approvalRoot: root });
    assert.equal(selected.deliveryProfile, RECIPIENT_V1);
    assert.notEqual(selected.approval_sha256, couponStagingApprovalHash(payload));
    for (const value of ["x25519-aesgcm-session-only", "x25519-aesgcm-recipient-v2", "", null, 1, ["x25519-aesgcm-recipient-v1"]])
      assert.throws(() => verifyCouponStagingAdmission(sign({ ...payload, delivery_profile: value }, domain), { approvalRoot: root }), { code: "staging_admission_refused" }, `${domain} ${JSON.stringify(value)}`);
    assert.throws(() => verifyCouponStagingAdmission(sign({ ...payload, delivery_profile: RECIPIENT_V1, retention: "durable" }, domain), { approvalRoot: root }), { code: "staging_admission_refused" });
    assert.throws(() => verifyCouponStagingAdmission(sign({ ...payload, delivery_profile: RECIPIENT_V1 }, domain === MAC_COUPON_APPROVAL_DOMAIN ? COUPON_STAGING_APPROVAL_DOMAIN : MAC_COUPON_APPROVAL_DOMAIN), { approvalRoot: root }), { code: "staging_admission_refused" });
  }
});
