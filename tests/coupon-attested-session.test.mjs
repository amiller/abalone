// Attested v4 recipient session: admissions, consent before claim, asynchronous claim with one
// retained key, cancellation, reconciliation, same-process recovery, signed debug-staging policy,
// the scoped provider-use brokers, and near admission-window recovery. Synthetic evidence only.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { servePeer } from "../lib/p2p.mjs";
import { canonicalCouponJson } from "../lib/coupon-offer.mjs";
import { couponAttestedClientForTesting, couponAttestedRecipient, couponAttestedRecipientPeerHash, COUPON_ISSUER_PROTOCOL, COUPON_ISSUER_FRAME_LIMIT, COUPON_PROTOCOL_V4 } from "../lib/coupon-attested.mjs";
import { openCouponNearAdapterForTesting } from "../lib/coupon-near.mjs";
import { issuerPolicyHash } from "../lib/vendor/dstack-issuer/dstack_issuer.mjs";
import { encrypt } from "../lib/near.mjs";
import { admitAttestedCouponIssuerPin, admitAttestedCouponSessionIssuer, openAttestedCouponSession, ATTESTED_COUPON_WAIT, ATTESTED_COUPON_RECOVER } from "../lib/coupon-attested-session.mjs";
import { syntheticIssuerIdentity } from "./fixtures/coupon/issuer-v2.mjs";
import { syntheticStagingSigner } from "./fixtures/coupon/staging-signer.mjs";
import { couponSocketFetch } from "../lib/coupon-socket.mjs";

const coupon = "a".repeat(43), sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const syntheticCredential = `synthetic-only-coupon-${sha(coupon)}`;
const nearCredential = "delivered-near-provider-credential-0123456789abcdef";
const nearModel = "selected/model";
const config = { couponSession: { mode: "synthetic-loopback", provider: "synthetic-near", baseUrl: "http://127.0.0.1:9999/v1", models: ["fixture-model"] } };
const identity = syntheticIssuerIdentity();
const issuerKeySha = sha(Buffer.from(identity.info.issuer_public_key_hex, "hex"));
const pin = () => ({ identityPolicy: structuredClone(identity.policy), expectedIdentityPolicySha256: identity.info.identity_policy_sha256,
  expectedIssuancePolicySha256: identity.info.issuance_policy_sha256, expectedIssuerPublicKeySha256: issuerKeySha });
const quote = async (hex) => JSON.parse(Buffer.from(hex, "hex").toString());
const bundle = (offer) => ({ offer, offer_hash: sha(Buffer.concat([Buffer.from("dsmack-coupon-offer-v4\0"), Buffer.from(canonicalCouponJson(offer))])) });
const terms = (peerId, { provider = "synthetic-near", scope = "cd".repeat(32), budget = "5000000000" } = {}) => ({ version: 4, coupon_digest: sha(coupon),
  issuer: { peer_id: peerId, policy: "dstack-tdx-coupon-v1", identity_policy_sha256: identity.info.identity_policy_sha256,
    issuance_policy_sha256: identity.info.issuance_policy_sha256, issuer_public_key_sha256: issuerKeySha },
  provider: { id: provider, scope_commitment: scope }, claim_policy: "first-authenticated-bearer", delivery_profile: "x25519-aesgcm-session-only",
  budget_nano_usd: budget, cap_semantics: "nominal-provider-limit", claim_expires_at: "2030-10-10T00:00:00Z", provider_expires_at: null, sponsor_powers: ["revoke", "change_limits"] });

function delivery(accepted, recipientKey, peer, credential) {
  const keyId = `synthetic-coupon-${sha(coupon)}`, recipient = Buffer.from(recipientKey, "base64");
  const aad = Buffer.from(canonicalCouponJson({ domain: "dsmack-coupon-delivery-v4", version: 4, offer_hash: accepted.offer_hash, coupon_digest: sha(coupon), key_id: keyId,
    recipient_key_sha256: sha(recipient), recipient_peer_sha256: couponAttestedRecipientPeerHash(peer) }));
  const pair = crypto.generateKeyPairSync("x25519"), remote = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), recipient]), format: "der", type: "spki" });
  const key = crypto.hkdfSync("sha256", crypto.diffieHellman({ privateKey: pair.privateKey, publicKey: remote }), Buffer.alloc(0), Buffer.concat([Buffer.from("dsmack-coupon-v1\0"), aad]), 32);
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(credential), cipher.final(), cipher.getAuthTag()]);
  return { key_id: keyId, envelope: JSON.stringify({ version: 1, aad: aad.toString("base64"), ephemeral: pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"), nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64") }) };
}

