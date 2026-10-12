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
import { couponAttestedRecipient, couponAttestedRecipientPeerHash, couponDeliveryAad, validateAttestedCouponOffer } from "../lib/coupon-attested.mjs";
import { createCreditManager, createCreditManagerForTesting, creditOfferBound, creditSummary } from "../lib/credit.mjs";
import { canonicalCouponJson } from "../lib/coupon-offer.mjs";
import { verifyCouponStagingAdmission, COUPON_STAGING_APPROVAL_DOMAIN, MAC_COUPON_APPROVAL_DOMAIN } from "../lib/coupon-staging.mjs";
import { MAC_ISSUER_PROFILE, MAC_ISSUER_DOMAIN, macIssuerPolicyHash, macIssuerData, macIssuerPossessionMessage, createMacCouponIssuerVerifierForTesting } from "../lib/mac-coupon-issuer.mjs";
import { openAttestedCouponSession, attestedCouponSessionOfferText } from "../lib/coupon-attested-session.mjs";
import { OUT_OF_DATE_TRIAL_POLICY, OUT_OF_DATE_TRIAL_NOTICE } from "../lib/coupon-near.mjs";
import { couponSocketFetch } from "../lib/coupon-socket.mjs";
import { creditStore, creditPreflight, couponInput, privateDirectory, readPrivate } from "../lib/credit-store.mjs";
import { syntheticIssuerIdentity } from "./fixtures/coupon/issuer-v2.mjs";
import { syntheticStagingSigner } from "./fixtures/coupon/staging-signer.mjs";
import { coupon, id, sha, credential, identity, signer, approval, legacyApproval, pin, provider, connect, pace, bundle, terms, issuer } from "./lib/credit-fixture.mjs";

const root = path.resolve(import.meta.dirname, "..");
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
    assert.equal(offer.claimWindowExpiresAt, "2030-10-10T00:00:00Z"); assert.equal(offer.providerExpiry, "unknown"); assert.equal(offer.requestMaxTokens, 4096);
    assert.equal(offer.provider, "near"); assert.equal(offer.outOfDateException, false); assert.equal(offer.operatorSecretAccess, true); assert.equal(offer.sponsorCanRevoke, true);
    assert.match(offer.claimWindow, /^Claim by 2030-10-10 00:00 UTC \(in \d+ days\); after that this gift cannot be redeemed\.$/);
    assert.deepEqual(offer.disclosures, [offer.claimWindow, "Nominal cap $5.00 from the offer; provider enforcement is not verified.", "Usage: not reported.",
      "Sponsor can revoke the credential or change its limits at any time.", "Each request is separately bounded to 4096 output tokens.",
      "Synthetic content only: the staging operator can access the credential."]);
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
    assert.deepEqual(server.frames.slice(-3).map((f) => f.op), ["offer", "status", "claim"], "issuer status is read before the first claim");
    assert.equal(installed.claimWindow, undefined);
    assert.equal((await manager.redeem(id, { offerHash: offer.offerHash })).state, "installed");
    assert.equal((await manager.redeem(id, { recover: true })).state, "installed");
    assert.equal((await manager.inspect(coupon, server.admission)).state, "installed");
    assert.equal(server.frames.filter((f) => f.op === "claim").length, claims, "no second claim");
    await assert.rejects(manager.inspect(coupon, { ...server.admission, provider: { ...provider, model: "other/model" } }), { code: "credit_admission_changed" });
    await assert.rejects(manager.inspect(coupon, { ...server.admission, provider: { ...provider, maxTokens: 512 } }),
      { code: "credit_admission_changed", message: /use the trial\.json you installed with, or run `abalone credit status`\. The saved credit keeps its original limits\./ });
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
    assert.deepEqual(fs.readdirSync(dir), [], "inspect saves nothing");
    // Async spawn: the issuer fixture runs on this process's event loop. The child inspects and redeems, like the CLI.
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { createCreditManagerForTesting } from ${JSON.stringify(path.join(root, "lib/credit.mjs"))};
      import { couponAttestedClientForTesting } from ${JSON.stringify(path.join(root, "lib/coupon-attested.mjs"))};
      const quote = async (hex) => JSON.parse(Buffer.from(hex, "hex").toString());
      const connect = async (a, o, t) => { const c = await couponAttestedClientForTesting(a, { ...o, syntheticQuoteVerifier: quote }, t);
        return { ...c, claim: () => process.kill(process.pid, "SIGKILL") }; };
      const m = createCreditManagerForTesting({ directory: process.argv[1], connect });
      await m.inspect(process.argv[4], JSON.parse(process.argv[5]));
      await m.redeem(process.argv[2], { offerHash: process.argv[3] });`, dir, id, offer.offerHash, coupon, JSON.stringify(server.admission)],
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

test("an offer past its claim window inspects as expired and redeem refuses it without contacting the issuer", { timeout: 30_000 }, async () => {
  const server = await issuer(), dir = path.join(tempDir(), "credit");
  try {
    server.state.offer = bundle({ ...terms(server.host.peerId.toString()), claim_expires_at: "2026-01-01T00:00:00Z" });
    const manager = createCreditManagerForTesting({ directory: dir, connect });
    const offer = await manager.inspect(coupon, server.admission); await pace();
    assert.equal(offer.state, "expired");
    assert.equal(offer.claimWindow, "Claim window closed; the deadline was 2026-01-01 00:00 UTC. This gift can no longer be redeemed: ask the sponsor for a new gift.");
    assert.equal(offer.disclosures[0], offer.claimWindow);
    const frames = server.frames.length;
    await assert.rejects(manager.redeem(id, { offerHash: offer.offerHash }), { code: "claim_expired",
      message: "This gift's claim window closed at 2026-01-01 00:00 UTC. Nothing was claimed; ask the sponsor for a new gift. If your computer's clock is wrong, correct it and retry." });
    assert.equal(server.frames.length, frames, "no issuer request, no claim");
    assert.deepEqual(fs.readdirSync(dir), [], "nothing is saved for a gift whose window closed before redemption started");
  } finally { await server.host.stop(); }
});

for (const [name, change, code, state, message] of [
    ["the issuer reports the claim window closed", { claimExpired: true }, "claim_expired", "expired", /ask the sponsor for a new gift/],
    ["the issuer requires reconciliation", { statuses: ["reconciliation_required"] }, "reconciliation_required", "reconciliation_required", /Ask the issuer's operator/],
    ["another recipient already won the gift", { lost: true }, "credit_not_claimed", "offered", /^Nothing was claimed: .*Someone else may already have claimed it.*ask the sponsor whether the gift was already used\.$/]]) {
  test(`redeem reads issuer status before the first claim and never claims when ${name}`, { timeout: 30_000 }, async () => {
    const server = await issuer(), dir = path.join(tempDir(), "credit");
    try {
      const manager = createCreditManagerForTesting({ directory: dir, connect });
      const offer = await manager.inspect(coupon, server.admission); await pace();
      Object.assign(server.state, change);
      await assert.rejects(manager.redeem(id, { offerHash: offer.offerHash, ...fast }), { code, message });
      assert.equal(claims(server).length, 0); assert.equal(savedRecord(dir).state, state);
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
    const offer = await manager.inspect(coupon, server.admission); await pace();
    assert.equal(offer.state, "offered"); assert.ok(fs.existsSync(stale), "inspect takes no lock and writes nothing");
    assert.equal((await manager.redeem(id, { offerHash: offer.offerHash })).state, "installed");
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

test("each provider response adds its reported usage to the saved 0600 record; a response without usage is not reported, never zero", { timeout: 30_000 }, async () => {
  const server = await issuer(), dir = path.join(tempDir(), "credit"), file = path.join(dir, `${id}.json`);
  try {
    const sse = (usage) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "synthetic answer" }, finish_reason: "stop" }] })}\n\n${usage ? `data: ${JSON.stringify({ choices: [], usage })}\n\n` : ""}data: [DONE]\n\n`;
    const replies = [sse(null), sse({ prompt_tokens: 30, completion_tokens: 101, total_tokens: 131, completion_tokens_details: { reasoning_tokens: 87 } }), sse({ prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 })];
    const manager = createCreditManagerForTesting({ directory: dir, connect, adapterFactory: () => ({ admit: async () => {}, close: async () => {},
      fetch: async () => new Response(replies.shift(), { headers: { "content-type": "text/event-stream" } }) }) });
    const offer = await manager.inspect(coupon, server.admission); await pace();
    await manager.redeem(id, { offerHash: offer.offerHash });
    const session = await manager.session(id), sock = path.join(tempDir(), "broker.sock");
    await session.broker(sock, { timeoutMs: 3000 });
    const ask = async () => (await couponSocketFetch(sock)("ignored", { body: JSON.stringify({ model: "selected/model", messages: [{ role: "user", content: "synthetic" }] }) })).text();
    await ask();
    assert.equal((await manager.status(id)).usage, "not reported");
    assert.ok(session.info().disclosures.includes("Usage: not reported."));
    await ask(); await ask(); await session.close();
    const expected = { responses: 3, reported: 2, inputTokens: 35, outputTokens: 108, reasoningTokens: 87 };
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).usage, expected);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const status = await manager.status(id);
    assert.deepEqual(status.usage, expected); assert.equal(status.balance, "unknown");
    assert.ok(status.disclosures.includes("Usage recorded on this computer: 108 output tokens (87 reported as reasoning) and 35 input tokens over 2 response(s); 1 response(s) reported no usage. Not priced; balance unknown."));
    for (const usage of [{ ...expected, reported: 4 }, { ...expected, outputTokens: -1 }, { ...expected, extra: 1 }]) {
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), usage }));
      await assert.rejects(manager.status(id), { code: "credit_record_refused" });
    }
  } finally { await server.host.stop(); }
});

