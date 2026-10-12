// Durable credit: one claim, original-key recovery across processes, saved-record bindings,
// private-file and lock safety, link input and CLI output. Synthetic issuer and adapter only.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { servePeer } from "../lib/p2p.mjs";
import { canonicalCouponJson } from "../lib/coupon-offer.mjs";
import { couponAttestedClientForTesting, couponAttestedRecipient, couponAttestedRecipientPeerHash, validateAttestedCouponOffer, COUPON_ISSUER_PROTOCOL, COUPON_ISSUER_FRAME_LIMIT, COUPON_PROTOCOL_V4 } from "../lib/coupon-attested.mjs";
import { createCreditManager, createCreditManagerForTesting } from "../lib/credit.mjs";
import { OUT_OF_DATE_TRIAL_POLICY, OUT_OF_DATE_TRIAL_NOTICE } from "../lib/coupon-near.mjs";
import { creditStore, creditId, couponInput, privateDirectory, readPrivate } from "../lib/credit-store.mjs";
import { syntheticIssuerIdentity } from "./fixtures/coupon/issuer-v2.mjs";
import { syntheticStagingSigner } from "./fixtures/coupon/staging-signer.mjs";

const root = path.resolve(import.meta.dirname, "..");
const coupon = "c".repeat(43), id = creditId(coupon), sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const credential = "delivered-near-provider-credential-0123456789abcdef";
const identity = syntheticIssuerIdentity(), issuerKeySha = sha(Buffer.from(identity.info.issuer_public_key_hex, "hex"));
const signer = syntheticStagingSigner(), scope = "ab".repeat(32);
const approval = signer.sign({ identityPolicySha256: identity.info.identity_policy_sha256, issuancePolicySha256: identity.info.issuance_policy_sha256,
  issuerPublicKeySha256: issuerKeySha, providerScopeCommitment: scope });
const pin = () => ({ identityPolicy: structuredClone(identity.policy), expectedIdentityPolicySha256: identity.info.identity_policy_sha256,
  expectedIssuancePolicySha256: identity.info.issuance_policy_sha256, expectedIssuerPublicKeySha256: issuerKeySha });
const provider = { baseUrl: "https://cloud-api.near.ai/v1", model: "selected/model", maxTokens: 512,
  policy: { gatewayTcb: "UpToDate", modelTcb: "UpToDate", gpuSignature: "required", composeRegistry: { rpc: "https://mainnet.base.org", chainId: 8453 } } };
const quote = async (hex) => JSON.parse(Buffer.from(hex, "hex").toString());
const connect = (addr, options, transport) => couponAttestedClientForTesting(addr, { ...options, syntheticQuoteVerifier: quote }, transport);
const pace = () => new Promise((resolve) => setTimeout(resolve, 220));
const bundle = (offer) => ({ offer, offer_hash: sha(Buffer.concat([Buffer.from("dsmack-coupon-offer-v4\0"), Buffer.from(canonicalCouponJson(offer))])) });
const terms = (peerId, profile = "x25519-aesgcm-recipient-v1") => ({ version: 4, coupon_digest: sha(coupon),
  issuer: { peer_id: peerId, policy: "dstack-tdx-coupon-v1", identity_policy_sha256: identity.info.identity_policy_sha256,
    issuance_policy_sha256: identity.info.issuance_policy_sha256, issuer_public_key_sha256: issuerKeySha },
  provider: { id: "near", scope_commitment: scope }, claim_policy: "first-authenticated-bearer", delivery_profile: profile,
  budget_nano_usd: "5000000000", cap_semantics: "nominal-provider-limit", claim_expires_at: "2030-10-10T00:00:00Z", provider_expires_at: null, sponsor_powers: ["revoke", "change_limits"] });

