// Reusable offer-binding experiment. Prebound recipients are fixtures here;
// accountless release acceptance, installation and issuer qualification remain open.
import crypto from "node:crypto";
import { lpStream } from "@libp2p/utils";
import { multiaddr } from "@multiformats/multiaddr";
import { node, verifyEvidence } from "./p2p.mjs";
import { COUPON_FRAME_LIMIT } from "./coupon.mjs";

export const COUPON_PROTOCOL_V2 = "/dsmack/coupon/2";
const POLICY = "experimental-local-unattested";
const acceptedOffers = new WeakSet();
const fail = () => new Error("coupon offer request failed");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const exact = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const hex = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const token = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const subject = (value) => typeof value === "string" && /^[A-Za-z0-9:_./-]{1,200}$/.test(value);
const freeze = (value) => { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };

export function canonicalCouponJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalCouponJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalCouponJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function validateCouponOffer(bundle, { coupon, peerId } = {}) {
  try {
    if (!token(coupon) || !exact(bundle, ["offer", "offer_hash"]) || !hex(bundle.offer_hash)) throw fail();
    const offer = bundle.offer;
    if (!exact(offer, ["version", "coupon_digest", "issuer", "provider", "recipient_subject", "delivery_profile", "budget_nano_usd", "cap_semantics", "claim_expires_at", "provider_expires_at", "sponsor_powers"])
        || offer.version !== 2 || offer.coupon_digest !== sha(coupon)
        || !exact(offer.issuer, ["peer_id", "policy"]) || offer.issuer.peer_id !== peerId
        || typeof peerId !== "string" || !/^[A-Za-z0-9]{1,200}$/.test(peerId) || offer.issuer.policy !== POLICY
        || !exact(offer.provider, ["id", "scope_commitment"]) || !["near", "synthetic-near"].includes(offer.provider.id)
        || !hex(offer.provider.scope_commitment) || !subject(offer.recipient_subject)
        || offer.delivery_profile !== "x25519-aesgcm-session-only" || offer.cap_semantics !== "nominal-provider-limit"
        || offer.provider_expires_at !== null || !Array.isArray(offer.sponsor_powers)
        || JSON.stringify(offer.sponsor_powers) !== '["revoke","change_limits"]'
        || typeof offer.budget_nano_usd !== "string" || !/^[1-9][0-9]{0,18}$/.test(offer.budget_nano_usd)
        || BigInt(offer.budget_nano_usd) > 9223372036854775807n
        || typeof offer.claim_expires_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(offer.claim_expires_at)
        || offer.claim_expires_at.startsWith("0000-")
        || new Date(offer.claim_expires_at).toISOString().replace(".000Z", "Z") !== offer.claim_expires_at) throw fail();
    const expected = sha(Buffer.concat([Buffer.from("dsmack-coupon-offer-v2\0"), Buffer.from(canonicalCouponJson(offer), "ascii")]));
    if (bundle.offer_hash !== expected) throw fail();
    return bundle;
  } catch { throw new Error("coupon offer verification failed"); }
}

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

