// Attested version 4 recipient session: issuer discovery and fresh identity verification, an
// exact offer, explicit consent, an asynchronous claim with bound polling, encrypted delivery and
// the scoped provider-use broker (synthetic loopback, or the strict NEAR adapter under a signed
// debug-staging admission). Custody, rollback and settlement qualification stay separate gates;
// nothing here claims a private release. Keys exist once per session and are never replaced.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { multiaddr } from "@multiformats/multiaddr";
import { couponAttestedClient, couponAttestedClientForTesting, couponAttestedRecipient, couponOfferNative } from "./coupon-attested.mjs";
import { openCouponNearAdapter, couponNearCredentialBroker, validateCouponNearProfile, OUT_OF_DATE_TRIAL_POLICY, OUT_OF_DATE_TRIAL_NOTICE } from "./coupon-near.mjs";
import { couponStagingGuardNotice } from "./coupon-staging.mjs";

const failure = (code, message) => Object.assign(new Error(message), { code });
const hex64 = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const SYNTHETIC_CREDENTIAL = /^synthetic-only-coupon-[0-9a-f]{64}$/;

export const ATTESTED_COUPON_PROFILES = Object.freeze(["fixture-local", "debug-staging"]);
export const ATTESTED_COUPON_CONSENT = Object.freeze({ "fixture-local": "CLAIM SESSION ONLY", "debug-staging": "CLAIM DEBUG STAGING SESSION" });
export const ATTESTED_COUPON_WAIT = "WAIT SAME KEYS";
export const ATTESTED_COUPON_RECOVER = "RETRY SAME KEYS";
export const ATTESTED_COUPON_POLL_ROUND_MS = 30_000;
export const ATTESTED_COUPON_POLL_INTERVAL_MS = 1000;
export const NEAR_COUPON_BASE_URL = "https://cloud-api.near.ai/v1";
// Pi's default OpenAI compatibility emits store/max_completion_tokens; the strict provider socket
// accepts the selected NEAR request grammar only. Pi's thinking level sets chat_template_kwargs.enable_thinking.
export const NEAR_COUPON_PI_COMPAT = Object.freeze({ supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens",
  thinkingFormat: "chat-template", chatTemplateKwargs: Object.freeze({ enable_thinking: Object.freeze({ $var: "thinking.enabled" }) }) });
// The direct debug-staging session (coupon-session --attested, including the explicit OutOfDate single-session trial)
// has no trial.json, so its per-request output cap is chosen here. Saved credit takes the cap from its trial's maxTokens.
export const DEBUG_STAGING_SESSION_MAX_TOKENS = 4096;
export const NEAR_COUPON_POLICY = Object.freeze({ gatewayTcb: "UpToDate", modelTcb: "UpToDate", gpuSignature: "required",
  composeRegistry: Object.freeze({ rpc: "https://mainnet.base.org", chainId: 8453 }) });

const PIN_TEXT = { identityPolicy: "identity policy", issuancePolicy: "issuance policy", issuerKey: "issuer public key" };

// The independently pinned issuer terms from --issuer-pin: the identity policy plus all three
// hashes. Genuine fresh issuer identity means pinning the key too, not only the policies.
export function admitAttestedCouponIssuerPin(pin) {
  if (!exact(pin, ["identityPolicy", "expectedIdentityPolicySha256", "expectedIssuancePolicySha256", "expectedIssuerPublicKeySha256"])
      || !hex64(pin.expectedIdentityPolicySha256) || !hex64(pin.expectedIssuancePolicySha256) || !hex64(pin.expectedIssuerPublicKeySha256)
      || !pin.identityPolicy || typeof pin.identityPolicy !== "object" || Array.isArray(pin.identityPolicy))
    throw failure("issuer_pin_refused", "The issuer pin must be the exact JSON object with the identity policy and the identity, issuance and issuer-key hashes. Nothing was claimed.");
  return Object.freeze({ identityPolicy: structuredClone(pin.identityPolicy), expectedIdentityPolicySha256: pin.expectedIdentityPolicySha256,
    expectedIssuancePolicySha256: pin.expectedIssuancePolicySha256, expectedIssuerPublicKeySha256: pin.expectedIssuerPublicKeySha256 });
}