function delivery(accepted, recipientKey, peer) {
  const keyId = `near-key-${sha(coupon).slice(0, 16)}`, recipient = Buffer.from(recipientKey, "base64");
  const aad = Buffer.from(canonicalCouponJson({ domain: "dsmack-coupon-delivery-v4", version: 4, offer_hash: accepted.offer_hash, coupon_digest: sha(coupon), key_id: keyId,
    recipient_key_sha256: sha(recipient), recipient_peer_sha256: couponAttestedRecipientPeerHash(peer) }));
  const pair = crypto.generateKeyPairSync("x25519"), remote = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), recipient]), format: "der", type: "spki" });
  const key = crypto.hkdfSync("sha256", crypto.diffieHellman({ privateKey: pair.privateKey, publicKey: remote }), Buffer.alloc(0), Buffer.concat([Buffer.from("dsmack-coupon-v1\0"), aad]), 32);
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(credential), cipher.final(), cipher.getAuthTag()]);
  return { key_id: keyId, envelope: JSON.stringify({ version: 1, aad: aad.toString("base64"), ephemeral: pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"), nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64") }) };
}

async function issuer(profile) {
  // statuses is consumed first (one per bound status frame), then status repeats.
  const frames = [], state = { claim: "grant", status: "in_progress", statuses: [], claimExpired: false, accountingBlocked: false };
  const host = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_ISSUER_PROTOCOL]: { maxDataLength: COUPON_ISSUER_FRAME_LIMIT, timeoutMs: 3000, handle: async (_lp, send, recv) => {
      const frame = await recv();
      await send({ id: frame.id, ok: true, result: frame.op === "info" ? identity.info : identity.evidence(frame.binding) });
    } },
    [COUPON_PROTOCOL_V4]: { timeoutMs: 3000, handle: async (_lp, send, recv, auth) => {
      const frame = await recv(); frames.push({ op: frame.op, peer: auth.remotePeer.toString(), recipient_key: frame.recipient_key });
      if (frame.op === "offer") return send({ id: frame.id, ok: true, result: state.offer });
      if (frame.op === "claim") {
        if (state.claim === "in_progress") return send({ id: frame.id, ok: true, result: { state: "in_progress", automatic_retry_allowed: false, deposit_release_authorized: false } });
        return send({ id: frame.id, ok: true, result: delivery(state.offer, frame.recipient_key, auth.remotePeer.toString()) });
      }
      const current = state.statuses.shift() ?? state.status;
      return send({ id: frame.id, ok: true, result: { state: current, claim_expired: state.claimExpired, accounting_blocked: state.accountingBlocked, automatic_retry_allowed: false,
        deposit_release_authorized: false, ...(current === "delivered" ? { key_id: `near-key-${sha(coupon).slice(0, 16)}` } : {}) } });
    } },
  } });
  state.offer = bundle(terms(host.peerId.toString(), profile));
  const address = String(host.getMultiaddrs()[0]);
  return { host, state, frames, admission: { peer: address, pin: pin(), approval: approval.bytes.toString("base64"), approvalRoot: signer.rootHex, provider } };
}
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "abalone-credit-"));
const noSecrets = (text, record) => { for (const secret of [coupon, credential, record.noiseSeed, record.recipientKey]) assert.ok(!text.includes(secret)); };