// A controllable v4 issuer: identity discovery answers the fixture, claim behavior and bound
// status are steered by the test, and every /4 frame is recorded for key-identity assertions.
async function issuerServer({ offerTerms, credential = syntheticCredential, identityFixture = identity } = {}) {
  const frames = [], claims = [], statuses = [], state = { evidenceFixture: identityFixture, claim: "grant", status: "in_progress", claimExpired: false, offer: bundle(offerTerms) };
  const host = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_ISSUER_PROTOCOL]: { maxDataLength: COUPON_ISSUER_FRAME_LIMIT, timeoutMs: 3000, handle: async (_lp, send, recv) => {
      const frame = await recv();
      await send({ id: frame.id, ok: true, result: frame.op === "info" ? identityFixture.info : state.evidenceFixture.evidence(frame.binding) });
    } },
    [COUPON_PROTOCOL_V4]: { timeoutMs: 3000, handle: async (_lp, send, recv, auth) => {
      const frame = await recv(); frames.push(frame);
      if (frame.op === "offer") return send({ id: frame.id, ok: true, result: state.offer });
      if (frame.op === "claim") {
        claims.push({ recipient_key: frame.recipient_key, offer_hash: frame.offer_hash });
        if (state.claim === "in_progress") return send({ id: frame.id, ok: true, result: { state: "in_progress", automatic_retry_allowed: false, deposit_release_authorized: false } });
        if (state.claim === "deny") return send({ id: frame.id, ok: false });
        return send({ id: frame.id, ok: true, result: delivery(state.offer, frame.recipient_key, auth.remotePeer, credential) });
      }
      statuses.push(frame);
      const keyId = state.status === "delivered" ? { key_id: `synthetic-coupon-${sha(coupon)}` } : {};
      return send({ id: frame.id, ok: true, result: { state: state.status, claim_expired: state.claimExpired, accounting_blocked: false,
        automatic_retry_allowed: false, deposit_release_authorized: false, ...keyId } });
    } },
  } });
  return { host, state, frames, claims, statuses, address: () => String(host.getMultiaddrs()[0]) };
}

const fixtureSession = (server, extra = {}) => openAttestedCouponSession({ peerAddr: server.address(), admit: { dev: true }, profile: "fixture-local",
  issuerPin: pin(), model: "fixture-model", config, syntheticQuoteVerifier: quote, pollRoundMs: 300, pollIntervalMs: 50, ...extra });

test("profile, pin, approval and slot admissions refuse before any connection or coupon capture", async () => {
  let connects = 0;
  const connect = () => { connects++; throw new Error("must not connect"); };
  const signer = syntheticStagingSigner();
  const approval = signer.sign({ identityPolicySha256: identity.info.identity_policy_sha256, issuancePolicySha256: identity.info.issuance_policy_sha256,
    issuerPublicKeySha256: issuerKeySha, providerScopeCommitment: "cd".repeat(32) });
  const loopback = "/ip4/127.0.0.1/tcp/1234/p2p/12D3KooWDbxDummy";
  const common = { peerAddr: loopback, admit: { dev: true }, issuerPin: pin(), config, syntheticQuoteVerifier: quote, connect, pollRoundMs: 300, pollIntervalMs: 50 };
  await assert.rejects(openAttestedCouponSession({ ...common, model: "fixture-model" }), { code: "issuer_unverified" });
  for (const change of [
    { peerAddr: loopback.replace("127.0.0.1", "192.0.2.1") }, { admit: { dev: false } },
    { issuerPin: { ...pin(), extra: 1 } },
    { model: "near/x" }, { occupied: true }, { ambient: true }, { syntheticQuoteVerifier: undefined },
    { stagingApproval: { bytes: approval.bytes, approvalRoot: approval.rootHex } },
  ]) await assert.rejects(openAttestedCouponSession({ ...common, profile: "fixture-local", model: "fixture-model", ...change, issuerPin: change.issuerPin ?? pin() }), (e) => !!e.code);
  for (const change of [
    { stagingApproval: undefined }, { stagingApproval: { bytes: approval.bytes } },
    { stagingApproval: { bytes: "not-a-buffer", approvalRoot: approval.rootHex } },
    { stagingApproval: { bytes: approval.bytes, approvalRoot: "nothex" } },
    { issuerPin: { ...pin(), extra: 1 } }, { occupied: true }, { ambient: true }, { model: 5 },
  ]) await assert.rejects(openAttestedCouponSession({ ...common, stagingApproval: { bytes: approval.bytes, approvalRoot: approval.rootHex },
    ...change, profile: "debug-staging", model: change.model ?? nearModel, issuerPin: change.issuerPin ?? pin() }), (e) => !!e.code);
  assert.equal(connects, 0, "no admission failure may open a connection or read a coupon");
  assert.throws(() => admitAttestedCouponIssuerPin({ ...pin(), identityPolicy: null }), { code: "issuer_pin_refused" });
  assert.equal(admitAttestedCouponSessionIssuer({ ...common, profile: "fixture-local", model: "fixture-model" }).profile, "fixture-local");
});

