// Signed staging admission against the exact service schema, using approval envelopes produced
// by the sibling service's own fixture (published test root — not the measured image root and
// not a staging authority). These are local synthetic results: no hardware, custody, provider
// or chain qualification.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { verifyCouponStagingAdmission, couponStagingApprovalHash, COUPON_STAGING_APPROVAL_DOMAIN } from "../lib/coupon-staging.mjs";
import { canonicalCouponJson } from "../lib/coupon-offer.mjs";

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
    promptPolicy: "synthetic-only", operatorSecretAccess: true, privateIssuanceQualified: false,
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