// The near provider-use admission: a selected model with strict defaults and an explicit trial choice.
// No providers.json inheritance, no ambient key, no config.
export function admitAttestedCouponNearProvider(model, allowOutOfDateTrial, maxTokens) {
  try { if (typeof allowOutOfDateTrial !== "boolean") throw new Error(); return validateCouponNearProfile({ baseUrl: NEAR_COUPON_BASE_URL, model, maxTokens, policy: { ...structuredClone(NEAR_COUPON_POLICY), ...(allowOutOfDateTrial ? { gatewayTcb: OUT_OF_DATE_TRIAL_POLICY, modelTcb: OUT_OF_DATE_TRIAL_POLICY } : {}) } }); }
  catch { throw failure("model_not_admitted", "Select the near model explicitly (--model near/<model>) for the debug-staging profile. Nothing was claimed."); }
}

// Everything checkable before any connection or coupon entry. The two profiles:
//  - fixture-local: a loopback development issuer with synthetic evidence and the configured
//    loopback synthetic provider (the explicit test boundary; it cannot emit hardware admission).
//  - debug-staging: a signed staging approval from an independently pinned root, cross-checked
//    against the verified issuer identity, admitting the real "near" provider use under the
//    selected NEAR policy. It discloses operator secret access and qualifies nothing private.
export function admitAttestedCouponSessionIssuer({ profile, peerAddr, admit, issuerPin, stagingApproval, model, config, syntheticQuoteVerifier, occupied = false, ambient = false, allowOutOfDateTrial = false }) {
  if (profile === undefined) throw failure("issuer_unverified", "Coupon issuance is not verified for production. No coupon was read or sent. Only the explicit fixture-local profile or a signed debug-staging admission is available.");
  if (!ATTESTED_COUPON_PROFILES.includes(profile)) throw failure("profile_refused", "Unknown attested coupon profile. Nothing was claimed.");
  if (typeof allowOutOfDateTrial !== "boolean" || (allowOutOfDateTrial && profile !== "debug-staging")) throw failure("profile_refused", "The OutOfDate exception is an explicit signed debug-staging trial choice only. Nothing was claimed.");
  let parts;
  try { parts = multiaddr(peerAddr).getComponents(); } catch { throw failure("issuer_unverified", "The issuer address is not a valid multiaddr. Nothing was claimed."); }
  const peerId = parts.findLast((p) => p.name === "p2p")?.value;
  if (!peerId) throw failure("issuer_unverified", "The issuer address must name its peer identity. Nothing was claimed.");
  const pin = admitAttestedCouponIssuerPin(issuerPin);
  let staging;
  if (stagingApproval !== undefined) {
    if (!exact(stagingApproval, ["bytes", "approvalRoot"]) || !Buffer.isBuffer(stagingApproval.bytes) || stagingApproval.bytes.length < 1
        || stagingApproval.bytes.length > 65_536 || !(hex64(stagingApproval.approvalRoot) || (Buffer.isBuffer(stagingApproval.approvalRoot) && stagingApproval.approvalRoot.length === 32)))
      throw failure("staging_admission_refused", "The staging approval must be exact bytes plus the independently pinned approval root. Nothing was claimed.");
    staging = { bytes: stagingApproval.bytes, approvalRoot: stagingApproval.approvalRoot };
  }
  let providerUse, provider;
  if (profile === "fixture-local") {
    if (staging) throw failure("profile_refused", "The fixture-local profile takes no staging approval; the debug-staging profile is separate. Nothing was claimed.");
    if (parts.length !== 3 || parts[0].name !== "ip4" || parts[0].value !== "127.0.0.1" || parts[1].name !== "tcp" || !Number(parts[1].value) || admit?.dev !== true)
      throw failure("experimental_profile_refused", "The fixture-local profile requires a loopback development issuer and explicit development-peer admission. Nothing was claimed.");
    // The disclosed test boundary: this profile's issuer evidence is synthetic by construction.
    if (typeof syntheticQuoteVerifier !== "function") throw failure("issuer_unverified", "The fixture-local profile requires the explicit synthetic quote verifier; it cannot emit hardware admission. Nothing was claimed.");
    if (typeof model !== "string" || !model) throw failure("model_not_admitted", "Select the admitted synthetic model (synthetic-near/<model>). Nothing was claimed.");
    providerUse = "synthetic";
    const admitted = admitCouponSessionProvider(config, model, { occupied, ambient });
    provider = Object.freeze({ ...admitted, offerProvider: admitted.provider });
  } else {
    if (!staging) throw failure("staging_approval_required", "The debug-staging profile requires the signed approval bytes and the independently pinned approval root. Nothing was claimed.");
    if (typeof model !== "string" || !model) throw failure("model_not_admitted", "Select the near model explicitly (near/<model>). Nothing was claimed.");
    if (occupied || ambient) throw failure("credential_slot_occupied", "A credential already exists for this provider. Nothing was replaced or claimed. Use a fresh profile; replacement is not supported.");
    providerUse = "near";
    provider = admitAttestedCouponNearProvider(model, allowOutOfDateTrial, DEBUG_STAGING_SESSION_MAX_TOKENS);
  }
  return Object.freeze({ profile, providerUse, provider, issuerPin: pin, stagingApproval: staging,
    consent: ATTESTED_COUPON_CONSENT[profile], productionVerified: false });
}

