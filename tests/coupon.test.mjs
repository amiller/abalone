import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { servePeer } from "../lib/p2p.mjs";
import { couponClient, couponRecipient, COUPON_PROTOCOL, COUPON_FRAME_LIMIT } from "../lib/coupon.mjs";

const coupon = "a".repeat(43);
const keyId = "synthetic-key-id";
const secret = "synthetic-provider-secret";
function delivery(recipientKey) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
  const recipient = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(recipientKey, "base64")]), format: "der", type: "spki" });
  const aad = Buffer.from(`${crypto.createHash("sha256").update(coupon).digest("hex")}:${keyId}`);
  const key = crypto.hkdfSync("sha256", crypto.diffieHellman({ privateKey, publicKey: recipient }), Buffer.alloc(0), Buffer.concat([Buffer.from("dsmack-coupon-v1\0"), aad]), 32);
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final(), cipher.getAuthTag()]);
  return { key_id: keyId, envelope: JSON.stringify({ version: 1, aad: aad.toString("base64"), ephemeral: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"), nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64") }) };
}

test("recipient delivery checks coupon, key, recipient and AEAD integrity", () => {
  const recipient = couponRecipient(), result = delivery(recipient.publicKey);
  assert.equal(recipient.decryptDelivery(coupon, result), secret);
  assert.equal(recipient.decryptDelivery(coupon, result), secret, "same delivery replays safely with retained recipient key");
  assert.throws(() => recipient.decryptDelivery("b".repeat(43), result), /verification failed/);
  assert.throws(() => recipient.decryptDelivery(coupon, { ...result, key_id: "other" }), /verification failed/);
  assert.throws(() => couponRecipient().decryptDelivery(coupon, result), /verification failed/);
  const envelope = JSON.parse(result.envelope), bytes = Buffer.from(envelope.ciphertext, "base64");
  bytes[0] ^= 1; envelope.ciphertext = bytes.toString("base64");
  assert.throws(() => recipient.decryptDelivery(coupon, { ...result, envelope: JSON.stringify(envelope) }), /verification failed/);
});

test("experimental client verifies service before claim, and supports claim/status/observe frames", { timeout: 15_000 }, async () => {
  let calls = 0;
  const server = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_PROTOCOL]: { raw: true, maxDataLength: COUPON_FRAME_LIMIT, handle: async (_lp, send, recv, context) => {
      const q = JSON.parse(await recv()); calls++;
      assert.equal(context.authenticated, true);
      assert.equal(q.coupon, coupon);
      const result = q.op === "claim" ? delivery(q.recipient_key) : q.op === "status" ? { state: "delivered", deposit_release_authorized: false } : { challenge: q.challenge, environment: "local-unattested" };
      await send(Buffer.from(JSON.stringify({ id: q.id, ok: true, result })));
    } },
  } });
  let client;
  try {
    const address = String(server.getMultiaddrs()[0]);
    await assert.rejects(couponClient(address, { dev: false }), /refused/);
    assert.equal(calls, 0);
    client = await couponClient(address, { dev: true });
    const recipient = couponRecipient();
    const result = await client.claim(coupon, recipient);
    assert.equal(recipient.decryptDelivery(coupon, result), secret);
    assert.equal((await client.status(coupon)).state, "delivered");
    assert.equal((await client.observe(coupon, { start: "2026-10-10T00:00:00Z", end: "2026-10-11T00:00:00Z", challenge: "ab".repeat(32) })).environment, "local-unattested");
    await assert.rejects(client.status("bad"), /request failed/);
    assert.equal(calls, 3);
  } finally { await client?.close(); await server.stop(); }
});

test("client rejects unmatched replies and ends bounded stalled requests", { timeout: 15_000 }, async () => {
  const server = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_PROTOCOL]: { handle: async (_lp, send, recv) => { const q = await recv(); if (q.op === "status") await send({ id: "wrong", ok: true, result: {} }); else await new Promise((resolve) => setTimeout(resolve, 500)); } },
  } });
  let client;
  try {
    client = await couponClient(String(server.getMultiaddrs()[0]), { dev: true }, { timeoutMs: 250 });
    await assert.rejects(client.status(coupon), /request failed/);
    await assert.rejects(client.claim(coupon, couponRecipient()), /request failed/);
  } finally { await client?.close(); await server.stop(); }
});
