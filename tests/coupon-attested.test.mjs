import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { servePeer } from "../lib/p2p.mjs";
import { canonicalCouponJson } from "../lib/coupon-offer.mjs";
import { couponAttestedClient, couponAttestedClientForTesting, couponAttestedRecipient, couponAttestedRecipientPeerHash, validateAttestedCouponOffer, COUPON_ISSUER_PROTOCOL, COUPON_ISSUER_FRAME_LIMIT, COUPON_PROTOCOL_V4 } from "../lib/coupon-attested.mjs";
import { syntheticIssuerIdentity } from "./fixtures/coupon/issuer-v2.mjs";
import { verifyDcapQuote, issuerPolicyHash, createDstackIssuerVerifierForTesting } from "../lib/vendor/dstack-issuer/dstack_issuer.mjs";

const coupon = "a".repeat(43), sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const bundle = (offer) => ({ offer, offer_hash: sha(Buffer.concat([Buffer.from("dsmack-coupon-offer-v4\0"), Buffer.from(canonicalCouponJson(offer))])) });
const terms = (peerId, info) => ({ version: 4, coupon_digest: sha(coupon), issuer: { peer_id: peerId, policy: "dstack-tdx-coupon-v1", identity_policy_sha256: info.identity_policy_sha256,
  issuance_policy_sha256: info.issuance_policy_sha256, issuer_public_key_sha256: sha(Buffer.from(info.issuer_public_key_hex, "hex")) },
  provider: { id: "synthetic-near", scope_commitment: "cd".repeat(32) }, claim_policy: "first-authenticated-bearer", delivery_profile: "x25519-aesgcm-session-only",
  budget_nano_usd: "9223372036854775807", cap_semantics: "nominal-provider-limit", claim_expires_at: "2030-10-10T00:00:00Z", provider_expires_at: null, sponsor_powers: ["revoke", "change_limits"] });

test("issuer policy admits the guest 0.5.9 key-provider event size through the existing 4096-byte replay bound", async () => {
  // Synthetic bytes reproduce the observed 204-byte size; no captured hardware is an allowlist.
  for (const size of [204, 4096]) {
    const fixture = syntheticIssuerIdentity(undefined, undefined, "06".repeat(size));
    const verifier = createDstackIssuerVerifierForTesting({ policy: fixture.policy,
      expectedPolicySha256: fixture.info.identity_policy_sha256, syntheticQuoteVerifier: fixture.options.syntheticQuoteVerifier });
    try {
      const binding = verifier.challenge({ remotePeer: "FixtureIssuer0001", issuerPublicKeyHex: fixture.info.issuer_public_key_hex });
      const identity = await verifier.verify(fixture.evidence(binding), { remotePeer: binding.peer_id });
      assert.equal(identity.evidenceStatus, "synthetic-only-not-hardware");
      assert.equal(identity.policySha256, issuerPolicyHash(fixture.policy));
      assert.equal(identity.privateIssuanceQualified, false);
    } finally { verifier.close(); }
  }
  const fixture = syntheticIssuerIdentity(), policy = structuredClone(fixture.policy);
  for (const invalid of ["06".repeat(4097), "0", "", "AB", "06".repeat(204) + "g0"]) {
    policy.approved_measurements[0].runtime_events["key-provider"] = invalid;
    assert.throws(() => issuerPolicyHash(policy), /verification refused/);
  }
});

test("larger key-provider pins retain exact measured content and strict TCB admission", async () => {
  for (const change of ["pin", "tcb"]) {
    const fixture = syntheticIssuerIdentity(undefined, undefined, "06".repeat(204));
    const verifier = createDstackIssuerVerifierForTesting({ policy: fixture.policy,
      expectedPolicySha256: fixture.info.identity_policy_sha256,
      syntheticQuoteVerifier: async (quote) => ({ ...await fixture.options.syntheticQuoteVerifier(quote), ...(change === "tcb" ? { status: "OutOfDate" } : {}) }) });
    try {
      const binding = verifier.challenge({ remotePeer: "FixtureIssuer0001", issuerPublicKeyHex: fixture.info.issuer_public_key_hex });
      // The fixture recomputes valid event digests and RTMR3, but the verifier keeps its original exact pin.
      if (change === "pin") fixture.policy.approved_measurements[0].runtime_events["key-provider"] = "08".repeat(204);
      await assert.rejects(verifier.verify(fixture.evidence(binding), { remotePeer: binding.peer_id }), /verification refused/);
    } finally { verifier.close(); }
  }
});

