import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { servePeer } from "../lib/p2p.mjs";
import { couponRecipient } from "../lib/coupon.mjs";
import { canonicalCouponJson, validateCouponOffer, couponOfferClient, couponOfferRecipient, COUPON_PROTOCOL_V2, verifyCouponObservation } from "../lib/coupon-offer.mjs";

const coupon = "a".repeat(43), sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const offerFor = (peerId, budget = "5000000000") => ({ version: 2, coupon_digest: sha(coupon), issuer: { peer_id: peerId, policy: "experimental-local-unattested" }, provider: { id: "synthetic-near", scope_commitment: "ab".repeat(32) }, recipient_subject: "fixture:recipient", delivery_profile: "x25519-aesgcm-session-only", budget_nano_usd: budget, cap_semantics: "nominal-provider-limit", claim_expires_at: "2026-10-11T00:00:00Z", provider_expires_at: null, sponsor_powers: ["revoke", "change_limits"] });
const bundle = (offer) => ({ offer, offer_hash: sha(Buffer.concat([Buffer.from("dsmack-coupon-offer-v2\0"), Buffer.from(canonicalCouponJson(offer))])) });

test("shared synthetic vector has identical canonical offer hash and delivery AAD", () => {
  const vector = JSON.parse(fs.readFileSync(new URL("fixtures/coupon/offer-v2.json", import.meta.url)));
  assert.equal(vector.mode, "synthetic-contract-vector");
  validateCouponOffer({ offer: vector.offer, offer_hash: vector.offer_hash }, { coupon: vector.coupon, peerId: vector.offer.issuer.peer_id });
  assert.equal(canonicalCouponJson({ domain: "dsmack-coupon-delivery-v2", version: 2,
    offer_hash: vector.offer_hash, coupon_digest: vector.offer.coupon_digest, key_id: vector.provider_key_id,
    recipient_key_sha256: sha(Buffer.from(vector.recipient_public_key, "base64")) }), vector.aad_utf8);
});
function delivery(accepted, recipientKey, changes = {}) {
  const keyId = "synthetic-key", rawRecipient = Buffer.from(recipientKey, "base64");
  const aad = Buffer.from(canonicalCouponJson({ domain: "dsmack-coupon-delivery-v2", version: 2, offer_hash: accepted.offer_hash, coupon_digest: sha(coupon), key_id: keyId, recipient_key_sha256: sha(rawRecipient), ...changes }));
  const { privateKey, publicKey } = crypto.generateKeyPairSync("x25519");
  const recipient = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), rawRecipient]), format: "der", type: "spki" });
  const key = crypto.hkdfSync("sha256", crypto.diffieHellman({ privateKey, publicKey: recipient }), Buffer.alloc(0), Buffer.concat([Buffer.from("dsmack-coupon-v1\0"), aad]), 32);
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update("synthetic-secret"), cipher.final(), cipher.getAuthTag()]);
  return { key_id: keyId, envelope: JSON.stringify({ version: 1, aad: aad.toString("base64"), ephemeral: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"), nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64") }) };
}

test("offer schema and hash preserve uint63 precision and reject changed terms or issuer", () => {
  const peerId = "fixturePeer";
  for (const budget of ["1", "9007199254740993", "9223372036854775807"]) validateCouponOffer(bundle(offerFor(peerId, budget)), { coupon, peerId });
  for (const budget of ["0", "01", "+1", "1.0", "1e3", "9223372036854775808", "1".repeat(20), 5_000_000_000]) {
    assert.throws(() => validateCouponOffer(bundle(offerFor(peerId, budget)), { coupon, peerId }), /verification failed/);
  }
  const accepted = bundle(offerFor(peerId));
  for (const change of [ { claim_expires_at: "2026-02-30T00:00:00Z" }, { claim_expires_at: "0000-01-01T00:00:00Z" }, { provider_expires_at: "2026-10-11T00:00:00Z" }, { extra: "unexpected" }, { recipient_subject: "nonascii-é" }, { sponsor_powers: ["change_limits", "revoke"] } ]) {
    assert.throws(() => validateCouponOffer(bundle({ ...accepted.offer, ...change }), { coupon, peerId }), /verification failed/);
  }
  for (const path of ["provider", "issuer"]) {
    const changed = structuredClone(accepted); changed.offer[path][path === "provider" ? "scope_commitment" : "policy"] = "cd".repeat(32);
    assert.throws(() => validateCouponOffer(changed, { coupon, peerId }), /verification failed/);
  }
  assert.throws(() => validateCouponOffer(accepted, { coupon, peerId: "otherPeer" }), /verification failed/);
  assert.throws(() => validateCouponOffer(accepted, { coupon: "b".repeat(43), peerId }), /verification failed/);
});

