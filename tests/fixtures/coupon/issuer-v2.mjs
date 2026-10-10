// SYNTHETIC ONLY. These reports are JSON, never Intel quotes or release policy.
import crypto from "node:crypto";
import { issuerPolicyHash, issuerReportData, issuerPossessionMessage } from "../../../lib/vendor/dstack-issuer/dstack_issuer.mjs";

const hash = (kind, data) => crypto.createHash(kind).update(data).digest();
export function syntheticIssuerIdentity(pair = crypto.generateKeyPairSync("ed25519"), ttlMs = 30_000) {
  const compose = '{"name":"SYNTHETIC ONLY COUPON CLIENT FIXTURE","services":{}}';
  const policy = { version: 2, challenge_ttl_ms: ttlMs, approved_measurements: [{ compose_sha256: hash("sha256", compose).toString("hex"),
    mr_td: "01".repeat(48), rtmr0: "02".repeat(48), rtmr1: "03".repeat(48), rtmr2: "04".repeat(48),
    runtime_events: { "app-id": "05".repeat(20), "key-provider": "06".repeat(32), "os-image-hash": "07".repeat(32) } }] };
  const publicKeyHex = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const info = { version: 2, issuer_public_key_hex: publicKeyHex, identity_policy_sha256: issuerPolicyHash(policy), issuance_policy_sha256: "ab".repeat(32) };
  const evidence = (binding) => {
    const measurement = policy.approved_measurements[0];
    const event = (name, payload) => {
      const preimage = Buffer.concat([Buffer.from("01000008", "hex"), Buffer.from(`:${name}:`), Buffer.from(payload, "hex")]);
      return { imr: 3, event_type: 0x08000001, event: name, event_payload: payload, digest: hash("sha384", preimage).toString("hex") };
    };
    const events = [event("compose-hash", measurement.compose_sha256), ...Object.entries(measurement.runtime_events).map(([name, value]) => event(name, value)), event("system-ready", "")];
    let mr = Buffer.alloc(48);
    for (const e of events) mr = hash("sha384", Buffer.concat([mr, Buffer.from(e.digest, "hex")]));
    const report = { quoteVersion: 4, reportType: "td10", status: "UpToDate", reportData: issuerReportData(binding).toString("hex"), tdAttributes: "0000001000000000",
      mrTd: measurement.mr_td, rtMr0: measurement.rtmr0, rtMr1: measurement.rtmr1, rtMr2: measurement.rtmr2, rtMr3: mr.toString("hex") };
    return { domain: "dsmack-coupon-issuer-identity-v2", binding, quote_hex: Buffer.from(JSON.stringify(report)).toString("hex"), event_log: JSON.stringify(events), app_compose: compose,
      possession_signature_hex: crypto.sign(null, issuerPossessionMessage(binding), pair.privateKey).toString("hex") };
  };
  return { info, policy, evidence, options: { identityPolicy: policy, expectedIdentityPolicySha256: info.identity_policy_sha256,
    expectedIssuancePolicySha256: info.issuance_policy_sha256, expectedIssuerPublicKeySha256: hash("sha256", Buffer.from(publicKeyHex, "hex")).toString("hex"),
    syntheticQuoteVerifier: async (hex) => JSON.parse(Buffer.from(hex, "hex").toString()) } };
}