test("a usage write that fails after the answer is delivered is a warning; the session state stays installed", { timeout: 30_000 }, async () => {
  const server = await issuer(), dir = path.join(tempDir(), "credit"), file = path.join(dir, `${id}.json`);
  let session;
  try {
    const reply = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "synthetic answer" }, finish_reason: "stop" }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: "x" } })}\n\ndata: [DONE]\n\n`;
    const manager = createCreditManagerForTesting({ directory: dir, connect, adapterFactory: () => ({ admit: async () => {}, close: async () => {},
      fetch: async () => new Response(reply, { headers: { "content-type": "text/event-stream" } }) }) });
    const offer = await manager.inspect(coupon, server.admission); await pace();
    await manager.redeem(id, { offerHash: offer.offerHash });
    session = await manager.session(id); const sock = path.join(tempDir(), "broker.sock"), states = [];
    await session.broker(sock, { timeoutMs: 3000, onState: (s) => states.push(s) });
    const res = await couponSocketFetch(sock)("ignored", { body: JSON.stringify({ model: "selected/model", messages: [{ role: "user", content: "synthetic" }] }) });
    assert.equal(res.status, 200); assert.equal(await res.text(), reply);
    assert.deepEqual(states, ["installed", "usage_not_recorded"]); assert.equal(session.info().state, "installed");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).usage, undefined);
  } finally { await session?.close(); await server.host.stop(); }
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
      providerProfile: (r) => { r.admission.provider.maxTokens = 4097; },
      noiseSeed: (r) => { r.noiseSeed = "11".repeat(32); },
      recipientKey: (r) => { r.recipientKey = crypto.generateKeyPairSync("x25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"); },
      credential: (r) => { r.credential = "replaced-credential-0123456789"; },
      envelope: (r) => { const e = JSON.parse(r.envelope); e.nonce = crypto.randomBytes(12).toString("base64"); r.envelope = JSON.stringify(e); },
      keyId: (r) => { r.keyId = "other-key"; },
      extraField: (r) => { r.conversation = []; },
      testingFlag: (r) => { r.testing = false; },
      provider: (r) => { r.provider = "other-provider"; },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      const r = structuredClone(base); mutate(r); fs.writeFileSync(file, JSON.stringify(r));
      await assert.rejects(manager.status(id), (e) => ["credit_record_refused", "credit_profile_refused", "credit_provider_unsupported"].includes(e.code), name);
      await assert.rejects(manager.session(id), (e) => ["credit_record_refused", "credit_profile_refused", "credit_provider_unsupported"].includes(e.code), name);
    }
    fs.writeFileSync(file, good);
    assert.equal((await manager.status(id)).state, "installed");
  } finally { await server.host.stop(); }
});

test("inspect writes nothing: no record, lock or temp file exists until redemption starts; a wrong hash writes nothing either", { timeout: 30_000 }, async () => {
  const server = await issuer(), dir = path.join(tempDir(), "credit");
  try {
    const manager = createCreditManagerForTesting({ directory: dir, connect });
    const offer = await manager.inspect(coupon, server.admission); await pace();
    assert.equal(offer.state, "offered"); assert.deepEqual(fs.readdirSync(dir), []);
    await assert.rejects(createCreditManagerForTesting({ directory: dir, connect }).status(id), { code: "credit_store_refused" });
    await assert.rejects(manager.redeem(id, { offerHash: "00".repeat(32) }), { code: "credit_intent_required" });
    assert.deepEqual(fs.readdirSync(dir), [], "a wrong offer hash writes nothing");
    await assert.rejects(manager.redeem(id, { recover: true }), { code: "credit_unavailable" });
    assert.deepEqual(fs.readdirSync(dir), [], "recover of an unknown id creates no lock file");
    await assert.rejects(manager.session(id), { code: "credit_unavailable" });
    assert.deepEqual(fs.readdirSync(dir), [], "a session for an unknown id creates no lock file");
    assert.ok(!server.frames.some((f) => f.op === "claim"));
    assert.equal((await manager.redeem(id, { offerHash: offer.offerHash })).state, "installed");
    assert.equal(savedRecord(dir).localPeer, claims(server)[0].peer, "the record holds the keys that claimed");
  } finally { await server.host.stop(); }
});

test("credit forget removes the record and its lock file, is refused while a session holds the lock, and says the credential is not revoked", { timeout: 30_000 }, async () => {
  const server = await issuer(), dir = path.join(tempDir(), "credit");
  try {
    const manager = createCreditManagerForTesting({ directory: dir, connect, adapterFactory: () => ({ admit: async () => {}, fetch: async () => new Response(""), close: async () => {} }) });
    const offer = await manager.inspect(coupon, server.admission); await pace();
    await manager.redeem(id, { offerHash: offer.offerHash });
    assert.deepEqual(fs.readdirSync(dir).sort(), [`${id}.json`, `${id}.json.lock`]);
    const session = await manager.session(id);
    await assert.rejects(manager.session(id), { code: "credit_locked" });
    assert.throws(() => manager.forget(id), { code: "credit_locked" });
    assert.deepEqual(fs.readdirSync(dir).sort(), [`${id}.json`, `${id}.json.lock`], "nothing removed while the session runs");
    await session.close();
    const installed = savedRecord(dir), rewrite = (state) => { const store = creditStore(dir), unlock = store.lock(id); try { store.write({ ...installed, state }); } finally { unlock(); } };
    for (const state of ["uncertain", "claiming"]) {
      rewrite(state);
      assert.throws(() => manager.forget(id), { code: "credit_claim_in_progress", message: /Run abalone credit recover --credit <id> first: these keys are the only way to recover the claim/ }, state);
      assert.deepEqual(fs.readdirSync(dir).sort(), [`${id}.json`, `${id}.json.lock`], `${state}: nothing removed`);
    }
    rewrite("installed"); manager.forget(id);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.throws(() => manager.forget(id), { code: "credit_unavailable" });
    assert.deepEqual(fs.readdirSync(dir), [], "forgetting an unknown id creates no lock file");
  } finally { await server.host.stop(); }
  // The CLI path over a minimal uncertain record: refused without --force, removed with it.
  const home = tempDir(), store = creditStore(path.join(home, "state", "credit")), file = path.join(home, "state", "credit", `${id}.json`);
  const unlock = store.lock(id); fs.writeFileSync(file, JSON.stringify({ version: 1, id, state: "uncertain" }), { mode: 0o600 }); unlock();
  const forget = (...extra) => spawnSync(process.execPath, [path.join(root, "bin/abalone.mjs"), "credit", "forget", "--credit", id, ...extra], { encoding: "utf8", timeout: 20_000, env: { ...process.env, ABALONE_DIR: path.join(home, "state") } });
  const refused = forget();
  assert.equal(refused.status, 1); assert.ok(refused.stderr.includes("Run abalone credit recover --credit <id> first: these keys are the only way to recover the claim."), refused.stderr);
  assert.ok(fs.existsSync(file));
  const r = forget("--force");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`Forgot credit ${id}: its saved record and lock file were removed.`) && r.stdout.includes("The provider credential was NOT revoked."), r.stdout);
  assert.deepEqual(fs.readdirSync(path.join(home, "state", "credit")), []);
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

test("kernel locks exclude a live writer across processes, release on crash and are never stolen", { timeout: 20_000 }, async () => {
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
    store.write({ version: 1, id, state: "installed" }, { create: true });
    await assert.rejects(createCreditManagerForTesting({ directory: dir, connect }).session(id), { code: "credit_locked" });
    child.kill("SIGKILL"); await once(child, "exit");
    const again = store.lock(id);
    assert.equal(fs.statSync(lockFile).ino, inode, "lock file reused, not replaced");
    again();
    // Without flock(1) the refusal is explicit and happens before any issuer contact.
    const saved = process.env.PATH; process.env.PATH = path.join(dir, "no-such-bin");
    try { assert.throws(() => store.lock(id), { code: "credit_flock_unavailable" }); assert.throws(() => creditPreflight(), { code: "credit_flock_unavailable" }); }
    finally { process.env.PATH = saved; }
  } finally { child.kill("SIGKILL"); }
});
// Admission shape only; the lock refusal happens before any connection.
const issuerAdmissionOnly = async () => ({ peer: `/ip4/127.0.0.1/tcp/9/p2p/${peerIdFromPrivateKey(await generateKeyPair("Ed25519"))}`, pin: pin(),
  approval: approval.bytes.toString("base64"), approvalRoot: signer.rootHex, provider });

test("durable and legacy signed approvals never cross entry points before any bearer frame", { timeout: 30_000 }, async () => {
  const server = await issuer(), dir = path.join(tempDir(), "credit");
  try {
    // Durable credit refuses a legacy approval before connecting.
    await assert.rejects(createCreditManagerForTesting({ directory: dir, connect }).inspect(coupon, { ...server.admission, approval: legacyApproval.bytes.toString("base64") }), { code: "credit_profile_refused" });
    // A durable client refuses a legacy approval, and the legacy default client refuses a durable approval, at identity admission.
    const pins = { ...pin() };
    for (const [deliveryProfile, signed] of [["x25519-aesgcm-recipient-v1", legacyApproval], [undefined, approval]]) {
      await assert.rejects(connect(server.admission.peer, { ...pins, ...(deliveryProfile ? { deliveryProfile } : {}), stagingApproval: { bytes: signed.bytes, approvalRoot: signer.rootHex } }), { code: "staging_admission_refused" });
      await pace();
    }
    // The existing session-only entry refuses a durable approval before reading any gift.
    await assert.rejects(openAttestedCouponSession({ peerAddr: server.admission.peer, admit: { dev: true }, profile: "debug-staging", model: "selected/model",
      config: { couponSession: { mode: "synthetic-loopback", provider: "synthetic-near", baseUrl: "http://127.0.0.1:9999/v1", models: ["fixture-model"] } }, issuerPin: pin(),
      stagingApproval: { bytes: approval.bytes, approvalRoot: signer.rootHex }, connect, pollRoundMs: 300, pollIntervalMs: 50 }), { code: "staging_admission_refused" });
    assert.equal(server.frames.length, 0, "no /4 bearer frame");
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { await server.host.stop(); }
});

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

test("credit CLI names each argument mistake and what to do next, never echoing a gift code or raw error detail", () => {
  const home = tempDir(), cli = (...argv) => spawnSync(process.execPath, [path.join(root, "bin/abalone.mjs"), "credit", ...argv],
    { encoding: "utf8", timeout: 20_000, env: { ...process.env, ABALONE_DIR: path.join(home, "state") }, input: "" });
  const secret = "s".repeat(43);
  for (const [argv, says] of [[["inspect", "--code", secret], 'Unexpected argument "--code" for credit inspect. Options: --trial, --stdin, --input-file.'],
      [["redeem", "--trial", "/x/trial.json", "--stdin", secret], "Unexpected argument (not shown: it looks like a gift code"],
      [["status", "--accept-offer", "00".repeat(32)], "credit status does not take --accept-offer. Options: --credit."],
      [["session", "--credit", id, "--stdin"], "credit session does not take --stdin."], [["recover", "--credit", id, "--trial", "/x/trial.json"], "credit recover does not take --trial."],
      [["inspect", "--trial", "relative.json", "--stdin"], `--trial path must be absolute: relative.json. Give the full path to trial.json, as printed by the installer, for example --trial "${path.join(root, "relative.json")}".`],
      [["inspect", "--trial", "/x/t.json", "--input-file", "gift.txt"], `--input-file path must be absolute: gift.txt. Give the full path to the private 0600 file holding your gift code or link, for example --input-file "${path.join(root, "gift.txt")}".`],
      [["inspect", "--trial", "/x/t.json", "--input-file", secret], "--input-file needs the full path to the private 0600 file holding your gift code or link, not the gift code itself"],
      [["inspect", "--trial", "/x/t.json", "--stdin", "--input-file", "/x/i"], "Give the gift code exactly one way"], [["inspect", "--stdin"], "credit inspect needs --trial /abs/trial.json"],
      [["redeem", "--trial", "/x/t.json", "--stdin"], "credit redeem needs --accept-offer <offerHash>; run credit inspect first"], [["status", "--credit", secret], "--credit needs a 64-character credit id"],
      [["status", "--credit", id, "--credit", id], "--credit was given twice"], [["status", "--credit"], "--credit needs a value."], [["recover"], "credit recover needs --credit <id>"], [["forget"], "credit forget needs --credit <id>"], [["forget", "--credit", id], "No saved credit has this id"],
      [["claim"], "abalone credit takes one of: inspect, redeem, recover, status, session, forget. Usage: abalone credit"], [["session", "--credit", id, "--mode", "tui"], "--mode accepts only rpc"],
      [["redeem", `--code=${secret}`], "Unexpected argument (not shown: it looks like a gift code"], [["inspect", "--trial", "/x/t.json", "--stdin", `${secret}.`], "Unexpected argument (not shown: it looks like a gift code"],
      [["inspect", "--trial", `gifts/${secret}`, "--stdin"], "--trial needs the full path to trial.json, as printed by the installer, not the gift code itself"],
      [["inspect", "--trial", "/x/t.json", "--input-file", `./${secret}`], "--input-file needs the full path to the private 0600 file holding your gift code or link, not the gift code itself"]]) {
    const r = spawnSync(process.execPath, [path.join(root, "bin/abalone.mjs"), "credit", ...argv], { encoding: "utf8", timeout: 20_000, cwd: root, env: { ...process.env, ABALONE_DIR: path.join(home, "state") }, input: "" });
    assert.equal(r.status, 1, argv.join(" "));
    assert.ok(r.stderr.includes(says), `${argv.join(" ")}: ${r.stderr}`);
    assert.ok(!r.stderr.includes("Usage:") || argv[0] === "claim", argv.join(" "));
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

test("plain abalone without saved credit points to the redeem page; help prints help; an unknown command fails with help and exit 2", () => {
  const home = tempDir(), run = (...argv) => spawnSync(process.execPath, [path.join(root, "bin/abalone.mjs"), ...argv], { encoding: "utf8", timeout: 20_000, env: { ...process.env, ABALONE_DIR: path.join(home, "state") }, input: "" });
  const none = run();
  assert.equal(none.status, 1);
  assert.ok(none.stderr.startsWith("No saved credit yet.\n"), none.stderr);
  for (const text of ["https://amiller.github.io/abalone/redeem/", "sh install.sh --credit", "abalone credit inspect --trial /abs/trial.json --input-file /abs/gift.txt",
      "--accept-offer <offerHash>", "Then run abalone again."]) assert.ok(none.stderr.includes(text), text);
  assert.ok(!/canar|bubblewrap|providers\.json/.test(none.stderr), "never the legacy sandboxed session");
  assert.equal(fs.existsSync(path.join(home, "state", "credit")), false, "listing creates no credit directory");
  for (const flag of ["--help", "-h", "help"]) {
    const r = run(flag);
    assert.equal(r.status, 0); assert.equal(r.stderr, "");
    for (const text of ["abalone credit inspect", "abalone credit redeem", "abalone credit status", "abalone credit recover", "abalone credit session", "abalone sandbox [folder]"]) assert.ok(r.stdout.includes(text), `${flag}: ${text}`);
  }
  for (const argv of [["status"], ["--model", "stub/script"], ["s".repeat(43)], [`--code=${"s".repeat(43)}`], [`${"s".repeat(43)}.`]]) {
    const r = run(...argv);
    assert.equal(r.status, 2, argv.join(" "));
    assert.ok(r.stderr.startsWith(`Unknown command ${argv[0].includes("s".repeat(43)) ? "(not shown" : JSON.stringify(argv[0])}`), r.stderr);
    assert.ok(r.stderr.includes("abalone sandbox [folder]") && r.stderr.includes("abalone credit session --credit <id>"));
    assert.ok(!r.stderr.includes("s".repeat(43)) && !r.stderr.includes("no canaries"), "never the legacy session");
  }
});

// Producer → consumer: matched dsmack bundles (tests/fixtures/coupon/durable/PROVENANCE.json "paired"), each recorded from one
// Python LiveWorker/MacLiveWorker run. Node checks them with the same functions durable credit uses.
const durableDir = new URL("fixtures/coupon/durable/", import.meta.url);
const paired = (name) => JSON.parse(fs.readFileSync(new URL(`paired/${name}.json`, durableDir), "utf8"));
const x25519Recovery = (hex) => Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), Buffer.from(hex, "hex")]).toString("base64");
function producerAdmission(b, approvalBytes = Buffer.from(b.approval.envelope, "utf8")) {
  const info = b.issuer_info.response.result, issuerKey = sha(Buffer.from(info.issuer_public_key_hex, "hex"));
  const approval = verifyCouponStagingAdmission(approvalBytes, { approvalRoot: b.authority.public_key_hex,
    identityPolicySha256: info.identity_policy_sha256, issuancePolicySha256: info.issuance_policy_sha256, issuerPublicKeySha256: issuerKey });
  const compose = JSON.parse(b.config.envelope).payload.app_compose;
  assert.equal(compose, b.config.payload.app_compose);
  const mac = b.domain.startsWith("mac-");
  if (mac) assert.equal(sha(Buffer.from(compose, "utf8")), approval.composeHash); else assert.equal(compose, undefined);
  return { info, approval, a: { approval, peerId: b.config.payload.issuer_peer_id,
    pin: { identityPolicy: mac ? { profile: MAC_ISSUER_PROFILE } : {}, expectedIssuerPublicKeySha256: issuerKey } } };
}

test("matched producer bundles: signed recipient-v1 approval, exact offer and original-key delivery agree on both approval domains", () => {
  const provenance = JSON.parse(fs.readFileSync(new URL("PROVENANCE.json", durableDir), "utf8"));
  for (const [name, file] of Object.entries(provenance.paired.files)) assert.equal(sha(fs.readFileSync(new URL(name, durableDir))), file.sha256, name);
  for (const [name, domain] of [["dstack-v1-recipient-v1", COUPON_STAGING_APPROVAL_DOMAIN], ["mac-v2-recipient-v1", MAC_COUPON_APPROVAL_DOMAIN]]) {
    const b = paired(name), { info, approval, a } = producerAdmission(b);
    assert.equal(b.environment, "SOFTWARE_TEST_ONLY"); assert.equal(approval.domain, domain); assert.equal(b.approval.domain, domain);
    assert.equal(approval.deliveryProfile, "x25519-aesgcm-recipient-v1");
    for (const pinned of [b.approval.sha256, b.ready.approval_sha256, b.config.payload.approval_sha256]) assert.equal(approval.approval_sha256, pinned);
    const { offer, offer_hash: offerHash } = b.offer_frame.response.result;
    assert.deepEqual(offer, b.provision.offer); assert.equal(offerHash, b.provision.offer_hash); assert.equal(b.claim.request.offer_hash, offerHash);
    creditOfferBound("near", offer, offerHash, b.coupon, info, a);
    const recipient = couponAttestedRecipient(x25519Recovery(b.recipient.x25519_private_hex_synthetic));
    assert.equal(recipient.publicKey, b.recipient.x25519_public_b64); assert.equal(b.claim.request.recipient_key, recipient.publicKey);
    assert.equal(couponAttestedRecipientPeerHash(b.recipient.noise_peer_id), b.recipient.peer_sha256);
    assert.deepEqual(b.claim.pending_response.result, { automatic_retry_allowed: false, deposit_release_authorized: false, state: "in_progress" });
    const keyId = b.delivery.recovery_response.result.key_id;
    assert.equal(couponDeliveryAad({ offerHash, coupon: b.coupon, keyId, recipientKey: Buffer.from(recipient.publicKey, "base64"), recipientPeer: b.recipient.noise_peer_id }).toString("utf8"), b.delivery.aad_utf8);
    for (const response of [b.delivery.recovery_response, b.delivery.replay_response]) {
      assert.equal(recipient.decryptSavedDelivery(b.coupon, response.result, offerHash, b.recipient.noise_peer_id), b.delivery.plaintext_synthetic, name);
      assert.throws(() => recipient.decryptSavedDelivery(b.coupon, response.result, offerHash, "OtherClaimantPeer1"), /verification failed/);
      assert.throws(() => recipient.decryptSavedDelivery(b.coupon, response.result, "00".repeat(32), b.recipient.noise_peer_id), /verification failed/);
      assert.throws(() => couponAttestedRecipient().decryptSavedDelivery(b.coupon, response.result, offerHash, b.recipient.noise_peer_id), /verification failed/);
    }
  }
});

test("matched Mac producer bundles: the issuer verifier admits only the raw UTF-8 app_compose behind the signed compose_hash", async () => {
  for (const name of ["mac-v2-recipient-v1", "mac-v2-session-only"]) {
    const b = paired(name), { info, approval } = producerAdmission(b), compose = JSON.parse(b.config.envelope).payload.app_compose;
    const policy = { version: 1, profile: MAC_ISSUER_PROFILE, app_id: "DC9JH5DRMY.dev.dsmack.provider", challenge_ttl_ms: 30000, max_enrollment_age_seconds: 43200,
      approved_measurements: [{ cdhash: approval.cdhash, compose_sha256: approval.composeHash }], custody: "operator-kms-readable" };
    const verifier = createMacCouponIssuerVerifierForTesting({ policy, expectedPolicySha256: macIssuerPolicyHash(policy), expectedIssuancePolicySha256: info.issuance_policy_sha256,
      syntheticRunnerVerifier: async () => ({ cdhash: approval.cdhash, compose_hash: approval.composeHash }) });
    const pair = crypto.generateKeyPairSync("ed25519"), publicKeyHex = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
    const peers = { remotePeer: "MacCouponIssuer00001", recipientPeer: "MacCouponRecipient01" };
    const attempt = (appCompose) => {
      const binding = verifier.challenge({ ...peers, issuerPublicKeyHex: publicKeyHex });
      return verifier.verify({ domain: MAC_ISSUER_DOMAIN, binding, app_compose: appCompose,
        possession_signature_hex: crypto.sign(null, macIssuerPossessionMessage(binding), pair.privateKey).toString("hex"),
        runner_evidence: { type: "macrunner", attestation: "AA==", keyId: "AA==", assertion: "AA==",
          bootClientData: Buffer.from(JSON.stringify({ compose_hash: approval.composeHash })).toString("base64"),
          assertClientData: Buffer.from(macIssuerData(binding)).toString("base64") } }, peers);
    };
    assert.equal((await attempt(compose)).composeSha256, approval.composeHash);
    for (const mutated of [compose + " ", compose + "\n", " " + compose, compose.replace(":", ": ")]) {
      assert.notEqual(sha(Buffer.from(mutated, "utf8")), approval.composeHash);
      await assert.rejects(attempt(mutated), /verification refused/);
    }
    verifier.close();
  }
});

test("matched producer bundles refuse legacy, cross-profile, cross-domain, unknown, signature, pin, scope and budget mismatches", () => {
  for (const d of ["dstack-v1", "mac-v2"]) {
    const durable = paired(`${d}-recipient-v1`), legacy = paired(`${d}-session-only`), D = producerAdmission(durable), L = producerAdmission(legacy);
    const issuerProfile = d === "mac-v2" ? MAC_ISSUER_PROFILE : "dstack-tdx-coupon-v1";
    const durableOffer = durable.offer_frame.response.result, legacyOffer = legacy.offer_frame.response.result;
    assert.equal(L.approval.deliveryProfile, "x25519-aesgcm-session-only"); assert.notEqual(L.approval.approval_sha256, D.approval.approval_sha256);
    // The legacy pair stays valid on the legacy path only.
    validateAttestedCouponOffer(legacyOffer, { coupon: legacy.coupon, peerId: L.a.peerId, issuerInfo: L.info, issuerProfile });
    assert.throws(() => validateAttestedCouponOffer(durableOffer, { coupon: durable.coupon, peerId: D.a.peerId, issuerInfo: D.info, issuerProfile }), /verification failed/);
    // Refusal comes from the binding check or from the exact offer validator; callers map both to static codes.
    const refusal = (e) => e.code === "credit_record_refused" || e.message === "coupon offer verification failed";
    const refusedBound = (offer, coupon, a, label) => assert.throws(() => creditOfferBound("near", offer.offer, offer.offer_hash, coupon, D.info, a), refusal, `${d}: ${label}`);
    refusedBound(legacyOffer, legacy.coupon, L.a, "legacy pair");
    refusedBound(legacyOffer, legacy.coupon, D.a, "durable approval with legacy offer");
    refusedBound(durableOffer, durable.coupon, L.a, "legacy approval with durable offer");
    refusedBound({ offer: { ...durableOffer.offer, delivery_profile: "x25519-aesgcm-session-only" }, offer_hash: durableOffer.offer_hash }, durable.coupon, D.a, "relabel under the produced hash");
    refusedBound({ offer: { ...durableOffer.offer, delivery_profile: "x25519-aesgcm-recipient-v2" }, offer_hash: durableOffer.offer_hash }, durable.coupon, D.a, "unknown profile");
    refusedBound(durableOffer, legacy.coupon, D.a, "replay for another gift");
    refusedBound(durableOffer, durable.coupon, { ...D.a, pin: { ...D.a.pin, identityPolicy: d === "mac-v2" ? {} : { profile: MAC_ISSUER_PROFILE } } }, "other issuer profile");
    refusedBound(durableOffer, durable.coupon, { ...D.a, pin: { ...D.a.pin, expectedIssuerPublicKeySha256: "00".repeat(32) } }, "issuer key pin");
    refusedBound(durableOffer, durable.coupon, { ...D.a, approval: { ...D.approval, payload: { ...D.approval.payload, provider_scope_commitment: "cd".repeat(32) } } }, "provider scope");
    refusedBound(durableOffer, durable.coupon, { ...D.a, approval: { ...D.approval, maxCouponNanoUsd: String(BigInt(durableOffer.offer.budget_nano_usd) - 1n) } }, "budget above approval");
    assert.throws(() => creditOfferBound("other-provider", durableOffer.offer, durableOffer.offer_hash, durable.coupon, D.info, D.a), refusal);
    // Signed approval bytes: domain swap, signature, root, pins and unsigned profile edits refuse.
    const envelope = JSON.parse(durable.approval.envelope);
    const refusedApproval = (raw, options = {}, label) => assert.throws(() => verifyCouponStagingAdmission(raw, { approvalRoot: durable.authority.public_key_hex, ...options }), { code: "staging_admission_refused" }, `${d}: ${label}`);
    refusedApproval(Buffer.from(durable.approval.envelope.replace(envelope.domain, envelope.domain === COUPON_STAGING_APPROVAL_DOMAIN ? MAC_COUPON_APPROVAL_DOMAIN : COUPON_STAGING_APPROVAL_DOMAIN)), {}, "domain swap");
    refusedApproval(Buffer.from(durable.approval.envelope.replace(/"signature_hex":"(.)/, (m, c) => `"signature_hex":"${c === "0" ? "1" : "0"}`)), {}, "signature");
    refusedApproval(Buffer.from(durable.approval.envelope), { approvalRoot: "11".repeat(32) }, "root");
    refusedApproval(Buffer.from(durable.approval.envelope), { issuerPublicKeySha256: "00".repeat(32) }, "issuer pin");
    for (const value of ["x25519-aesgcm-session-only", "x25519-aesgcm-recipient-v2"])
      refusedApproval(Buffer.from(durable.approval.envelope.replace('"delivery_profile":"x25519-aesgcm-recipient-v1"', `"delivery_profile":"${value}"`)), {}, `unsigned ${value}`);
  }
});

