// Optional two-repository synthetic integration; never reads operator state.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { lpStream } from "@libp2p/utils";
import { multiaddr } from "@multiformats/multiaddr";
import { node, servePeer } from "../lib/p2p.mjs";
import { couponClient, couponRecipient, COUPON_PROTOCOL } from "../lib/coupon.mjs";
import { couponOfferClient, couponOfferRecipient, COUPON_PROTOCOL_V2, verifyCouponObservation } from "../lib/coupon-offer.mjs";

const source = process.env.DSMACK_CODE_DIR;
if (!source || !path.isAbsolute(source)) throw new Error("Set DSMACK_CODE_DIR to an absolute dsmack code checkout");
const { createCouponPeerService } = await import(pathToFileURL(path.join(source, "experiments/coupon_redemption/peer_bridge.mjs")));
assert.deepEqual(JSON.parse(await fs.readFile(path.join(source, "experiments/coupon_redemption/fixtures/offer-v2.json"))),
  JSON.parse(await fs.readFile(new URL("fixtures/coupon/offer-v2.json", import.meta.url))), "both repositories carry the same synthetic contract vector");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "abalone-coupon-e2e-"));
const keys = await Promise.all(Array.from({ length: 7 }, () => generateKeyPair("Ed25519")));
const identities = await Promise.all(keys.map((privateKey) => node([], {}, privateKey)));
const [sponsorPeer, recipientPeer, observerPeer, attackerPeer, issuerPeer, rawRecipientPeer, legacyRecipientPeer] = identities.map((peer) => peer.peerId.toString());
const context = (remotePeer, protocol = COUPON_PROTOCOL_V2) => ({ authenticated: true, transport: "noise", protocol, remotePeer, localPeer: issuerPeer });
let bridge, peer, recipientClient, observerClient, attackerClient, legacyClient, provider;
let stage = "protected setup";
const frames = [], logs = [], originalError = console.error;
console.error = (...args) => logs.push(args.join(" "));
try {
  await Promise.all(identities.map((identity) => identity.stop()));
  const configPath = path.join(directory, "config.json"), stateDir = path.join(directory, "state");
  await fs.writeFile(configPath, JSON.stringify({ version: 1, state_dir: stateDir, issuer_peer_id: issuerPeer, sponsor_subject: "test:sponsor", observer_subject: "test:observer", peers: {
    [sponsorPeer]: { subject: "test:sponsor", roles: ["sponsor"] },
    [recipientPeer]: { subject: "test:recipient", roles: ["recipient"] },
    [observerPeer]: { subject: "test:observer", roles: ["observer"] },
    // Protected fixture aliases avoid starting multiple live libp2p nodes with
    // one transport identity; they intentionally map to the same service grant.
    [rawRecipientPeer]: { subject: "test:recipient", roles: ["recipient"] },
    [legacyRecipientPeer]: { subject: "test:recipient", roles: ["recipient"] },
  }, provider: { mode: "synthetic" } }), { mode: 0o600 });
  bridge = await createCouponPeerService({ configPath, cwd: source });
  peer = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], privateKey: keys[4], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_PROTOCOL]: bridge.service,
    [COUPON_PROTOCOL_V2]: { ...bridge.serviceV2, handle: (lp, send, recv, auth) => bridge.serviceV2.handle(lp,
      (bytes) => { frames.push(Buffer.from(bytes).toString()); return send(bytes); },
      async () => { const bytes = await recv(); frames.push(bytes.toString()); return bytes; }, auth) },
  } });
  const address = String(peer.getMultiaddrs()[0]);
  const expiry = new Date(Date.now() + 5000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const provisioned = await bridge.provisionV2(context(sponsorPeer), "5000000000", recipientPeer, expiry);
  const coupon = provisioned.coupon;
  assert.equal(provisioned.deposit_release_authorized, false);
  stage = "recipient connection";
  recipientClient = await couponOfferClient(address, { dev: true }, { privateKey: keys[1] });
  stage = "observer connection";
  observerClient = await couponOfferClient(address, { dev: true }, { privateKey: keys[2] });
  stage = "attacker connection";
  attackerClient = await couponOfferClient(address, { dev: true }, { privateKey: keys[3] });
  stage = "legacy connection";
  legacyClient = await couponClient(address, { dev: true }, { privateKey: keys[6] });
  assert.equal(recipientClient.localPeer, recipientPeer);
  stage = "unauthorized frames";
  const recipient = couponOfferRecipient();
  await assert.rejects(attackerClient.offer(coupon), /request failed/);
  await assert.rejects(attackerClient.status(coupon), /request failed/);
  // Raw attacker fields cannot override transport identity or strict parsing.
  const rawAttacker = await node([], {}, keys[3]);
  try {
    for (const raw of [JSON.stringify({ id: "spoof", op: "claim", coupon, recipient_key: recipient.publicKey, offer_hash: provisioned.offer_hash, peerId: recipientPeer, roles: ["recipient"] }),
      `{"id":"dup","op":"status","coupon":"${coupon}","coupon":"${coupon}"}`,
      JSON.stringify({ id: "provision", op: "provision", coupon, budget: 1 })]) {
      const stream = await rawAttacker.dialProtocol(multiaddr(address), COUPON_PROTOCOL_V2), lp = lpStream(stream);
      await lp.write(Buffer.from(raw));
      assert.equal(JSON.parse(Buffer.from((await lp.read({ signal: AbortSignal.timeout(5000) })).subarray())).ok, false);
      await stream.close();
    }
  } finally { await rawAttacker.stop(); }
  // libp2p admits five connections per source IP per second by default. Pace
  // this larger same-host fixture instead of changing the transport's limit.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const rawRecipient = await node([], {}, keys[5]);
  stage = "strict duplicate frame";
  try {
    const stream = await rawRecipient.dialProtocol(multiaddr(address), COUPON_PROTOCOL_V2), lp = lpStream(stream);
    await lp.write(Buffer.from(`{"id":"dup","op":"status","coupon":"${coupon}","coupon":"${coupon}"}`));
    assert.equal(JSON.parse(Buffer.from((await lp.read({ signal: AbortSignal.timeout(5000) })).subarray())).ok, false);
    await stream.close();
  } finally { await rawRecipient.stop(); }
  const accepted = await recipientClient.offer(coupon);
  stage = "concurrent claim";
  assert.equal(accepted.offer_hash, provisioned.offer_hash, "Python and Node exact canonical hashes match");
  assert.equal(accepted.offer.issuer.peer_id, issuerPeer);
  assert.equal(accepted.offer.provider_expires_at, null);
  const [result, concurrentReplay] = await Promise.all([recipientClient.claim(coupon, recipient, accepted), recipientClient.claim(coupon, recipient, accepted)]);
  assert.deepEqual(concurrentReplay, result, "concurrent claims share exactly one issuance and envelope");
  const credential = recipient.decryptDelivery(coupon, result, accepted);
  assert.ok(credential.startsWith("synthetic-only-"));
  assert.equal((await recipientClient.status(coupon)).state, "delivered");
  assert.deepEqual(await recipientClient.claim(coupon, recipient, accepted), result);
  await assert.rejects(recipientClient.claim(coupon, couponOfferRecipient(), accepted), /request failed/);
  await assert.rejects(legacyClient.claim(coupon, couponRecipient()), /request failed/);
  const legacy = await bridge.provision(context(sponsorPeer, COUPON_PROTOCOL), 5_000_000_000, recipientPeer);
  stage = "legacy compatibility";
  await assert.rejects(recipientClient.offer(legacy.coupon), /request failed/);
  const legacyRecipient = couponRecipient(), legacyResult = await legacyClient.claim(legacy.coupon, legacyRecipient);
  assert.ok(legacyRecipient.decryptDelivery(legacy.coupon, legacyResult).startsWith("synthetic-only-"));
  // Expired ready coupons cannot issue. Precision-edge offers retain exact terms.
  const expired = await bridge.provisionV2(context(sponsorPeer), "9223372036854775807", recipientPeer, "2000-01-01T00:00:00Z");
  stage = "expiry and restart";
  const expiredOffer = await recipientClient.offer(expired.coupon);
  assert.equal(expiredOffer.offer.budget_nano_usd, "9223372036854775807");
  assert.equal((await recipientClient.status(expired.coupon)).claim_expired, true);
  await assert.rejects(recipientClient.claim(expired.coupon, couponOfferRecipient(), expiredOffer), /request failed/);
  await bridge.restart();
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(expiry) - Date.now() + 25)));
  assert.equal((await recipientClient.status(coupon)).claim_expired, true);
  assert.deepEqual(await recipientClient.claim(coupon, recipient, accepted), result, "delivered same-key replay survives claim expiry");
  assert.deepEqual(await recipientClient.offer(coupon), accepted, "offer and scope commitment remain stable through restart");
  // Direct inference is a loopback fixture. No prompt enters the coupon bridge.
  let directCalls = 0;
  stage = "direct provider use";
  const prompt = "synthetic-direct-prompt-canary";
  provider = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${credential}`);
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), prompt);
    directCalls++; response.end("synthetic-useful-result");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const direct = await fetch(`http://127.0.0.1:${provider.address().port}/inference`, { method: "POST", headers: { authorization: `Bearer ${credential}` }, body: prompt });
  assert.equal(await direct.text(), "synthetic-useful-result"); assert.equal(directCalls, 1);
  const challenge = crypto.randomBytes(32).toString("hex");
  stage = "bound observation";
  const observerOffer = await observerClient.offer(coupon);
  const observerPrivate = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), await fs.readFile(path.join(stateDir, "observer.key"))]), format: "der", type: "pkcs8" });
  const expectedPublicKey = crypto.createPublicKey(observerPrivate).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const observation = await observerClient.observe(coupon, { start: "2026-10-10T00:00:00Z", end: "2026-10-11T00:00:00Z", challenge }, observerOffer, { expectedPublicKey, keyId: result.key_id, recipientKey: recipient.publicKey, envelope: result.envelope });
  assert.equal(observation.payload.challenge, challenge);
  assert.equal(observation.payload.environment, "local-unattested");
  assert.equal(observation.payload.offer_hash, accepted.offer_hash);
  for (const change of [{ offer_hash: "cd".repeat(32) }, { coupon_digest: "cd".repeat(32) }, { provider: "near" }, { threshold_nano_usd: "5000000001" }, { challenge: "cd".repeat(32) }]) {
    assert.throws(() => verifyCouponObservation({ ...observation, payload: { ...observation.payload, ...change } }, accepted, { coupon, challenge, expectedPublicKey }), /verification failed/);
  }
  assert.throws(() => verifyCouponObservation(observation, accepted, { coupon, challenge, expectedPublicKey: Buffer.alloc(32).toString("base64") }), /verification failed/);
  await assert.rejects(recipientClient.observe(coupon, { start: "2026-10-10T00:00:00Z", end: "2026-10-11T00:00:00Z", challenge }, accepted), /request failed/);
  const counts = JSON.parse(execFileSync("python3", ["-c", "import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(dict(c.execute('SELECT kind,COUNT(*) FROM synthetic_events GROUP BY kind'))))", path.join(stateDir, "state.sqlite")], { encoding: "utf8" }));
  assert.deepEqual(counts, { create: 2, read: 1 });
  assert.ok([...frames, ...logs].every((text) => !text.includes(credential) && !text.includes(prompt)));
  assert.ok(logs.every((text) => !text.includes(coupon)));
  console.log(JSON.stringify({ mode: "synthetic-offer-binding-e2e", accepted_offer_bound: true, cross_protocol_denied: true, concurrent_replay: true, replay_after_expiry: true, expired_initial_claim_denied: true, restart_replay: true, direct_provider_calls: directCalls, provider_creates: counts.create, observation_offer_bound: true, v1_compatible: true, environment: "local-unattested", deposit_release_authorized: false }));
} catch (error) {
  throw new Error(`Synthetic offer integration failed during ${stage}`, { cause: error });
} finally {
  console.error = originalError;
  await Promise.all([recipientClient?.close(), observerClient?.close(), attackerClient?.close(), legacyClient?.close(), peer?.stop(), bridge?.close(), ...identities.map((identity) => identity.stop())]);
  if (provider) await new Promise((resolve) => provider.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
