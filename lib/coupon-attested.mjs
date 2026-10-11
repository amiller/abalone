// Connection-bound issuer identity and /4 offer client; custody remains a separate gate.
// Retain both the client transport identity and recipient object for retry.
import crypto from "node:crypto";
import { lpStream } from "@libp2p/utils";
import { multiaddr } from "@multiformats/multiaddr";
import { node } from "./p2p.mjs";
import { COUPON_FRAME_LIMIT } from "./coupon.mjs";
import { canonicalCouponJson, validateCouponOffer } from "./coupon-offer.mjs";
import { verifyCouponStagingAdmission } from "./coupon-staging.mjs";
import { MAC_ISSUER_PROFILE, createMacCouponIssuerVerifier, createMacCouponIssuerVerifierForTesting, macIssuerPolicyHash } from "./mac-coupon-issuer.mjs";
import { issuerPolicyHash } from "./vendor/dstack-issuer/dstack_issuer.mjs";
export const couponIssuerProfile = (policy) => policy?.profile === MAC_ISSUER_PROFILE ? MAC_ISSUER_PROFILE : "dstack-tdx-coupon-v1";
export const couponIssuerPolicyHash = (policy) => policy?.profile === MAC_ISSUER_PROFILE ? macIssuerPolicyHash(policy) : issuerPolicyHash(policy);

export const COUPON_PROTOCOL_V4 = "/dsmack/coupon/4";
export const COUPON_ISSUER_PROTOCOL = "/dsmack/coupon/issuer/2";
export const COUPON_ISSUER_FRAME_LIMIT = 2 * 1024 * 1024;
const acceptedOffers = new WeakMap();
const fail = () => new Error("coupon offer request failed");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const hex = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const token = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const subject = (value) => typeof value === "string" && /^[A-Za-z0-9:_./-]{1,200}$/.test(value);
const freeze = (value) => { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };

export function couponAttestedRecipientPeerHash(peerId) {
  if (typeof peerId !== "string" || !/^[A-Za-z0-9]{1,200}$/.test(peerId)) throw fail();
  return sha(Buffer.concat([Buffer.from("dsmack-coupon-recipient-peer-v4\0"), Buffer.from(peerId, "ascii")]));
}

export function validateAttestedCouponOffer(bundle, { coupon, peerId, issuerInfo, issuerProfile = "dstack-tdx-coupon-v1" } = {}) {
  try {
    if (!["dstack-tdx-coupon-v1", MAC_ISSUER_PROFILE].includes(issuerProfile) || !token(coupon) || !exact(bundle, ["offer", "offer_hash"]) || !hex(bundle.offer_hash)
        || !exact(issuerInfo, ["version", "issuer_public_key_hex", "identity_policy_sha256", "issuance_policy_sha256"])
        || issuerInfo.version !== 2 || ![issuerInfo.issuer_public_key_hex, issuerInfo.identity_policy_sha256, issuerInfo.issuance_policy_sha256].every(hex)) throw fail();
    const offer = bundle.offer;
    if (!exact(offer, ["version", "coupon_digest", "issuer", "provider", "claim_policy", "delivery_profile", "budget_nano_usd", "cap_semantics", "claim_expires_at", "provider_expires_at", "sponsor_powers"])
        || offer.version !== 4 || offer.claim_policy !== "first-authenticated-bearer") throw fail();
    // Reuse the exact common terms validator without changing v2's contract.
    const { claim_policy: _policy, ...reference } = offer;
    if (!exact(offer.issuer, ["peer_id", "policy", "identity_policy_sha256", "issuance_policy_sha256", "issuer_public_key_sha256"])
        || offer.issuer.policy !== issuerProfile || offer.issuer.peer_id !== peerId
        || typeof peerId !== "string" || !/^[A-Za-z0-9]{16,128}$/.test(peerId)
        || !issuerInfo || offer.issuer.identity_policy_sha256 !== issuerInfo.identity_policy_sha256
        || offer.issuer.issuance_policy_sha256 !== issuerInfo.issuance_policy_sha256
        || offer.issuer.issuer_public_key_sha256 !== sha(Buffer.from(issuerInfo.issuer_public_key_hex, "hex"))) throw fail();
    reference.version = 2; reference.recipient_subject = "recipient:unbound";
    reference.issuer = { peer_id: peerId, policy: "experimental-local-unattested" };
    const referenceHash = sha(Buffer.concat([Buffer.from("dsmack-coupon-offer-v2\0"), Buffer.from(canonicalCouponJson(reference), "ascii")]));
    validateCouponOffer({ offer: reference, offer_hash: referenceHash }, { coupon, peerId });
    const expected = sha(Buffer.concat([Buffer.from("dsmack-coupon-offer-v4\0"), Buffer.from(canonicalCouponJson(offer), "ascii")]));
    if (bundle.offer_hash !== expected) throw fail();
    return bundle;
  } catch { throw new Error("coupon offer verification failed"); }
}

