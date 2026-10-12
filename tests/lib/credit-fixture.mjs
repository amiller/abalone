// SYNTHETIC FIXTURE ONLY: a loopback v4 issuer with synthetic identity evidence, a synthetic staging
// signer and a fixed non-provider credential, shared by the credit unit tests and the CLI session fixture.
import crypto from "node:crypto";
import { servePeer } from "../../lib/p2p.mjs";
import { canonicalCouponJson } from "../../lib/coupon-offer.mjs";
import { couponAttestedClientForTesting, couponAttestedRecipientPeerHash, COUPON_ISSUER_PROTOCOL, COUPON_ISSUER_FRAME_LIMIT, COUPON_PROTOCOL_V4 } from "../../lib/coupon-attested.mjs";
import { creditId } from "../../lib/credit-store.mjs";
import { syntheticIssuerIdentity } from "../fixtures/coupon/issuer-v2.mjs";
import { syntheticStagingSigner } from "../fixtures/coupon/staging-signer.mjs";

export const coupon = "c".repeat(43), id = creditId(coupon), sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
export const credential = "delivered-near-provider-credential-0123456789abcdef";
export const identity = syntheticIssuerIdentity(), issuerKeySha = sha(Buffer.from(identity.info.issuer_public_key_hex, "hex"));
export const signer = syntheticStagingSigner(), scope = "ab".repeat(32);
const approvalTerms = { identityPolicySha256: identity.info.identity_policy_sha256, issuancePolicySha256: identity.info.issuance_policy_sha256,
  issuerPublicKeySha256: issuerKeySha, providerScopeCommitment: scope };
// Durable credit needs the explicitly signed recipient-v1 profile; the legacy approval is for refusal tests.
export const approval = signer.sign({ ...approvalTerms, deliveryProfile: "x25519-aesgcm-recipient-v1" }), legacyApproval = signer.sign(approvalTerms);
export const pin = () => ({ identityPolicy: structuredClone(identity.policy), expectedIdentityPolicySha256: identity.info.identity_policy_sha256,
  expectedIssuancePolicySha256: identity.info.issuance_policy_sha256, expectedIssuerPublicKeySha256: issuerKeySha });
export const provider = { baseUrl: "https://cloud-api.near.ai/v1", model: "selected/model", maxTokens: 4096,
  policy: { gatewayTcb: "UpToDate", modelTcb: "UpToDate", gpuSignature: "required", composeRegistry: { rpc: "https://mainnet.base.org", chainId: 8453 } } };
export const quote = async (hex) => JSON.parse(Buffer.from(hex, "hex").toString());
export const connect = (addr, options, transport) => couponAttestedClientForTesting(addr, { ...options, syntheticQuoteVerifier: quote }, transport);
export const pace = () => new Promise((resolve) => setTimeout(resolve, 220));
export const bundle = (offer) => ({ offer, offer_hash: sha(Buffer.concat([Buffer.from("dsmack-coupon-offer-v4\0"), Buffer.from(canonicalCouponJson(offer))])) });
export const terms = (peerId, profile = "x25519-aesgcm-recipient-v1", code = coupon) => ({ version: 4, coupon_digest: sha(code),
  issuer: { peer_id: peerId, policy: "dstack-tdx-coupon-v1", identity_policy_sha256: identity.info.identity_policy_sha256,
    issuance_policy_sha256: identity.info.issuance_policy_sha256, issuer_public_key_sha256: issuerKeySha },
  provider: { id: "near", scope_commitment: scope }, claim_policy: "first-authenticated-bearer", delivery_profile: profile,
  budget_nano_usd: "5000000000", cap_semantics: "nominal-provider-limit", claim_expires_at: "2030-10-10T00:00:00Z", provider_expires_at: null, sponsor_powers: ["revoke", "change_limits"] });

export function delivery(accepted, recipientKey, peer, code = coupon) {
  const keyId = `near-key-${sha(code).slice(0, 16)}`, recipient = Buffer.from(recipientKey, "base64");
  const aad = Buffer.from(canonicalCouponJson({ domain: "dsmack-coupon-delivery-v4", version: 4, offer_hash: accepted.offer_hash, coupon_digest: sha(code), key_id: keyId,
    recipient_key_sha256: sha(recipient), recipient_peer_sha256: couponAttestedRecipientPeerHash(peer) }));
  const pair = crypto.generateKeyPairSync("x25519"), remote = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), recipient]), format: "der", type: "spki" });
  const key = crypto.hkdfSync("sha256", crypto.diffieHellman({ privateKey: pair.privateKey, publicKey: remote }), Buffer.alloc(0), Buffer.concat([Buffer.from("dsmack-coupon-v1\0"), aad]), 32);
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(credential), cipher.final(), cipher.getAuthTag()]);
  return { key_id: keyId, envelope: JSON.stringify({ version: 1, aad: aad.toString("base64"), ephemeral: pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"), nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64") }) };
}

export async function issuer(profile, code = coupon) {
  // statuses is consumed first (one per bound status frame), then status repeats once a claim was sent; before any claim it is ready.
  // lost answers every v4 frame with the generic failure a losing holder gets once another recipient won.
  const frames = [], state = { claim: "grant", status: "in_progress", statuses: [], claimExpired: false, accountingBlocked: false, lost: false };
  const host = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_ISSUER_PROTOCOL]: { maxDataLength: COUPON_ISSUER_FRAME_LIMIT, timeoutMs: 3000, handle: async (_lp, send, recv) => {
      const frame = await recv();
      await send({ id: frame.id, ok: true, result: frame.op === "info" ? identity.info : identity.evidence(frame.binding) });
    } },
    [COUPON_PROTOCOL_V4]: { timeoutMs: 3000, handle: async (_lp, send, recv, auth) => {
      const frame = await recv(); frames.push({ op: frame.op, peer: auth.remotePeer.toString(), recipient_key: frame.recipient_key });
      if (state.lost) return send({ id: frame.id, ok: false, error: "request_failed" });
      if (frame.op === "offer") return send({ id: frame.id, ok: true, result: state.offer });
      if (frame.op === "claim") {
        if (state.claim === "in_progress") return send({ id: frame.id, ok: true, result: { state: "in_progress", automatic_retry_allowed: false, deposit_release_authorized: false } });
        return send({ id: frame.id, ok: true, result: delivery(state.offer, frame.recipient_key, auth.remotePeer.toString(), code) });
      }
      const current = state.statuses.shift() ?? (frames.some((f) => f.op === "claim") ? state.status : "ready");
      return send({ id: frame.id, ok: true, result: { state: current, claim_expired: state.claimExpired, accounting_blocked: state.accountingBlocked, automatic_retry_allowed: false,
        deposit_release_authorized: false, ...(current === "delivered" ? { key_id: `near-key-${sha(code).slice(0, 16)}` } : {}) } });
    } },
  } });
  state.offer = bundle(terms(host.peerId.toString(), profile, code));
  const address = String(host.getMultiaddrs()[0]);
  return { host, state, frames, admission: { peer: address, pin: pin(), approval: approval.bytes.toString("base64"), approvalRoot: signer.rootHex, provider } };
}