test("issuer and approval pin mismatches refuse on connect before any bearer frame", { timeout: 25_000 }, async () => {
  const server = await issuerServer({ offerTerms: terms("placeholder") });
  const signer = syntheticStagingSigner();
  const pace = () => new Promise((resolve) => setTimeout(resolve, 220)); // keep the libp2p admission limit happy
  try {
    const good = { peerAddr: server.address(), admit: { dev: true }, profile: "debug-staging", model: nearModel, config,
      connect: (addr, options) => couponAttestedClientForTesting(addr, { ...options, syntheticQuoteVerifier: quote }) };
    // A wrong issuance pin cannot pass identity verification: nothing reaches /4.
    await assert.rejects(openAttestedCouponSession({ ...good, issuerPin: { ...pin(), expectedIssuancePolicySha256: "ff".repeat(32) },
      stagingApproval: { bytes: signer.sign({ identityPolicySha256: identity.info.identity_policy_sha256, issuancePolicySha256: "ff".repeat(32), issuerPublicKeySha256: issuerKeySha, providerScopeCommitment: "cd".repeat(32) }).bytes, approvalRoot: signer.rootHex } }),
      { code: "issuer_unverified" });
    assert.equal(server.frames.length, 0);
    // An approval for a different issuer (or signed by another root) is refused against the
    // identity this connection actually verified, still before any bearer material.
    for (const wrong of [
      { issuerPublicKeySha256: "ee".repeat(32) }, { issuancePolicySha256: "ee".repeat(32) }, { identityPolicySha256: "ee".repeat(32) },
      { appId: "ee".repeat(20) }, { composeHash: "ee".repeat(32) },
    ]) {
      await assert.rejects(openAttestedCouponSession({ ...good, issuerPin: pin(),
        stagingApproval: { bytes: signer.sign({ identityPolicySha256: wrong.identityPolicySha256 ?? identity.info.identity_policy_sha256,
          issuancePolicySha256: wrong.issuancePolicySha256 ?? identity.info.issuance_policy_sha256, issuerPublicKeySha256: wrong.issuerPublicKeySha256 ?? issuerKeySha,
          providerScopeCommitment: "cd".repeat(32), ...wrong }).bytes, approvalRoot: signer.rootHex } }), { code: "staging_admission_refused" });
      await pace();
    }
    const other = syntheticStagingSigner();
    await assert.rejects(openAttestedCouponSession({ ...good, issuerPin: pin(),
      stagingApproval: { bytes: other.sign({ identityPolicySha256: identity.info.identity_policy_sha256, issuancePolicySha256: identity.info.issuance_policy_sha256,
        issuerPublicKeySha256: issuerKeySha, providerScopeCommitment: "cd".repeat(32) }).bytes, approvalRoot: signer.rootHex } }), { code: "staging_admission_refused" });
    await pace();
    assert.equal(server.frames.length, 0, "no bearer frame may leave before the signed admission verifies");
    // An expired approval keeps its own stable code.
    await assert.rejects(openAttestedCouponSession({ ...good, issuerPin: pin(),
      stagingApproval: { bytes: signer.sign({ identityPolicySha256: identity.info.identity_policy_sha256, issuancePolicySha256: identity.info.issuance_policy_sha256,
        issuerPublicKeySha256: issuerKeySha, providerScopeCommitment: "cd".repeat(32), expiresAt: "2020-01-01T00:00:00Z" }).bytes, approvalRoot: signer.rootHex } }),
      { code: "staging_approval_expired" });
    assert.equal(server.frames.length, 0);
  } finally { await server.host.stop(); }
});

test("staging buffers are snapshotted and every identity refresh binds the signed app and compose", { timeout: 15_000 }, async () => {
  const pair = crypto.generateKeyPairSync("ed25519"), initial = syntheticIssuerIdentity(pair), alternate = syntheticIssuerIdentity(pair);
  alternate.policy.approved_measurements[0].runtime_events["app-id"] = "99".repeat(20);
  initial.policy.approved_measurements.push(structuredClone(alternate.policy.approved_measurements[0]));
  initial.info.identity_policy_sha256 = issuerPolicyHash(initial.policy);
  const server = await issuerServer({ offerTerms: terms("placeholder"), identityFixture: initial });
  const signer = syntheticStagingSigner(), raw = signer.sign({ identityPolicySha256: initial.info.identity_policy_sha256,
    issuancePolicySha256: initial.info.issuance_policy_sha256, issuerPublicKeySha256: sha(Buffer.from(initial.info.issuer_public_key_hex, "hex")), providerScopeCommitment: "cd".repeat(32) });
  const root = Buffer.from(signer.rootHex, "hex");
  let client;
  try {
    const opening = couponAttestedClientForTesting(server.address(), { identityPolicy: initial.policy,
      expectedIdentityPolicySha256: initial.info.identity_policy_sha256, expectedIssuancePolicySha256: initial.info.issuance_policy_sha256,
      expectedIssuerPublicKeySha256: sha(Buffer.from(initial.info.issuer_public_key_hex, "hex")), syntheticQuoteVerifier: quote,
      stagingApproval: { bytes: raw.bytes, approvalRoot: root } });
    raw.bytes.fill(0); root.fill(0);
    client = await opening;
    assert.equal(client.identity.appId, "05".repeat(20));
    server.state.evidenceFixture = alternate;
    await assert.rejects(client.refreshIdentity(), { code: "staging_admission_refused" });
    await assert.rejects(client.offer(coupon), { code: "staging_admission_refused" });
    assert.equal(server.frames.length, 0, "a policy-admitted alternate app cannot receive staging bearer material");
  } finally { await client?.close(); await server.host.stop(); }
});