test("one accepted redeem claims once; installed credit never claims again; legacy session-only offers are refused before saving", { timeout: 30_000 }, async () => {
  const legacy = await issuer("x25519-aesgcm-session-only"), server = await issuer();
  const dir = tempDir(), manager = createCreditManagerForTesting({ directory: path.join(dir, "credit"), connect });
  try {
    await assert.rejects(manager.inspect(coupon, legacy.admission), { code: "credit_offer_refused" });
    assert.deepEqual(legacy.frames.map((f) => f.op), ["offer"]);
    assert.equal(fs.existsSync(path.join(dir, "credit", `${id}.json`)), false);
    const offer = await manager.inspect(coupon, server.admission);
    assert.equal(offer.state, "offered"); assert.equal(offer.deliveryProfile, "x25519-aesgcm-recipient-v1");
    assert.equal(offer.nominalCapUsd, "5.00"); assert.equal(offer.balance, "unknown"); assert.deepEqual(offer.sponsorPowers, ["revoke", "change_limits"]);
    assert.equal(offer.claimWindowExpiresAt, "2030-10-10T00:00:00Z"); assert.equal(offer.providerExpiry, "unknown"); assert.equal(offer.requestMaxTokens, 512);
    assert.equal(offer.provider, "near"); assert.equal(offer.outOfDateException, false); assert.equal(offer.operatorSecretAccess, true);
    assert.deepEqual(offer.disclosures, ["Nominal cap $5.00; actual balance unknown.", "The sponsor can revoke this credit or change its limits.",
      "Each request is limited to 512 output tokens.", "Synthetic input only: the issuer operator can access secrets in this debug-staging service."]);
    await pace();
    await assert.rejects(manager.redeem(id, { offerHash: "00".repeat(32) }), { code: "credit_intent_required" });
    assert.ok(!server.frames.some((f) => f.op === "claim"));
    const installed = await manager.redeem(id, { offerHash: offer.offerHash });
    assert.equal(installed.state, "installed");
    const record = JSON.parse(fs.readFileSync(path.join(dir, "credit", `${id}.json`)));
    assert.equal(record.credential, credential);
    assert.equal(fs.statSync(path.join(dir, "credit", `${id}.json`)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, "credit")).mode & 0o777, 0o700);
    noSecrets(JSON.stringify(installed), record);
    await pace();
    const claims = server.frames.filter((f) => f.op === "claim").length;
    assert.equal(claims, 1);
    assert.equal((await manager.redeem(id, { offerHash: offer.offerHash })).state, "installed");
    assert.equal((await manager.redeem(id, { recover: true })).state, "installed");
    assert.equal((await manager.inspect(coupon, server.admission)).state, "installed");
    assert.equal(server.frames.filter((f) => f.op === "claim").length, claims, "no second claim");
    await assert.rejects(manager.inspect(coupon, { ...server.admission, provider: { ...provider, model: "other/model" } }), { code: "credit_admission_changed" });
  } finally { await legacy.host.stop(); await server.host.stop(); }
});

const claims = (server) => server.frames.filter((f) => f.op === "claim");
const savedRecord = (dir) => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`)));
const fast = { pollIntervalMs: 50 };
// First redeem whose claim stays pending past its wait: the record is uncertain with one claim sent.
async function pendingClaim(server, dir) {
  const manager = createCreditManagerForTesting({ directory: dir, connect });
  const offer = await manager.inspect(coupon, server.admission); await pace();
  server.state.claim = "in_progress";
  await assert.rejects(manager.redeem(id, { offerHash: offer.offerHash, waitMs: 300, ...fast }), { code: "claim_pending" });
  assert.equal(savedRecord(dir).state, "uncertain"); assert.equal(claims(server).length, 1);
  await pace();
  return { offer, original: claims(server)[0] };
}

test("pending recovery in a fresh manager polls bound status only, then retrieves the same winner once", { timeout: 30_000 }, async () => {
  const server = await issuer(), dir = path.join(tempDir(), "credit");
  try {
    const { original } = await pendingClaim(server, dir);
    server.state.statuses = ["in_progress", "in_progress", "in_progress"]; server.state.status = "delivered"; server.state.claim = "grant";
    const mark = server.frames.length;
    assert.equal((await createCreditManagerForTesting({ directory: dir, connect }).redeem(id, { recover: true, ...fast })).state, "installed");
    const recovery = server.frames.slice(mark);
    assert.deepEqual(recovery.map((f) => f.op), ["offer", "status", "status", "status", "status", "claim"], "no claim while pending");
    for (const frame of recovery) assert.equal(frame.peer, original.peer, "same Noise identity");
    for (const frame of recovery.slice(1)) assert.equal(frame.recipient_key, original.recipient_key, "same X25519 recipient key");
  } finally { await server.host.stop(); }
});

test("a crash before the first claim frame keeps the durable original keys; only explicit recover retries them once", { timeout: 30_000 }, async () => {
  const server = await issuer(), dir = path.join(tempDir(), "credit");
  try {
    const offer = await createCreditManagerForTesting({ directory: dir, connect }).inspect(coupon, server.admission); await pace();
    // Async spawn: the issuer fixture runs on this process's event loop.
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { createCreditManagerForTesting } from ${JSON.stringify(path.join(root, "lib/credit.mjs"))};
      import { couponAttestedClientForTesting } from ${JSON.stringify(path.join(root, "lib/coupon-attested.mjs"))};
      const quote = async (hex) => JSON.parse(Buffer.from(hex, "hex").toString());
      const connect = async (a, o, t) => { const c = await couponAttestedClientForTesting(a, { ...o, syntheticQuoteVerifier: quote }, t);
        return { ...c, claim: () => process.kill(process.pid, "SIGKILL") }; };
      await createCreditManagerForTesting({ directory: process.argv[1], connect }).redeem(process.argv[2], { offerHash: process.argv[3] });`, dir, id, offer.offerHash],
      { stdio: ["ignore", "ignore", "inherit"] });
    const [, signal] = await once(child, "exit");
    assert.equal(signal, "SIGKILL");
    const crashed = savedRecord(dir);
    assert.equal(crashed.state, "claiming"); assert.equal(claims(server).length, 0);
    await pace();
    const manager = createCreditManagerForTesting({ directory: dir, connect });
    await assert.rejects(manager.redeem(id, { offerHash: offer.offerHash }), { code: "credit_intent_required" });
    server.state.status = "ready";
    assert.equal((await manager.redeem(id, { recover: true, ...fast })).state, "installed");
    assert.equal(claims(server).length, 1);
    assert.equal(claims(server)[0].recipient_key, couponAttestedRecipient(crashed.recipientKey).publicKey);
    assert.equal(claims(server)[0].peer, crashed.localPeer);
  } finally { await server.host.stop(); }
});

