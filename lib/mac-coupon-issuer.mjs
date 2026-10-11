// Coupon issuer identity only. App Attest does not qualify owner-resistant custody or rollback.
import crypto from "node:crypto";
import { verifyMacRunner } from "./vendor/macrunner.mjs";
export const MAC_ISSUER_PROFILE = "mac-appattest-coupon-v1";
export const MAC_ISSUER_DOMAIN = "dsmack-coupon-mac-issuer-identity-v1";
const POLICY_DOMAIN = "dsmack-coupon-mac-issuer-policy-v1\0";
const POSSESSION_DOMAIN = "dsmack-coupon-mac-issuer-possession-v1\0";
const APP_ID = "DC9JH5DRMY.dev.dsmack.provider";
const deny = () => new Error("Mac coupon issuer identity verification refused");
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const hex = (v, bytes = 32) => typeof v === "string" && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(v);
const peer = (v) => typeof v === "string" && /^[A-Za-z0-9]{16,128}$/.test(v);
const runtimeApp = (v) => typeof v === "string" && /^[A-Za-z0-9:_./|+-]{1,200}$/.test(v);
const sha = (...parts) => crypto.createHash("sha256").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest("hex");
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}
const json = (v) => JSON.stringify(canonical(v));
function checkedPolicy(v) {
  if (!exact(v, ["version", "profile", "app_id", "challenge_ttl_ms", "max_enrollment_age_seconds", "approved_measurements", "custody"])
      || v.version !== 1 || v.profile !== MAC_ISSUER_PROFILE || v.app_id !== APP_ID || v.custody !== "operator-kms-readable"
      || !Number.isSafeInteger(v.challenge_ttl_ms) || v.challenge_ttl_ms < 1000 || v.challenge_ttl_ms > 300000
      || !Number.isSafeInteger(v.max_enrollment_age_seconds) || v.max_enrollment_age_seconds < 1 || v.max_enrollment_age_seconds > 43200
      || !Array.isArray(v.approved_measurements) || !v.approved_measurements.length || v.approved_measurements.length > 64
      || !v.approved_measurements.every((m) => exact(m, ["cdhash", "compose_sha256"]) && hex(m.cdhash) && hex(m.compose_sha256))) throw deny();
  return structuredClone(v);
}
export function macIssuerPolicyHash(policy) { return sha(POLICY_DOMAIN, json(checkedPolicy(policy))); }
function binding(b) {
  if (!exact(b, ["version", "peer_id", "recipient_peer_id", "public_key_hex", "challenge_hex", "identity_policy_sha256", "issuance_policy_sha256"])
      || b.version !== 1 || !peer(b.peer_id) || !peer(b.recipient_peer_id)
      || ![b.public_key_hex, b.challenge_hex, b.identity_policy_sha256, b.issuance_policy_sha256].every((v) => hex(v))) throw deny();
  return b;
}
export function macIssuerData(value) { return `${MAC_ISSUER_DOMAIN}|${sha(json(binding(value)))}`; }
export function macIssuerPossessionMessage(value) { return Buffer.from(POSSESSION_DOMAIN + macIssuerData(value), "utf8"); }
function evidence(v) {
  if (!exact(v, ["domain", "binding", "runner_evidence", "app_compose", "possession_signature_hex"]) || v.domain !== MAC_ISSUER_DOMAIN
      || !hex(v.possession_signature_hex, 64) || typeof v.app_compose !== "string" || !v.app_compose.length || Buffer.byteLength(v.app_compose) > 131072
      || !exact(v.runner_evidence, ["type", "attestation", "keyId", "bootClientData", "assertion", "assertClientData"]) || v.runner_evidence.type !== "macrunner") throw deny();
  binding(v.binding);
  for (const field of ["attestation", "keyId", "bootClientData", "assertion", "assertClientData"]) {
    const s = v.runner_evidence[field];
    if (typeof s !== "string" || !s.length || s.length > 262144 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s) || Buffer.from(s, "base64").toString("base64") !== s) throw deny();
  }
  return structuredClone(v);
}
function verifier(options, verifyRunner, now, synthetic) {
  const policy = checkedPolicy(options.policy), hash = macIssuerPolicyHash(policy);
  if (!hex(options.expectedPolicySha256) || hash !== options.expectedPolicySha256 || !hex(options.expectedIssuancePolicySha256)) throw deny();
  const pending = new Map(); let closed = false, lastTime = 0;
  const time = () => { const t = now(); if (!Number.isSafeInteger(t) || t < lastTime) throw deny(); lastTime = t; return t; };
  return Object.freeze({
    policySha256: hash,
    challenge({ remotePeer, recipientPeer, issuerPublicKeyHex }) {
      if (closed) throw deny(); const issued = time();
      for (const [id, c] of pending) if (c.expires <= issued) pending.delete(id);
      if (pending.size >= 256) throw deny();
      const b = binding({ version: 1, peer_id: remotePeer, recipient_peer_id: recipientPeer, public_key_hex: issuerPublicKeyHex,
        challenge_hex: crypto.randomBytes(32).toString("hex"), identity_policy_sha256: hash, issuance_policy_sha256: options.expectedIssuancePolicySha256 });
      pending.set(b.challenge_hex, { binding: structuredClone(b), expires: issued + policy.challenge_ttl_ms });
      return Object.freeze(b);
    },
    async verify(value, { remotePeer, recipientPeer }) {
      try {
        if (closed) throw deny(); const ev = evidence(value), b = ev.binding, c = pending.get(b.challenge_hex);
        if (!c || time() >= c.expires || b.peer_id !== remotePeer || b.recipient_peer_id !== recipientPeer || json(b) !== json(c.binding)) throw deny();
        // Consume once before asynchronous work; a failed assertion cannot be replayed.
        pending.delete(b.challenge_hex);
        const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(b.public_key_hex, "hex")]), format: "der", type: "spki" });
        if (!crypto.verify(null, macIssuerPossessionMessage(b), key, Buffer.from(ev.possession_signature_hex, "hex"))) throw deny();
        const enroll = JSON.parse(Buffer.from(ev.runner_evidence.bootClientData, "base64").toString("utf8"));
        if ((Object.hasOwn(enroll, "app") && !runtimeApp(enroll.app)) || enroll.compose_hash !== sha(ev.app_compose)) throw deny();
        const checked = await verifyRunner(ev.runner_evidence, { cdhashes: policy.approved_measurements.map((m) => m.cdhash),
          composeHashes: policy.approved_measurements.map((m) => m.compose_sha256), expectData: macIssuerData(b),
          maxAgeSeconds: policy.max_enrollment_age_seconds, now: new Date(time()) });
        if (closed || time() >= c.expires || !policy.approved_measurements.some((m) => m.cdhash === checked.cdhash && m.compose_sha256 === checked.compose_hash)) throw deny();
        return Object.freeze({ version: 1, scope: "issuer-identity-only", evidenceStatus: synthetic ? "synthetic-only-not-hardware" : "verified-apple-appattest-issuer-identity",
          issuerProfile: MAC_ISSUER_PROFILE, peerId: b.peer_id, recipientPeerId: b.recipient_peer_id, issuerPublicKeyHex: b.public_key_hex,
          policySha256: hash, issuancePolicySha256: b.issuance_policy_sha256, composeSha256: checked.compose_hash, cdhash: checked.cdhash,
          appleAppId: policy.app_id, runtimeAppAttested: Object.hasOwn(enroll, "app"), ...(Object.hasOwn(enroll, "app") ? { runtimeApp: enroll.app } : {}), verifiedAtMs: time(), expiresAtMs: c.expires,
          custody: policy.custody, privateIssuanceQualified: false, rollbackQualified: false });
      } catch { throw deny(); }
    },
    close() { closed = true; pending.clear(); },
  });
}
export function createMacCouponIssuerVerifier(options) {
  if (!exact(options, ["policy", "expectedPolicySha256", "expectedIssuancePolicySha256"])) throw deny();
  return verifier(structuredClone(options), verifyMacRunner, Date.now, false);
}
// Explicit synthetic-only boundary; never emits a hardware-admission success label.
export function createMacCouponIssuerVerifierForTesting({ policy, expectedPolicySha256, expectedIssuancePolicySha256, syntheticRunnerVerifier, now = Date.now }) {
  if (typeof syntheticRunnerVerifier !== "function" || typeof now !== "function") throw deny();
  return verifier(structuredClone({ policy, expectedPolicySha256, expectedIssuancePolicySha256 }), syntheticRunnerVerifier, now, true);
}