function delivery(accepted, recipientKey, peer) {
  const keyId = `synthetic-coupon-${sha(coupon)}`, recipient = Buffer.from(recipientKey, "base64");
  const aad = Buffer.from(canonicalCouponJson({ domain: "dsmack-coupon-delivery-v4", version: 4, offer_hash: accepted.offer_hash, coupon_digest: sha(coupon), key_id: keyId,
    recipient_key_sha256: sha(recipient), recipient_peer_sha256: couponAttestedRecipientPeerHash(peer) }));
  const pair = crypto.generateKeyPairSync("x25519"), remote = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), recipient]), format: "der", type: "spki" });
  const key = crypto.hkdfSync("sha256", crypto.diffieHellman({ privateKey: pair.privateKey, publicKey: remote }), Buffer.alloc(0), Buffer.concat([Buffer.from("dsmack-coupon-v1\0"), aad]), 32);
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(`synthetic-only-coupon-${sha(coupon)}`), cipher.final(), cipher.getAuthTag()]);
  return { key_id: keyId, envelope: JSON.stringify({ version: 1, aad: aad.toString("base64"), ephemeral: pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"), nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64") }) };
}

test("exact v4 offers bind independently pinned identity/issuance/key terms and canonical budgets", () => {
  const fixture = syntheticIssuerIdentity(), peerId = "FixtureIssuer0001";
  const accepted = bundle(terms(peerId, fixture.info));
  validateAttestedCouponOffer(accepted, { coupon, peerId, issuerInfo: fixture.info });
  for (const key of ["identity_policy_sha256", "issuance_policy_sha256", "issuer_public_key_sha256"]) {
    const changed = structuredClone(accepted.offer); changed.issuer[key] = "ff".repeat(32);
    assert.throws(() => validateAttestedCouponOffer(bundle(changed), { coupon, peerId, issuerInfo: fixture.info }), /verification failed/);
  }
  for (const change of [{ version: 3 }, { extra: true }, { provider_expires_at: "2030-10-10T00:00:00Z" }, { claim_expires_at: "0000-01-01T00:00:00Z" }, { budget_nano_usd: "9223372036854775808" }])
    assert.throws(() => validateAttestedCouponOffer(bundle({ ...accepted.offer, ...change }), { coupon, peerId, issuerInfo: fixture.info }));
  const stale = structuredClone(accepted); stale.offer.budget_nano_usd = "1";
  assert.throws(() => validateAttestedCouponOffer(stale, { coupon, peerId, issuerInfo: fixture.info }));
});

test("same actual Noise connection verifies fresh public issuer evidence before synthetic v4 bearer frames", { timeout: 15_000 }, async () => {
  const fixture = syntheticIssuerIdentity(), frames = [], identities = [], authenticatedClients = new Set();
  let accepted;
  const host = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_ISSUER_PROTOCOL]: { maxDataLength: COUPON_ISSUER_FRAME_LIMIT, timeoutMs: 3000, handle: async (_lp, send, recv, auth) => {
      const frame = await recv(); frames.push(frame);
      assert.ok(!Object.hasOwn(frame, "coupon"));
      if (frame.op === "info") return send({ id: frame.id, ok: true, result: fixture.info });
      assert.equal(frame.binding.peer_id, auth.localPeer); assert.equal(frame.binding.public_key_hex, fixture.info.issuer_public_key_hex);
      identities.push(frame.binding.challenge_hex); authenticatedClients.add(auth.remotePeer);
      return send({ id: frame.id, ok: true, result: fixture.evidence(frame.binding) });
    } },
    [COUPON_PROTOCOL_V4]: async (_lp, send, recv, auth) => {
      const frame = await recv(); frames.push(frame); assert.ok(authenticatedClients.has(auth.remotePeer));
      if (frame.op === "offer") return send({ id: frame.id, ok: true, result: accepted });
      if (frame.op === "claim") return send({ id: frame.id, ok: true, result: delivery(accepted, frame.recipient_key, auth.remotePeer) });
      return send({ id: frame.id, ok: true, result: { state: "ready", claim_expired: false, accounting_blocked: false, automatic_retry_allowed: false, deposit_release_authorized: false } });
    },
  } });
  const clients = [];
  try {
    accepted = bundle(terms(host.peerId.toString(), fixture.info));
    const client = await couponAttestedClientForTesting(String(host.getMultiaddrs()[0]), fixture.options); clients.push(client);
    assert.equal(client.identity.evidenceStatus, "synthetic-only-not-hardware"); assert.equal(client.identity.privateIssuanceQualified, false); assert.equal(client.custodyQualified, false);
    assert.equal(frames.filter((f) => Object.hasOwn(f, "coupon")).length, 0);
    const selected = await client.offer(coupon); assert.ok(Object.isFrozen(selected.offer.issuer));
    const recipient = couponAttestedRecipient(), result = await client.claim(coupon, recipient, selected);
    assert.equal(recipient.decryptDelivery(coupon, result, selected), `synthetic-only-coupon-${sha(coupon)}`);
    const other = await couponAttestedClientForTesting(String(host.getMultiaddrs()[0]), fixture.options); clients.push(other);
    const otherOffer = await other.offer(coupon);
    assert.throws(() => other.claim(coupon, recipient, selected), /request failed/);
    assert.throws(() => recipient.decryptDelivery(coupon, result, otherOffer), /verification failed/);
    await client.refreshIdentity(); assert.equal(identities.length, 3); assert.equal(new Set(identities).size, 3);
    const mutated = structuredClone(selected.offer); mutated.issuer.issuance_policy_sha256 = "ff".repeat(32); accepted = bundle(mutated);
    await assert.rejects(client.offer(coupon), /verification failed/);
    assert.equal((await client.status(coupon)).state, "ready");
  } finally { await Promise.all(clients.map((c) => c.close())); await host.stop(); }
});