// Native-authority producer bundles (Mac approval v3): exact provider key expiry, no sponsor powers, same hash/AAD/envelope.
const offerHashV4 = (offer) => sha(Buffer.concat([Buffer.from("dsmack-coupon-offer-v4\0"), Buffer.from(canonicalCouponJson(offer), "ascii")]));
const summaryOf = (offer, offerHash) => creditSummary({ id: "c", state: "offered", provider: "near", offer, offerHash,
  admission: { provider: { model: "m", maxTokens: 512, policy: { gatewayTcb: "UpToDate" } } } });

test("native producer bundles: v3 approval, native offer and original-key delivery agree; disclosures state key expiry and no sponsor powers", () => {
  for (const name of ["mac-v3-native-recipient-v1", "mac-v3-native-session-only"]) {
    const b = paired(name), { info, approval, a } = producerAdmission(b), { offer, offer_hash: offerHash } = b.offer_frame.response.result;
    assert.equal(b.environment, "SOFTWARE_TEST_ONLY"); assert.equal(approval.domain, MAC_COUPON_APPROVAL_DOMAIN);
    assert.equal(approval.payload.version, 3); assert.equal(approval.nativeAuthority, true); assert.equal(approval.deliveryProfile, b.delivery_profile);
    for (const pinned of [b.approval.sha256, b.ready.approval_sha256, b.config.payload.approval_sha256]) assert.equal(approval.approval_sha256, pinned);
    assert.deepEqual(offer, b.provision.offer); assert.equal(offerHash, b.provision.offer_hash); assert.equal(b.claim.request.offer_hash, offerHash);
    assert.deepEqual(offer.sponsor_powers, []); assert.equal(offer.provider_expires_at, "2026-11-11T11:19:41Z"); assert.equal(offer.provider.id, "near");
    validateAttestedCouponOffer({ offer, offer_hash: offerHash }, { coupon: b.coupon, peerId: a.peerId, issuerInfo: info, issuerProfile: MAC_ISSUER_PROFILE, deliveryProfile: b.delivery_profile });
    if (b.delivery_profile === "x25519-aesgcm-recipient-v1") creditOfferBound("near", offer, offerHash, b.coupon, info, a);
    const recipient = couponAttestedRecipient(x25519Recovery(b.recipient.x25519_private_hex_synthetic));
    assert.equal(recipient.publicKey, b.recipient.x25519_public_b64); assert.equal(b.claim.request.recipient_key, recipient.publicKey);
    const keyId = b.delivery.recovery_response.result.key_id;
    assert.equal(couponDeliveryAad({ offerHash, coupon: b.coupon, keyId, recipientKey: Buffer.from(recipient.publicKey, "base64"), recipientPeer: b.recipient.noise_peer_id }).toString("utf8"), b.delivery.aad_utf8);
    for (const response of [b.delivery.recovery_response, b.delivery.replay_response]) {
      assert.equal(recipient.decryptSavedDelivery(b.coupon, response.result, offerHash, b.recipient.noise_peer_id), b.delivery.plaintext_synthetic, name);
      assert.throws(() => recipient.decryptSavedDelivery(b.coupon, response.result, offerHash, "OtherClaimantPeer1"), /verification failed/);
    }
    const summary = summaryOf(offer, offerHash);
    assert.equal(summary.providerExpiry, "2026-11-11T11:19:41Z"); assert.equal(summary.sponsorCanRevoke, false); assert.deepEqual(summary.sponsorPowers, []);
    assert.ok(summary.disclosures.includes("Provider key expires 2026-11-11T11:19:41Z.") && summary.disclosures.includes("The sponsor cannot revoke or change limits."));
    assert.ok(!summary.disclosures.some((line) => line.startsWith("Sponsor can revoke")));
    const text = attestedCouponSessionOfferText({ offer, offer_hash: offerHash }, { admission: { profile: "fixture-local", provider: { provider: "near", model: "m", baseUrl: "https://x", policy: {} } } });
    assert.ok(text.includes("provider key expires 2026-11-11T11:19:41Z") && text.includes("the sponsor cannot revoke or change limits") && !text.includes("provider expiry: unknown"));
  }
  // Legacy pairs keep their disclosures and approval mode.
  for (const name of ["mac-v2-recipient-v1", "dstack-v1-recipient-v1"]) {
    const b = paired(name), { approval } = producerAdmission(b), { offer, offer_hash: offerHash } = b.offer_frame.response.result;
    assert.equal(approval.nativeAuthority, false);
    const summary = summaryOf(offer, offerHash);
    assert.equal(summary.providerExpiry, "unknown"); assert.equal(summary.sponsorCanRevoke, true);
    assert.ok(summary.disclosures.includes("Sponsor can revoke the credential or change its limits at any time.") && !summary.disclosures.some((line) => line.includes("cannot revoke")));
    const text = attestedCouponSessionOfferText({ offer, offer_hash: offerHash }, { admission: { profile: "fixture-local", provider: { provider: "near", model: "m", baseUrl: "https://x", policy: {} } } });
    assert.ok(text.includes("provider expiry: unknown; balance: unknown.\nSponsor powers: revoke, change_limits."));
  }
});

