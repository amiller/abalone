// Synthetic accountless claim over actual local Noise peers. No operator state.
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
import { couponClient, COUPON_PROTOCOL } from "../lib/coupon.mjs";
import { couponOfferClient, COUPON_PROTOCOL_V2 } from "../lib/coupon-offer.mjs";
import { couponAccountlessClient, couponAccountlessRecipient, COUPON_PROTOCOL_V3, couponRecipientPeerHash, verifyAccountlessCouponObservation } from "../lib/coupon-accountless.mjs";

const source = process.env.DSMACK_CODE_DIR;
if (!source || !path.isAbsolute(source)) throw new Error("Set DSMACK_CODE_DIR to an absolute dsmack code checkout");
const { createCouponPeerService } = await import(pathToFileURL(path.join(source, "experiments/coupon_redemption/peer_bridge.mjs")));
assert.deepEqual(JSON.parse(await fs.readFile(path.join(source, "experiments/coupon_redemption/fixtures/offer-v3.json"))),
  JSON.parse(await fs.readFile(new URL("fixtures/coupon/offer-v3.json", import.meta.url))));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "abalone-accountless-e2e-"));
const keys = await Promise.all(Array.from({ length: 6 }, () => generateKeyPair("Ed25519")));
const initial = await Promise.all(keys.map((privateKey) => node([], {}, privateKey)));
const [sponsorPeer, observerPeer, issuerPeer, peerA, peerB, legacyPeer] = initial.map((peer) => peer.peerId.toString());
await Promise.all(initial.map((peer) => peer.stop()));
const context = (protocol = COUPON_PROTOCOL_V3, localPeer = issuerPeer) => ({ authenticated: true, transport: "noise", protocol, remotePeer: sponsorPeer, localPeer });
const counts = (stateDir) => JSON.parse(execFileSync("python3", ["-c", "import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(dict(c.execute('SELECT kind,COUNT(*) FROM synthetic_events GROUP BY kind'))))", path.join(stateDir, "state.sqlite")], { encoding: "utf8" }));
const config = (stateDir, issuer = issuerPeer) => ({ version: 1, state_dir: stateDir, issuer_peer_id: issuer,
  sponsor_subject: "test:sponsor", observer_subject: "test:observer", peers: {
    [sponsorPeer]: { subject: "test:sponsor", roles: ["sponsor"] },
    [observerPeer]: { subject: "test:observer", roles: ["observer"] },
    [legacyPeer]: { subject: "test:legacy", roles: ["recipient"] },
  }, provider: { mode: "synthetic" } }); // Neither accountless recipient is registered.