test("an unreserved claim during polling is not resent; explicit recover retries the same keys", { timeout: 30_000 }, async () => {
  const server = await issuer(), dir = path.join(tempDir(), "credit");
  try {
    const manager = createCreditManagerForTesting({ directory: dir, connect });
    const offer = await manager.inspect(coupon, server.admission); await pace();
    server.state.claim = "in_progress"; server.state.status = "ready";
    await assert.rejects(manager.redeem(id, { offerHash: offer.offerHash, ...fast }), { code: "claim_not_reserved" });
    assert.equal(claims(server).length, 1); assert.equal(savedRecord(dir).state, "uncertain");
    await pace(); server.state.claim = "grant";
    assert.equal((await manager.redeem(id, { recover: true, ...fast })).state, "installed");
    assert.equal(claims(server).length, 2);
    assert.equal(claims(server)[0].recipient_key, claims(server)[1].recipient_key); assert.equal(claims(server)[0].peer, claims(server)[1].peer);
  } finally { await server.host.stop(); }
});

for (const [name, change, code, state] of [["expired claim window", { status: "ready", claimExpired: true }, "claim_expired", "expired"],
    ["accounting block", { status: "in_progress", accountingBlocked: true }, "reconciliation_required", "reconciliation_required"],
    ["issuer reconciliation", { status: "reconciliation_required" }, "reconciliation_required", "reconciliation_required"]]) {
  test(`${name} is terminal: nothing is resent and the saved state is never reset`, { timeout: 30_000 }, async () => {
    const server = await issuer(), dir = path.join(tempDir(), "credit");
    try {
      const { offer } = await pendingClaim(server, dir);
      Object.assign(server.state, change);
      const manager = createCreditManagerForTesting({ directory: dir, connect });
      await assert.rejects(manager.redeem(id, { recover: true, ...fast }), { code });
      assert.equal(savedRecord(dir).state, state); assert.equal(claims(server).length, 1);
      const frames = server.frames.length;
      await assert.rejects(manager.redeem(id, { recover: true, ...fast }), { code });
      await assert.rejects(manager.redeem(id, { offerHash: offer.offerHash }), { code });
      assert.equal(server.frames.length, frames, "no further issuer request");
      assert.equal((await manager.status(id)).state, state);
    } finally { await server.host.stop(); }
  });
}