test("issuer discovery, quote peer/key/policy/challenge and signature substitution refuse before bearer", { timeout: 15_000 }, async () => {
  const fixture = syntheticIssuerIdentity(); let changed = "info-extra", bearerFrames = 0, quoteCalls = 0;
  const host = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_ISSUER_PROTOCOL]: { maxDataLength: COUPON_ISSUER_FRAME_LIMIT, handle: async (_lp, send, recv) => {
      const frame = await recv(); let result;
      if (frame.op === "info") result = { ...fixture.info, ...(changed === "info-extra" ? { extra: true } : {}), ...(changed === "issuance-policy" ? { issuance_policy_sha256: "ff".repeat(32) } : {}) };
      else {
        result = fixture.evidence(frame.binding);
        if (changed === "peer") result.binding = { ...result.binding, peer_id: "12D3KooWTestOtherSyntheticIssuer00001" };
        if (changed === "key") result.binding = { ...result.binding, public_key_hex: "ff".repeat(32) };
        if (changed === "challenge") result.binding = { ...result.binding, challenge_hex: "ff".repeat(32) };
        if (changed === "policy") result.binding = { ...result.binding, policy_sha256: "ff".repeat(32) };
        if (changed === "signature") result.possession_signature_hex = "00".repeat(64);
      }
      await send({ id: frame.id, ok: true, result });
    } },
    [COUPON_PROTOCOL_V4]: async () => { bearerFrames++; },
  } });
  try {
    for (const attack of ["info-extra", "issuance-policy", "peer", "key", "challenge", "policy", "signature"]) {
      changed = attack;
      await assert.rejects(couponAttestedClientForTesting(String(host.getMultiaddrs()[0]), { ...fixture.options, syntheticQuoteVerifier: async (...a) => { quoteCalls++; return fixture.options.syntheticQuoteVerifier(...a); } }), /identity verification failed/);
      await new Promise((r) => setTimeout(r, 210)); // retain the installed libp2p admission limit
    }
    assert.equal(bearerFrames, 0); assert.equal(quoteCalls, 0);
    changed = "valid";
    // The normal factory cannot turn an injected testing callback into hardware admission.
    await assert.rejects(couponAttestedClient(String(host.getMultiaddrs()[0]), fixture.options), /identity verification failed/);
    assert.equal(bearerFrames, 0);
  } finally { await host.stop(); }
});

test("vendored genuine DCAP worker rejects synthetic input, aborts and reaps without exposing errors", async () => {
  await assert.rejects(verifyDcapQuote("00"), { message: "dstack issuer identity verification refused" });
  await assert.rejects(verifyDcapQuote("00", { timeoutMs: 1 }), { message: "dstack issuer identity verification refused" });
  await assert.rejects(verifyDcapQuote("00", { signal: AbortSignal.abort() }));
  const fixture = syntheticIssuerIdentity();
  await assert.rejects(couponAttestedClientForTesting("/ip4/192.0.2.1/tcp/1234/p2p/12D3KooWTestOnlySyntheticIssuerPeer0001", fixture.options));
});