test("explicit consent precedes any claim; the offer states the asynchronous and session-only terms", { timeout: 15_000 }, async () => {
  const server = await issuerServer({ offerTerms: terms("placeholder") });
  let session;
  try {
    server.state.offer = bundle(terms(server.host.peerId.toString()));
    session = await fixtureSession(server);
    const preview = await session.inspect(coupon);
    assert.equal(session.state, "offer_received");
    for (const needle of ["V4 OFFER", "asynchronous", "EXIT OR CRASH LOSES RECOVERY", "session-only", "dstack-tdx-coupon-v1",
      "synthetic-near/fixture-model", `Offer hash: ${preview.offerHash}`, "not a private-issuance guarantee"])
      assert.ok(preview.text.includes(needle), `offer text must state ${needle}`);
    for (const options of [undefined, {}, { offerHash: preview.offerHash }, { consent: "CLAIM SESSION ONLY", offerHash: "b".repeat(64) },
      { consent: "CLAIM DEBUG STAGING SESSION", offerHash: preview.offerHash }])
      await assert.rejects(session.claim(options), { code: "consent_required" });
    await assert.rejects(session.resume({ consent: ATTESTED_COUPON_WAIT }), { code: "resume_refused" });
    await assert.rejects(session.recover({ consent: ATTESTED_COUPON_RECOVER }), { code: "recovery_refused" });
    await assert.rejects(session.inspect("b".repeat(43)), { code: "coupon_already_selected" });
    assert.equal(server.claims.length, 0, "no claim may leave before explicit consent");
    assert.ok(!JSON.stringify(preview).includes(syntheticCredential));
    await session.close();
    await assert.rejects(session.claim({ offerHash: preview.offerHash, consent: "CLAIM SESSION ONLY" }), { code: "session_closed" });
  } finally { await session?.close(); await server.host.stop(); }
});

test("asynchronous claim keeps one key and offer hash across polling, waits and the delivered replay", { timeout: 15_000 }, async () => {
  const server = await issuerServer({ offerTerms: terms("placeholder") });
  let session;
  try {
    server.state.offer = bundle(terms(server.host.peerId.toString()));
    server.state.claim = "in_progress";
    session = await fixtureSession(server);
    const preview = await session.inspect(coupon);
    // A second claim while a round is in flight is refused: never a second key.
    const pending = session.claim({ offerHash: preview.offerHash, consent: "CLAIM SESSION ONLY" });
    await assert.rejects(session.claim({ offerHash: preview.offerHash, consent: "CLAIM SESSION ONLY" }), { code: "claim_in_progress" });
    await assert.rejects(pending, { code: "claim_pending" });
    assert.equal(server.claims.length, 1);
    // Waiting requires the exact same-key consent line.
    await assert.rejects(session.resume({ consent: "WAIT" }), { code: "resume_refused" });
    await assert.rejects(session.resume({ consent: ATTESTED_COUPON_WAIT }), { code: "claim_pending" });
    assert.equal(server.claims.length, 1, "polling never reissues the claim");
    server.state.status = "delivered"; server.state.claim = "grant";
    const installed = await session.resume({ consent: ATTESTED_COUPON_WAIT });
    assert.equal(installed.state, "installed"); assert.equal(session.state, "installed");
    assert.equal(server.claims.length, 2, "delivery replays exactly the original claim binding");
    const keys = new Set(server.claims.map((c) => c.recipient_key));
    assert.equal(keys.size, 1, "one recipient delivery key for the whole session");
    assert.ok(server.claims.every((c) => c.offer_hash === preview.offerHash));
    assert.ok(server.statuses.every((f) => f.recipient_key === [...keys][0] && f.offer_hash === preview.offerHash));
    assert.ok(!JSON.stringify(installed).includes(syntheticCredential) && !JSON.stringify(session).includes(syntheticCredential));
    const info = session.info();
    assert.equal(info.profile, "fixture-local"); assert.equal(info.issuer.policy, "dstack-tdx-coupon-v1");
    assert.equal(info.issuer.evidence, "synthetic-only-not-hardware"); assert.equal(info.restartRecovery, false);
    assert.ok(!JSON.stringify(info).includes(syntheticCredential));
  } finally { await session?.close(); await server.host.stop(); }
});