export function couponOfferRecipient() {
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
        const aad = Buffer.from(canonicalCouponJson({ domain: "dsmack-coupon-delivery-v2", version: 2,
          offer_hash: accepted.offer_hash, coupon_digest: accepted.offer.coupon_digest, key_id: result.key_id, recipient_key_sha256: sha(raw) }), "ascii");
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
export function verifyCouponObservation(bundle, accepted, { coupon, challenge, start, end, expectedPublicKey, keyId, recipientKey, envelope } = {}) {
  try {
    const offer = retained(accepted, coupon), payload = bundle?.payload;
    if (!hex(challenge) || !exact(bundle, ["payload", "public_key", "signature"])
        || !exact(payload, ["domain", "version", "environment", "evidence_id", "challenge", "coupon_digest", "key_id", "provider", "threshold_nano_usd", "provider_reported_nano_usd", "start_time", "end_time", "delivery_sha256", "recipient_sha256", "offer_hash"])
        || payload.domain !== "dsmack-coupon-observation-v2" || payload.version !== 2 || payload.environment !== "local-unattested"
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

export async function couponOfferClient(peerAddr, admit, { privateKey, timeoutMs = 30_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw fail();
  const addr = multiaddr(peerAddr), peerId = addr.getComponents().findLast((part) => part.name === "p2p")?.value;
  if (!peerId) throw fail();
  const client = await node([], {}, privateKey), ownOffers = new WeakSet();
  let connection, verdict;
  const exchange = async (protocol, frame) => {
    const signal = AbortSignal.timeout(timeoutMs); let stream;
    try {
      const bytes = Buffer.from(JSON.stringify(frame)); if (bytes.length > COUPON_FRAME_LIMIT) throw fail();
      stream = await connection.newStream(protocol, { runOnLimitedConnection: true, signal });
      const lp = lpStream(stream, { maxDataLength: COUPON_FRAME_LIMIT });
      await lp.write(bytes, { signal });
      const response = JSON.parse(Buffer.from((await lp.read({ signal })).subarray()).toString());
      await stream.close({ signal }); return response;
    } catch { stream?.abort(fail()); throw fail(); }
  };
  try {
    connection = await client.dial(addr, { signal: AbortSignal.timeout(timeoutMs) });
    if (connection.encryption !== "/noise" || connection.remotePeer.toString() !== peerId) throw fail();
    const nonce = crypto.randomBytes(32).toString("hex");
    verdict = verifyEvidence(await exchange("/abalone/attest/1", { role: "client", nonce }), peerId, client.peerId.toString(), nonce, admit);
  } catch (error) { await client.stop(); throw error; }
  const request = async (op, coupon, fields = {}) => {
    if (!token(coupon)) throw fail();
    const id = crypto.randomBytes(16).toString("hex");
    const response = await exchange(COUPON_PROTOCOL_V2, { id, op, coupon, ...fields });
    if (response?.id !== id || response.ok !== true || !response.result || typeof response.result !== "object") throw fail();
    return response.result;
  };
  const requireOwn = (accepted, coupon) => { if (!ownOffers.has(accepted)) throw fail(); return retained(accepted, coupon); };
  return Object.freeze({
    peerId, localPeer: client.peerId.toString(), verdict,
    async offer(coupon, { expectedHash } = {}) {
      const bundle = validateCouponOffer(await request("offer", coupon), { coupon, peerId });
      if (expectedHash !== undefined && (!hex(expectedHash) || bundle.offer_hash !== expectedHash)) throw new Error("coupon offer verification failed");
      freeze(bundle); ownOffers.add(bundle); acceptedOffers.add(bundle); return bundle;
    },
    claim(coupon, recipient, accepted) {
      requireOwn(accepted, coupon);
      return request("claim", coupon, { recipient_key: recipient.publicKey, offer_hash: accepted.offer_hash }).then((result) => {
        if (!exact(result, ["key_id", "envelope"]) || !subject(result.key_id) || typeof result.envelope !== "string") throw fail();
        return result;
      });
    },
    async status(coupon) {
      const result = await request("status", coupon);
      if (!exact(result, ["state", "claim_expired", "accounting_blocked", "automatic_retry_allowed", "deposit_release_authorized", ...(result.key_id === undefined ? [] : ["key_id"])])
          || !["ready", "delivered", "reconciliation_required"].includes(result.state)
          || (result.key_id !== undefined && !subject(result.key_id))
          || (result.state === "delivered" && result.key_id === undefined)
          || (result.state === "ready" && result.key_id !== undefined)
          || typeof result.claim_expired !== "boolean" || typeof result.accounting_blocked !== "boolean"
          || result.automatic_retry_allowed !== false || result.deposit_release_authorized !== false) throw fail();
      return result;
    },
    async observe(coupon, { start, end, challenge }, accepted, expected = {}) {
      requireOwn(accepted, coupon);
      const result = await request("observe", coupon, { start, end, challenge });
      verifyCouponObservation(result, accepted, { ...expected, coupon, challenge, start, end }); return result;
    },
    close: () => client.stop(),
  });
}
