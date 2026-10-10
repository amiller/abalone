import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { servePeer } from "../lib/p2p.mjs";
import { canonicalCouponJson } from "../lib/coupon-offer.mjs";
import { couponAccountlessClient, couponRecipientPeerHash, COUPON_PROTOCOL_V3 } from "../lib/coupon-accountless.mjs";
import { openCouponSession, couponCredentialBroker, admitCouponSessionIssuer, admitCouponSessionProvider } from "../lib/coupon-session.mjs";
import { couponSocketFetch } from "../lib/coupon-socket.mjs";

const coupon = "a".repeat(43), sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const credential = `synthetic-only-coupon-${sha(coupon)}`;
const config = (port = 9999) => ({ couponSession: { mode: "synthetic-loopback", provider: "synthetic-near", baseUrl: `http://127.0.0.1:${port}/v1`, models: ["fixture"] } });
const provider = (port) => admitCouponSessionProvider(config(port), "fixture");
const request = (socketPath, body, { auth = "coupon-session", route = "/v1/chat/completions", method = "POST" } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ socketPath, path: route, method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" } }, (s) => {
    const chunks = []; s.on("data", (c) => chunks.push(c)); s.on("end", () => resolve({ status: s.statusCode, text: Buffer.concat(chunks).toString() })); s.on("error", reject);
  }); r.on("error", reject); r.end(typeof body === "string" ? body : JSON.stringify(body));
});
const body = { model: "fixture", messages: [{ role: "user", content: "synthetic-private-prompt" }] };

test("production, profile, credential conflicts and model refusal happen before connection or coupon capture", async () => {
  let calls = 0;
  const common = { peerAddr: "/ip4/127.0.0.1/tcp/1234/p2p/12D3KooWDbxDummy", admit: { dev: true }, config: config(), model: "fixture", connect: () => { calls++; } };
  await assert.rejects(openCouponSession(common), { code: "issuer_unverified" });
  // Valid actual PeerId from a throwaway peer is used only for syntax checks.
  const peer = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }) });
  try {
    const args = { ...common, peerAddr: String(peer.getMultiaddrs()[0]), experimental: true };
    for (const change of [{ occupied: true }, { ambient: true }, { model: "unknown" }, { admit: { dev: false } }, { peerAddr: args.peerAddr.replace("127.0.0.1", "192.0.2.1") }, { config: config().couponSession }])
      await assert.rejects(openCouponSession({ ...args, ...change }));
    for (const baseUrl of ["https://provider.example/v1", "http://127.0.0.1:99/other", "http://localhost:99/v1", "http://127.0.0.1:99/v1?redirect=x", "http://key@127.0.0.1:99/v1"])
      assert.throws(() => admitCouponSessionProvider({ couponSession: { ...config().couponSession, baseUrl } }, "fixture"));
    assert.equal(calls, 0);
  } finally { await peer.stop(); }
});

function encrypted(offer, recipientKey, peerId) {
  const keyId = `synthetic-coupon-${sha(coupon)}`, recipient = Buffer.from(recipientKey, "base64");
  const aad = Buffer.from(canonicalCouponJson({ domain: "dsmack-coupon-delivery-v3", version: 3, offer_hash: offer.offer_hash, coupon_digest: sha(coupon), key_id: keyId, recipient_key_sha256: sha(recipient), recipient_peer_sha256: couponRecipientPeerHash(peerId) }));
  const pair = crypto.generateKeyPairSync("x25519"), key = crypto.hkdfSync("sha256", crypto.diffieHellman({ privateKey: pair.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), recipient]), format: "der", type: "spki" }) }), Buffer.alloc(0), Buffer.concat([Buffer.from("dsmack-coupon-v1\0"), aad]), 32);
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(credential), cipher.final(), cipher.getAuthTag()]);
  return { key_id: keyId, envelope: JSON.stringify({ version: 1, aad: aad.toString("base64"), ephemeral: pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"), nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64") }) };
}