test("cancelling a pending round keeps the original keys pending; reconciliation and expiry stay terminal", { timeout: 20_000 }, async () => {
  const server = await issuerServer({ offerTerms: terms("placeholder") });
  let session;
  try {
    server.state.offer = bundle(terms(server.host.peerId.toString()));
    server.state.claim = "in_progress";
    session = await fixtureSession(server);
    const preview = await session.inspect(coupon);
    const pending = session.claim({ offerHash: preview.offerHash, consent: "CLAIM SESSION ONLY" });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await session.cancel();
    await assert.rejects(pending, { code: "claim_cancelled" });
    assert.equal(session.state, "claim_pending");
    assert.equal(server.claims.length, 1, "cancellation never reissues the claim");
    await assert.rejects(session.cancel(), { code: "nothing_pending" });
    server.state.status = "delivered"; server.state.claim = "grant";
    const installed = await session.resume({ consent: ATTESTED_COUPON_WAIT });
    assert.equal(installed.state, "installed");
    assert.equal(session.state, "installed", "a delivery landing on a resumed round installs the credential");
    assert.equal(new Set(server.claims.map((c) => c.recipient_key)).size, 1);
    await session.close();
    // Reconciliation and an expired unclaimed gift are terminal states that never re-claim.
    for (const [status, claimExpired, code] of [["reconciliation_required", false, "reconciliation_required"], ["ready", true, "claim_expired"]]) {
      const other = await issuerServer({ offerTerms: terms("placeholder") });
      let pendingSession;
      try {
        other.state.offer = bundle(terms(other.host.peerId.toString()));
        other.state.claim = "in_progress"; other.state.status = status; other.state.claimExpired = claimExpired;
        pendingSession = await fixtureSession(other);
        const offer = await pendingSession.inspect(coupon);
        await assert.rejects(pendingSession.claim({ offerHash: offer.offerHash, consent: "CLAIM SESSION ONLY" }), { code: code });
        assert.equal(other.claims.length, 1, "a terminal status is reported, never retried into a claim");
        await assert.rejects(pendingSession.resume({ consent: ATTESTED_COUPON_WAIT }), { code: "resume_refused" });
      } finally { await pendingSession?.close(); await other.host.stop(); }
    }
  } finally { await session?.close(); await server.host.stop(); }
});

test("an uncertain claim recovers in-process with the same keys; a never-landed claim retries the original request", { timeout: 20_000 }, async () => {
  for (const [claimMode, status, code] of [["deny", "delivered", "claim_uncertain"], ["in_progress", "ready", "claim_not_reserved"]]) {
    const server = await issuerServer({ offerTerms: terms("placeholder") });
    let session;
    try {
      server.state.offer = bundle(terms(server.host.peerId.toString()));
      server.state.claim = claimMode; server.state.status = status;
      session = await fixtureSession(server);
      const preview = await session.inspect(coupon);
      await assert.rejects(session.claim({ offerHash: preview.offerHash, consent: "CLAIM SESSION ONLY" }), { code });
      assert.equal(server.claims.length, 1);
      await assert.rejects(session.recover({ consent: "RETRY" }), { code: "recovery_refused" });
      server.state.claim = "grant"; // the recorded claim replays its delivery on the original binding
      const installed = await session.recover({ consent: ATTESTED_COUPON_RECOVER });
      assert.equal(installed.state, "installed");
      assert.equal(new Set(server.claims.map((c) => c.recipient_key)).size, 1, "recovery replays the original key and hash only");
      assert.ok(server.claims.every((c) => c.offer_hash === preview.offerHash));
    } finally { await session?.close(); await server.host.stop(); }
  }
});

test("a delivered credential that does not match the admitted provider profile installs nothing", { timeout: 20_000 }, async () => {
  const signer = syntheticStagingSigner();
  // The near profile refuses a synthetic-only delivery.
  const nearServer = await issuerServer({ offerTerms: terms("placeholder", { provider: "near", scope: "ab".repeat(32) }), credential: syntheticCredential });
  let near;
  try {
    nearServer.state.offer = bundle(terms(nearServer.host.peerId.toString(), { provider: "near", scope: "ab".repeat(32) }));
    near = await openAttestedCouponSession({ peerAddr: nearServer.address(), admit: { dev: true }, profile: "debug-staging", model: nearModel, config,
      issuerPin: pin(), stagingApproval: { bytes: signer.sign({ identityPolicySha256: identity.info.identity_policy_sha256, issuancePolicySha256: identity.info.issuance_policy_sha256,
        issuerPublicKeySha256: issuerKeySha, providerScopeCommitment: "ab".repeat(32) }).bytes, approvalRoot: signer.rootHex },
      connect: (addr, options) => couponAttestedClientForTesting(addr, { ...options, syntheticQuoteVerifier: quote }), pollRoundMs: 300, pollIntervalMs: 50 });
    const preview = await near.inspect(coupon);
    assert.ok(preview.text.includes("DEBUG-STAGING ADMISSION") && preview.text.includes("OPERATOR SECRET ACCESS") && preview.text.includes("SYNTHETIC-ONLY"));
    await assert.rejects(near.claim({ offerHash: preview.offerHash, consent: "CLAIM DEBUG STAGING SESSION" }), { code: "credential_refused" });
    assert.equal(near.state, "delivery_refused");
    assert.ok(!JSON.stringify(near).includes(syntheticCredential));
  } finally { await near?.close(); await nearServer.host.stop(); }
  // The synthetic fixture profile refuses a non-synthetic delivery.
  const fixtureServer = await issuerServer({ offerTerms: terms("placeholder"), credential: "not-a-synthetic-fixture-credential" });
  let fixture;
  try {
    fixtureServer.state.offer = bundle(terms(fixtureServer.host.peerId.toString()));
    fixture = await fixtureSession(fixtureServer);
    const preview = await fixture.inspect(coupon);
    await assert.rejects(fixture.claim({ offerHash: preview.offerHash, consent: "CLAIM SESSION ONLY" }), { code: "credential_refused" });
    assert.equal(fixture.state, "delivery_refused");
  } finally { await fixture?.close(); await fixtureServer.host.stop(); }
});