test("expired identity refreshes on the retained connection; caller mutations and changed discovery cannot move pins", { timeout: 10_000 }, async () => {
  const fixture = syntheticIssuerIdentity(undefined, 1000), frames = [];
  let alteredInfo = false;
  const host = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_ISSUER_PROTOCOL]: async (_lp, send, recv) => {
      const frame = await recv(); frames.push(frame);
      await send({ id: frame.id, ok: true, result: frame.op === "info" ? { ...fixture.info,
        ...(alteredInfo ? { issuance_policy_sha256: "ff".repeat(32) } : {}) } : fixture.evidence(frame.binding) });
    },
    [COUPON_PROTOCOL_V4]: async (_lp, send, recv) => {
      const frame = await recv(); frames.push(frame);
      await send({ id: frame.id, ok: true, result: bundle(terms(host.peerId.toString(), fixture.info)) });
    },
  } });
  let client;
  try {
    const supplied = { ...fixture.options, identityPolicy: structuredClone(fixture.policy) };
    client = await couponAttestedClientForTesting(String(host.getMultiaddrs()[0]), supplied);
    supplied.identityPolicy.approved_measurements[0].mr_td = "ff".repeat(48);
    supplied.expectedIssuancePolicySha256 = "ff".repeat(32);
    supplied.syntheticQuoteVerifier = () => { throw new Error("caller mutation must not run"); };
    const first = client.identity;
    await new Promise((r) => setTimeout(r, Math.max(0, first.expiresAtMs - Date.now() + 10)));
    await client.offer(coupon);
    assert.ok(client.identity.verifiedAtMs > first.verifiedAtMs);
    assert.equal(frames.filter((f) => f.op === "evidence").length, 2);
    assert.equal(host.getConnections().length, 1, "refresh retains the authenticated connection");
    alteredInfo = true;
    await assert.rejects(client.refreshIdentity(), /request failed/);
    assert.equal(client.identity, undefined, "failed refresh invalidates previous authorization");
    await assert.rejects(client.offer(coupon), /request failed/);
    assert.equal(frames.filter((f) => Object.hasOwn(f, "coupon")).length, 1);
    // An unusable bearer object cannot be serialized during public identity work.
    let serialized = 0;
    const neverCoupon = { toJSON() { serialized++; throw new Error("bearer canary"); } };
    await assert.rejects(client.offer(neverCoupon), /request failed/);
    assert.equal(serialized, 0);
  } finally { await client?.close(); await host.stop(); }
});

test("close aborts a pending quote refresh and cannot revive identity or send a coupon", { timeout: 5000 }, async () => {
  const fixture = syntheticIssuerIdentity(); let stall = false, seen, quoteAborted = false, bearerFrames = 0;
  const entered = new Promise((resolve) => { seen = resolve; });
  const host = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_ISSUER_PROTOCOL]: async (_lp, send, recv) => {
      const frame = await recv(); await send({ id: frame.id, ok: true, result: frame.op === "info" ? fixture.info : fixture.evidence(frame.binding) });
    },
    [COUPON_PROTOCOL_V4]: async () => { bearerFrames++; },
  } });
  let client;
  try {
    client = await couponAttestedClientForTesting(String(host.getMultiaddrs()[0]), { ...fixture.options,
      syntheticQuoteVerifier: async (quote, { signal }) => {
        if (!stall) return fixture.options.syntheticQuoteVerifier(quote);
        seen(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { quoteAborted = true; reject(new Error("private quote canary")); }, { once: true }));
      } });
    stall = true;
    const pending = client.refreshIdentity();
    const refused = assert.rejects(pending, /request failed/);
    await entered;
    assert.equal(client.identity, undefined, "refresh immediately removes the prior public admission verdict");
    const bearerRefused = assert.rejects(client.offer(coupon), /request failed/);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(bearerFrames, 0, "bearer waits for an in-flight refresh despite the earlier unexpired verdict");
    await client.close(); await Promise.all([refused, bearerRefused]);
    assert.ok(quoteAborted); assert.equal(client.identity, undefined);
    await assert.rejects(client.offer(coupon), /request failed/);
    assert.equal(bearerFrames, 0); await client.close();
  } finally { await client?.close(); await host.stop(); }
});

test("issuer response limits and refresh deadlines abort actual streams before bearer", { timeout: 8000 }, async () => {
  const fixture = syntheticIssuerIdentity(); let mode = "good", bearerFrames = 0;
  const host = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_ISSUER_PROTOCOL]: { timeoutMs: 1000, handle: async (lp, send, recv) => {
      const frame = await recv();
      if (mode === "oversize") return send({ id: frame.id, ok: true, result: "x".repeat(COUPON_ISSUER_FRAME_LIMIT) });
      if (mode === "stall") return new Promise((resolve) => lp.unwrap().addEventListener("close", resolve, { once: true }));
      return send({ id: frame.id, ok: true, result: frame.op === "info" ? fixture.info : fixture.evidence(frame.binding) });
    } },
    [COUPON_PROTOCOL_V4]: async () => { bearerFrames++; },
  } });
  let client;
  try {
    client = await couponAttestedClientForTesting(String(host.getMultiaddrs()[0]), fixture.options, { timeoutMs: 300 });
    mode = "oversize"; await assert.rejects(client.refreshIdentity(), /request failed/);
    mode = "stall"; const started = Date.now(); await assert.rejects(client.refreshIdentity(), /request failed/);
    assert.ok(Date.now() - started < 1500); assert.equal(bearerFrames, 0);
  } finally { await client?.close(); await host.stop(); }
});

