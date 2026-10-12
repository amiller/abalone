// Redemption and durable credit are separate from ephemeral conversations.
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import { couponAttestedClient, couponAttestedRecipient, couponIssuerPolicyHash, couponIssuerProfile, validateAttestedCouponOffer, COUPON_DELIVERY_RECIPIENT_V1 } from "./coupon-attested.mjs";
import { admitAttestedCouponIssuerPin, couponNearAdapterHolder } from "./coupon-attested-session.mjs";
import { verifyCouponStagingAdmission } from "./coupon-staging.mjs";
import { validateCouponNearProfile, couponNearCredentialBroker, OUT_OF_DATE_TRIAL_POLICY, OUT_OF_DATE_TRIAL_NOTICE } from "./coupon-near.mjs";
import { creditStore, creditId } from "./credit-store.mjs";

const failure = (code, message) => Object.assign(new Error(message), { code });
const refused = () => failure("credit_record_refused", "Credit inputs or the saved original identity, offer or delivery are invalid; no replacement was made.");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const hex = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const credentialOk = (value) => typeof value === "string" && /^[\x21-\x7e]{1,8192}$/.test(value) && !value.startsWith("synthetic-only-");
// `provider` names the execution path; only NEAR is qualified, other values are refused, never adapted.
const PROVIDERS = new Set(["near"]);
const RECORD = ["version", "id", "state", "testing", "provider", "coupon", "noiseSeed", "recipientKey", "admission", "localPeer", "issuerInfo", "offer", "offerHash"];
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
  if (approval.promptPolicy !== "synthetic-only") throw failure("credit_profile_refused", "Saved credit's provider policy was refused.");
  if (approval.deliveryProfile !== COUPON_DELIVERY_RECIPIENT_V1) throw failure("credit_profile_refused", "The signed staging approval does not select durable recipient credit (x25519-aesgcm-recipient-v1); nothing was sent or claimed.");
  return { pin, approval, provider, bytes, peerId: peerId.value };
}
// Joint durable admission of one offer: the signed approval selects recipient-v1, the offer is the exact recipient-v1
// offer for this gift and issuer, and its issuer key, provider, scope and budget match the pin and approval.
export function creditOfferBound(provider, offer, offerHash, coupon, issuerInfo, a) {
  if (a.approval.deliveryProfile !== COUPON_DELIVERY_RECIPIENT_V1) throw refused();
  validateAttestedCouponOffer({ offer, offer_hash: offerHash }, { coupon, peerId: a.peerId, issuerInfo, issuerProfile: couponIssuerProfile(a.pin.identityPolicy), deliveryProfile: COUPON_DELIVERY_RECIPIENT_V1 });
  if (sha(Buffer.from(issuerInfo.issuer_public_key_hex, "hex")) !== a.pin.expectedIssuerPublicKeySha256 || offer.provider.id !== provider
      || offer.provider.scope_commitment !== a.approval.payload.provider_scope_commitment || BigInt(offer.budget_nano_usd) > BigInt(a.approval.maxCouponNanoUsd)) throw refused();
}
export function creditSummary(record) {
  const p = record.admission.provider, cap = (Number(record.offer.budget_nano_usd) / 1e9).toFixed(2), outOfDate = p.policy.gatewayTcb === OUT_OF_DATE_TRIAL_POLICY;
  return { creditId: record.id, state: record.state, provider: record.provider, model: p.model,
    nominalCapUsd: cap, nominalCapNanoUsd: record.offer.budget_nano_usd, balance: "unknown", providerExpiry: "unknown",
    sponsorCanRevoke: true, sponsorPowers: record.offer.sponsor_powers, claimWindowExpiresAt: record.offer.claim_expires_at, deliveryProfile: record.offer.delivery_profile,
    providerTcbPolicy: p.policy.gatewayTcb, outOfDateException: outOfDate, requestMaxTokens: p.maxTokens, promptPolicy: "synthetic-only",
    operatorSecretAccess: true, retention: "credential and recovery keys saved; conversations fresh by default", offerHash: record.offerHash,
    disclosures: [`Nominal cap $${cap} from the offer; provider enforcement is not verified.`, "Balance: unknown.",
      "Sponsor can revoke the credential or change its limits at any time.", `Each request is separately bounded to ${p.maxTokens} output tokens.`,
      "Synthetic content only: the staging operator can access the credential.", ...(outOfDate ? [OUT_OF_DATE_TRIAL_NOTICE] : [])] };
}
const reconciliation = () => failure("reconciliation_required", "The issuer requires operator reconciliation for this claim. Original keys remain saved; nothing is retried or replaced. Ask the issuer's operator to reconcile.");
const expired = () => failure("claim_expired", "The claim window closed before any delivery to the original keys. Nothing was installed or resent; ask the sponsor for a new gift.");
function manager({ directory, connect, adapterFactory, testing }) {
  const store = creditStore(directory);
  const checked = async (id, now = 0) => {
    const r = store.read(id);
    if (!exact(r, r.state === "installed" ? [...RECORD, ...DELIVERED] : RECORD) || r.testing !== testing || typeof r.coupon !== "string"
        || !/^[A-Za-z0-9_-]{43}$/.test(r.coupon) || creditId(r.coupon) !== id || !hex(r.noiseSeed) || typeof r.recipientKey !== "string") throw refused();
    if (!PROVIDERS.has(r.provider)) throw failure("credit_provider_unsupported", "This saved credit names a provider this version cannot use; it was left unchanged.");
    const a = validateAdmission(r.admission, now);
    const privateKey = await generateKeyPairFromSeed("Ed25519", Buffer.from(r.noiseSeed, "hex"));
    if (peerIdFromPrivateKey(privateKey).toString() !== r.localPeer) throw refused();
    let recipient;
    try {
      recipient = couponAttestedRecipient(r.recipientKey);
      creditOfferBound(r.provider, r.offer, r.offerHash, r.coupon, r.issuerInfo, a);
      if (r.state === "installed" && (!credentialOk(r.credential) || typeof r.installedAt !== "string"
          || recipient.decryptSavedDelivery(r.coupon, { key_id: r.keyId, envelope: r.envelope }, r.offerHash, r.localPeer) !== r.credential)) throw refused();
    } catch { throw refused(); }
    return { record: r, a, privateKey, recipient };
  };
  const open = async (record, a, privateKey) => {
    const client = await connect(record.admission.peer, { ...a.pin, deliveryProfile: COUPON_DELIVERY_RECIPIENT_V1, stagingApproval: { bytes: a.bytes, approvalRoot: record.admission.approvalRoot } }, { privateKey });
    if ((!testing && !["verified-apple-appattest-issuer-identity", "verified-intel-tdx-identity"].includes(client.identity?.evidenceStatus))
        || client.deliveryProfile !== COUPON_DELIVERY_RECIPIENT_V1 || (record.localPeer && record.localPeer !== client.localPeer)) {
      await client.close(); throw failure("issuer_unverified", "The coupon issuer identity or original recovery identity was refused; nothing was claimed.");
    }
    return client;
  };
  return Object.freeze({
    async status(id) {
      if (id) return creditSummary((await checked(id)).record);
      const all = [];
      for (const each of store.list()) {
        try { all.push(creditSummary((await checked(each)).record)); }
        catch (e) { all.push({ creditId: each, state: "refused", code: e.code ?? "credit_record_refused" }); }
      }
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
        const record = { version: 1, id, state: "offered", testing, provider: "near", coupon, noiseSeed: noiseSeed.toString("hex"),
          recipientKey: couponAttestedRecipient().recoveryKey(), admission: structuredClone(admission), localPeer: "" };
        client = await open(record, a, privateKey);
        let accepted;
        try { accepted = await client.offer(coupon); }
        catch { throw failure("credit_offer_refused", "The issuer did not offer a durable recipient-retention credit for this provider; nothing was claimed."); }
        Object.assign(record, { localPeer: client.localPeer, issuerInfo: structuredClone(client.issuerInfo), offer: structuredClone(accepted.offer), offerHash: accepted.offer_hash });
        try { creditOfferBound(record.provider, record.offer, record.offerHash, coupon, record.issuerInfo, a); }
        catch { throw failure("credit_offer_refused", "The offer does not match the signed approval's provider scope or budget; nothing was claimed."); }
        store.write(record, { create: true });
        return creditSummary(record);
      } finally { await client?.close(); unlock(); }
    },
    // Claims only with the original Noise and X25519 keys. Recovery reads bound status first: an unreserved claim
    // is retried once per explicit recover call inside the claim window, a pending one is polled without a claim,
    // and a delivered one is retrieved from the same winner. Expiry and reconciliation are terminal here.
    async redeem(id, { offerHash, recover = false, signal, waitMs = 180000, pollIntervalMs = 1000 } = {}) {
      const unlock = store.lock(id);
      let client, record;
      try {
        const saved = await checked(id, Date.now());
        record = saved.record;
        if (record.state === "installed") return creditSummary(record); // Never redeem twice.
        if (record.state === "reconciliation_required") throw reconciliation();
        if (record.state === "expired") throw expired();
        if (recover && record.state === "offered") throw failure("credit_intent_required", "Nothing was claimed yet. Review credit inspect, then redeem with --accept-offer <offerHash>.");
        if (!recover && record.state !== "offered") throw failure("credit_intent_required", "A claim with the original keys may exist. Use credit recover; it checks status first and never creates new keys.");
        if (!recover && offerHash !== record.offerHash) throw failure("credit_intent_required", "Accept the exact offer hash shown by credit inspect.");
        client = await open(record, saved.a, saved.privateKey);
        const accepted = await client.offer(record.coupon, { expectedHash: record.offerHash });
        const recipient = saved.recipient, bound = { recipient, accepted, signal };
        const status = async () => {
          const s = await client.status(record.coupon, bound);
          if (s.accounting_blocked || s.state === "reconciliation_required") { record.state = "reconciliation_required"; store.write(record); throw reconciliation(); }
          if (s.state === "ready" && s.claim_expired) { record.state = "expired"; store.write(record); throw expired(); }
          return s.state;
        };
        const claim = () => { record.state = "claiming"; store.write(record); return client.claim(record.coupon, recipient, accepted, signal); }; // Durable keys BEFORE mutation.
        const initial = recover ? await status() : "ready";
        let result = initial === "in_progress" ? { state: "in_progress" } : await claim();
        for (const deadline = Date.now() + waitMs; result.state === "in_progress";) {
          if (Date.now() >= deadline) throw failure("claim_pending", "The issuer is still preparing delivery for the original keys. Run credit recover later; it polls status and never claims again.");
          await delay(pollIntervalMs, undefined, { signal });
          const state = await status();
          if (state === "ready") throw failure("claim_not_reserved", "The issuer reports no reservation for the original keys. Nothing was resent; run credit recover to retry once with the same keys within the claim window.");
          if (state === "delivered") result = await claim(); // Retrieval of the same winner's delivery.
        }
        const credential = recipient.decryptDelivery(record.coupon, result, accepted);
        if (!credentialOk(credential)) throw failure("credential_refused", "Delivered credential was refused; original recovery keys remain saved.");
        Object.assign(record, { state: "installed", credential, keyId: result.key_id, envelope: result.envelope, installedAt: new Date().toISOString() });
        store.write(record);
        return creditSummary(record);
      } catch (error) {
        if (record?.state === "claiming") { record.state = "uncertain"; store.write(record); }
        if (["credit_intent_required", "claim_not_reserved", "claim_pending", "claim_expired", "reconciliation_required", "credential_refused", "credit_record_refused", "credit_provider_unsupported", "credit_store_refused", "credit_locked", "credit_flock_unavailable", "staging_approval_expired"].includes(error?.code)) throw error;
        if (record?.state === "offered") throw failure("credit_not_claimed", "Nothing was claimed; the saved offer and original keys remain. Retry credit redeem with the same --accept-offer.");
        throw failure("credit_redemption_incomplete", "The claim may have reached the issuer. Original keys remain saved; run credit recover, which checks status first and never uses another gift or identity.");
      } finally { await client?.close(); unlock(); }
    },
    async session(id) {
      const { record, a } = await checked(id, Date.now());
      if (record.state !== "installed") throw failure("credit_unavailable", "No delivered credential is saved for this credit.");
      if (testing && !adapterFactory) throw failure("testing_credit_refused", "Testing credit cannot open a real provider session.");
      let holder, broker, closed = false, usage;
      return Object.freeze({ provider: a.provider, savedCredit: true,
        info: () => ({ ...creditSummary(record), state: closed ? "closed" : usage ?? "installed", provider: a.provider.provider, profile: "debug-staging",
          retention: "saved-credit", restartRecovery: true, staging: { promptPolicy: a.approval.promptPolicy, operatorSecretAccess: true,
            privateIssuanceQualified: false, rollbackQualified: false, settlementApproval: false, expiresAt: new Date(a.approval.expiresAtMs).toISOString() } }),
        async broker(socketPath, options = {}) {
          if (closed || broker) throw failure("credit_unavailable", "This credit session is closed or already open.");
          const onState = (value) => { usage = value; options.onState?.(value); };
          holder = couponNearAdapterHolder({ credential: record.credential, profile: a.provider, approvalExpiresAtMs: a.approval.expiresAtMs,
            timeoutMs: options.timeoutMs, onState, ...(adapterFactory ? { factory: adapterFactory } : {}) });
          broker = await couponNearCredentialBroker({ socketPath, adapter: holder, timeoutMs: options.timeoutMs, maxBytes: options.maxBytes, onState });
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