test("signed debug-staging policy: exact consent line, scope commitment and budget bound before any claim", { timeout: 25_000 }, async () => {
  const signer = syntheticStagingSigner();
  const approvalFor = (changes = {}) => signer.sign({ identityPolicySha256: identity.info.identity_policy_sha256, issuancePolicySha256: identity.info.issuance_policy_sha256,
    issuerPublicKeySha256: issuerKeySha, providerScopeCommitment: "ab".repeat(32), ...changes });
  const server = await issuerServer({ offerTerms: terms("placeholder", { provider: "near", scope: "ab".repeat(32), budget: "5000000000" }), credential: nearCredential });
  const pace = () => new Promise((resolve) => setTimeout(resolve, 220)); // keep the libp2p admission limit happy
  let session, expiring;
  try {
    const open = (approval) => openAttestedCouponSession({ peerAddr: server.address(), admit: { dev: true }, profile: "debug-staging", model: nearModel, config,
      issuerPin: pin(), stagingApproval: { bytes: approval.bytes, approvalRoot: signer.rootHex },
      connect: (addr, options) => couponAttestedClientForTesting(addr, { ...options, syntheticQuoteVerifier: quote }), pollRoundMs: 300, pollIntervalMs: 50 });
    server.state.offer = bundle(terms(server.host.peerId.toString(), { provider: "near", scope: "ab".repeat(32), budget: "5000000000" }));
    session = await open(approvalFor());
    const preview = await session.inspect(coupon);
    assert.equal(session.stagingAdmission.operatorSecretAccess, true);
    assert.equal(session.stagingAdmission.privateIssuanceQualified, false);
    assert.equal(session.stagingAdmission.rollbackQualified, false);
    assert.equal(session.stagingAdmission.settlementApproval, false);
    await assert.rejects(session.claim({ offerHash: preview.offerHash, consent: "CLAIM SESSION ONLY" }), { code: "consent_required" });
    assert.equal(server.claims.length, 0, "the debug-staging consent line is required before any claim");
    // A budget beyond the approval's bound, a wrong scope commitment and a silently downgraded
    // synthetic provider are all refused at the offer, before consent or any claim.
    for (const [offer, approval] of [
      [terms(server.host.peerId.toString(), { provider: "near", scope: "ab".repeat(32), budget: "6000000000" }), approvalFor()],
      [terms(server.host.peerId.toString(), { provider: "near", scope: "ef".repeat(32), budget: "5000000000" }), approvalFor()],
      [terms(server.host.peerId.toString(), { provider: "synthetic-near", budget: "5000000000" }), approvalFor()],
    ]) {
      await pace();
      const other = await open(approval);
      server.state.offer = bundle(offer);
      try { await assert.rejects(other.inspect(coupon), { code: "offer_refused" }); }
      finally { await other.close(); }
    }
    assert.equal(server.claims.length, 0);
    // An approval whose window closes mid-session keeps its own refusal on the next bearer request.
    // The window must outlive the paced connect and the offer, but not the wait that follows.
    await pace();
    expiring = await open(approvalFor({ expiresAt: new Date(Date.now() + 2000).toISOString().replace(/\.\d{3}Z$/, "Z") }));
    server.state.offer = bundle(terms(server.host.peerId.toString(), { provider: "near", scope: "ab".repeat(32), budget: "5000000000" }));
    const expiringOffer = await expiring.inspect(coupon);
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await assert.rejects(expiring.claim({ offerHash: expiringOffer.offerHash, consent: "CLAIM DEBUG STAGING SESSION" }), { code: "staging_approval_expired" });
    await expiring.close();
    assert.equal(server.claims.length, 0, "an expired admission never sends the bearer claim");
  } finally { await expiring?.close(); await session?.close(); await server.host.stop(); }
});