export function attestedCouponSessionOfferText(accepted, { admission, identity, stagingAdmission } = {}) {
  const o = accepted.offer, staging = admission.profile === "debug-staging" ? stagingAdmission : null;
  const short = (value) => `${value.slice(0, 16)}…`;
  const guardNotice = staging ? couponStagingGuardNotice(staging.guard) : "";
  return `${admission.profile === "fixture-local" ? "SYNTHETIC ATTESTED FIXTURE" : "DEBUG-STAGING ATTESTED"} V4 OFFER (profile: ${admission.profile}). Issuance code is unverified for production; this is not a private-issuance guarantee.
Issuer: peer ${o.issuer.peer_id} under policy ${o.issuer.policy}, identity verified fresh on this Noise connection (evidence: ${identity?.evidenceStatus ?? "unverified"}).
Pins — ${PIN_TEXT.identityPolicy} ${short(o.issuer.identity_policy_sha256)}, ${PIN_TEXT.issuancePolicy} ${short(o.issuer.issuance_policy_sha256)}, ${PIN_TEXT.issuerKey} ${short(o.issuer.issuer_public_key_sha256)}.
Provider: ${o.provider.id} (scope commitment ${short(o.provider.scope_commitment)}); use ${admission.provider.provider}/${admission.provider.model} at ${admission.provider.baseUrl}.
${admission.provider.policy?.gatewayTcb === OUT_OF_DATE_TRIAL_POLICY ? OUT_OF_DATE_TRIAL_NOTICE + "\n" : ""}Nominal limit: ${o.budget_nano_usd} nanoUSD (a provider cap can overshoot).
Claim expires: ${o.claim_expires_at}; ${couponOfferNative(o) ? `provider key expires ${o.provider_expires_at}` : "provider expiry: unknown"}; balance: unknown.
${couponOfferNative(o) ? "Sponsor powers: none; the sponsor cannot revoke or change limits." : `Sponsor powers: ${o.sponsor_powers.join(", ")}.`} Copied codes can be stolen before first claim; the first authenticated bearer wins.
The claim is asynchronous: the issuer may answer in progress and deliver later. Keep this process open; poll with the original keys; never start a second identity or delivery key.${staging ? `
DEBUG-STAGING ADMISSION, signed by your pinned approval root: the service operator holds OPERATOR SECRET ACCESS — it may know, use or revoke the delivered API credential. Inference goes directly through admitted encrypted NEAR model transport; the issuer is not a prompt relay. This admission does NOT qualify private issuance (privateIssuanceQualified: false), rollback safety (rollbackQualified: false) or settlement (settlementApproval: false).
${guardNotice ? guardNotice + "\n" : ""}Prompt policy: ${staging.promptPolicy.toUpperCase()} — send synthetic prompt content only, never real secrets or private data.
Bounds: at most ${staging.maxCouponNanoUsd} nanoUSD per coupon and ${staging.maxTotalNanoUsd} in total; the approval expires ${new Date(staging.expiresAtMs).toISOString()}.` : ""}
Retention: session-only — coupon, Noise identity, delivery key and provider credential stay in this process's memory.
EXIT OR CRASH LOSES RECOVERY: this profile cannot recover the credential on restart or claim a replacement.
Ordinary conversation history, notebook records, workspace files and host egress names may persist.
Forgetting locally is not upstream revocation or secure erasure. No private summary is sent to a setup agent.
Offer hash: ${accepted.offer_hash}.`;
}

