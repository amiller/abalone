// Explicit synthetic issuer reports over real local Noise connections, never hardware approval.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { node, servePeer } from "../lib/p2p.mjs";
import { couponClient, COUPON_PROTOCOL } from "../lib/coupon.mjs";
import { couponOfferClient, COUPON_PROTOCOL_V2, canonicalCouponJson } from "../lib/coupon-offer.mjs";
import { couponAccountlessClient, COUPON_PROTOCOL_V3 } from "../lib/coupon-accountless.mjs";
import { couponAttestedClient, couponAttestedClientForTesting, couponAttestedRecipient, COUPON_PROTOCOL_V4, COUPON_ISSUER_PROTOCOL,
  couponAttestedRecipientPeerHash, validateAttestedCouponOffer, verifyAttestedCouponObservation } from "../lib/coupon-attested.mjs";

const source = process.env.DSMACK_CODE_DIR;
if (!source || !path.isAbsolute(source)) throw new Error("Set DSMACK_CODE_DIR to an absolute dsmack code checkout");
const { createCouponPeerService } = await import(pathToFileURL(path.join(source, "experiments/coupon_redemption/peer_bridge.mjs")));
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const vector = JSON.parse(await fs.readFile(new URL("fixtures/coupon/offer-v4.json", import.meta.url)));
assert.deepEqual(vector, JSON.parse(await fs.readFile(path.join(source, "experiments/coupon_redemption/fixtures/offer-v4.json"))));
validateAttestedCouponOffer({ offer: vector.offer, offer_hash: vector.offer_hash }, { coupon: vector.coupon, peerId: vector.offer.issuer.peer_id,
  issuerInfo: { version: 2, issuer_public_key_hex: vector.issuer_public_key_hex,
    identity_policy_sha256: vector.offer.issuer.identity_policy_sha256, issuance_policy_sha256: vector.offer.issuer.issuance_policy_sha256 } });
assert.equal(vector.recipient_peer_sha256, couponAttestedRecipientPeerHash(vector.recipient_peer));
assert.equal(vector.aad_utf8, canonicalCouponJson({ domain: "dsmack-coupon-delivery-v4", version: 4, offer_hash: vector.offer_hash,
  coupon_digest: vector.offer.coupon_digest, key_id: vector.provider_key_id, recipient_key_sha256: sha(Buffer.from(vector.recipient_public_key, "base64")),
  recipient_peer_sha256: vector.recipient_peer_sha256 }));