test("approval expiry after a reserved claim preserves pending history and original keys", { timeout: 15_000 }, async () => {
  const signer = syntheticStagingSigner(), server = await issuerServer({ offerTerms: terms("placeholder", { provider: "near", scope: "ab".repeat(32) }), credential: nearCredential });
  let session;
  try {
    server.state.offer = bundle(terms(server.host.peerId.toString(), { provider: "near", scope: "ab".repeat(32) }));
    server.state.claim = "in_progress";
    const expiry = new Date(Date.now() + 3000).toISOString().replace(/\.\d{3}Z$/, "Z");
    session = await openAttestedCouponSession({ peerAddr: server.address(), profile: "debug-staging", model: nearModel, issuerPin: pin(),
      stagingApproval: { bytes: signer.sign({ identityPolicySha256: identity.info.identity_policy_sha256, issuancePolicySha256: identity.info.issuance_policy_sha256,
        issuerPublicKeySha256: issuerKeySha, providerScopeCommitment: "ab".repeat(32), expiresAt: expiry }).bytes, approvalRoot: signer.rootHex },
      connect: (addr, options) => couponAttestedClientForTesting(addr, { ...options, syntheticQuoteVerifier: quote }), pollRoundMs: 300, pollIntervalMs: 50 });
    const preview = await session.inspect(coupon);
    await assert.rejects(session.claim({ offerHash: preview.offerHash, consent: "CLAIM DEBUG STAGING SESSION" }), { code: "claim_pending" });
    const requests = server.frames.length;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, Date.parse(expiry) - Date.now() + 30)));
    await assert.rejects(session.resume({ consent: ATTESTED_COUPON_WAIT }), (e) => e.code === "staging_approval_expired" && !e.message.includes("No claim or key was created"));
    assert.equal(session.state, "claim_pending");
    assert.equal(server.frames.length, requests, "expiry cannot transmit another bearer frame");
    assert.equal(server.claims.length, 1);
  } finally { await session?.close(); await server.host.stop(); }
});