// The delivered credential outlives each bounded adapter admission window: on expiry the holder
// opens a FRESH admission with the same credential and profile for the next request. It never
// re-claims the coupon and never creates new recipient or delivery keys; close clears the
// credential reference and aborts the admission in flight.
export function couponNearAdapterHolder({ credential, profile, approvalExpiresAtMs, sessionLifetimeMs, timeoutMs, maxBytes, factory = openCouponNearAdapter, onState = () => {} }) {
  let current, held = credential, closed = false, closing, expired = false;
  const expiryError = () => failure("staging_approval_expired", "The signed staging authorization expired. Provider use is stopped; no new gift or key is requested.");
  const expire = () => { if (expired) return; expired = true; held = undefined; onState("staging_approval_expired"); void current?.close(); };
  const checkAuthorization = () => { if (Date.now() >= approvalExpiresAtMs) expire(); if (expired) throw expiryError(); };
  // Long-dated fixture approvals still use a bounded timer without the Node overflow fallback.
  let expiryTimer;
  const scheduleExpiry = () => { expiryTimer = setTimeout(() => { if (Date.now() >= approvalExpiresAtMs) expire(); else scheduleExpiry(); }, Math.min(2_147_483_647, Math.max(1, approvalExpiresAtMs - Date.now()))); expiryTimer.unref(); };
  scheduleExpiry();
  const open = () => { current = factory({ baseUrl: profile.baseUrl, model: profile.model, policy: profile.policy, maxTokens: profile.maxTokens,
    credential: held, ...(sessionLifetimeMs !== undefined ? { sessionLifetimeMs } : {}), ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(maxBytes !== undefined ? { maxBytes } : {}) }); return current; };
  const closedError = () => failure("provider_closed", "coupon provider: provider_closed");
  return Object.freeze({
    profile,
    async fetch(input, init = {}) {
      checkAuthorization();
      if (closed) throw closedError();
      try {
        if (!current) open();
        await current.admit();
      } catch (error) {
        // Only a bounded-window expiry re-admits; every other refusal (refused admission,
        // transport, closure) is surfaced to the requesting child unchanged.
        checkAuthorization();
        if (closed || !["provider_admission_expired", "provider_closed"].includes(error?.code)) throw error;
        await current?.close().catch(() => {});
        if (closed) throw closedError();
        checkAuthorization();
        open(); onState("provider_readmitted");
        await current.admit();
      }
      if (closed) throw closedError();
      checkAuthorization();
      try { return await current.fetch(input, init); } catch (error) { checkAuthorization(); throw error; }
    },
    async close() {
      if (closing) return closing;
      closed = true; held = undefined; clearTimeout(expiryTimer);
      const previous = current; current = undefined;
      closing = previous?.close();
      return closing;
    },
  });
}