test("native offers: exactly the legacy or native pair is accepted, under a matching approval mode", () => {
  const b = paired("mac-v3-native-recipient-v1"), N = producerAdmission(b), native = b.offer_frame.response.result;
  const v2 = paired("mac-v2-recipient-v1"), L = producerAdmission(v2), legacy = v2.offer_frame.response.result;
  const check = (offer, offerHash = offerHashV4(offer)) => validateAttestedCouponOffer({ offer, offer_hash: offerHash },
    { coupon: b.coupon, peerId: N.a.peerId, issuerInfo: N.info, issuerProfile: MAC_ISSUER_PROFILE, deliveryProfile: "x25519-aesgcm-recipient-v1" });
  const refused = (change, label) => assert.throws(() => check({ ...native.offer, ...change }), /verification failed/, label);
  check({ ...native.offer, provider_expires_at: "2099-01-01T00:00:00Z" });
  check({ ...native.offer, provider_expires_at: null, sponsor_powers: ["revoke", "change_limits"] });
  refused({ provider_expires_at: null }, "null + []");
  refused({ sponsor_powers: ["revoke", "change_limits"] }, "timestamp + [revoke, change_limits]");
  refused({ provider_expires_at: native.offer.claim_expires_at }, "expiry equal to claim expiry");
  refused({ provider_expires_at: "2026-10-13T11:19:40Z" }, "expiry before claim expiry");
  for (const value of ["2026-11-11T11:19:41.000Z", "2026-11-11 11:19:41Z", "2026-11-11T11:19:41+00:00", "2027-02-30T00:00:00Z", "2026-11-11T24:00:00Z", "", 1794482381, undefined])
    refused({ provider_expires_at: value }, `malformed ${value}`);
  for (const value of [["revoke"], ["change_limits", "revoke"], [""], null, {}, "[]"]) refused({ sponsor_powers: value }, `powers ${JSON.stringify(value)}`);
  assert.throws(() => check({ ...native.offer, provider_expires_at: "2099-01-01T00:00:00Z" }, native.offer_hash), /verification failed/, "terms changed under the produced hash");
  // The signed approval version fixes the mode: v3 admits only native offers, v2 only legacy ones.
  const refusal = (e) => e.code === "credit_record_refused" || e.message === "coupon offer verification failed";
  assert.throws(() => creditOfferBound("near", native.offer, native.offer_hash, b.coupon, N.info, { ...N.a, approval: { ...N.approval, nativeAuthority: false } }), refusal);
  assert.throws(() => creditOfferBound("near", legacy.offer, legacy.offer_hash, v2.coupon, L.info, { ...L.a, approval: { ...L.approval, nativeAuthority: true } }), refusal);
  creditOfferBound("near", legacy.offer, legacy.offer_hash, v2.coupon, L.info, L.a);
  // Version is signed: editing it breaks the signature, and unknown versions refuse.
  for (const version of [2, 4]) assert.throws(() => verifyCouponStagingAdmission(Buffer.from(b.approval.envelope.replace('"version":3', `"version":${version}`)), { approvalRoot: b.authority.public_key_hex }), { code: "staging_admission_refused" });
});