// A model key standing in for the attested signing key, and a transport stand-in speaking the real
// wire protocol. Only the admission verdict is synthetic; the adapter runtime is the real one.
const modelKey = crypto.createECDH("secp256k1"); modelKey.generateKeys();
const nearTransport = (state, credential) => ({
  close: async () => { state.closed = true; },
  fetch: async (input, init) => {
    state.chats++;
    const url = new URL(String(input));
    assert.equal(url.origin, "https://cloud-api.near.ai"); assert.equal(url.pathname, "/v1/chat/completions");
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${credential}`);
    const body = JSON.parse(init.body);
    assert.equal(body.model, nearModel); assert.equal(body.stream, true);
    if (state.mode === "stall") return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("upstream aborted")), { once: true }));
    const clientPub = new Headers(init.headers).get("x-client-pub-key");
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: encrypt(`useful near answer ${credential}`, clientPub) } }] })}\n\ndata: [DONE]\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } });
  },
});

test("near broker: bounded admission windows re-admit the same delivered credential; expiry mid-request explains itself; close clears everything", { timeout: 30_000 }, async () => {
  const signer = syntheticStagingSigner();
  const server = await issuerServer({ offerTerms: terms("placeholder", { provider: "near", scope: "ab".repeat(32) }), credential: nearCredential });
  const admissions = [], states = [];
  const approvalExpiry = new Date(Date.now() + 5000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coupon-attested-near-"));
  let session, socketPath;
  try {
    server.state.offer = bundle(terms(server.host.peerId.toString(), { provider: "near", scope: "ab".repeat(32) }));
    session = await openAttestedCouponSession({ peerAddr: server.address(), admit: { dev: true }, profile: "debug-staging", model: nearModel, config, issuerPin: pin(),
      stagingApproval: { bytes: signer.sign({ identityPolicySha256: identity.info.identity_policy_sha256, issuancePolicySha256: identity.info.issuance_policy_sha256,
        issuerPublicKeySha256: issuerKeySha, providerScopeCommitment: "ab".repeat(32), expiresAt: approvalExpiry }).bytes, approvalRoot: signer.rootHex },
      connect: (addr, options) => couponAttestedClientForTesting(addr, { ...options, syntheticQuoteVerifier: quote }),
      nearAdapterFactory: (options) => { admissions.push({ credential: options.credential, transport: { chats: 0, closed: false, mode: "ok" } });
        const state = admissions.at(-1).transport;
        return openCouponNearAdapterForTesting({ ...options, sessionLifetimeMs: 700, timeoutMs: 3000, verifiedForTesting: { signingPublicKey: modelKey.getPublicKey("hex"),
          profile: { gateway_tcb: "synthetic-only-not-hardware", model_tcb: ["synthetic-only-not-hardware"], gpu: "GPU: NVIDIA verdict (synthetic-only-not-hardware)" },
          transport: nearTransport(state, nearCredential) } }); },
      pollRoundMs: 300, pollIntervalMs: 50 });
    const preview = await session.inspect(coupon);
    await session.claim({ offerHash: preview.offerHash, consent: "CLAIM DEBUG STAGING SESSION" });
    assert.equal(session.state, "installed");
    const claimsAtDelivery = server.claims.length;
    socketPath = path.join(directory, "broker.sock");
    await session.broker(socketPath, { timeoutMs: 3000, maxBytes: 65536, onState: (s) => states.push(s) });
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
    const send = couponSocketFetch(socketPath);
    const body = JSON.stringify({ model: nearModel, messages: [{ role: "user", content: "synthetic qualification content" }], stream: true, max_tokens: 128 });
    const first = await send("ignored", { body });
    assert.ok((await first.text()).includes("useful near answer"));
    assert.equal(admissions.length, 1);
    // The window closes; the next request opens a fresh admission with the same credential. No
    // new coupon claim, no new recipient key.
    await new Promise((resolve) => setTimeout(resolve, 900));
    const second = await send("ignored", { body });
    assert.ok((await second.text()).includes("useful near answer"));
    assert.equal(admissions.length, 2, "expiry re-admits through a fresh adapter");
    assert.deepEqual(admissions.map((a) => a.credential), [nearCredential, nearCredential], "the same delivered credential is reused, never re-claimed");
    assert.ok(states.includes("provider_readmitted"));
    assert.equal(server.claims.length, claimsAtDelivery, "provider use never claims again");
    // Expiry mid-request surfaces its own bounded explanation; the next request self-heals.
    admissions.at(-1).transport.mode = "stall";
    const aborted = await send("ignored", { body });
    assert.equal(aborted.status, 503);
    const text = await aborted.text();
    assert.ok(text.includes("fresh adapter admission") && text.includes("do not create another coupon or recipient key"));
    assert.ok(!text.includes(nearCredential));
    assert.ok(states.includes("provider_admission_expired"));
    const healed = await send("ignored", { body });
    assert.ok((await healed.text()).includes("useful near answer"));
    assert.equal(admissions.length, 3);
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, Date.parse(approvalExpiry) - Date.now() + 30)));
    const effects = admissions.reduce((count, a) => count + a.transport.chats, 0);
    const expiredApproval = await send("ignored", { body });
    assert.ok((await expiredApproval.text()).includes("staging_approval_expired"));
    assert.equal(admissions.length, 3, "signed approval expiry cannot renew model admission");
    assert.equal(admissions.reduce((count, a) => count + a.transport.chats, 0), effects, "signed approval expiry cannot contact the provider");
    assert.equal(server.claims.length, claimsAtDelivery, "approval expiry never reclaims the gift");
    // close/forget: the socket goes, the admission and its credential reference are dropped.
    const closed = admissions.filter((a) => a.transport.closed).length;
    await session.close();
    assert.equal(fs.existsSync(socketPath), false);
    assert.equal(admissions.filter((a) => a.transport.closed).length, admissions.length, "every adapter admission closed with the session");
    assert.equal(closed, admissions.length, "approval expiry already closes all admitted transports");
    await assert.rejects(send("ignored", { body }), /broker is unavailable/);
    assert.ok(!JSON.stringify(session).includes(nearCredential), "close clears the session's credential reference");
  } finally { await session?.close(); await server.host.stop(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("closing during a pending claim or broker opening aborts cleanly and leaves nothing installed", { timeout: 15_000 }, async () => {
  const server = await issuerServer({ offerTerms: terms("placeholder") });
  let session;
  try {
    server.state.offer = bundle(terms(server.host.peerId.toString()));
    server.state.claim = "in_progress";
    session = await fixtureSession(server);
    const preview = await session.inspect(coupon);
    // The rejection handler is attached up front: close() tears down the transport asynchronously,
    // so the aborted round's rejection must never sit unhandled while the test waits for close.
    const pending = assert.rejects(session.claim({ offerHash: preview.offerHash, consent: "CLAIM SESSION ONLY" }), { code: "session_closed" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await session.close();
    await pending;
    assert.equal(session.state, "closed");
    await assert.rejects(session.inspect(coupon), { code: "session_closed" });
    await assert.rejects(session.cancel(), { code: "session_closed" });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coupon-attested-close-")), socketPath = path.join(directory, "broker.sock");
    try {
      // An installed session whose broker is opening when close() lands: the opening is undone,
      // nothing is left behind, and the abort is reported as a closed session.
      server.state.claim = "grant"; server.state.status = "delivered";
      const other = await fixtureSession(server);
      const offer = await other.inspect(coupon);
      await other.claim({ offerHash: offer.offerHash, consent: "CLAIM SESSION ONLY" });
      const opening = other.broker(socketPath), closing = other.close();
      await assert.rejects(opening, { code: "session_closed" }); await closing;
      assert.equal(fs.existsSync(socketPath), false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  } finally { await session?.close(); await server.host.stop(); }
});
