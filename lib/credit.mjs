// Redemption and durable credit are separate from ephemeral conversations.
import crypto from "node:crypto";
import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import { couponAttestedClient, couponAttestedRecipient, couponIssuerPolicyHash, couponIssuerProfile, validateAttestedCouponOffer, COUPON_DELIVERY_RECIPIENT_V1 } from "./coupon-attested.mjs";
import { admitAttestedCouponIssuerPin, couponNearAdapterHolder } from "./coupon-attested-session.mjs";
import { verifyCouponStagingAdmission } from "./coupon-staging.mjs";
import { validateCouponNearProfile, couponNearCredentialBroker } from "./coupon-near.mjs";
import { creditStore, creditId } from "./credit-store.mjs";

const failure = (code, message) => Object.assign(new Error(message), { code });
const refused = () => failure("credit_record_refused", "Credit inputs or the saved original identity, offer or delivery are invalid; no replacement was made.");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const hex = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const credentialOk = (value) => typeof value === "string" && /^[\x21-\x7e]{1,8192}$/.test(value) && !value.startsWith("synthetic-only-");
const RECORD = ["version", "id", "state", "testing", "coupon", "noiseSeed", "recipientKey", "admission", "localPeer", "issuerInfo", "offer", "offerHash"];
const DELIVERED = ["credential", "keyId", "envelope", "installedAt"];