test("pending claim polling retains winner key/hash, cancels actual reads, and never initiates or reconstructs issuance", { timeout: 10_000 }, async () => {
  const fixture = syntheticIssuerIdentity(); let accepted, winner, mode = "pending", claims = 0, statusFrames = [], stalls = 0, readAborted;
  const abortedRead = new Promise((resolve) => { readAborted = resolve; });
  const progress = (state, changes = {}) => ({ state, claim_expired: false, accounting_blocked: false, automatic_retry_allowed: false, deposit_release_authorized: false,
    ...(state === "delivered" ? { key_id: `synthetic-coupon-${sha(coupon)}` } : {}), ...changes });
  const host = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_ISSUER_PROTOCOL]: async (_lp, send, recv) => {
      const frame = await recv(); await send({ id: frame.id, ok: true, result: frame.op === "info" ? fixture.info : fixture.evidence(frame.binding) });
    },
    [COUPON_PROTOCOL_V4]: { timeoutMs: 3000, handle: async (lp, send, recv, auth) => {
      const frame = await recv(); let result;
      if (frame.op === "offer") result = accepted;
      else {
        assert.equal(frame.offer_hash, accepted.offer_hash); assert.equal(frame.recipient_key, winner.publicKey);
        if (frame.op === "claim") { claims++; result = mode === "delivered" ? delivery(accepted, frame.recipient_key, auth.remotePeer)
          : { state: "in_progress", automatic_retry_allowed: false, deposit_release_authorized: false }; }
        else {
          statusFrames.push(frame);
          if (mode === "stall") { stalls++; return new Promise((resolve) => lp.unwrap().addEventListener("close", () => { readAborted(); resolve(); }, { once: true })); }
          result = progress(mode === "delivered" ? "delivered" : mode === "restarted" ? "reconciliation_required" : mode === "expired" ? "ready" : "in_progress", mode === "expired" ? { claim_expired: true } : {});
        }
      }
      await send({ id: frame.id, ok: true, result });
    } },
  } });
  let client;
  try {
    accepted = bundle(terms(host.peerId.toString(), fixture.info));
    client = await couponAttestedClientForTesting(String(host.getMultiaddrs()[0]), fixture.options);
    const selected = await client.offer(coupon); winner = couponAttestedRecipient();
    await assert.rejects(client.awaitDelivery(coupon, winner, selected), /request failed/);
    assert.equal(claims, 0); assert.equal(statusFrames.length, 0);
    assert.equal((await client.claim(coupon, winner, selected)).state, "in_progress");
    await assert.rejects(client.awaitDelivery(coupon, couponAttestedRecipient(), selected), /request failed/);
    mode = "stall";
    await assert.rejects(client.awaitDelivery(coupon, winner, selected, { timeoutMs: 100, pollIntervalMs: 10 }), { code: "claim_pending" });
    await abortedRead; assert.equal(claims, 1, "timeout only polls; it does not reissue");
    mode = "restarted";
    await assert.rejects(client.awaitDelivery(coupon, winner, selected), { code: "claim_reconciliation_required" });
    assert.equal(claims, 1, "reconciliation never reconstructs a live job");
    mode = "expired";
    await assert.rejects(client.awaitDelivery(coupon, winner, selected), { code: "claim_expired" });
    assert.equal(claims, 1, "an expired unclaimed gift is reported, never retried into a claim");
    mode = "stall";
    const caller = new AbortController();
    const aborting = assert.rejects(client.awaitDelivery(coupon, winner, selected, { signal: caller.signal }), (error) => /request failed/.test(error.message) && error.code !== "claim_pending");
    while (stalls < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    caller.abort();
    await aborting;
    mode = "delivered";
    const result = await client.awaitDelivery(coupon, winner, selected);
    assert.equal(winner.decryptDelivery(coupon, result, selected), `synthetic-only-coupon-${sha(coupon)}`);
    assert.equal(claims, 2, "delivered retrieval replays exactly the original key/hash");
    assert.ok(statusFrames.every((frame) => frame.recipient_key === winner.publicKey && frame.offer_hash === selected.offer_hash));
  } finally { await client?.close(); await host.stop(); }
});