test("exact consent and same-process recovery retain original authenticated peer, offer and delivery keys", { timeout: 15_000 }, async () => {
  let accepted, result, selected, claims = 0, reconciliation = false, drop = true;
  const host = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: { [COUPON_PROTOCOL_V3]: async (_lp, send, recv, context) => {
    const frame = await recv();
    if (frame.op === "offer") return send({ id: frame.id, ok: true, result: accepted });
    if (frame.op === "status") return send({ id: frame.id, ok: true, result: { state: reconciliation ? "reconciliation_required" : "delivered", key_id: result.key_id, claim_expired: true, accounting_blocked: false, automatic_retry_allowed: false, deposit_release_authorized: false } });
    claims++;
    const binding = { peer: context.remotePeer, key: frame.recipient_key, hash: frame.offer_hash };
    if (selected) assert.deepEqual(binding, selected); else selected = binding;
    result ??= encrypted(accepted, frame.recipient_key, context.remotePeer);
    await send({ id: frame.id, ok: true, result });
  } } });
  const offer = { version: 3, coupon_digest: sha(coupon), issuer: { peer_id: host.peerId.toString(), policy: "experimental-local-unattested" }, provider: { id: "synthetic-near", scope_commitment: "ab".repeat(32) }, claim_policy: "first-authenticated-bearer", delivery_profile: "x25519-aesgcm-session-only", budget_nano_usd: "5000000000", cap_semantics: "nominal-provider-limit", claim_expires_at: "2030-10-11T00:00:00Z", provider_expires_at: null, sponsor_powers: ["revoke", "change_limits"] };
  accepted = { offer, offer_hash: sha(Buffer.concat([Buffer.from("dsmack-coupon-offer-v3\0"), Buffer.from(canonicalCouponJson(offer))])) };
  const session = await openCouponSession({ peerAddr: String(host.getMultiaddrs()[0]), admit: { dev: true }, config: config(), model: "fixture", experimental: true,
    connect: async (...args) => { const client = await couponAccountlessClient(...args); return { ...client, claim: async (...a) => { const value = await client.claim(...a); if (drop) { drop = false; throw new Error(credential); } return value; } }; } });
  try {
    const preview = await session.inspect(coupon);
    assert.ok(preview.text.includes("EXIT OR CRASH LOSES RECOVERY")); assert.ok(preview.text.includes("balance: unknown"));
    for (const options of [{ offerHash: preview.offerHash }, { consent: "CLAIM SESSION ONLY", offerHash: "b".repeat(64) }]) await assert.rejects(session.claim(options), { code: "consent_required" });
    assert.equal(claims, 0);
    await assert.rejects(session.claim({ offerHash: preview.offerHash, consent: "CLAIM SESSION ONLY" }), (e) => e.code === "claim_uncertain" && !e.message.includes(credential));
    assert.equal(claims, 1); reconciliation = true;
    await assert.rejects(session.recover({ consent: "RETRY SAME KEYS" }), { code: "reconciliation_required" }); assert.equal(claims, 1);
    reconciliation = false;
    const installed = await session.recover({ consent: "RETRY SAME KEYS" }); assert.equal(installed.state, "installed"); assert.equal(claims, 2);
    assert.ok(!JSON.stringify(installed).includes(credential)); assert.equal(session.credential, undefined);
    await assert.rejects(session.inspect("b".repeat(43)), { code: "coupon_already_selected" });
    await assert.rejects(session.claim({ offerHash: preview.offerHash, consent: "CLAIM SESSION ONLY" }), { code: "consent_required" });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coupon-close-opening-")), socketPath = path.join(directory, "broker.sock");
    try {
      const opening = session.broker(socketPath), closing = session.close();
      await assert.rejects(opening, { code: "session_closed" }); await closing;
      assert.equal(session.state, "closed"); assert.equal(fs.existsSync(socketPath), false, "close during broker listen leaves no socket or live broker");
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  } finally { await session.close(); await host.stop(); }
  await assert.rejects(session.recover({ consent: "RETRY SAME KEYS" }), { code: "session_closed" });
});