// now = 0 checks signatures and bindings only, so status still reports a credit whose approval expired.
function validateAdmission(value, now = Date.now()) {
  if (!exact(value, ["peer", "pin", "approval", "approvalRoot", "provider"]) || typeof value.approval !== "string" || typeof value.peer !== "string") throw refused();
  const pin = admitAttestedCouponIssuerPin(value.pin);
  if (couponIssuerPolicyHash(pin.identityPolicy) !== pin.expectedIdentityPolicySha256) throw refused();
  let peerId;
  try { peerId = multiaddr(value.peer).getComponents().at(-1); } catch { throw refused(); }
  if (peerId?.name !== "p2p") throw refused();
  const bytes = Buffer.from(value.approval, "base64");
  if (bytes.toString("base64") !== value.approval) throw refused();
  let approval, provider;
  try {
    approval = verifyCouponStagingAdmission(bytes, { approvalRoot: value.approvalRoot, now,
      identityPolicySha256: pin.expectedIdentityPolicySha256, issuancePolicySha256: pin.expectedIssuancePolicySha256,
      issuerPublicKeySha256: pin.expectedIssuerPublicKeySha256 });
    provider = validateCouponNearProfile(value.provider);
  } catch (e) {
    if (e?.code === "staging_approval_expired" && now) throw failure("staging_approval_expired", "The signed staging approval for this credit expired; no provider use or claim is authorized. Saved keys are kept.");
    throw refused();
  }
  if (provider.maxTokens !== 512 || approval.promptPolicy !== "synthetic-only") throw failure("credit_profile_refused", "Saved credit's provider policy was refused.");
  return { pin, approval, provider, bytes, peerId: peerId.value };
}
function offerBound(offer, offerHash, coupon, issuerInfo, a) {
  validateAttestedCouponOffer({ offer, offer_hash: offerHash }, { coupon, peerId: a.peerId, issuerInfo, issuerProfile: couponIssuerProfile(a.pin.identityPolicy), deliveryProfile: COUPON_DELIVERY_RECIPIENT_V1 });
  if (sha(Buffer.from(issuerInfo.issuer_public_key_hex, "hex")) !== a.pin.expectedIssuerPublicKeySha256 || offer.provider.id !== "near"
      || offer.provider.scope_commitment !== a.approval.payload.provider_scope_commitment || BigInt(offer.budget_nano_usd) > BigInt(a.approval.maxCouponNanoUsd)) throw refused();
}
export function creditSummary(record) {
  return { creditId: record.id, state: record.state, provider: "near", model: record.admission.provider.model,
    nominalCapUsd: (Number(record.offer.budget_nano_usd) / 1e9).toFixed(2), nominalCapNanoUsd: record.offer.budget_nano_usd,
    balance: "unknown", providerExpiry: "unknown", sponsorPowers: record.offer.sponsor_powers,
    claimWindowExpiresAt: record.offer.claim_expires_at, deliveryProfile: record.offer.delivery_profile,
    retention: "credential and recovery keys saved; conversations fresh by default",
    requestMaxTokens: record.admission.provider.maxTokens, promptPolicy: "synthetic-only", operatorSecretAccess: true,
    offerHash: record.offerHash };
}
function manager({ directory, connect, adapterFactory, testing }) {
  const store = creditStore(directory);
  const checked = async (id, now = 0) => {
    const r = store.read(id);
    if (!exact(r, r.state === "installed" ? [...RECORD, ...DELIVERED] : RECORD) || r.testing !== testing || typeof r.coupon !== "string"
        || !/^[A-Za-z0-9_-]{43}$/.test(r.coupon) || creditId(r.coupon) !== id || !hex(r.noiseSeed) || typeof r.recipientKey !== "string") throw refused();
    const a = validateAdmission(r.admission, now);
    const privateKey = await generateKeyPairFromSeed("Ed25519", Buffer.from(r.noiseSeed, "hex"));
    if (peerIdFromPrivateKey(privateKey).toString() !== r.localPeer) throw refused();
    let recipient;
    try {
      recipient = couponAttestedRecipient(r.recipientKey);
      offerBound(r.offer, r.offerHash, r.coupon, r.issuerInfo, a);
      if (r.state === "installed" && (!credentialOk(r.credential) || typeof r.installedAt !== "string"
          || recipient.decryptSavedDelivery(r.coupon, { key_id: r.keyId, envelope: r.envelope }, r.offerHash, r.localPeer) !== r.credential)) throw refused();
    } catch { throw refused(); }
    return { record: r, a, privateKey, recipient };
  };
  const open = async (record, a, privateKey) => {
    const client = await connect(record.admission.peer, { ...a.pin, stagingApproval: { bytes: a.bytes, approvalRoot: record.admission.approvalRoot } }, { privateKey });
    if ((!testing && !["verified-apple-appattest-issuer-identity", "verified-intel-tdx-identity"].includes(client.identity?.evidenceStatus))
        || (record.localPeer && record.localPeer !== client.localPeer)) {
      await client.close(); throw failure("issuer_unverified", "The coupon issuer identity or original recovery identity was refused; nothing was claimed.");
    }
    return client;
  };
  return Object.freeze({
    async status(id) {
      if (id) return creditSummary((await checked(id)).record);
      const all = [];
      for (const each of store.list()) all.push(creditSummary((await checked(each)).record));
      return all;
    },
    async inspect(coupon, admission) {
      const a = validateAdmission(admission);
      const id = creditId(coupon), unlock = store.lock(id);
      let client;
      try {
        if (store.exists(id)) {
          const { record } = await checked(id);
          if (JSON.stringify(record.admission) !== JSON.stringify(admission)) throw failure("credit_admission_changed", "This gift is already saved under different trial inputs; nothing was replaced.");
          return creditSummary(record);
        }
        const noiseSeed = crypto.randomBytes(32), privateKey = await generateKeyPairFromSeed("Ed25519", noiseSeed);
        const record = { version: 1, id, state: "offered", testing, coupon, noiseSeed: noiseSeed.toString("hex"),
          recipientKey: couponAttestedRecipient().recoveryKey(), admission: structuredClone(admission), localPeer: "" };
        client = await open(record, a, privateKey);
        let accepted;
        try { accepted = await client.offer(coupon, { deliveryProfile: COUPON_DELIVERY_RECIPIENT_V1 }); }
        catch { throw failure("credit_offer_refused", "The issuer did not offer a durable recipient-retention credit for this provider; nothing was claimed."); }
        Object.assign(record, { localPeer: client.localPeer, issuerInfo: structuredClone(client.issuerInfo), offer: structuredClone(accepted.offer), offerHash: accepted.offer_hash });
        try { offerBound(record.offer, record.offerHash, coupon, record.issuerInfo, a); }
        catch { throw failure("credit_offer_refused", "The offer does not match the signed approval's provider scope or budget; nothing was claimed."); }
        store.write(record, { create: true });
        return creditSummary(record);
      } finally { await client?.close(); unlock(); }
    },
    async redeem(id, { offerHash, recover = false, signal, waitMs = 180000 } = {}) {
      const unlock = store.lock(id);
      let client, record;
      try {
        const saved = await checked(id, Date.now());
        record = saved.record;
        if (record.state === "installed") return creditSummary(record); // Never redeem twice.
        if (recover ? !["claiming", "uncertain"].includes(record.state) : record.state !== "offered" || offerHash !== record.offerHash)
          throw failure("credit_intent_required", "Accept the exact offer first, or use original-key recovery for an uncertain claim.");
        client = await open(record, saved.a, saved.privateKey);
        const accepted = await client.offer(record.coupon, { expectedHash: record.offerHash, deliveryProfile: COUPON_DELIVERY_RECIPIENT_V1 });
        const recipient = saved.recipient;
        if (recover) {
          const progress = await client.status(record.coupon, { recipient, accepted, signal });
          if (progress.accounting_blocked || progress.state === "reconciliation_required") {
            record.state = "reconciliation_required"; store.write(record);
            throw failure("reconciliation_required", "Issuer reconciliation is required; original recovery keys remain saved. No replacement claim was made.");
          }
          if (!["in_progress", "delivered"].includes(progress.state)) throw failure("claim_not_reserved", "The original claim is not confirmed. No automatic replay was made; ask the issuer to reconcile.");
        }
        record.state = "claiming"; store.write(record); // Durable original keys BEFORE mutation.
        let result = await client.claim(record.coupon, recipient, accepted, signal);
        if (result.state === "in_progress") result = await client.awaitDelivery(record.coupon, recipient, accepted, { timeoutMs: waitMs, signal });
        const credential = recipient.decryptDelivery(record.coupon, result, accepted);
        if (!credentialOk(credential)) throw failure("credential_refused", "Delivered credential was refused; original recovery keys remain saved.");
        Object.assign(record, { state: "installed", credential, keyId: result.key_id, envelope: result.envelope, installedAt: new Date().toISOString() });
        store.write(record);
        return creditSummary(record);
      } catch (error) {
        if (record?.state === "claiming") { record.state = "uncertain"; store.write(record); }
        if (["credit_intent_required", "claim_not_reserved", "reconciliation_required", "credential_refused", "credit_record_refused", "credit_store_refused", "credit_locked", "staging_approval_expired"].includes(error?.code)) throw error;
        throw failure("credit_redemption_incomplete", "Redemption did not complete. Original keys are saved: use credit recover, never another coupon or identity.");
      } finally { await client?.close(); unlock(); }
    },
    async session(id) {
      const { record, a } = await checked(id, Date.now());
      if (record.state !== "installed") throw failure("credit_unavailable", "No delivered credential is saved for this credit.");
      if (testing && !adapterFactory) throw failure("testing_credit_refused", "Testing credit cannot open a real provider session.");
      let holder, broker, closed = false;
      return Object.freeze({ provider: a.provider, savedCredit: true,
        info: () => ({ ...creditSummary(record), state: closed ? "closed" : "installed", restartRecovery: true }),
        async broker(socketPath, options = {}) {
          if (closed || broker) throw failure("credit_unavailable", "This credit session is closed or already open.");
          holder = couponNearAdapterHolder({ credential: record.credential, profile: a.provider, approvalExpiresAtMs: a.approval.expiresAtMs,
            timeoutMs: options.timeoutMs, onState: options.onState, ...(adapterFactory ? { factory: adapterFactory } : {}) });
          broker = await couponNearCredentialBroker({ socketPath, adapter: holder, timeoutMs: options.timeoutMs, maxBytes: options.maxBytes, onState: options.onState });
          return broker;
        },
        async close() { closed = true; await broker?.close(); await holder?.close(); },
      });
    },
  });
}
export const createCreditManager = ({ directory }) => manager({ directory, connect: couponAttestedClient, testing: false });
// Explicit fixture boundary: synthetic issuer client and synthetic provider adapter only.
export const createCreditManagerForTesting = ({ directory, connect, adapterFactory }) => manager({ directory, connect, adapterFactory, testing: true });