const custodyRefused = () => Object.assign(new Error("Issuer identity alone does not qualify private issuance or rollback. No coupon was sent; an independently approved custody policy is required."), { code: "custody_policy_unqualified" });

function validateClaimResult(result) {
  if (exact(result, ["state", "automatic_retry_allowed", "deposit_release_authorized"]) && result.state === "in_progress"
      && result.automatic_retry_allowed === false && result.deposit_release_authorized === false) return result;
  if (!exact(result, ["key_id", "envelope"]) || !subject(result.key_id) || typeof result.envelope !== "string") throw fail();
  return result;
}

function abortable(work, signal) {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(fail());
    if (signal.aborted) { work.catch(() => {}); reject(fail()); return; }
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(fail()); };
    const timer = setTimeout(finish, ms);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

async function attestedClient(peerAddr, options, { privateKey, timeoutMs = 30_000, signal } = {}, synthetic = false) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || signal?.aborted) throw fail();
  if (!hex(options?.expectedIdentityPolicySha256) || !hex(options?.expectedIssuancePolicySha256)
      || (options.expectedIssuerPublicKeySha256 !== undefined && !hex(options.expectedIssuerPublicKeySha256))) throw fail();
  const stagingOption = options?.stagingApproval;
  if (stagingOption !== undefined && (!exact(stagingOption, ["bytes", "approvalRoot"]) || !Buffer.isBuffer(stagingOption.bytes)
      || stagingOption.bytes.length < 1 || stagingOption.bytes.length > 65_536
      || !(hex(stagingOption.approvalRoot) || (Buffer.isBuffer(stagingOption.approvalRoot) && stagingOption.approvalRoot.length === 32)))) throw fail();
  options = { identityPolicy: JSON.parse(JSON.stringify(options.identityPolicy)), expectedIdentityPolicySha256: options.expectedIdentityPolicySha256,
    expectedIssuancePolicySha256: options.expectedIssuancePolicySha256, expectedIssuerPublicKeySha256: options.expectedIssuerPublicKeySha256,
    ...(stagingOption ? { stagingApproval: { bytes: Buffer.from(stagingOption.bytes), approvalRoot: Buffer.isBuffer(stagingOption.approvalRoot) ? Buffer.from(stagingOption.approvalRoot) : stagingOption.approvalRoot } } : {}),
    ...(synthetic ? { syntheticQuoteVerifier: options.syntheticQuoteVerifier, syntheticRunnerVerifier: options.syntheticRunnerVerifier } : {}) };
  const addr = multiaddr(peerAddr), parts = addr.getComponents(), peerId = parts.findLast((p) => p.name === "p2p")?.value;
  if (!peerId || (synthetic && (parts.length !== 3 || parts[0].name !== "ip4" || parts[0].value !== "127.0.0.1" || parts[1].name !== "tcp" || !Number(parts[1].value)))) throw fail();
  const { createDstackIssuerVerifier, createDstackIssuerVerifierForTesting } = await import("./vendor/dstack-issuer/dstack_issuer.mjs");
  const verifierOptions = { policy: options.identityPolicy, expectedPolicySha256: options.expectedIdentityPolicySha256 };
  const issuerProfile = couponIssuerProfile(options.identityPolicy), isMac = issuerProfile === MAC_ISSUER_PROFILE;
  const verifier = isMac
    ? (synthetic ? createMacCouponIssuerVerifierForTesting({ ...verifierOptions, expectedIssuancePolicySha256: options.expectedIssuancePolicySha256, syntheticRunnerVerifier: options.syntheticRunnerVerifier }) : createMacCouponIssuerVerifier({ ...verifierOptions, expectedIssuancePolicySha256: options.expectedIssuancePolicySha256 }))
    : (synthetic ? createDstackIssuerVerifierForTesting({ ...verifierOptions, syntheticQuoteVerifier: options.syntheticQuoteVerifier }) : createDstackIssuerVerifier(verifierOptions));
  const controller = new AbortController(), client = await node([], {}, privateKey), ownOffers = new WeakSet(), attempts = new WeakMap();
  let connection, identity, issuerInfo, stagingAdmission, closed = false, closing, verifying;
  const checkOpen = () => { if (closed || signal?.aborted) throw fail(); };
  const exchange = async (protocol, frame, requestSignal) => {
    checkOpen(); const bound = protocol === COUPON_ISSUER_PROTOCOL ? COUPON_ISSUER_FRAME_LIMIT : COUPON_FRAME_LIMIT;
    const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), controller.signal, ...(signal ? [signal] : []), ...(requestSignal ? [requestSignal] : [])]); let stream;
    try {
      deadline.throwIfAborted();
      const bytes = Buffer.from(JSON.stringify(frame)); if (bytes.length > bound) throw fail();
      stream = await connection.newStream(protocol, { runOnLimitedConnection: true, signal: deadline });
      const lp = lpStream(stream, { maxDataLength: bound }); await lp.write(bytes, { signal: deadline });
      const response = JSON.parse(Buffer.from((await lp.read({ signal: deadline })).subarray()).toString());
      await stream.close({ signal: deadline }); checkOpen();
      if (!exact(response, ["id", "ok", "result"]) || response.id !== frame.id || response.ok !== true) throw fail();
      return response.result;
    } catch { stream?.abort(fail()); throw fail(); }
  };
  const publicRequest = (op, fields = {}) => exchange(COUPON_ISSUER_PROTOCOL, { id: crypto.randomBytes(16).toString("hex"), op, ...fields });
  const verifyIdentity = async () => {
    checkOpen();
    if (!verifying) {
      identity = undefined;
      verifying = (async () => {
      const info = await publicRequest("info");
      if (!exact(info, ["version", "issuer_public_key_hex", "identity_policy_sha256", "issuance_policy_sha256"]) || info.version !== 2
          || ![info.issuer_public_key_hex, info.identity_policy_sha256, info.issuance_policy_sha256].every(hex)
          || info.identity_policy_sha256 !== options.expectedIdentityPolicySha256 || info.issuance_policy_sha256 !== options.expectedIssuancePolicySha256
          || (options.expectedIssuerPublicKeySha256 !== undefined && sha(Buffer.from(info.issuer_public_key_hex, "hex")) !== options.expectedIssuerPublicKeySha256)
          || (issuerInfo && canonicalCouponJson(issuerInfo) !== canonicalCouponJson(info))) throw fail();
      const actualPeer = connection.remotePeer.toString();
      const binding = verifier.challenge({ remotePeer: actualPeer, issuerPublicKeyHex: info.issuer_public_key_hex, ...(isMac ? { recipientPeer: client.peerId.toString() } : {}) });
      const bundle = await publicRequest("evidence", { binding });
      const verified = await verifier.verify(bundle, { remotePeer: actualPeer, ...(isMac ? { recipientPeer: client.peerId.toString() } : {}) }); checkOpen();
      if (verified.scope !== "issuer-identity-only" || verified.peerId !== actualPeer || verified.issuerPublicKeyHex !== info.issuer_public_key_hex
          || verified.policySha256 !== info.identity_policy_sha256 || verified.privateIssuanceQualified !== false || verified.rollbackQualified !== false
          || verified.evidenceStatus !== (synthetic ? "synthetic-only-not-hardware" : (isMac ? "verified-apple-appattest-issuer-identity" : "verified-intel-tdx-identity"))
          || (isMac && (verified.issuerProfile !== issuerProfile || verified.issuancePolicySha256 !== info.issuance_policy_sha256 || verified.recipientPeerId !== client.peerId.toString()))) throw fail();
      let approval;
      if (options.stagingApproval) {
        approval = verifyCouponStagingAdmission(options.stagingApproval.bytes, {
          approvalRoot: options.stagingApproval.approvalRoot, identityPolicySha256: info.identity_policy_sha256,
          issuancePolicySha256: info.issuance_policy_sha256, issuerPublicKeySha256: sha(Buffer.from(info.issuer_public_key_hex, "hex")),
        });
        if (approval.composeHash !== verified.composeSha256
            || (isMac ? approval.issuerProfile !== MAC_ISSUER_PROFILE || approval.cdhash !== verified.cdhash
              || (verified.runtimeAppAttested && approval.appId !== verified.runtimeApp)
              : approval.appId !== verified.appId || approval.issuerProfile !== undefined))
          throw Object.assign(new Error("The signed staging app/compose does not match the freshly verified issuer."), { code: "staging_admission_refused" });
      }
      issuerInfo = freeze(info); identity = verified; stagingAdmission = approval; return identity;
      })();
    }
    const current = verifying;
    try { return await current; }
    catch (error) { identity = undefined; if (["staging_admission_refused", "staging_approval_expired"].includes(error?.code)) throw error; throw fail(); }
    finally { if (verifying === current) verifying = undefined; }
  };
  const close = async () => {
    if (closing) return closing;
    closed = true; controller.abort(); verifier.close(); signal?.removeEventListener("abort", onAbort);
    closing = client.stop(); return closing;
  };
  const onAbort = () => { void close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    connection = await client.dial(addr, { signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), controller.signal, ...(signal ? [signal] : [])]) });
    if (connection.encryption !== "/noise" || connection.remotePeer.toString() !== peerId) throw fail();
    await verifyIdentity();
  } catch (error) {
    await close();
    if (error?.code === "staging_admission_refused" || error?.code === "staging_approval_expired") throw error;
    throw new Error("coupon issuer identity verification failed");
  }
  // Bearer operations stay blocked for the real factory. The one real admission is the signed
  // debug-staging approval verified above: it discloses operator secret access and keeps custody,
  // rollback and settlement qualification explicitly false.
  const requireCustody = () => {
    checkOpen();
    if (!stagingAdmission) { if (synthetic) return; throw custodyRefused(); }
    if (Date.now() >= stagingAdmission.expiresAtMs) throw Object.assign(new Error("The signed debug-staging authorization expired. No further bearer request is authorized; an earlier claim or provider effect may still exist. Preserve the original keys and ask the operator to reconcile."), { code: "staging_approval_expired" });
  };
  const request = async (op, coupon, fields = {}, requestSignal) => {
    requireCustody(); // before inspecting or serializing any bearer material
    if (!token(coupon)) throw fail();
    requestSignal?.throwIfAborted();
    if (verifying || !identity || Date.now() >= identity.expiresAtMs) await abortable(verifyIdentity(), requestSignal);
    requireCustody(); // a fresh identity check must not outlive the signed bearer authorization
    requestSignal?.throwIfAborted();
    return exchange(COUPON_PROTOCOL_V4, { id: crypto.randomBytes(16).toString("hex"), op, coupon, ...fields }, requestSignal);
  };
  const requireOwn = (accepted, coupon) => { requireCustody(); if (!ownOffers.has(accepted)) throw fail(); return retained(accepted, coupon); };
  const recipientFields = (coupon, recipient, accepted) => {
    requireOwn(accepted, coupon); bytes64(recipient?.publicKey, 32);
    return { recipient_key: recipient.publicKey, offer_hash: accepted.offer_hash };
  };
  const claim = (coupon, recipient, accepted, requestSignal) => {
    const fields = recipientFields(coupon, recipient, accepted);
    let keys = attempts.get(accepted); if (!keys) attempts.set(accepted, keys = new Set());
    // Record before sending: a lost acknowledgement may still have reserved the winner.
    keys.add(fields.recipient_key);
    return request("claim", coupon, fields, requestSignal).then(validateClaimResult);
  };
  const status = async (coupon, { recipient, accepted, signal: requestSignal } = {}) => {
    const bound = recipient !== undefined || accepted !== undefined;
    const fields = bound ? recipientFields(coupon, recipient, accepted) : {};
    const result = await request("status", coupon, fields, requestSignal);
    if (!exact(result, ["state", "claim_expired", "accounting_blocked", "automatic_retry_allowed", "deposit_release_authorized", ...(result.key_id === undefined ? [] : ["key_id"])])
        || !["ready", "delivered", "reconciliation_required", ...(bound ? ["in_progress"] : [])].includes(result.state) || (result.key_id !== undefined && !subject(result.key_id))
        || (result.state === "delivered" && result.key_id === undefined) || (["ready", "in_progress"].includes(result.state) && result.key_id !== undefined)
        || typeof result.claim_expired !== "boolean" || typeof result.accounting_blocked !== "boolean" || result.automatic_retry_allowed !== false || result.deposit_release_authorized !== false) throw fail();
    return result;
  };
  return Object.freeze({
    peerId, issuerProfile, localPeer: client.peerId.toString(),
    get identity() { return identity; }, get issuerInfo() { return issuerInfo; }, get stagingAdmission() { return stagingAdmission; },
    custodyQualified: false, rollbackQualified: false,
    refreshIdentity: verifyIdentity,
    async offer(coupon, { expectedHash } = {}) {
      const bundle = validateAttestedCouponOffer(await request("offer", coupon), { coupon, peerId, issuerInfo, issuerProfile });
      const provider = bundle.offer.provider.id;
      // A real provider ("near") is admitted only under the signed debug-staging approval whose
      // exact context matches this offer: the same provider scope commitment and its budget bound.
      if (provider !== "synthetic-near" && (provider !== "near" || !stagingAdmission
          || bundle.offer.provider.scope_commitment !== stagingAdmission.payload.provider_scope_commitment
          || BigInt(bundle.offer.budget_nano_usd) > BigInt(stagingAdmission.maxCouponNanoUsd))) throw fail();
      if (expectedHash !== undefined && (!hex(expectedHash) || expectedHash !== bundle.offer_hash)) throw fail();
      freeze(bundle); ownOffers.add(bundle); acceptedOffers.set(bundle, { localPeer: client.peerId.toString(), identity, issuerInfo }); return bundle;
    },
    claim, status,
    async awaitDelivery(coupon, recipient, accepted, { pollIntervalMs = 1000, timeoutMs: waitMs = 120_000, signal: waitSignal } = {}) {
      const fields = recipientFields(coupon, recipient, accepted);
      if (!attempts.get(accepted)?.has(fields.recipient_key) || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 30_000
          || !Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 600_000) throw fail();
      const deadline = AbortSignal.any([AbortSignal.timeout(waitMs), controller.signal, ...(signal ? [signal] : []), ...(waitSignal ? [waitSignal] : [])]);
      try {
        while (true) {
          const progress = await status(coupon, { recipient, accepted, signal: deadline });
          if (progress.state === "delivered") {
            const result = await claim(coupon, recipient, accepted, deadline);
            if (result.state !== "in_progress") return result;
          } else if (progress.state !== "in_progress") {
            // A bound "ready" whose claim window has closed is an expired unclaimed gift, not a retryable miss.
            if (progress.state === "ready" && progress.claim_expired) throw Object.assign(fail(), { code: "claim_expired" });
            throw Object.assign(fail(), { code: progress.state === "ready" ? "claim_not_reserved" : "claim_reconciliation_required" });
          }
          await pause(pollIntervalMs, deadline);
        }
      } catch (error) {
        // Only a polling-deadline expiry leaves the claim genuinely uncertain: keep the session
        // and the original keys. A caller abort or closing the client rethrows what happened.
        if (deadline.aborted && !controller.signal.aborted && !waitSignal?.aborted) throw Object.assign(new Error("Coupon claim is still uncertain. Keep this session open and poll with the original keys; do not start another issuance."), { code: "claim_pending" });
        throw error;
      }
    },
    async observe(coupon, { start, end, challenge }, accepted, expected = {}) {
      requireOwn(accepted, coupon); const result = await request("observe", coupon, { start, end, challenge });
      verifyAttestedCouponObservation(result, accepted, { ...expected, coupon, start, end, challenge }); return result;
    },
    close,
  });
}