// One recipient key and one Noise client per session; a retry or restart ambiguity can never turn
// into authorization for a second key. All polling replays the same accepted offer hash.
export async function openAttestedCouponSession({ peerAddr, admit, issuerPin, profile, stagingApproval, model, config, syntheticQuoteVerifier, occupied = false, ambient = false, allowOutOfDateTrial = false,
    connect, nearAdapterFactory = openCouponNearAdapter, pollRoundMs = ATTESTED_COUPON_POLL_ROUND_MS, pollIntervalMs = ATTESTED_COUPON_POLL_INTERVAL_MS }) {
  const admission = admitAttestedCouponSessionIssuer({ profile, peerAddr, admit, issuerPin, stagingApproval, model, config, syntheticQuoteVerifier, occupied, ambient, allowOutOfDateTrial });
  if (!Number.isSafeInteger(pollRoundMs) || pollRoundMs < 10 || pollRoundMs > 600_000 || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 30_000)
    throw failure("session_refused", "Invalid attested coupon polling bounds.");
  const clientOptions = { identityPolicy: admission.issuerPin.identityPolicy, expectedIdentityPolicySha256: admission.issuerPin.expectedIdentityPolicySha256,
    expectedIssuancePolicySha256: admission.issuerPin.expectedIssuancePolicySha256, expectedIssuerPublicKeySha256: admission.issuerPin.expectedIssuerPublicKeySha256,
    ...(admission.stagingApproval ? { stagingApproval: admission.stagingApproval } : {}),
    ...(admission.profile === "fixture-local" ? { syntheticQuoteVerifier } : {}) };
  let client;
  try {
    client = await (connect ?? (admission.profile === "fixture-local" ? couponAttestedClientForTesting : couponAttestedClient))(peerAddr, clientOptions);
  } catch (error) {
    if (["staging_admission_refused", "staging_approval_expired"].includes(error?.code))
      throw failure(error.code, `${error.message} No coupon was read or sent.`);
    throw failure("issuer_unverified", "The coupon issuer is unreachable, or its fresh identity evidence or the signed admission did not verify against the pinned terms. No coupon was read or sent.");
  }
  const stagingAdmission = client.stagingAdmission;
  if (allowOutOfDateTrial && (!stagingAdmission || stagingAdmission.promptPolicy !== "synthetic-only"
      || BigInt(stagingAdmission.maxCouponNanoUsd) > 5_000_000_000n || BigInt(stagingAdmission.maxTotalNanoUsd) > 5_000_000_000n)) {
    await client.close(); throw failure("profile_refused", "The OutOfDate exception requires a signed synthetic-only trial capped at $5 per coupon and in total. No coupon was read or sent.");
  }
  let recipient = couponAttestedRecipient();
  let coupon, accepted, credential, state = "unclaimed", usageState, busy = false, broker, brokerOpening, closing, holder;
  const requireOpen = () => { if (state === "closed") throw failure("session_closed", "This coupon session is closed. Its keys cannot be recovered by starting another process."); };
  const installed = () => Object.freeze({ state: "installed", provider: admission.provider.provider, model: admission.provider.model, balance: "unknown",
    providerExpiry: accepted?.offer.provider_expires_at ?? "unknown", retention: "session-only",
    ...(admission.providerUse === "near" ? { admissionWindow: "bounded per adapter window; a fresh admission opens with the same delivered credential; the coupon is never re-claimed" } : {}) });
  // The delivered credential must match the admitted provider use exactly: a synthetic-only
  // credential cannot back the real near profile, and vice versa. Nothing is installed on a
  // mismatch; the session's original keys are preserved for the operator to reconcile.
  const deliver = (result) => {
    requireOpen();
    const key = recipient.decryptDelivery(coupon, result, accepted);
    if (admission.providerUse === "synthetic" && !SYNTHETIC_CREDENTIAL.test(key))
      throw failure("credential_refused", "The delivery is not a synthetic fixture credential. It was not installed; this session's original keys are preserved. Report the issuer to its operator.");
    if (admission.providerUse === "near" && (key.startsWith("synthetic-only-") || !/^[\x21-\x7e]{1,8192}$/.test(key)))
      throw failure("credential_refused", "The delivered credential cannot back the real near provider profile. It was not installed; this session's original keys are preserved. Report the issuer to its operator.");
    credential = key; state = "installed";
  };
  let roundController = null, cancelling = false, previousState;
  const round = (signal) => client.awaitDelivery(coupon, recipient, accepted, { pollIntervalMs, timeoutMs: pollRoundMs, signal });
  const mapClaimError = (error) => {
    if (state === "closed") return failure("session_closed", "This coupon session closed while claiming. Nothing further was requested.");
    if (error?.code === "staging_approval_expired") {
      state = ["claim_pending", "claim_uncertain", "claim_not_reserved"].includes(previousState) ? previousState : "claim_uncertain";
      return failure("staging_approval_expired", "The signed staging authorization expired. No further bearer request is authorized. The original keys are retained; an earlier claim or provider effect may still exist. Ask the operator to reconcile; do not create a replacement identity or gift.");
    }
    if (error?.code === "claim_pending") { state = "claim_pending"; return failure("claim_pending", "The asynchronous claim is still in progress. Keep this session open and poll again with the original keys (WAIT SAME KEYS). Do not start another claim or identity."); }
    if (error?.code === "claim_expired") { state = "claim_expired"; return failure("claim_expired", "The unclaimed gift expired before delivery. Nothing was installed; ask its sponsor for a new gift."); }
    if (error?.code === "claim_reconciliation_required") { state = "reconciliation_required"; return failure("reconciliation_required", "Issuance requires operator reconciliation. Nothing was installed; an earlier provider effect may still exist. Automatic retry and recipient recovery are disabled. Ask the issuer's operator to reconcile; do not claim a replacement."); }
    if (error?.code === "claim_not_reserved") { state = "claim_not_reserved"; return failure("claim_not_reserved", "The claim never landed. The original request may be retried with the same keys (RETRY SAME KEYS); no new key is created."); }
    if (error?.code === "credential_refused") { state = "delivery_refused"; return error; }
    if (cancelling) { state = "claim_pending"; return failure("claim_cancelled", "Polling was cancelled. The claim remains unresolved: keep this process open and continue with the original keys (WAIT SAME KEYS). Do not start another claim."); }
    state = "claim_uncertain"; return failure("claim_uncertain", "The claim response was interrupted, denied or invalid. Keep this process open and use same-process recovery (RETRY SAME KEYS). Do not try another identity or delivery key.");
  };
  const attempt = async (action) => {
    requireOpen();
    if (busy) throw failure("claim_in_progress", "A claim is already in progress. Wait for its result; do not create new keys.");
    busy = true; previousState = state; state = "claiming"; cancelling = false;
    roundController = new AbortController();
    try {
      await action(roundController.signal);
      requireOpen();
      return installed();
    } catch (error) { throw mapClaimError(error); }
    finally { busy = false; roundController = null; }
  };
  return Object.freeze({
    admission,
    provider: admission.provider,
    get state() { return state === "installed" ? (usageState ?? state) : state; },
    get stagingAdmission() { return stagingAdmission; },
    issuer: Object.freeze({ policy: client.issuerProfile ?? "dstack-tdx-coupon-v1", peer: client.peerId, productionVerified: false }),
    info() {
      requireOpen();
      return Object.freeze({ state: state === "installed" ? (usageState ?? state) : state, provider: admission.provider.provider, model: admission.provider.model,
        balance: "unknown", providerExpiry: accepted?.offer.provider_expires_at ?? "unknown", retention: "session-only", profile: admission.profile,
        issuer: { policy: client.issuerProfile ?? "dstack-tdx-coupon-v1", peer: client.peerId, evidence: client.identity?.evidenceStatus ?? "unverified",
          identityPolicy: accepted?.offer.issuer.identity_policy_sha256, issuancePolicy: accepted?.offer.issuer.issuance_policy_sha256, issuerKey: accepted?.offer.issuer.issuer_public_key_sha256 },
        ...(stagingAdmission ? { staging: { promptPolicy: stagingAdmission.promptPolicy, operatorSecretAccess: true,
          privateIssuanceQualified: false, rollbackQualified: false, settlementApproval: false,
          maxCouponNanoUsd: stagingAdmission.maxCouponNanoUsd, expiresAt: new Date(stagingAdmission.expiresAtMs).toISOString() } } : {}),
        ...(admission.providerUse === "near" ? { admissionWindow: "bounded per adapter window; a fresh admission opens with the same delivered credential; the coupon is never re-claimed" } : {}),
        sponsorPowers: accepted?.offer.sponsor_powers, sponsorCanRevoke: !accepted || !couponOfferNative(accepted.offer), restartRecovery: false });
    },
    async inspect(value) {
      requireOpen();
      if (coupon !== undefined) throw failure("coupon_already_selected", "This process already holds a coupon. Recover or close this session; do not replace its keys.");
      coupon = value;
      try {
        accepted = await client.offer(coupon);
        requireOpen();
        if (accepted.offer.provider.id !== admission.provider.offerProvider || accepted.offer.issuer.policy !== (client.issuerProfile ?? "dstack-tdx-coupon-v1")) throw new Error();
        state = "offer_received";
        return Object.freeze({ text: attestedCouponSessionOfferText(accepted, { admission, identity: client.identity, stagingAdmission }), offerHash: accepted.offer_hash });
      } catch (error) {
        if (state === "closed") { accepted = undefined; throw failure("session_closed", "This coupon session closed while inspecting its offer. Nothing was claimed."); }
        state = "offer_refused";
        throw failure("offer_refused", `The coupon offer was denied, unavailable or did not match the ${admission.profile} profile (provider, issuer identity or the signed admission's exact context). Nothing was claimed. Check the gift, the issuer pin and the approval with its operator. ${error?.code === "staging_approval_expired" ? error.message : ""}`.trim());
      }
    },
    async claim({ offerHash, consent } = {}) {
      requireOpen();
      if (busy) throw failure("claim_in_progress", "A claim is already in progress. Wait for its result; do not create new keys.");
      if (state === "claim_pending") throw failure("claim_pending", "The asynchronous claim is still in progress. Keep this session open and poll again with the original keys (WAIT SAME KEYS). Do not start another claim or identity.");
      if (state !== "offer_received" || offerHash !== accepted?.offer_hash || consent !== admission.consent)
        throw failure("consent_required", `Review the exact offer and type ${admission.consent} to accept session-only retention before claiming.`);
      return attempt((signal) => (async () => {
        const result = await client.claim(coupon, recipient, accepted, signal);
        requireOpen();
        if (result.state !== "in_progress") { deliver(result); return; }
        requireOpen();
        deliver(await round(signal));
      })());
    },
    // Continue polling the still-unresolved claim with the original keys; a delivery that lands
    // during the resumed round installs through the same cross-checked path as the first claim.
    async resume({ consent } = {}) {
      requireOpen();
      if (state !== "claim_pending" || busy || consent !== ATTESTED_COUPON_WAIT)
        throw failure("resume_refused", "Resume requires this original process, an unresolved pending claim and explicit same-key consent (WAIT SAME KEYS). Nothing new was claimed.");
      return attempt(async (signal) => deliver(await round(signal)));
    },
    // Same-process recovery after an uncertain or never-landed claim: status first, then a replay
    // with the original accepted hash, Noise identity and delivery key only.
    async recover({ consent } = {}) {
      requireOpen();
      if (!["claim_uncertain", "claim_not_reserved"].includes(state) || busy || consent !== ATTESTED_COUPON_RECOVER)
        throw failure("recovery_refused", "Recovery requires this original process and explicit same-key retry (RETRY SAME KEYS). Nothing new was claimed.");
      return attempt((signal) => (async () => {
        const s = await client.status(coupon, { recipient, accepted, signal });
        requireOpen();
        if (s.state === "reconciliation_required" || s.accounting_blocked) throw Object.assign(new Error(), { code: "claim_reconciliation_required" });
        if (s.state === "ready" && s.claim_expired) throw Object.assign(new Error(), { code: "claim_expired" });
        if (s.state === "ready" || s.state === "delivered") {
          const result = await client.claim(coupon, recipient, accepted, signal);
          requireOpen();
          if (result.state !== "in_progress") { deliver(result); return; }
        }
        deliver(await round(signal));
      })());
    },
    // Stop the in-flight polling round without losing the keys: the claim stays pending.
    async cancel() {
      requireOpen();
      if (!busy || state !== "claiming") throw failure("nothing_pending", "No claim round is in progress.");
      cancelling = true;
      roundController?.abort();
    },
    async broker(socketPath, options = {}) {
      requireOpen();
      if (state !== "installed" || broker || brokerOpening) throw failure("slot_unavailable", "The session credential is unavailable or already installed. No slot was replaced.");
      if (admission.providerUse === "near" && !(client.issuerProfile === "mac-appattest-coupon-v1" ? client.identity?.evidenceStatus === "verified-apple-appattest-issuer-identity" : client.identity?.evidenceStatus === "verified-intel-tdx-identity") && nearAdapterFactory === openCouponNearAdapter)
        throw failure("synthetic_provider_refused", "Synthetic issuer evidence cannot authorize the real provider adapter. A trusted-host fixture must inject its explicitly synthetic adapter.");
      const onState = (value) => { if (state !== "closed" && value !== "usage_not_recorded") usageState = value; options.onState?.(value); };
      brokerOpening = admission.providerUse === "synthetic"
        ? couponCredentialBroker({ socketPath, provider: admission.provider, credential, coupon, ...options, onState })
        : (async () => {
          holder = couponNearAdapterHolder({ credential, profile: admission.provider, approvalExpiresAtMs: stagingAdmission.expiresAtMs, sessionLifetimeMs: options.sessionLifetimeMs, timeoutMs: options.timeoutMs,
            maxBytes: options.maxBytes, factory: nearAdapterFactory, onState });
          return couponNearCredentialBroker({ socketPath, adapter: holder, timeoutMs: options.timeoutMs, maxBytes: options.maxBytes, onState });
        })();
      let opened;
      try { opened = await brokerOpening; }
      finally { brokerOpening = undefined; }
      if (state === "closed") { await opened.close(); throw failure("session_closed", "This coupon session closed before its broker was installed."); }
      broker = opened; return broker;
    },
    async close() {
      if (closing) return closing;
      state = "closed"; usageState = undefined; credential = undefined; coupon = undefined; accepted = undefined; recipient = undefined;
      roundController?.abort();
      const opening = brokerOpening;
      closing = (async () => {
        await broker?.close();
        await holder?.close();
        if (opening) await (await opening.catch(() => undefined))?.close();
        await client.close(); client = undefined;
      })();
      return closing;
    },
  });
}

