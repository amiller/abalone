// Experimental prebound local-test profile, not the complete recipient journey.
// Delivery currently binds coupon digest + key ID; provider/account/issuer policy
// and verified-offer bindings still require the shared contract. No persistence,
// installation or production issuer admission is established by these helpers.
import crypto from "node:crypto";
import { lpStream } from "@libp2p/utils";
import { multiaddr } from "@multiformats/multiaddr";
import { node, verifyEvidence } from "./p2p.mjs";

export const COUPON_PROTOCOL = "/dsmack/coupon/1";
export const COUPON_FRAME_LIMIT = 65536;
const ATTEST = "/abalone/attest/1";
const fail = () => new Error("coupon request failed");
const encode = (value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > COUPON_FRAME_LIMIT) throw fail();
  return bytes;
};

// Keep this object for retries: delivery is bound to its X25519 public key.
// Its private key stays in the closure; neither key nor token is persisted here.
export function couponRecipient() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
  const rawPublic = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const b64 = (value, length) => {
    if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw fail();
    const bytes = Buffer.from(value, "base64");
    if (length !== undefined && bytes.length !== length) throw fail();
    return bytes;
  };
  return Object.freeze({
    publicKey: rawPublic.toString("base64"),
    decryptDelivery(coupon, result) {
      try {
        if (typeof coupon !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(coupon) || typeof result?.key_id !== "string" || !result.key_id || typeof result.envelope !== "string") throw fail();
        const value = JSON.parse(result.envelope);
        if (value.version !== 1 || Object.keys(value).sort().join(",") !== "aad,ciphertext,ephemeral,nonce,version") throw fail();
        const aad = Buffer.from(`${crypto.createHash("sha256").update(coupon).digest("hex")}:${result.key_id}`);
        if (!b64(value.aad).equals(aad)) throw fail();
        const ephemeral = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), b64(value.ephemeral, 32)]), format: "der", type: "spki" });
        const shared = crypto.diffieHellman({ privateKey, publicKey: ephemeral });
        const key = crypto.hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.concat([Buffer.from("dsmack-coupon-v1\0"), aad]), 32);
        const encrypted = b64(value.ciphertext);
        if (encrypted.length <= 16) throw fail();
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, b64(value.nonce, 12));
        decipher.setAAD(aad);
        decipher.setAuthTag(encrypted.subarray(-16));
        return Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString("utf8");
      } catch { throw new Error("coupon delivery verification failed"); }
    },
  });
}

// peerAddr must pin /p2p/<PeerId>. Evidence admission finishes before any coupon
// frame is sent. Pass an explicit libp2p privateKey to use an existing grant.
export async function couponClient(peerAddr, admit, { privateKey, timeoutMs = 30_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw fail();
  const addr = multiaddr(peerAddr);
  const peerId = addr.getComponents().findLast((part) => part.name === "p2p")?.value;
  if (!peerId) throw new Error("coupon peer address must pin a PeerId");
  const client = await node([], {}, privateKey);
  let connection, verdict;
  const exchange = async (protocol, frame) => {
    const signal = AbortSignal.timeout(timeoutMs);
    let stream;
    try {
      stream = await connection.newStream(protocol, { runOnLimitedConnection: true, signal });
      const lp = lpStream(stream, { maxDataLength: COUPON_FRAME_LIMIT });
      await lp.write(encode(frame), { signal });
      const response = JSON.parse(Buffer.from((await lp.read({ signal })).subarray()).toString());
      await stream.close({ signal });
      return response;
    } catch {
      stream?.abort(fail());
      throw fail();
    }
  };
  try {
    connection = await client.dial(addr, { signal: AbortSignal.timeout(timeoutMs) });
    if (connection.encryption !== "/noise" || connection.remotePeer.toString() !== peerId) throw fail();
    const nonce = crypto.randomBytes(32).toString("hex");
    const evidence = await exchange(ATTEST, { role: "client", nonce });
    verdict = verifyEvidence(evidence, peerId, client.peerId.toString(), nonce, admit);
  } catch (error) { await client.stop(); throw error; }
  const request = async (op, coupon, fields = {}) => {
    if (typeof coupon !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(coupon)) throw fail();
    const id = crypto.randomBytes(16).toString("hex");
    const response = await exchange(COUPON_PROTOCOL, { id, op, coupon, ...fields });
    if (response?.id !== id || response.ok !== true || !response.result || typeof response.result !== "object") throw fail();
    return response.result;
  };
  return Object.freeze({
    peerId, localPeer: client.peerId.toString(), verdict,
    claim: (coupon, recipient) => request("claim", coupon, { recipient_key: recipient.publicKey }),
    status: (coupon) => request("status", coupon),
    observe: (coupon, { start, end, challenge }) => request("observe", coupon, { start, end, challenge }),
    close: () => client.stop(),
  });
}