test("close while offer is pending cannot revive the session or retain a selected offer", async () => {
  let release, closed = false;
  const deferred = new Promise((r) => { release = r; });
  const peer = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }) });
  try {
    const session = await openCouponSession({ peerAddr: String(peer.getMultiaddrs()[0]), admit: { dev: true }, config: config(), model: "fixture", experimental: true,
      connect: async () => ({ offer: () => deferred, close: async () => { closed = true; } }) });
    const inspect = session.inspect(coupon); await session.close();
    release({ offer: { provider: { id: "synthetic-near" }, issuer: { policy: "experimental-local-unattested" } }, offer_hash: "b".repeat(64) });
    await assert.rejects(inspect, { code: "session_closed" }); assert.equal(session.state, "closed"); assert.equal(closed, true);
    await assert.rejects(session.inspect(coupon), { code: "session_closed" });
  } finally { await peer.stop(); }
});

test("socket broker pins provider/model/auth, sanitizes echoes and errors, bounds and aborts requests, cleans up", { timeout: 15_000 }, async () => {
  let calls = 0, mode = "ok", aborted = false;
  const upstream = http.createServer(async (req, res) => {
    calls++; assert.equal(req.headers.authorization, `Bearer ${credential}`);
    let text = ""; for await (const chunk of req) text += chunk;
    assert.equal(JSON.parse(text).model, "fixture");
    if (mode === "hang") { res.on("close", () => { aborted = true; }); return; }
    if (mode === "redirect") { res.writeHead(302, { location: "http://192.0.2.1:80/secret" }); res.end(credential); return; }
    if (mode === "revoked") { res.writeHead(401); res.end(credential); return; }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ answer: mode === "large" ? "x".repeat(5000) : `useful synthetic answer ${credential} ${coupon}` }));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coupon-session-unit-")), socketPath = path.join(dir, "broker.sock"), states = [];
  const broker = await couponCredentialBroker({ socketPath, provider: provider(upstream.address().port), credential, coupon, timeoutMs: 300, maxBytes: 2048, onState: (s) => states.push(s) });
  try {
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
    await assert.rejects(couponSocketFetch(socketPath)("ignored", { body: JSON.stringify(body), signal: AbortSignal.abort() }), /broker is unavailable/);
    assert.equal(calls, 0, "already-aborted provider call must not contact the broker or upstream");
    for (const [payload, options] of [[{ ...body, model: "other" }, {}], [{ ...body, endpoint: "http://192.0.2.1/evil" }, {}], [body, { auth: "ambient-key" }], [body, { route: "/redirect" }], ["malformed", {}]]) assert.ok((await request(socketPath, payload, options)).status >= 400);
    assert.equal(calls, 0);
    const ok = await request(socketPath, body); assert.equal(ok.status, 200); assert.ok(ok.text.includes("useful synthetic answer")); assert.ok(!ok.text.includes(credential) && !ok.text.includes(coupon));
    mode = "revoked"; const revoked = await request(socketPath, body); assert.ok(revoked.text.includes("access_revoked_or_expired")); assert.ok(!revoked.text.includes(credential));
    mode = "redirect"; assert.ok((await request(socketPath, body)).text.includes("provider_unavailable"));
    mode = "large"; assert.ok((await request(socketPath, body)).text.includes("provider_response_too_large"));
    mode = "hang"; await assert.rejects(request(socketPath, body));
    await new Promise((r) => setTimeout(r, 50)); assert.equal(aborted, true);
    assert.ok(states.includes("access_revoked_or_expired") && states.includes("provider_unavailable") && states.includes("installed"));
    const before = calls; assert.ok((await request(socketPath, "x".repeat(3000))).status >= 400); assert.equal(calls, before);
    await broker.close(); assert.equal(fs.existsSync(socketPath), false); await assert.rejects(request(socketPath, body));
  } finally { await broker.close(); upstream.closeAllConnections(); await new Promise((r) => upstream.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});