// The signed approval bytes come from a file the operator handed over; this reads them with the
// same bounds the verifier enforces, without putting them in argv or the environment.
export function readAttestedCouponAdmissionFile(file, limit) {
  let bytes;
  try { bytes = fs.readFileSync(file); } catch { throw failure("admission_file_refused", `Cannot read ${file}. Nothing was claimed.`); }
  if (bytes.length < 1 || bytes.length > limit) throw failure("admission_file_refused", `${file} is empty or too large. Nothing was claimed.`);
  return bytes;
}

export function admitCouponSessionProvider(config, model, { occupied = false, ambient = false } = {}) {
  const p = config?.couponSession;
  if (!p || Object.keys(p).sort().join(",") !== "baseUrl,mode,models,provider" || p.mode !== "synthetic-loopback" || p.provider !== "synthetic-near"
      || !Array.isArray(p.models) || !p.models.length || p.models.length > 32 || !p.models.every((id) => typeof id === "string" && /^[A-Za-z0-9_./-]{1,120}$/.test(id))
      || !p.models.includes(model)) throw failure("model_not_admitted", "Choose a model explicitly admitted by the synthetic coupon-session profile. Nothing was claimed.");
  let url;
  try { url = new URL(p.baseUrl); } catch { throw failure("provider_not_admitted", "The synthetic provider configuration is invalid. Nothing was claimed."); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/v1")
    throw failure("provider_not_admitted", "The experiment only admits a configured loopback synthetic provider. Nothing was claimed.");
  if (occupied || ambient) throw failure("credential_slot_occupied", "A credential already exists for this provider. Nothing was replaced or claimed. Use a fresh synthetic profile; replacement is not supported.");
  return Object.freeze({ provider: p.provider, baseUrl: url.href, model });
}

// A socket is a scoped provider-use capability, not secret sealing from the host.
export async function couponCredentialBroker({ socketPath, provider, credential, coupon, timeoutMs = 30_000, maxBytes = 2 * 1024 * 1024, onState = () => {} }) {
  admitCouponSessionProvider({ couponSession: { mode: "synthetic-loopback", provider: provider?.provider, baseUrl: provider?.baseUrl, models: [provider?.model] } }, provider?.model);
  if (!/^synthetic-only-coupon-[0-9a-f]{64}$/.test(credential ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(coupon ?? "")) throw failure("broker_configuration", "Only a synthetic session credential is allowed.");
  const dir = fs.lstatSync(path.dirname(socketPath));
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077) || fs.existsSync(socketPath)) throw failure("broker_configuration", "The coupon broker requires an unused socket in a private directory owned by this user.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw failure("broker_configuration", "Invalid coupon broker bounds.");
  const pending = new Set(), sockets = new Set(); let closed = false, closing;
  const answer = (res, status, code) => { if (!res.destroyed && !res.headersSent && !res.writableEnded) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: `coupon session: ${code}`, type: code } })); } };
  const server = http.createServer(async (req, res) => {
    if (pending.size >= 16) return answer(res, 503, "broker_busy");
    const controller = new AbortController(); pending.add(controller);
    const timer = setTimeout(() => { controller.abort(); req.destroy(); res.destroy(); }, timeoutMs); timer.unref();
    res.once("close", () => controller.abort());
    try {
      if (closed || req.method !== "POST" || req.url !== "/v1/chat/completions" || req.headers.authorization !== "Bearer coupon-session") return answer(res, 403, "request_refused");
      const chunks = []; let count = 0;
      for await (const chunk of req) { count += chunk.length; if (count > maxBytes) { answer(res, 413, "request_too_large"); req.destroy(); return; } chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return answer(res, 400, "request_refused"); }
      if (body?.model !== provider.model || !Array.isArray(body.messages) || ["baseUrl", "endpoint", "url", "api_key", "authorization"].some((key) => Object.hasOwn(body, key))) return answer(res, 403, "model_not_admitted");
      const upstream = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual", signal: controller.signal });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        const code = upstream.status === 402 || upstream.status === 429 ? "credit_exhausted" : upstream.status === 401 || upstream.status === 403 ? "access_revoked_or_expired" : "provider_unavailable";
        onState(code); return answer(res, 502, code);
      }
      const contentType = upstream.headers.get("content-type") ?? "";
      if (!/^(application\/json|text\/event-stream)(?:;|$)/i.test(contentType)) { await upstream.body?.cancel(); return answer(res, 502, "provider_response_refused"); }
      const response = []; count = 0;
      for await (const chunk of upstream.body) { count += chunk.length; if (count > maxBytes) { controller.abort(); return answer(res, 502, "provider_response_too_large"); } response.push(chunk); }
      let text = Buffer.concat(response).toString("utf8");
      for (const secret of [credential, coupon]) if (secret) text = text.split(secret).join("[private credential removed]");
      onState("installed");
      res.writeHead(200, { "content-type": contentType }); res.end(text);
    } catch { onState("provider_unavailable"); answer(res, 502, "provider_unavailable"); }
    finally { clearTimeout(timer); pending.delete(controller); }
  });
  server.maxConnections = 32;
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600);
  return Object.freeze({ socketPath, async close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => { for (const c of pending) c.abort(); for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)); fs.rmSync(socketPath, { force: true }); credential = undefined; coupon = undefined; })();
    return closing;
  } });
}
