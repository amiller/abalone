// SYNTHETIC ONLY. A local Ed25519 signer for debug-staging approval manifests, so client-side
// tests can drive the signed admission path without borrowing the service's published test root
// (which is not a staging authority either). It signs whatever pins a test chooses and verifies
// nothing about hardware or the measured image: it fabricates no qualification, and a manifest it
// signs can never reach production roots because the recipient pins the root independently.
import crypto from "node:crypto";
import { canonicalCouponJson, COUPON_STAGING_APPROVAL_DOMAIN } from "../../../lib/coupon-staging.mjs";

export const syntheticBaseGuard = () => ({ chain_id: 8453, address: `0x${"11".repeat(20)}`, code_hash: `0x${"22".repeat(32)}`,
  issuer_address: "0x5975c152fe58cdcb7e25586a3c9b994a16dbb615",
  confirmation: { version: 1, profile: "base-mainnet-rpc-safe-debug-v1", block_tag: "safe", rpc_url: "https://mainnet.base.org",
    trust: "configured-rpc", l1_finality_verified: false, reorg_action: "quarantine-no-retry" } });

export function syntheticStagingSigner(rootPair = crypto.generateKeyPairSync("ed25519")) {
  const root = rootPair.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const sign = ({ identityPolicySha256, issuancePolicySha256, issuerPublicKeySha256, providerScopeCommitment,
      maxCouponNanoUsd = "5000000000", maxTotalNanoUsd, expiresAt = "2099-01-01T00:00:00Z", promptPolicy = "synthetic-only", generation = 1, guard, deliveryProfile,
      appId = "05".repeat(20), composeHash = crypto.createHash("sha256").update('{"name":"SYNTHETIC ONLY COUPON CLIENT FIXTURE","services":{}}').digest("hex") } = {}) => {
    const payload = { version: 1, profile: "debug-staging", app_id: appId, compose_hash: composeHash,
      identity_policy_sha256: identityPolicySha256, issuance_policy_sha256: issuancePolicySha256, issuer_public_key_sha256: issuerPublicKeySha256,
      provider_scope_commitment: providerScopeCommitment,
      guard: guard ?? { chain_id: 11155111, address: "0x1111111111111111111111111111111111111111", code_hash: `0x${"22".repeat(32)}`, issuer_address: "0x5975c152fe58cdcb7e25586a3c9b994a16dbb615" },
      powers: ["operator-secret-access", "application-exec", "debugger", "host-clock"], prompt_policy: promptPolicy,
      max_coupon_nano_usd: maxCouponNanoUsd, max_total_nano_usd: maxTotalNanoUsd ?? maxCouponNanoUsd, expires_at: expiresAt, generation,
      ...(deliveryProfile === undefined ? {} : { delivery_profile: deliveryProfile }) };
    const message = Buffer.concat([Buffer.from(`${COUPON_STAGING_APPROVAL_DOMAIN}\0`, "ascii"), Buffer.from(canonicalCouponJson(payload), "ascii")]);
    const envelope = { domain: COUPON_STAGING_APPROVAL_DOMAIN, payload, signature_hex: crypto.sign(null, message, rootPair.privateKey).toString("hex") };
    return { bytes: Buffer.from(canonicalCouponJson(envelope), "utf8"), rootHex: root.toString("hex") };
  };
  return { sign, rootHex: root.toString("hex") };
}