// Genuine DCAP identity probe. There is currently no approved custody capability,
// so its bearer methods remain blocked even after successful hardware admission.
export const couponAttestedClient = (peerAddr, options, transport) => attestedClient(peerAddr, options, transport, false);
// Explicit local fixture boundary; it cannot emit hardware or custody approval.
export const couponAttestedClientForTesting = (peerAddr, options, transport) => attestedClient(peerAddr, options, transport, true);

const bytes64 = (value, length) => {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw fail();
  const bytes = Buffer.from(value, "base64");
  if (length !== undefined && bytes.length !== length) throw fail();
  return bytes;
};
function retained(accepted, coupon) {
  if (!acceptedOffers.has(accepted) || !token(coupon) || accepted.offer.coupon_digest !== sha(coupon)) throw fail();
  return accepted.offer;
}

export function couponAttestedRecipient() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return Object.freeze({
    publicKey: raw.toString("base64"),
    decryptDelivery(coupon, result, accepted) {
      try {
        retained(accepted, coupon);
        if (!exact(result, ["key_id", "envelope"]) || !subject(result.key_id) || typeof result.envelope !== "string") throw fail();
        const envelope = JSON.parse(result.envelope);
        if (!exact(envelope, ["version", "aad", "ephemeral", "nonce", "ciphertext"]) || envelope.version !== 1) throw fail();
        const aad = Buffer.from(canonicalCouponJson({ domain: "dsmack-coupon-delivery-v4", version: 4,
          offer_hash: accepted.offer_hash, coupon_digest: accepted.offer.coupon_digest, key_id: result.key_id, recipient_key_sha256: sha(raw),
          recipient_peer_sha256: couponAttestedRecipientPeerHash(acceptedOffers.get(accepted).localPeer) }), "ascii");
        if (!bytes64(envelope.aad).equals(aad)) throw fail();
        const ephemeral = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), bytes64(envelope.ephemeral, 32)]), format: "der", type: "spki" });
        const shared = crypto.diffieHellman({ privateKey, publicKey: ephemeral });
        const key = crypto.hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.concat([Buffer.from("dsmack-coupon-v1\0"), aad]), 32);
        const ciphertext = bytes64(envelope.ciphertext);
        if (ciphertext.length <= 16) throw fail();
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes64(envelope.nonce, 12));
        decipher.setAAD(aad); decipher.setAuthTag(ciphertext.subarray(-16));
        return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString("utf8");
      } catch { throw new Error("coupon offer delivery verification failed"); }
    },
  });
}