test("record creation is atomic and exclusive: a crash leaves no partial record and an existing credit is never overwritten", { timeout: 30_000 }, async () => {
  const server = await issuer(), dir = path.join(tempDir(), "credit"), store = creditStore(dir);
  try {
    // A creator killed between temp write and rename leaves only a temp file holding keys.
    const stale = path.join(dir, `${id}.json.${"ab".repeat(16)}.tmp`);
    fs.writeFileSync(stale, "{}", { mode: 0o600 });
    const manager = createCreditManagerForTesting({ directory: dir, connect });
    assert.equal((await manager.inspect(coupon, server.admission)).state, "offered");
    assert.equal(fs.existsSync(stale), false, "the next lock holder removes it");
    const file = path.join(dir, `${id}.json`), before = fs.readFileSync(file, "utf8");
    assert.equal(fs.statSync(file).nlink, 1);
    const unlock = store.lock(id);
    try { assert.throws(() => store.write({ ...JSON.parse(before), state: "uncertain" }, { create: true }), { code: "credit_store_refused" }); }
    finally { unlock(); }
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.deepEqual(fs.readdirSync(dir).sort(), [`${id}.json`, `${id}.json.lock`]);
  } finally { await server.host.stop(); }
});

test("pre-consent summary discloses the selected OutOfDate exception without trial boilerplate", { timeout: 30_000 }, async () => {
  const server = await issuer(), dir = path.join(tempDir(), "credit");
  try {
    const admission = { ...server.admission, provider: { ...provider, policy: { ...provider.policy, gatewayTcb: OUT_OF_DATE_TRIAL_POLICY, modelTcb: OUT_OF_DATE_TRIAL_POLICY } } };
    const offer = await createCreditManagerForTesting({ directory: dir, connect }).inspect(coupon, admission);
    assert.equal(offer.outOfDateException, true); assert.equal(offer.providerTcbPolicy, OUT_OF_DATE_TRIAL_POLICY);
    assert.equal(offer.disclosures.at(-1), OUT_OF_DATE_TRIAL_NOTICE);
    assert.ok(!JSON.stringify(offer).includes("$5 "));
  } finally { await server.host.stop(); }
});

test("a separate process reads the durable summary and hands the saved credential to a fresh provider session without conversation files", { timeout: 30_000 }, async () => {
  const server = await issuer(), dir = path.join(tempDir(), "credit");
  try {
    const manager = createCreditManagerForTesting({ directory: dir, connect });
    const offer = await manager.inspect(coupon, server.admission); await pace();
    await manager.redeem(id, { offerHash: offer.offerHash });
    await server.host.stop();
    const before = fs.readdirSync(dir).sort(), sock = path.join(tempDir(), "broker.sock");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import crypto from "node:crypto";
      import { createCreditManagerForTesting } from ${JSON.stringify(path.join(root, "lib/credit.mjs"))};
      import { couponSocketFetch } from ${JSON.stringify(path.join(root, "lib/coupon-socket.mjs"))};
      const seen = [];
      const m = createCreditManagerForTesting({ directory: process.argv[1], adapterFactory: (o) => { seen.push(crypto.createHash("sha256").update(o.credential).digest("hex"));
        return { admit: async () => {}, fetch: async () => new Response("synthetic answer"), close: async () => {} }; } });
      const status = await m.status();
      const s = await m.session(process.argv[2]);
      await s.broker(process.argv[3], { timeoutMs: 3000 });
      const r = await couponSocketFetch(process.argv[3])("ignored", { body: JSON.stringify({ model: "selected/model", messages: [{ role: "user", content: "synthetic" }], max_tokens: 64 }) });
      const text = await r.text(); await s.close();
      console.log(JSON.stringify({ status, info: s.info(), seen, text }));`, dir, id, sock], { encoding: "utf8", timeout: 20_000 });
    assert.equal(child.status, 0, child.stderr);
    const out = JSON.parse(child.stdout);
    assert.equal(out.status.length, 1); assert.equal(out.status[0].state, "installed"); assert.equal(out.info.state, "closed");
    assert.deepEqual(out.seen, [sha(credential)]);
    assert.ok(out.text.includes("synthetic answer"));
    noSecrets(child.stdout + child.stderr, JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`))));
    assert.deepEqual(fs.readdirSync(dir).sort(), before, "provider use adds no conversation or other files");
    // The real manager never opens a testing record.
    await assert.rejects(createCreditManager({ directory: dir }).status(id), { code: "credit_record_refused" });
  } finally { await server.host.stop(); }
});

