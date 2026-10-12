// Client-side verification of the dsmack service's signed staging admission. This mirrors the
// exact schema the service task ships (experiments/coupon_redemption/staging_approval.py);
// it verifies an approval manifest only. The companion config manifest is operator-side and
// carries provider secrets, so recipient code never consumes it. A verified debug-staging
// admission states genuine operator powers; it cannot claim private issuance, rollback
// qualification or settlement approval, and the first private-inference release still
// requires the restrictive target profile.
import crypto from "node:crypto";
import { canonicalCouponJson } from "./coupon-offer.mjs";

export const COUPON_STAGING_APPROVAL_DOMAIN = "dsmack-coupon-staging-approval-v1";
export const MAC_COUPON_APPROVAL_DOMAIN = "dsmack-coupon-mac-approval-v1";
const POWERS = ["operator-secret-access", "application-exec", "debugger", "host-clock"];
// Absent delivery_profile signs the legacy session-only profile; the only explicit value is the durable one.
export const STAGING_DELIVERY_SESSION_ONLY = "x25519-aesgcm-session-only", STAGING_DELIVERY_RECIPIENT_V1 = "x25519-aesgcm-recipient-v1";
const fail = (code = "staging_admission_refused") => Object.assign(new Error(`coupon staging admission: ${code}`), { code });
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const hex = (length) => (value) => typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
// The service's own offer_v2.amount domain, mirrored exactly: a canonical positive uint63
// decimal — [1-9] then at most 18 more digits, and int(value) <= 2**63-1. Zero, leading
// zeros, 20-digit and 19-digit-over-int63 values all refuse under a valid signature.
const amount = (value) => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 2n ** 63n - 1n;
const freeze = (value) => { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
const legacyGuardKeys = ["chain_id", "address", "code_hash", "issuer_address"];
const baseConfirmation = (value) => exact(value, ["version", "profile", "block_tag", "rpc_url", "trust", "l1_finality_verified", "reorg_action"])
  && value.version === 1 && value.profile === "base-mainnet-rpc-safe-debug-v1" && value.block_tag === "safe"
  && value.rpc_url === "https://mainnet.base.org" && value.trust === "configured-rpc"
  && value.l1_finality_verified === false && value.reorg_action === "quarantine-no-retry";
const guardProfile = (guard) => (exact(guard, legacyGuardKeys) && guard.chain_id === 11155111)
  || (exact(guard, [...legacyGuardKeys, "confirmation"]) && guard.chain_id === 8453 && baseConfirmation(guard.confirmation));

// Display only a verified approval's guard. The recipient verifies the signed policy,
// not the chain state that the issuer's separate backend observes.
export function couponStagingGuardNotice(guard) {
  return guard?.chain_id === 8453 && baseConfirmation(guard.confirmation)
    ? "WARNING: Base mainnet issuance trusts the configured RPC at https://mainnet.base.org to report a safe block. The recipient does not independently verify chain state, and Ethereum L1 finality is not independently verified. RPC dishonesty or an Ethereum reorganization can invalidate this report; an earlier provider effect cannot be undone. Freshness also relies on the operator's host clock. Ambiguous issuance is quarantined without automatic retry. This is a bounded synthetic trial, not rollback qualification."
    : "";
}

export function couponStagingApprovalHash(payload) {
  return crypto.createHash("sha256").update(Buffer.concat([Buffer.from(`${payload?.issuer_profile === "mac-appattest-coupon-v1" ? MAC_COUPON_APPROVAL_DOMAIN : COUPON_STAGING_APPROVAL_DOMAIN}\0`, "ascii"),
    Buffer.from(canonicalCouponJson(payload), "ascii")])).digest("hex");
}

// The approval bytes must be exactly the canonical artifact the operator pipe admits; the
// signature is Ed25519 over the domain, a NUL, and the canonical payload, checked against a
// caller-pinned root (hex or raw 32 bytes). Optional pins cross-check the manifest against the
// identity admission this client already verified for the same service.
export function verifyCouponStagingAdmission(bytes, { approvalRoot, identityPolicySha256, issuancePolicySha256, issuerPublicKeySha256, now = Date.now() } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 65_536 || !bytes.every((byte) => byte < 0x80)) throw fail();
  let envelope;
  try { envelope = JSON.parse(bytes.toString("utf8")); } catch { throw fail(); }
  if (!exact(envelope, ["domain", "payload", "signature_hex"]) || ![COUPON_STAGING_APPROVAL_DOMAIN, MAC_COUPON_APPROVAL_DOMAIN].includes(envelope.domain)
      || !hex(128)(envelope.signature_hex) || canonicalCouponJson(envelope) !== bytes.toString("utf8")) throw fail();
  const root = typeof approvalRoot === "string" ? (hex(64)(approvalRoot) ? Buffer.from(approvalRoot, "hex") : undefined) : Buffer.isBuffer(approvalRoot) && approvalRoot.length === 32 ? approvalRoot : undefined;
  if (!root) throw fail();
  const message = Buffer.concat([Buffer.from(`${envelope.domain}\0`, "ascii"), Buffer.from(canonicalCouponJson(envelope.payload), "ascii")]);
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), root]), format: "der", type: "spki" });
  if (!crypto.verify(null, message, key, Buffer.from(envelope.signature_hex, "hex"))) throw fail();
  const payload = envelope.payload;
  const mac = envelope.domain === MAC_COUPON_APPROVAL_DOMAIN;
  const hashes = ["compose_hash", "identity_policy_sha256", "issuance_policy_sha256", "issuer_public_key_sha256", "provider_scope_commitment"];
  const guard = payload?.guard;
  if (!exact(payload, ["version", "profile", "app_id", "compose_hash", "identity_policy_sha256", "issuance_policy_sha256", "issuer_public_key_sha256",
      "provider_scope_commitment", "guard", "powers", "prompt_policy", "max_coupon_nano_usd", "max_total_nano_usd", "expires_at", "generation", ...(mac ? ["issuer_profile", "cdhash"] : []),
      ...(Object.hasOwn(payload ?? {}, "delivery_profile") ? ["delivery_profile"] : [])])
      || (Object.hasOwn(payload, "delivery_profile") && payload.delivery_profile !== STAGING_DELIVERY_RECIPIENT_V1)
      || !(mac ? [2, 3] : [1]).includes(payload.version) || payload.profile !== "debug-staging"
      || (mac ? payload.issuer_profile !== "mac-appattest-coupon-v1" || !hex(64)(payload.cdhash) || typeof payload.app_id !== "string" || !/^[A-Za-z0-9:_./|+-]{1,200}$/.test(payload.app_id) : !hex(40)(payload.app_id)) || !hashes.every((field) => hex(64)(payload[field]))
      || JSON.stringify(payload.powers) !== JSON.stringify(POWERS) || payload.prompt_policy !== "synthetic-only"
      || !Number.isSafeInteger(payload.generation) || payload.generation < 1 || payload.generation > Number.MAX_SAFE_INTEGER
      || !guardProfile(guard)
      || !/^0x[0-9a-f]{64}$/.test(guard.code_hash) || !/^0x[0-9a-f]{40}$/.test(guard.address) || !/^0x[0-9a-f]{40}$/.test(guard.issuer_address)
      || !amount(payload.max_coupon_nano_usd) || !amount(payload.max_total_nano_usd)
      || BigInt(payload.max_coupon_nano_usd) > BigInt(payload.max_total_nano_usd)
      || (guard.chain_id === 8453 && (BigInt(payload.max_coupon_nano_usd) > 5_000_000_000n || BigInt(payload.max_total_nano_usd) > 5_000_000_000n))) throw fail();
  // A schema-valid manifest whose window has closed keeps its own stable code.
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(payload.expires_at)
      || !Number.isFinite(Date.parse(payload.expires_at)) || Date.parse(payload.expires_at) <= now) throw fail("staging_approval_expired");
  for (const [pin, field] of [[identityPolicySha256, "identity_policy_sha256"], [issuancePolicySha256, "issuance_policy_sha256"], [issuerPublicKeySha256, "issuer_public_key_sha256"]])
    if (pin !== undefined && (!hex(64)(pin) || pin !== payload[field])) throw fail();
  // What the manifest states — explicit debug powers — and what it can never state.
  return freeze({ domain: envelope.domain, ...(mac ? { issuerProfile: payload.issuer_profile, cdhash: payload.cdhash } : {}), approval_sha256: couponStagingApprovalHash(payload),
    profile: payload.profile, powers: [...payload.powers], promptPolicy: payload.prompt_policy, deliveryProfile: payload.delivery_profile ?? STAGING_DELIVERY_SESSION_ONLY,
    nativeAuthority: mac && payload.version === 3, operatorSecretAccess: true, privateIssuanceQualified: false, rollbackQualified: false, settlementApproval: false,
    appId: payload.app_id, composeHash: payload.compose_hash, guard: freeze({ ...guard }),
    maxCouponNanoUsd: payload.max_coupon_nano_usd, maxTotalNanoUsd: payload.max_total_nano_usd,
    expiresAtMs: Date.parse(payload.expires_at), generation: payload.generation, payload: freeze(structuredClone(payload)) });
}