const fixture = JSON.parse(execFileSync("python3", ["-m", "experiments.coupon_redemption.test_issuer_fixture"], { cwd: source, encoding: "utf8" }));
assert.equal(fixture.environment, "synthetic-only-not-hardware");
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "abalone-attested-e2e-"));
const keys = await Promise.all(Array.from({ length: 6 }, () => generateKeyPair("Ed25519")));
const initial = await Promise.all(keys.map((privateKey) => node([], {}, privateKey)));
const [sponsorPeer, observerPeer, issuerPeer, peerA, peerB, legacyPeer] = initial.map((peer) => peer.peerId.toString());
await Promise.all(initial.map((peer) => peer.stop()));
const context = (protocol = COUPON_PROTOCOL_V4) => ({ authenticated: true, transport: "noise", protocol, remotePeer: sponsorPeer, localPeer: issuerPeer });
const counts = (stateDir) => JSON.parse(execFileSync("python3", ["-c", "import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(dict(c.execute('SELECT kind,COUNT(*) FROM synthetic_events GROUP BY kind'))))", path.join(stateDir, "state.sqlite")], { encoding: "utf8" }));
const resources = [], frames = [], logs = [], originalError = console.error;
let provider, stage = "setup";
console.error = (...args) => logs.push(args.join(" "));
try {
  const stateDir = path.join(directory, "state"), configPath = path.join(directory, "config.json"), composeFile = path.join(directory, "compose.json"), python = path.join(directory, "python-synthetic-fixture");
  const config = { version: 1, state_dir: stateDir, issuer_peer_id: issuerPeer, sponsor_subject: "test:sponsor", observer_subject: "test:observer", peers: {
    [sponsorPeer]: { subject: "test:sponsor", roles: ["sponsor"] }, [observerPeer]: { subject: "test:observer", roles: ["observer"] }, [legacyPeer]: { subject: "test:legacy", roles: ["recipient"] },
  }, provider: { mode: "synthetic" }, issuer_evidence: { identity_policy_sha256: fixture.identity_policy_sha256, issuance_policy_sha256: fixture.issuance_policy_sha256,
    socket_path: path.join(directory, "nonexistent-synthetic-dstack.sock"), compose_file: composeFile } };
  assert.ok([peerA, peerB].every((peer) => !(peer in config.peers)));
  await fs.writeFile(composeFile, fixture.app_compose, { mode: 0o600 });
  await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await fs.writeFile(python, '#!/usr/bin/env python3\nimport sys, os\nsys.path.insert(0,os.getcwd())\nfrom experiments.coupon_redemption import peer_worker\nfrom experiments.coupon_redemption.test_issuer_fixture import synthetic_worker\npeer_worker.Worker=synthetic_worker\nraise SystemExit(peer_worker.main(sys.argv[3:]))\n', { mode: 0o700 });
  const bridge = await createCouponPeerService({ configPath, cwd: source, python }); resources.push(() => bridge.close());
  const wrapped = (descriptor, protocol) => ({ ...descriptor, handle: (lp, send, recv, auth) => descriptor.handle(lp,
    (bytes) => { frames.push({ protocol, remotePeer: auth.remotePeer, direction: "response", body: bytes.toString() }); return send(bytes); },
    async () => { const bytes = await recv(); frames.push({ protocol, remotePeer: auth.remotePeer, direction: "request", body: bytes.toString() }); return bytes; }, auth) });
  const peer = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], privateKey: keys[2], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_PROTOCOL]: bridge.service, [COUPON_PROTOCOL_V2]: bridge.serviceV2, [COUPON_PROTOCOL_V3]: bridge.serviceV3,
    [COUPON_PROTOCOL_V4]: wrapped(bridge.serviceV4, COUPON_PROTOCOL_V4), [COUPON_ISSUER_PROTOCOL]: wrapped(bridge.issuerService, COUPON_ISSUER_PROTOCOL),
  } }); resources.push(() => peer.stop());
  const address = String(peer.getMultiaddrs()[0]);
  const signingSeed = await fs.readFile(path.join(stateDir, "observer.key"));
  const signingPrivate = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), signingSeed]), format: "der", type: "pkcs8" });
  const signingPublic = crypto.createPublicKey(signingPrivate).export({ format: "der", type: "spki" }).subarray(-32);
  const options = { identityPolicy: fixture.identity_policy, expectedIdentityPolicySha256: fixture.identity_policy_sha256,
    expectedIssuancePolicySha256: fixture.issuance_policy_sha256, expectedIssuerPublicKeySha256: sha(signingPublic),
    syntheticQuoteVerifier: async (quote) => JSON.parse(Buffer.from(quote, "hex").toString()) };
  stage = "identity admission before bearer";
  await assert.rejects(couponAttestedClient(address, options), /identity verification failed/);
  assert.equal(frames.filter((f) => f.protocol === COUPON_PROTOCOL_V4).length, 0);
  const clients = await Promise.all([3, 4].map((index) => couponAttestedClientForTesting(address, options, { privateKey: keys[index] })));
  clients.forEach((client) => resources.push(() => client.close()));
  assert.deepEqual(clients.map((client) => client.localPeer), [peerA, peerB]);
  for (const client of clients) { assert.equal(client.identity.evidenceStatus, "synthetic-only-not-hardware"); assert.equal(client.custodyQualified, false); assert.equal(client.identity.privateIssuanceQualified, false); }
  assert.equal(frames.filter((f) => f.protocol === COUPON_PROTOCOL_V4).length, 0);
  stage = "unknown-peer race and immutable terms";
  const expiry = new Date(Date.now() + 3000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const coupon = (await bridge.provisionV4(context(), "5000000000", expiry)).coupon;
  const offers = await Promise.all(clients.map((client) => client.offer(coupon))), recipients = clients.map(() => couponAttestedRecipient());
  assert.deepEqual(offers[0], offers[1]);
  assert.equal(offers[0].offer.issuer.issuance_policy_sha256, fixture.issuance_policy_sha256);
  assert.equal(offers[0].offer.issuer.issuer_public_key_sha256, sha(signingPublic));
  const race = await Promise.allSettled(clients.map((client, i) => client.claim(coupon, recipients[i], offers[i])));
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  const winner = race.findIndex((r) => r.status === "fulfilled"), loser = 1 - winner;
  const result = race[winner].value, winningClient = clients[winner], losingClient = clients[loser];
  const credential = recipients[winner].decryptDelivery(coupon, result, offers[winner]);
  assert.equal(credential, `synthetic-only-coupon-${sha(coupon)}`);
  assert.throws(() => recipients[winner].decryptDelivery(coupon, result, offers[loser]), /verification failed/);
  await assert.rejects(losingClient.claim(coupon, recipients[winner], offers[loser]), /request failed/);
  await assert.rejects(losingClient.status(coupon), /request failed/); await assert.rejects(losingClient.offer(coupon), /request failed/);
  await assert.rejects(winningClient.claim(coupon, couponAttestedRecipient(), offers[winner]), /request failed/);
  await bridge.restart();
  await winningClient.refreshIdentity();
  await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(expiry) - Date.now() + 10)));
  assert.equal((await winningClient.status(coupon)).claim_expired, true);
  assert.deepEqual(await winningClient.claim(coupon, recipients[winner], offers[winner]), result);
  stage = "v1-v3 protocol isolation";
  await new Promise((r) => setTimeout(r, 1100)); // preserve libp2p admission pacing
  const old1 = await bridge.provision(context(COUPON_PROTOCOL), 1, legacyPeer);
  const old2 = await bridge.provisionV2(context(COUPON_PROTOCOL_V2), "1", legacyPeer, "2030-10-10T00:00:00Z");
  const old3 = await bridge.provisionV3(context(COUPON_PROTOCOL_V3), "1", "2030-10-10T00:00:00Z");
  const legacyClients = await Promise.all([
    couponClient(address, { dev: true }, { privateKey: keys[5] }), couponOfferClient(address, { dev: true }, { privateKey: keys[5] }), couponAccountlessClient(address, { dev: true }, { privateKey: keys[5] }),
  ]);
  legacyClients.forEach((client) => resources.push(() => client.close()));
  for (const [index, old] of [old1, old2, old3].entries()) {
    assert.equal((await legacyClients[index].status(old.coupon)).state, "ready");
    await assert.rejects(legacyClients[index].status(coupon), /request failed/);
    await assert.rejects(winningClient.offer(old.coupon), /request failed/);
  }
  stage = "direct inference and bound observation";
  const prompt = "synthetic-attested-coupon-direct-prompt";
  provider = http.createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${credential}`);
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), prompt); response.end("synthetic-private-inference-result");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  assert.equal(await (await fetch(`http://127.0.0.1:${provider.address().port}/inference`, { method: "POST", headers: { authorization: `Bearer ${credential}` }, body: prompt })).text(), "synthetic-private-inference-result");
  await new Promise((r) => setTimeout(r, 1100));
  const observer = await couponAttestedClientForTesting(address, options, { privateKey: keys[1] }); resources.push(() => observer.close());
  const observerOffer = await observer.offer(coupon), challenge = crypto.randomBytes(32).toString("hex");
  const observation = await observer.observe(coupon, { start: "2026-10-10T00:00:00Z", end: "2026-10-11T00:00:00Z", challenge }, observerOffer,
    { recipientPeer: winningClient.localPeer, expectedPublicKey: signingPublic.toString("base64"), keyId: result.key_id, recipientKey: recipients[winner].publicKey, envelope: result.envelope });
  assert.equal(observation.payload.offer_hash, offers[winner].offer_hash);
  assert.throws(() => verifyAttestedCouponObservation(observation, offers[winner], { coupon, challenge, recipientPeer: losingClient.localPeer }), /verification failed/);
  assert.deepEqual(counts(stateDir), { create: 1, read: 1 });
  const requests = frames.filter((f) => f.direction === "request");
  for (const client of clients) {
    const clientFrames = requests.filter((f) => f.remotePeer === client.localPeer);
    assert.ok(clientFrames.findIndex((f) => f.protocol === COUPON_PROTOCOL_V4) > clientFrames.findIndex((f) => JSON.parse(f.body).op === "evidence"));
  }
  assert.ok([...frames.map((f) => f.body), ...logs].every((value) => !value.includes("synthetic-only-coupon-") && !value.includes(prompt)));
  assert.ok(logs.every((value) => !value.includes(coupon)));
  console.log(JSON.stringify({ mode: "synthetic-issuer-v2-coupon-v4-libp2p-e2e", identity: "synthetic-only-not-hardware", actual_noise_peer_bound: true,
    bearer_after_identity: true, genuine_verifier_refuses_fixture: true, policy_and_key_offer_bound: true, unknown_peer_race_winners: 1,
    provider_creates: 1, issuer_restart_replay: true, replay_after_expiry: true, loser_denied: true, direct_inference: true,
    offer_bound_observation: true, v1_v2_v3_compatible: true, private_issuance_qualified: false, rollback_qualified: false, deposit_release_authorized: false }));
} catch (error) { throw new Error(`Synthetic attested integration failed during ${stage}`, { cause: error }); }
finally {
  console.error = originalError;
  await Promise.allSettled(resources.reverse().map((close) => close()));
  if (provider) await new Promise((resolve) => provider.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