test("saved records bind offer hash, issuer, provider scope, budget, Noise peer, recipient key and envelope", { timeout: 30_000 }, async () => {
  const server = await issuer(), dir = path.join(tempDir(), "credit"), file = path.join(dir, `${id}.json`);
  try {
    const manager = createCreditManagerForTesting({ directory: dir, connect });
    const offer = await manager.inspect(coupon, server.admission); await pace();
    await manager.redeem(id, { offerHash: offer.offerHash });
    const good = fs.readFileSync(file, "utf8"), base = JSON.parse(good);
    const other = syntheticIssuerIdentity(), otherSigner = syntheticStagingSigner();
    const mutations = {
      offerBudget: (r) => { r.offer.budget_nano_usd = "4000000000"; },
      offerHash: (r) => { r.offerHash = "ee".repeat(32); },
      rehashedBudget: (r) => { r.offer.budget_nano_usd = "6000000000"; r.offerHash = bundle(r.offer).offer_hash; },
      rehashedScope: (r) => { r.offer.provider.scope_commitment = "cd".repeat(32); r.offerHash = bundle(r.offer).offer_hash; },
      legacyProfile: (r) => { r.offer.delivery_profile = "x25519-aesgcm-session-only"; r.offerHash = bundle(r.offer).offer_hash; },
      issuerInfo: (r) => { r.issuerInfo = other.info; },
      approvalRoot: (r) => { r.admission.approvalRoot = otherSigner.rootHex; },
      providerProfile: (r) => { r.admission.provider.maxTokens = 1024; },
      noiseSeed: (r) => { r.noiseSeed = "11".repeat(32); },
      recipientKey: (r) => { r.recipientKey = crypto.generateKeyPairSync("x25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"); },
      credential: (r) => { r.credential = "replaced-credential-0123456789"; },
      envelope: (r) => { const e = JSON.parse(r.envelope); e.nonce = crypto.randomBytes(12).toString("base64"); r.envelope = JSON.stringify(e); },
      keyId: (r) => { r.keyId = "other-key"; },
      extraField: (r) => { r.conversation = []; },
      testingFlag: (r) => { r.testing = false; },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      const r = structuredClone(base); mutate(r); fs.writeFileSync(file, JSON.stringify(r));
      await assert.rejects(manager.status(id), (e) => ["credit_record_refused", "credit_profile_refused"].includes(e.code), name);
      await assert.rejects(manager.session(id), (e) => ["credit_record_refused", "credit_profile_refused"].includes(e.code), name);
    }
    fs.writeFileSync(file, good);
    assert.equal((await manager.status(id)).state, "installed");
  } finally { await server.host.stop(); }
});

