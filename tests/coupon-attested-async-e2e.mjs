// Asynchronous /4 claim interop against the sibling service's real AsyncCouponServiceV4 over
// genuine local Noise peers. Identity stays the explicit synthetic fixture; a gate-file issuance
// authorizer steers hold/grant/fail around the service's actual forked issuance job. Never
// hardware, provider credentials or chain access. Set DSMACK_CODE_DIR to the service checkout.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { node, servePeer } from "../lib/p2p.mjs";
import { couponAttestedClientForTesting, couponAttestedRecipient, COUPON_PROTOCOL_V4, COUPON_ISSUER_PROTOCOL } from "../lib/coupon-attested.mjs";

const source = process.env.DSMACK_CODE_DIR;
if (!source || !path.isAbsolute(source)) throw new Error("Set DSMACK_CODE_DIR to an absolute dsmack service checkout");
const { createCouponPeerService } = await import(pathToFileURL(path.join(source, "experiments/coupon_redemption/peer_bridge.mjs")));
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const vector = JSON.parse(await fs.readFile(new URL("fixtures/coupon/offer-v4.json", import.meta.url)));
const fixture = JSON.parse(execFileSync("python3", ["-m", "experiments.coupon_redemption.test_issuer_fixture"], { cwd: source, encoding: "utf8" }));
assert.equal(fixture.environment, "synthetic-only-not-hardware");

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "abalone-attested-async-"));
const gate = path.join(directory, "async-gate");
const keys = await Promise.all([0, 1, 2].map(() => generateKeyPair("Ed25519")));
const ids = await Promise.all(keys.map((privateKey) => node([], {}, privateKey)));
const [sponsorPeer, , issuerPeer] = ids.map((peer) => peer.peerId.toString());
await Promise.all(ids.map((peer) => peer.stop()));
const context = { authenticated: true, transport: "noise", protocol: COUPON_PROTOCOL_V4, remotePeer: sponsorPeer, localPeer: "" };
const counts = (stateDir) => JSON.parse(execFileSync("python3", ["-c", "import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(dict(c.execute('SELECT kind,COUNT(*) FROM synthetic_events GROUP BY kind'))))", path.join(stateDir, "state.sqlite")], { encoding: "utf8" }));
const gateMode = async (mode) => { await fs.writeFile(gate, mode, { mode: 0o600 }); };
// The service's own worker seams (issuer_collector_factory, issuance_authorizer) carry the
// synthetic identity and a gate-file authorization double; the v4 service class itself is the
// real AsyncCouponServiceV4. No sibling file is modified — this is the bridge's wrapper protocol.
const wrapper = `#!/usr/bin/env python3
import sys, os, time
sys.path.insert(0, os.getcwd())
from pathlib import Path
from experiments.coupon_redemption import peer_worker, async_service_v4, test_issuer_fixture as fixture
from experiments.coupon_redemption.dstack_issuer_identity import DstackIssuerIdentity
from experiments.coupon_redemption.peer_worker import SyntheticProvider
from experiments.coupon_redemption.spike import RedemptionError, IssuedKey
import sqlite3
GATE = Path(${JSON.stringify(gate)})
RealWorker = peer_worker.Worker
worker = None
class ForkSafeSyntheticProvider(SyntheticProvider):
    # The issuance job forks and closes the inherited store handle, so each durable
    # fixture effect reopens sqlite against the same database file.
    def __init__(self, store):
        super().__init__(store)
        self.db_path = store.db.execute('PRAGMA database_list').fetchone()['file']
    def _event(self, kind):
        db = sqlite3.connect(self.db_path)
        try:
            db.execute('INSERT INTO synthetic_events VALUES (?)', (kind,)); db.commit()
        finally:
            db.close()
    def create_key(self, name, budget):
        self._event('create')
        return IssuedKey('synthetic-' + name, 'synthetic-only-' + name)
    def usage_rows(self, key_id, start, end):
        self._event('read')
        return [{'source': 'inference', 'id': 'synthetic-row-' + key_id,
                 'api_key_id': key_id, 'total_cost_nano_usd': 5_000_000_000}]
peer_worker.SyntheticProvider = ForkSafeSyntheticProvider
def authorize(digest, peer, public, accepted_hash, binding):
    if (worker is None or not isinstance(worker.service_v4.provider, SyntheticProvider)
            or binding['issuance_policy_sha256'] != fixture.ISSUANCE_POLICY_HASH):
        raise RedemptionError('synthetic fixture cannot authorize near credentials')
    while True:
        mode = GATE.read_text() if GATE.exists() else 'grant'
        if mode == 'grant':
            return
        if mode == 'fail':
            raise RedemptionError('synthetic fixture authorization refused')
        time.sleep(0.05)
def build(config_path):
    global worker
    worker = RealWorker(config_path,
        issuer_collector_factory=lambda socket_path, signing_key: DstackIssuerIdentity(fixture.SyntheticGuest(), signing_key),
        issuance_authorizer=authorize)
    return worker
peer_worker.DsmackCouponServiceV4 = async_service_v4.AsyncCouponServiceV4
peer_worker.Worker = build
raise SystemExit(peer_worker.main(sys.argv[3:]))
`;
const resources = [];
let bridge, peer, client, stage = "setup";
try {
  const stateDir = path.join(directory, "state"), configPath = path.join(directory, "config.json"), composeFile = path.join(directory, "compose.json"), python = path.join(directory, "python-async-fixture");
  context.localPeer = issuerPeer;
  const config = { version: 1, state_dir: stateDir, issuer_peer_id: context.localPeer, sponsor_subject: "test:sponsor", observer_subject: "test:observer",
    peers: { [sponsorPeer]: { subject: "test:sponsor", roles: ["sponsor"] } }, provider: { mode: "synthetic" },
    issuer_evidence: { identity_policy_sha256: fixture.identity_policy_sha256, issuance_policy_sha256: fixture.issuance_policy_sha256,
      socket_path: path.join(directory, "nonexistent-synthetic-dstack.sock"), compose_file: composeFile } };
  await fs.writeFile(composeFile, fixture.app_compose, { mode: 0o600 });
  await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await fs.writeFile(python, wrapper, { mode: 0o700 });
  await gateMode("hold");
  bridge = await createCouponPeerService({ configPath, cwd: source, python }); resources.push(() => bridge.close());
  peer = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], privateKey: keys[2], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_PROTOCOL_V4]: bridge.serviceV4, [COUPON_ISSUER_PROTOCOL]: bridge.issuerService } }); resources.push(() => peer.stop());
  const address = String(peer.getMultiaddrs()[0]);
  const signingSeed = await fs.readFile(path.join(stateDir, "observer.key"));
  const signingPrivate = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), signingSeed]), format: "der", type: "pkcs8" });
  const signingPublic = crypto.createPublicKey(signingPrivate).export({ format: "der", type: "spki" }).subarray(-32);
  const options = { identityPolicy: fixture.identity_policy, expectedIdentityPolicySha256: fixture.identity_policy_sha256,
    expectedIssuancePolicySha256: fixture.issuance_policy_sha256, expectedIssuerPublicKeySha256: sha(signingPublic.subarray(-32)),
    syntheticQuoteVerifier: async (quote) => JSON.parse(Buffer.from(quote, "hex").toString()) };
  client = await couponAttestedClientForTesting(address, options, { privateKey: keys[1] }); resources.push(() => client.close());
  assert.equal(client.identity.evidenceStatus, "synthetic-only-not-hardware");
  stage = "held claim answers exactly in_progress";
  const expiry = new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const coupon = (await bridge.provisionV4(context, "5000000000", expiry)).coupon;
  const accepted = await client.offer(coupon), recipient = couponAttestedRecipient();
  assert.deepEqual(await client.claim(coupon, recipient, accepted), { state: "in_progress", automatic_retry_allowed: false, deposit_release_authorized: false });
  assert.deepEqual(counts(stateDir), {}, "a held job commits no provider effect yet");
  stage = "bound winner status and unbound refusal";
  const progress = await client.status(coupon, { recipient, accepted });
  assert.equal(progress.state, "in_progress"); assert.equal(progress.claim_expired, false);
  await assert.rejects(client.status(coupon), /request failed/);
  stage = "polling deadline stays uncertain and creates nothing";
  await assert.rejects(client.awaitDelivery(coupon, recipient, accepted, { timeoutMs: 300, pollIntervalMs: 50 }),
    (error) => error.code === "claim_pending" && /still uncertain/.test(error.message));
  assert.deepEqual(counts(stateDir), {}, "polling never causes provider-key creation");
  stage = "a second claimant cannot bind the held job";
  const rivalClient = await couponAttestedClientForTesting(address, options, { privateKey: keys[0] }); resources.push(() => rivalClient.close());
  await assert.rejects(rivalClient.claim(coupon, couponAttestedRecipient(), await rivalClient.offer(coupon)), /request failed/);
  stage = "grant delivers through the original keys";
  await gateMode("grant");
  const result = await client.awaitDelivery(coupon, recipient, accepted, { timeoutMs: 20_000, pollIntervalMs: 100 });
  assert.equal(recipient.decryptDelivery(coupon, result, accepted), `synthetic-only-coupon-${sha(coupon)}`);
  assert.deepEqual(counts(stateDir), { create: 1 }, "exactly one provider key across claim, polls and delivery");
  assert.deepEqual(await client.claim(coupon, recipient, accepted), result, "delivered replay returns the same envelope");
  stage = "restart with an unresolved job requires reconciliation";
  const expiry2 = new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const coupon2 = (await bridge.provisionV4(context, "1000000000", expiry2)).coupon;
  const accepted2 = await client.offer(coupon2), recipient2 = couponAttestedRecipient();
  await gateMode("hold");
  assert.equal((await client.claim(coupon2, recipient2, accepted2)).state, "in_progress");
  await bridge.restart();
  await gateMode("fail"); // reap the orphaned job child without a provider effect
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await client.status(coupon2, { recipient: recipient2, accepted: accepted2 })).state, "reconciliation_required");
  await assert.rejects(client.awaitDelivery(coupon2, recipient2, accepted2, { timeoutMs: 2000, pollIntervalMs: 50 }), { code: "claim_reconciliation_required" });
  assert.deepEqual(counts(stateDir), { create: 1 }, "reconciliation never issues a replacement key");
  console.log(JSON.stringify({ mode: "synthetic-issuer-v2-coupon-v4-async-libp2p-e2e", identity: "synthetic-only-not-hardware", service: "AsyncCouponServiceV4",
    claim_in_progress_exact_schema: true, bound_status_in_progress: true, unbound_status_refused: true, poll_deadline_claim_pending: true,
    polling_creates_no_key: true, rival_claimant_refused: true, grant_delivers_original_keys: true, provider_creates: 1,
    delivered_replay: true, restart_unresolved_reconciliation: true, reconciliation_creates_no_key: true,
    private_issuance_qualified: false, rollback_qualified: false, deposit_release_authorized: false }));
} catch (error) { throw new Error(`Synthetic attested async integration failed during ${stage}`, { cause: error }); }
finally {
  await fs.writeFile(gate, "fail", { mode: 0o600 }).catch(() => {});
  await Promise.allSettled(resources.reverse().map((close) => close()));
  await new Promise((resolve) => setTimeout(resolve, 200)); // let any orphaned job child observe the gate
  await fs.rm(directory, { recursive: true, force: true });
}