test("client retains authoritative offers and v2 decryption rejects AAD substitution and v1 downgrade", { timeout: 15_000 }, async () => {
  let currentOffer, claimCalls = 0, selected, extraResult = false, status = { state: "ready", claim_expired: false, accounting_blocked: false, automatic_retry_allowed: false, deposit_release_authorized: false };
  const server = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_PROTOCOL_V2]: async (_lp, send, recv) => {
      const request = await recv();
      if (request.op === "offer") await send({ id: request.id, ok: true, result: currentOffer });
      else if (request.op === "status") await send({ id: request.id, ok: true, result: status });
      else { claimCalls++; assert.equal(request.offer_hash, selected.offer_hash); await send({ id: request.id, ok: true, result: { ...delivery(selected, request.recipient_key), ...(extraResult ? { extra: "unexpected" } : {}) } }); }
    },
  } });
  let client, other;
  try {
    currentOffer = bundle(offerFor(server.peerId.toString()));
    client = await couponOfferClient(String(server.getMultiaddrs()[0]), { dev: true });
    other = await couponOfferClient(String(server.getMultiaddrs()[0]), { dev: true });
    selected = await client.offer(coupon);
    assert.ok(Object.isFrozen(selected.offer.provider));
    const recipient = couponOfferRecipient();
    assert.throws(() => client.claim(coupon, recipient, structuredClone(selected)), /request failed/);
    assert.throws(() => other.claim(coupon, recipient, selected), /request failed/);
    assert.equal(claimCalls, 0);
    assert.equal((await client.status(coupon)).state, "ready");
    const validStatus = status;
    for (const change of [{ extra: "unexpected" }, { key_id: "unexpected-ready-key" }, { state: "delivered" }, { state: "issuing" }, { automatic_retry_allowed: true }, { deposit_release_authorized: true }]) {
      status = { ...validStatus, ...change };
      await assert.rejects(client.status(coupon), /request failed/);
    }
    status = { ...validStatus, state: "delivered", key_id: "bad-key-é" };
    await assert.rejects(client.status(coupon), /request failed/);
    const result = await client.claim(coupon, recipient, selected);
    assert.equal(recipient.decryptDelivery(coupon, result, selected), "synthetic-secret");
    assert.throws(() => recipient.decryptDelivery(coupon, { ...result, extra: "unexpected" }, selected), /verification failed/);
    extraResult = true;
    await assert.rejects(client.claim(coupon, recipient, selected), /request failed/);
    extraResult = false;
    for (const change of [{ offer_hash: "cd".repeat(32) }, { coupon_digest: "cd".repeat(32) }, { key_id: "other-key" }, { recipient_key_sha256: "cd".repeat(32) }, { version: 1 }]) {
      assert.throws(() => recipient.decryptDelivery(coupon, delivery(selected, recipient.publicKey, change), selected), /verification failed/);
    }
    assert.throws(() => couponOfferRecipient().decryptDelivery(coupon, result, selected), /verification failed/);
    assert.throws(() => couponRecipient().decryptDelivery(coupon, result), /verification failed/);
    currentOffer = structuredClone(selected); currentOffer.offer.provider.scope_commitment = "cd".repeat(32);
    await assert.rejects(client.offer(coupon), /verification failed/);
    currentOffer = bundle(currentOffer.offer);
    await assert.rejects(client.offer(coupon, { expectedHash: selected.offer_hash }), /verification failed/);
    currentOffer = bundle(offerFor("another-service"));
    await assert.rejects(client.offer(coupon), /verification failed/);
    const fakeObservation = { payload: { offer_hash: selected.offer_hash } };
    assert.throws(() => verifyCouponObservation(fakeObservation, selected, { coupon, challenge: "ab".repeat(32) }), /verification failed/);
  } finally { await client?.close(); await other?.close(); await server.stop(); }
});