test("private files refuse FIFOs, symlinks, hard links, loose modes and unsafe directories without chmod", () => {
  const dir = tempDir(), good = path.join(dir, "good");
  fs.writeFileSync(good, "x", { mode: 0o600 });
  assert.equal(readPrivate(good).toString(), "x");
  const fifo = path.join(dir, "fifo");
  assert.equal(spawnSync("mkfifo", ["-m", "600", fifo]).status, 0);
  const started = Date.now();
  assert.throws(() => readPrivate(fifo), { code: "credit_store_refused" });
  assert.ok(Date.now() - started < 2000, "FIFO open does not block");
  fs.symlinkSync(good, path.join(dir, "link"));
  assert.throws(() => readPrivate(path.join(dir, "link")), { code: "credit_store_refused" });
  fs.linkSync(good, path.join(dir, "hard"));
  assert.throws(() => readPrivate(good), { code: "credit_store_refused" });
  fs.unlinkSync(path.join(dir, "hard"));
  fs.chmodSync(good, 0o644);
  assert.throws(() => readPrivate(good), { code: "credit_store_refused" });
  fs.chmodSync(good, 0o600); fs.writeFileSync(good, "y".repeat(3000));
  assert.throws(() => readPrivate(good, 2048), { code: "credit_store_refused" });
  assert.throws(() => readPrivate(path.join(dir, "missing")), { code: "credit_store_refused" });
  // A symlinked parent is refused, as is an existing loose directory, which keeps its mode.
  fs.mkdirSync(path.join(dir, "real"), { mode: 0o700 });
  fs.symlinkSync(path.join(dir, "real"), path.join(dir, "alias"));
  assert.throws(() => privateDirectory(path.join(dir, "alias", "credit")), { code: "credit_store_refused" });
  assert.equal(fs.existsSync(path.join(dir, "real", "credit")), false);
  fs.mkdirSync(path.join(dir, "loose"), { mode: 0o755 }); fs.chmodSync(path.join(dir, "loose"), 0o755);
  assert.throws(() => creditStore(path.join(dir, "loose")), { code: "credit_store_refused" });
  assert.equal(fs.statSync(path.join(dir, "loose")).mode & 0o777, 0o755);
  assert.throws(() => privateDirectory("relative/credit"), { code: "credit_store_refused" });
  privateDirectory(path.join(dir, "new", "nested"));
  assert.equal(fs.statSync(path.join(dir, "new")).mode & 0o777, 0o700);
  // Record files: a symlinked or loose record is refused, never rewritten.
  const store = creditStore(path.join(dir, "store")), target = path.join(dir, "store", `${id}.json`);
  fs.symlinkSync(good, target);
  assert.throws(() => store.read(id), { code: "credit_store_refused" });
  assert.throws(() => store.write({ version: 1, id, state: "offered" }), { code: "credit_store_refused" });
  assert.throws(() => store.write({ version: 1, id, state: "offered" }, { create: true }), { code: "credit_store_refused" });
  assert.equal(fs.readFileSync(good, "utf8"), "y".repeat(3000));
});

test("kernel locks exclude a live writer across processes, release on crash and are never unlinked or stolen", { timeout: 20_000 }, async () => {
  const dir = path.join(tempDir(), "credit"), store = creditStore(dir), lockFile = path.join(dir, `${id}.json.lock`);
  const unlock = store.lock(id);
  assert.throws(() => store.lock(id), { code: "credit_locked" });
  unlock(); unlock();
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { creditStore } from ${JSON.stringify(path.join(root, "lib/credit-store.mjs"))};
    creditStore(process.argv[1]).lock(process.argv[2]); console.log("locked"); setInterval(() => {}, 1000);`, dir, id], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await once(child.stdout, "data");
    const inode = fs.statSync(lockFile).ino;
    // Two contenders while the holder lives: both refused, and neither removes the live lock.
    for (let i = 0; i < 2; i++) assert.throws(() => creditStore(dir).lock(id), { code: "credit_locked" });
    assert.equal(fs.statSync(lockFile).ino, inode);
    await assert.rejects(createCreditManagerForTesting({ directory: dir, connect }).inspect(coupon, (await issuerAdmissionOnly())), { code: "credit_locked" });
    child.kill("SIGKILL"); await once(child, "exit");
    const again = store.lock(id);
    assert.equal(fs.statSync(lockFile).ino, inode, "lock file reused, not replaced");
    again();
  } finally { child.kill("SIGKILL"); }
});
// Admission shape only; the lock refusal happens before any connection.
const issuerAdmissionOnly = async () => ({ peer: `/ip4/127.0.0.1/tcp/9/p2p/${peerIdFromPrivateKey(await generateKeyPair("Ed25519"))}`, pin: pin(),
  approval: approval.bytes.toString("base64"), approvalRoot: signer.rootHex, provider });

test("each v4 delivery profile is accepted only by the caller that asked for it", () => {
  const peerId = "FixtureIssuer0001", options = { coupon, peerId, issuerInfo: identity.info };
  const durable = bundle(terms(peerId)), legacy = bundle(terms(peerId, "x25519-aesgcm-session-only"));
  validateAttestedCouponOffer(legacy, options);
  validateAttestedCouponOffer(durable, { ...options, deliveryProfile: "x25519-aesgcm-recipient-v1" });
  assert.throws(() => validateAttestedCouponOffer(durable, options), /verification failed/);
  assert.throws(() => validateAttestedCouponOffer(legacy, { ...options, deliveryProfile: "x25519-aesgcm-recipient-v1" }), /verification failed/);
  assert.throws(() => validateAttestedCouponOffer(bundle(terms(peerId, "x25519-aesgcm-recipient-v2")), { ...options, deliveryProfile: "x25519-aesgcm-recipient-v2" }), /verification failed/);
});

test("gift input accepts the code or exact fragment link only", () => {
  assert.equal(couponInput(`${coupon}\n`), coupon);
  for (const link of [`https://amiller.github.io/abalone/redeem#code=${coupon}`, `https://amiller.github.io/abalone/redeem/#code=${coupon}`]) assert.equal(couponInput(link), coupon);
  for (const bad of [`https://amiller.github.io/abalone/redeem?code=${coupon}`, `https://amiller.github.io/abalone/redeem/?x=1#code=${coupon}`,
    `https://amiller.github.io/abalone/redeem/?#code=${coupon}`, `https://example.com/abalone/redeem/#code=${coupon}`, `http://amiller.github.io/abalone/redeem/#code=${coupon}`,
    `https://amiller.github.io/abalone/redeem/#code=${coupon}&x=1`, `https://u:p@amiller.github.io/abalone/redeem/#code=${coupon}`, coupon.slice(1), `${coupon}x`, ""])
    assert.throws(() => couponInput(bad), { code: "coupon_input_refused" });
});

