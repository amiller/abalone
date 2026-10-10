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

const source = process.env.DSMACK_CODE_DIR;
if (!source || !path.isAbsolute(source)) throw new Error("Set DSMACK_CODE_DIR to an absolute dsmack code checkout");
const { createCouponPeerService } = await import(pathToFileURL(path.join(source, "experiments/coupon_redemption/peer_bridge.mjs")));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "abalone-coupon-e2e-"));
const keys = await Promise.all(Array.from({ length: 4 }, () => generateKeyPair("Ed25519")));
const identities = await Promise.all(keys.map((privateKey) => node([], {}, privateKey)));
const [sponsorPeer, recipientPeer, observerPeer, attackerPeer] = identities.map((peer) => peer.peerId.toString());
const context = (remotePeer, localPeer = sponsorPeer) => ({ authenticated: true, transport: "noise", protocol: COUPON_PROTOCOL, remotePeer, localPeer });
let bridge, peer, recipientClient, observerClient, attackerClient, provider;
const frames = [], logs = [], originalError = console.error;
console.error = (...args) => logs.push(args.join(" "));
try {
  await Promise.all(identities.map((identity) => identity.stop()));
  const configPath = path.join(directory, "config.json"), stateDir = path.join(directory, "state");
  await fs.writeFile(configPath, JSON.stringify({ version: 1, state_dir: stateDir, sponsor_subject: "test:sponsor", observer_subject: "test:observer", peers: {
    [sponsorPeer]: { subject: "test:sponsor", roles: ["sponsor"] },
    [recipientPeer]: { subject: "test:recipient", roles: ["recipient"] },
    [observerPeer]: { subject: "test:observer", roles: ["observer"] },
  }, provider: { mode: "synthetic" } }), { mode: 0o600 });
  bridge = await createCouponPeerService({ configPath, cwd: source });
  peer = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_PROTOCOL]: { ...bridge.service, handle: (lp, send, recv, auth) => bridge.service.handle(lp,
      (bytes) => { frames.push(Buffer.from(bytes).toString()); return send(bytes); },
      async () => { const bytes = await recv(); frames.push(bytes.toString()); return bytes; }, auth) },
  } });
  const address = String(peer.getMultiaddrs()[0]);
  const provisioned = await bridge.provision(context(sponsorPeer, peer.peerId.toString()), 5_000_000_000, recipientPeer);
  const coupon = provisioned.coupon;
  assert.equal(provisioned.deposit_release_authorized, false);
  recipientClient = await couponClient(address, { dev: true }, { privateKey: keys[1] });
  observerClient = await couponClient(address, { dev: true }, { privateKey: keys[2] });
  attackerClient = await couponClient(address, { dev: true }, { privateKey: keys[3] });
  assert.equal(recipientClient.localPeer, recipientPeer);
  const recipient = couponRecipient();
  await assert.rejects(attackerClient.claim(coupon, recipient), /request failed/);
  await assert.rejects(attackerClient.status(coupon), /request failed/);
  // Raw attacker fields cannot override transport identity or strict parsing.
  const rawAttacker = await node([], {}, keys[3]);
  try {
    for (const raw of [JSON.stringify({ id: "spoof", op: "claim", coupon, recipient_key: recipient.publicKey, peerId: recipientPeer, roles: ["recipient"] }),
      `{"id":"dup","op":"status","coupon":"${coupon}","coupon":"${coupon}"}`,
      JSON.stringify({ id: "provision", op: "provision", coupon, budget: 1 })]) {
      const stream = await rawAttacker.dialProtocol(multiaddr(address), COUPON_PROTOCOL), lp = lpStream(stream);
      await lp.write(Buffer.from(raw));
      assert.equal(JSON.parse(Buffer.from((await lp.read({ signal: AbortSignal.timeout(5000) })).subarray())).ok, false);
      await stream.close();
    }
  } finally { await rawAttacker.stop(); }
  const rawRecipient = await node([], {}, keys[1]);
  try {
    const stream = await rawRecipient.dialProtocol(multiaddr(address), COUPON_PROTOCOL), lp = lpStream(stream);
    await lp.write(Buffer.from(`{"id":"dup","op":"status","coupon":"${coupon}","coupon":"${coupon}"}`));
    assert.equal(JSON.parse(Buffer.from((await lp.read({ signal: AbortSignal.timeout(5000) })).subarray())).ok, false);
    await stream.close();
  } finally { await rawRecipient.stop(); }
  const [result, concurrentReplay] = await Promise.all([recipientClient.claim(coupon, recipient), recipientClient.claim(coupon, recipient)]);
  assert.deepEqual(concurrentReplay, result, "concurrent claims share exactly one issuance and envelope");
  const credential = recipient.decryptDelivery(coupon, result);
  assert.ok(credential.startsWith("synthetic-only-"));
  assert.equal((await recipientClient.status(coupon)).state, "delivered");
  assert.deepEqual(await recipientClient.claim(coupon, recipient), result);
  await assert.rejects(recipientClient.claim(coupon, couponRecipient()), /request failed/);
  await bridge.restart();
  assert.deepEqual(await recipientClient.claim(coupon, recipient), result);
  // Direct inference is a loopback fixture. No prompt enters the coupon bridge.
  let directCalls = 0;
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
  const observation = await observerClient.observe(coupon, { start: "2026-10-10T00:00:00Z", end: "2026-10-11T00:00:00Z", challenge });
  assert.equal(observation.payload.challenge, challenge);
  assert.equal(observation.payload.environment, "local-unattested");
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(observation.public_key, "base64")]), type: "spki", format: "der" });
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(observation.payload).sort(([a], [b]) => a.localeCompare(b))));
  assert.equal(crypto.verify(null, Buffer.from(canonical), publicKey, Buffer.from(observation.signature, "base64")), true);
  await assert.rejects(recipientClient.observe(coupon, { start: "2026-10-10T00:00:00Z", end: "2026-10-11T00:00:00Z", challenge }), /request failed/);
  const counts = JSON.parse(execFileSync("python3", ["-c", "import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(dict(c.execute('SELECT kind,COUNT(*) FROM synthetic_events GROUP BY kind'))))", path.join(stateDir, "state.sqlite")], { encoding: "utf8" }));
  assert.deepEqual(counts, { create: 1, read: 1 });
  assert.ok([...frames, ...logs].every((text) => !text.includes(credential) && !text.includes(prompt)));
  assert.ok(logs.every((text) => !text.includes(coupon)));
  console.log(JSON.stringify({ mode: "synthetic-libp2p-e2e", encrypted_delivery: true, wrong_peer_denied: true, concurrent_replay: true, restart_replay: true, direct_provider_calls: directCalls, provider_creates: counts.create, signed_observation: true, environment: "local-unattested", deposit_release_authorized: false }));
} finally {
  console.error = originalError;
  await Promise.all([recipientClient?.close(), observerClient?.close(), attackerClient?.close(), peer?.stop(), bridge?.close(), ...identities.map((identity) => identity.stop())]);
  if (provider) await new Promise((resolve) => provider.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