// Integrity and accepted-terms binding only. A supplied expectedPublicKey can pin
// a local observer key; neither this nor self-contained signature verification
// authenticates an approved measured observer or authorizes deposit release.
export function verifyAttestedCouponObservation(bundle, accepted, { coupon, challenge, start, end, recipientPeer, expectedPublicKey, keyId, recipientKey, envelope } = {}) {
  try {
    const offer = retained(accepted, coupon), payload = bundle?.payload;
    if (!hex(challenge) || !exact(bundle, ["payload", "public_key", "signature"])
        || !exact(payload, ["domain", "version", "environment", "evidence_id", "challenge", "coupon_digest", "key_id", "provider", "threshold_nano_usd", "provider_reported_nano_usd", "start_time", "end_time", "delivery_sha256", "recipient_sha256", "recipient_peer_sha256", "offer_hash"])
        || payload.domain !== "dsmack-coupon-observation-v4" || payload.version !== 4 || payload.environment !== "local-unattested"
        || payload.recipient_peer_sha256 !== couponAttestedRecipientPeerHash(recipientPeer)
        || payload.challenge !== challenge || payload.offer_hash !== accepted.offer_hash || payload.coupon_digest !== offer.coupon_digest
        || payload.provider !== offer.provider.id || payload.threshold_nano_usd !== offer.budget_nano_usd
        || typeof payload.start_time !== "string" || typeof payload.end_time !== "string"
        || !/^[0-9T:Z+.-]{1,40}$/.test(payload.start_time) || !/^[0-9T:Z+.-]{1,40}$/.test(payload.end_time)
        || (start !== undefined && payload.start_time !== start) || (end !== undefined && payload.end_time !== end)
        || !subject(payload.key_id) || !hex(payload.evidence_id) || !hex(payload.delivery_sha256) || !hex(payload.recipient_sha256)
        || typeof payload.provider_reported_nano_usd !== "string" || !/^(0|[1-9][0-9]{0,38})$/.test(payload.provider_reported_nano_usd)
        || (keyId !== undefined && payload.key_id !== keyId)
        || (recipientKey !== undefined && payload.recipient_sha256 !== sha(bytes64(recipientKey, 32)))
        || (envelope !== undefined && payload.delivery_sha256 !== sha(envelope))) throw fail();
    const rawPublic = bytes64(bundle.public_key, 32);
    if (expectedPublicKey !== undefined && !rawPublic.equals(bytes64(expectedPublicKey, 32))) throw fail();
    const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawPublic]), format: "der", type: "spki" });
    if (!crypto.verify(null, Buffer.from(canonicalCouponJson(payload), "ascii"), publicKey, bytes64(bundle.signature, 64))) throw fail();
    return payload;
  } catch { throw new Error("coupon observation verification failed"); }
}