test("a legacy-mode approval refuses a native offer at the client before anything is saved or claimed", { timeout: 15_000 }, async () => {
  const server = await issuer(), dir = tempDir(), manager = createCreditManagerForTesting({ directory: path.join(dir, "credit"), connect });
  server.state.offer = bundle({ ...server.state.offer.offer, provider_expires_at: "2031-01-01T00:00:00Z", sponsor_powers: [] });
  try {
    await assert.rejects(manager.inspect(coupon, server.admission), { code: "credit_offer_refused", message: /did not offer/ });
    assert.deepEqual(server.frames.map((f) => f.op), ["offer"]);
    assert.equal(fs.existsSync(path.join(dir, "credit", `${id}.json`)), false);
  } finally { await server.host.stop(); }
});

test("a native-authority (v3) approval refuses a legacy offer at client.offer(); the native offer is accepted", { timeout: 30_000 }, async () => {
  const { servePeer } = await import("../lib/p2p.mjs");
  const { couponAttestedClientForTesting, COUPON_ISSUER_PROTOCOL, COUPON_ISSUER_FRAME_LIMIT, COUPON_PROTOCOL_V4 } = await import("../lib/coupon-attested.mjs");
  const issuerKey = crypto.generateKeyPairSync("ed25519"), rootKey = crypto.generateKeyPairSync("ed25519"), raw = (k) => k.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const compose = '{"name":"SYNTHETIC ONLY MAC NATIVE ISSUER","services":{}}', composeHash = sha(Buffer.from(compose)), cdhash = "ab".repeat(32);
  const policy = { version: 1, profile: MAC_ISSUER_PROFILE, app_id: "DC9JH5DRMY.dev.dsmack.provider", challenge_ttl_ms: 30000, max_enrollment_age_seconds: 43200,
    approved_measurements: [{ cdhash, compose_sha256: composeHash }], custody: "operator-kms-readable" };
  const info = { version: 2, issuer_public_key_hex: raw(issuerKey).toString("hex"), identity_policy_sha256: macIssuerPolicyHash(policy), issuance_policy_sha256: "cd".repeat(32) };
  const payload = { version: 3, profile: "debug-staging", app_id: "SYNTHETIC-Mac-runtime", compose_hash: composeHash, identity_policy_sha256: info.identity_policy_sha256,
    issuance_policy_sha256: info.issuance_policy_sha256, issuer_public_key_sha256: sha(raw(issuerKey)), provider_scope_commitment: "ab".repeat(32),
    guard: { chain_id: 11155111, address: `0x${"11".repeat(20)}`, code_hash: `0x${"22".repeat(32)}`, issuer_address: `0x${"33".repeat(20)}` },
    powers: ["operator-secret-access", "application-exec", "debugger", "host-clock"], prompt_policy: "synthetic-only", max_coupon_nano_usd: "5000000000", max_total_nano_usd: "5000000000",
    expires_at: "2099-01-01T00:00:00Z", generation: 1, issuer_profile: MAC_ISSUER_PROFILE, cdhash, delivery_profile: "x25519-aesgcm-recipient-v1" };
  const approvalBytes = Buffer.from(canonicalCouponJson({ domain: MAC_COUPON_APPROVAL_DOMAIN, payload,
    signature_hex: crypto.sign(null, Buffer.from(`${MAC_COUPON_APPROVAL_DOMAIN}\0${canonicalCouponJson(payload)}`), rootKey.privateKey).toString("hex") }));
  let served;
  const host = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_ISSUER_PROTOCOL]: { maxDataLength: COUPON_ISSUER_FRAME_LIMIT, timeoutMs: 3000, handle: async (_lp, send, recv) => {
      const frame = await recv();
      await send({ id: frame.id, ok: true, result: frame.op === "info" ? info : { domain: MAC_ISSUER_DOMAIN, binding: frame.binding, app_compose: compose,
        possession_signature_hex: crypto.sign(null, macIssuerPossessionMessage(frame.binding), issuerKey.privateKey).toString("hex"),
        runner_evidence: { type: "macrunner", attestation: "AA==", keyId: "AA==", assertion: "AA==", bootClientData: Buffer.from(JSON.stringify({ compose_hash: composeHash })).toString("base64"),
          assertClientData: Buffer.from(macIssuerData(frame.binding)).toString("base64") } } });
    } },
    [COUPON_PROTOCOL_V4]: { timeoutMs: 3000, handle: async (_lp, send, recv) => { const frame = await recv(); await send({ id: frame.id, ok: true, result: served }); } },
  } });
  const legacy = { ...terms(host.peerId.toString()), issuer: { peer_id: host.peerId.toString(), policy: MAC_ISSUER_PROFILE, identity_policy_sha256: info.identity_policy_sha256,
    issuance_policy_sha256: info.issuance_policy_sha256, issuer_public_key_sha256: sha(raw(issuerKey)) }, provider: { id: "near", scope_commitment: "ab".repeat(32) } };
  const client = () => couponAttestedClientForTesting(String(host.getMultiaddrs()[0]), { identityPolicy: policy, expectedIdentityPolicySha256: info.identity_policy_sha256,
    expectedIssuancePolicySha256: info.issuance_policy_sha256, expectedIssuerPublicKeySha256: sha(raw(issuerKey)), deliveryProfile: "x25519-aesgcm-recipient-v1",
    stagingApproval: { bytes: approvalBytes, approvalRoot: raw(rootKey).toString("hex") }, syntheticRunnerVerifier: async () => ({ cdhash, compose_hash: composeHash }) });
  try {
    for (const [offer, accepted] of [[legacy, false], [{ ...legacy, provider_expires_at: "2031-01-01T00:00:00Z", sponsor_powers: [] }, true]]) {
      served = bundle(offer);
      const c = await client();
      try {
        if (accepted) assert.equal((await c.offer(coupon)).offer_hash, served.offer_hash);
        else await assert.rejects(c.offer(coupon), /^Error: coupon offer request failed$/);
        assert.equal(c.stagingAdmission.nativeAuthority, true);
      } finally { await c.close(); }
    }
  } finally { await host.stop(); }
});