const resources = [], frames = [], logs = [], originalError = console.error;
let provider, stage = "setup", lostRequestSeen;
console.error = (...args) => logs.push(args.join(" "));
try {
  const stateDir = path.join(directory, "state"), configPath = path.join(directory, "config.json");
  assert.ok([peerA, peerB].every((recipientPeer) => !(recipientPeer in config(stateDir).peers)), "accountless claimants have no configured grant or roles");
  await fs.writeFile(configPath, JSON.stringify(config(stateDir)), { mode: 0o600 });
  const bridge = await createCouponPeerService({ configPath, cwd: source }); resources.push(() => bridge.close());
  const peer = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], privateKey: keys[2], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_PROTOCOL]: bridge.service, [COUPON_PROTOCOL_V2]: bridge.serviceV2,
    [COUPON_PROTOCOL_V3]: { ...bridge.serviceV3, handle: (lp, send, recv, auth) => bridge.serviceV3.handle(lp,
      (bytes) => { frames.push(bytes.toString()); return send(bytes); },
      async () => { const bytes = await recv(); frames.push(bytes.toString()); if (JSON.parse(bytes).id === "lostack") lostRequestSeen?.(); return bytes; }, auth) },
  } }); resources.push(() => peer.stop());
  const address = String(peer.getMultiaddrs()[0]);
  const expiry = new Date(Date.now() + 6000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const provisioned = await bridge.provisionV3(context(), "5000000000", expiry), coupon = provisioned.coupon;
  const clients = await Promise.all([3, 4].map((index) => couponAccountlessClient(address, { dev: true }, { privateKey: keys[index] })));
  clients.forEach((client) => resources.push(() => client.close()));
  assert.deepEqual(clients.map((client) => client.localPeer), [peerA, peerB]);
  const accepted = await Promise.all(clients.map((client) => client.offer(coupon)));
  const recipients = clients.map(() => couponAccountlessRecipient());
  assert.deepEqual(accepted[0], accepted[1]);
  assert.equal((await clients[1].status(coupon)).state, "ready");
  stage = "two unknown-peer race";
  const race = await Promise.allSettled(clients.map((client, index) => client.claim(coupon, recipients[index], accepted[index])));
  assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
  const winner = race.findIndex((result) => result.status === "fulfilled"), loser = 1 - winner;
  const result = race[winner].value, winningClient = clients[winner], losingClient = clients[loser];
  const credential = recipients[winner].decryptDelivery(coupon, result, accepted[winner]);
  assert.ok(credential.startsWith("synthetic-only-"));
  assert.throws(() => recipients[winner].decryptDelivery(coupon, result, accepted[loser]), /verification failed/);
  await assert.rejects(losingClient.claim(coupon, recipients[winner], accepted[loser]), /request failed/);
  await assert.rejects(losingClient.status(coupon), /request failed/);
  await assert.rejects(losingClient.offer(coupon), /request failed/);
  await assert.rejects(winningClient.claim(coupon, couponAccountlessRecipient(), accepted[winner]), /request failed/);
  assert.deepEqual(await winningClient.claim(coupon, recipients[winner], accepted[winner]), result);
  stage = "lost acknowledgement";
  const lost = await bridge.provisionV3(context(), "5000000000", "2030-10-10T00:00:00Z"), lostOffer = await winningClient.offer(lost.coupon);
  const lostRecipient = couponAccountlessRecipient(), rawWinner = await node([], {}, keys[winner + 3]);
  try {
    const stream = await rawWinner.dialProtocol(multiaddr(address), COUPON_PROTOCOL_V3), lp = lpStream(stream);
    const seen = new Promise((resolve) => { lostRequestSeen = resolve; });
    await lp.write(Buffer.from(JSON.stringify({ id: "lostack", op: "claim", coupon: lost.coupon, recipient_key: lostRecipient.publicKey, offer_hash: lostOffer.offer_hash })));
    await Promise.race([seen, new Promise((_, reject) => setTimeout(() => reject(new Error("lost-ack fixture timeout")), 3000))]);
    stream.abort(new Error("synthetic lost acknowledgement"));
  } finally { lostRequestSeen = undefined; await rawWinner.stop(); }
  // Prove the abandoned request itself delivered; a later retry must only
  // replay that result, rather than being the request which caused issuance.
  const lostDigest = crypto.createHash("sha256").update(lost.coupon).digest("hex");
  let abandonedState;
  for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
    abandonedState = execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('SELECT state FROM coupons WHERE digest=?',(sys.argv[2],)).fetchone()[0])", path.join(stateDir, "state.sqlite"), lostDigest], { encoding: "utf8" }).trim();
    if (abandonedState === "delivered") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(abandonedState, "delivered", "first request committed delivery before any retry");
  const recovered = await winningClient.claim(lost.coupon, lostRecipient, lostOffer);
  assert.ok(lostRecipient.decryptDelivery(lost.coupon, recovered, lostOffer).startsWith("synthetic-only-"));
  await bridge.restart();
  assert.deepEqual(await winningClient.claim(lost.coupon, lostRecipient, lostOffer), recovered);
  await assert.rejects(losingClient.status(lost.coupon), /request failed/);
  stage = "expiry and old protocol isolation";
  const expired = await bridge.provisionV3(context(), "1", "2000-01-01T00:00:00Z"), expiredOffer = await losingClient.offer(expired.coupon);
  await assert.rejects(losingClient.claim(expired.coupon, couponAccountlessRecipient(), expiredOffer), /request failed/);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(expiry) - Date.now() + 25)));
  assert.equal((await winningClient.status(coupon)).claim_expired, true);
  assert.deepEqual(await winningClient.claim(coupon, recipients[winner], accepted[winner]), result);
  const old1 = await bridge.provision(context(COUPON_PROTOCOL), 1, legacyPeer);
  const old2 = await bridge.provisionV2(context(COUPON_PROTOCOL_V2), "1", legacyPeer, "2030-10-10T00:00:00Z");
  const legacy1 = await couponClient(address, { dev: true }, { privateKey: keys[5] }); resources.push(() => legacy1.close());
  const legacy2 = await couponOfferClient(address, { dev: true }, { privateKey: keys[5] }); resources.push(() => legacy2.close());
  assert.equal((await legacy1.status(old1.coupon)).state, "ready");
  assert.equal((await legacy2.status(old2.coupon)).state, "ready");
  await assert.rejects(legacy1.status(coupon), /request failed/); await assert.rejects(legacy2.status(coupon), /request failed/);
  await assert.rejects(winningClient.offer(old1.coupon), /request failed/); await assert.rejects(winningClient.offer(old2.coupon), /request failed/);
  stage = "direct inference and bound observation";
  const prompt = "synthetic-accountless-direct-prompt";
  provider = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${credential}`);
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), prompt); response.end("synthetic-private-inference-result");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  assert.equal(await (await fetch(`http://127.0.0.1:${provider.address().port}/inference`, { method: "POST", headers: { authorization: `Bearer ${credential}` }, body: prompt })).text(), "synthetic-private-inference-result");
  // Reset libp2p's ordinary five-connections/source-IP/second fixture allowance.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const observer = await couponAccountlessClient(address, { dev: true }, { privateKey: keys[1] }); resources.push(() => observer.close());
  const observerOffer = await observer.offer(coupon), challenge = crypto.randomBytes(32).toString("hex");
  const rawObserverKey = await fs.readFile(path.join(stateDir, "observer.key"));
  const privateObserver = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), rawObserverKey]), format: "der", type: "pkcs8" });
  const expectedPublicKey = crypto.createPublicKey(privateObserver).export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const observation = await observer.observe(coupon, { start: "2026-10-10T00:00:00Z", end: "2026-10-11T00:00:00Z", challenge }, observerOffer,
    { recipientPeer: winningClient.localPeer, expectedPublicKey, keyId: result.key_id, recipientKey: recipients[winner].publicKey, envelope: result.envelope });
  assert.equal(observation.payload.recipient_peer_sha256, couponRecipientPeerHash(winningClient.localPeer));
  assert.throws(() => verifyAccountlessCouponObservation(observation, accepted[winner], { coupon, challenge, recipientPeer: losingClient.localPeer, expectedPublicKey }), /verification failed/);
  const spoof = await node();
  try {
    const stream = await spoof.dialProtocol(multiaddr(address), COUPON_PROTOCOL_V3), lp = lpStream(stream);
    await lp.write(Buffer.from(JSON.stringify({ id: "spoof", op: "claim", coupon, recipient_key: recipients[winner].publicKey,
      offer_hash: accepted[winner].offer_hash, peerId: winningClient.localPeer, roles: ["observer", "recipient"] })));
    assert.equal(JSON.parse(Buffer.from((await lp.read({ signal: AbortSignal.timeout(3000) })).subarray())).ok, false);
    await stream.close();
  } finally { await spoof.stop(); }
  assert.deepEqual(counts(stateDir), { create: 2, read: 1 });
  assert.ok([...frames, ...logs].every((value) => !value.includes("synthetic-only-") && !value.includes(prompt)));
  assert.ok(logs.every((value) => !value.includes(coupon) && !value.includes(lost.coupon)));

  stage = "ambiguous issuance";
  const ambiguousDir = path.join(directory, "ambiguous"), ambiguousState = path.join(ambiguousDir, "state");
  await fs.mkdir(ambiguousDir, { mode: 0o700 });
  const ambiguousKey = await generateKeyPair("Ed25519"), identity = await node([], {}, ambiguousKey), ambiguousPeer = identity.peerId.toString(); await identity.stop();
  const ambiguousConfig = path.join(ambiguousDir, "config.json");
  await fs.writeFile(ambiguousConfig, JSON.stringify(config(ambiguousState, ambiguousPeer)), { mode: 0o600 });
  // Test-only executable wrapper alters the synthetic provider, not runtime config.
  const python = path.join(ambiguousDir, "python-fixture");
  await fs.writeFile(python, '#!/usr/bin/env python3\nimport os, sys\nsys.path.insert(0, os.getcwd())\nfrom experiments.coupon_redemption import peer_worker\noriginal = peer_worker.SyntheticProvider.create_key\ndef ambiguous(self, name, budget):\n    original(self, name, budget)\n    raise RuntimeError("synthetic ambiguous issuance")\npeer_worker.SyntheticProvider.create_key = ambiguous\nsys.argv = [sys.argv[0], *sys.argv[3:]]\nraise SystemExit(peer_worker.main())\n', { mode: 0o700 });
  const ambiguousBridge = await createCouponPeerService({ configPath: ambiguousConfig, cwd: source, python }); resources.push(() => ambiguousBridge.close());
  const ambiguousServer = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], privateKey: ambiguousKey, evidence: () => () => ({ type: "dev" }), services: { [COUPON_PROTOCOL_V3]: ambiguousBridge.serviceV3 } }); resources.push(() => ambiguousServer.stop());
  const ambiguousClients = await Promise.all([0, 1].map(() => couponAccountlessClient(String(ambiguousServer.getMultiaddrs()[0]), { dev: true })));
  ambiguousClients.forEach((client) => resources.push(() => client.close()));
  const ambiguousCoupon = (await ambiguousBridge.provisionV3(context(COUPON_PROTOCOL_V3, ambiguousPeer), "1", "2030-10-10T00:00:00Z")).coupon;
  const ambiguousOffers = await Promise.all(ambiguousClients.map((client) => client.offer(ambiguousCoupon))), ambiguousRecipient = couponAccountlessRecipient();
  await assert.rejects(ambiguousClients[0].claim(ambiguousCoupon, ambiguousRecipient, ambiguousOffers[0]), /request failed/);
  assert.equal((await ambiguousClients[0].status(ambiguousCoupon)).state, "reconciliation_required");
  await assert.rejects(ambiguousClients[1].status(ambiguousCoupon), /request failed/);
  await assert.rejects(ambiguousClients[1].claim(ambiguousCoupon, ambiguousRecipient, ambiguousOffers[1]), /request failed/);
  await ambiguousBridge.restart();
  await assert.rejects(ambiguousClients[0].claim(ambiguousCoupon, ambiguousRecipient, ambiguousOffers[0]), /request failed/);
  assert.deepEqual(counts(ambiguousState), { create: 1 });
  console.log(JSON.stringify({ mode: "synthetic-accountless-libp2p-e2e", unregistered_recipients: 2, race_winners: 1, primary_provider_creates: 2,
    lost_ack_recovered: true, winner_restart_replay: true, loser_envelope_and_status_denied: true, replay_after_expiry: true,
    direct_inference: true, winner_peer_bound_observation: true, v1_v2_compatible: true, ambiguous_creates: 1, ambiguous_retry_disabled: true,
    environment: "local-unattested", deposit_release_authorized: false }));
} catch (error) { throw new Error(`Synthetic accountless integration failed during ${stage}`, { cause: error }); }
finally {
  console.error = originalError;
  await Promise.allSettled(resources.reverse().map((close) => close()));
  if (provider) await new Promise((resolve) => provider.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