test("credit CLI refuses incompatible or secret argv options and prints static, path-free errors", () => {
  const home = tempDir(), cli = (...argv) => spawnSync(process.execPath, [path.join(root, "bin/abalone.mjs"), "credit", ...argv],
    { encoding: "utf8", timeout: 20_000, env: { ...process.env, ABALONE_DIR: path.join(home, "state") }, input: "" });
  const secret = "s".repeat(43);
  for (const argv of [["inspect", "--code", secret], ["redeem", "--trial", "/x/trial.json", "--stdin", secret], ["status", "--accept-offer", "00".repeat(32)],
      ["session", "--credit", id, "--stdin"], ["recover", "--credit", id, "--trial", "/x/trial.json"], ["inspect", "--trial", "relative.json", "--stdin"],
      ["inspect", "--trial", "/x/t.json", "--stdin", "--input-file", "/x/i"], ["redeem", "--trial", "/x/t.json", "--stdin"], ["status", "--credit", secret], ["claim"],
      ["session", "--credit", id, "--mode", "tui"]]) {
    const r = cli(...argv);
    assert.equal(r.status, 1, argv.join(" "));
    assert.ok(r.stderr.includes("Usage: abalone credit"), argv.join(" "));
    assert.ok(!r.stderr.includes(secret) && !r.stdout.includes(secret));
  }
  const missing = cli("status", "--credit", id);
  assert.equal(missing.status, 1);
  assert.ok(!missing.stderr.includes(home) && !missing.stderr.includes(id) && !/ENOENT|at .*\.mjs/.test(missing.stderr));
  const empty = cli("status");
  assert.equal(empty.status, 0, empty.stderr); assert.deepEqual(JSON.parse(empty.stdout), []);
  // At a real terminal --stdin would echo the code: refused before any trial, gift or issuer is read.
  const tty = spawnSync("script", ["-qec", `${process.execPath} ${path.join(root, "bin/abalone.mjs")} credit inspect --trial /x/t.json --stdin`, "/dev/null"],
    { encoding: "utf8", timeout: 20_000, env: { ...process.env, ABALONE_DIR: path.join(home, "state") }, input: "" });
  assert.equal(tty.status, 1, tty.stdout + tty.stderr); assert.ok(tty.stdout.includes("--stdin reads a pipe only"));
  const trial = cli("inspect", "--trial", path.join(home, "missing-trial.json"), "--stdin");
  assert.equal(trial.status, 1); assert.ok(!trial.stderr.includes(home) && !trial.stderr.includes("ENOENT"));
});
