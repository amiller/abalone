// Real dsmack synthetic async /4 -> actual incognito Pi -> socket broker.
// It does not qualify hardware, a live provider or VPN behavior.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { node, servePeer } from "../lib/p2p.mjs";
import { COUPON_PROTOCOL_V4, COUPON_ISSUER_PROTOCOL } from "../lib/coupon-attested.mjs";
import { runPrompt, assistantText } from "../lib/rpc.mjs";

const ownedHost = process.argv.includes("--owned-host");
const memoryRuns = new Set();
const protocol = COUPON_PROTOCOL_V4;
const source = process.env.DSMACK_CODE_DIR;
if (!source || !path.isAbsolute(source)) throw new Error("Set DSMACK_CODE_DIR to an absolute dsmack code checkout");
const { createCouponPeerService } = await import(pathToFileURL(path.join(source, "experiments/coupon_redemption/peer_bridge.mjs")));
const root = path.resolve(import.meta.dirname, ".."), dir = fs.mkdtempSync(path.join(os.tmpdir(), "abcs-"));
const resources = [], frames = [], logs = [], prompts = [], environment = [], argv = [], originalError = console.error;
let stage = "setup", provider, creates = 0;
console.error = (...a) => logs.push(a.join(" "));
try {
  const keys = await Promise.all([0, 1].map(() => generateKeyPair("Ed25519")));
  const identities = await Promise.all(keys.map((key) => node([], {}, key)));
  const [sponsorPeer, issuerPeer] = identities.map((p) => p.peerId.toString()); await Promise.all(identities.map((p) => p.stop()));
  const state = path.join(dir, "issuer-state"), configPath = path.join(dir, "issuer.json");
  const serviceConfig = { version: 1, state_dir: state, issuer_peer_id: issuerPeer, sponsor_subject: "fixture:sponsor", observer_subject: "fixture:observer", peers: { [sponsorPeer]: { subject: "fixture:sponsor", roles: ["sponsor"] } }, provider: { mode: "synthetic" } };
  const fixture = JSON.parse(execFileSync("python3", ["-m", "experiments.coupon_redemption.test_issuer_fixture"], { cwd: source, encoding: "utf8" }));
  const composeFile = path.join(dir, "compose.json"); fs.writeFileSync(composeFile, fixture.app_compose, { mode: 0o600 });
  serviceConfig.issuer_evidence = { identity_policy_sha256: fixture.identity_policy_sha256, issuance_policy_sha256: fixture.issuance_policy_sha256, socket_path: path.join(dir, "synthetic.sock"), compose_file: composeFile };
  const workerExecutable = path.join(dir, "async-worker");
  fs.writeFileSync(workerExecutable, `#!/usr/bin/env python3
import os, sys
sys.path.insert(0, os.getcwd())
from experiments.coupon_redemption import peer_worker, test_async_fixture
from experiments.coupon_redemption.spike import IssuedKey
original = test_async_fixture.AsyncFileProvider.create_key
def create(self, name, budget):
    original(self, name, budget)
    return IssuedKey("synthetic-" + name, "synthetic-only-" + name)
test_async_fixture.AsyncFileProvider.create_key = create
peer_worker.Worker = test_async_fixture.async_fixture_worker
raise SystemExit(peer_worker.main(sys.argv[3:]))
`, { mode: 0o700 });
  fs.writeFileSync(configPath, JSON.stringify(serviceConfig), { mode: 0o600 });
  const bridge = await createCouponPeerService({ configPath, cwd: source, python: workerExecutable }); resources.push(() => bridge.close());
  const host = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], privateKey: keys[1], evidence: () => () => ({ type: "dev" }), services: {
    [COUPON_ISSUER_PROTOCOL]: bridge.issuerService,
    [protocol]: { ...bridge.serviceV4, handle: (lp, send, recv, auth) => bridge.serviceV4.handle(lp, (bytes) => { frames.push(bytes.toString()); return send(bytes); }, async () => { const bytes = await recv(); frames.push(bytes.toString()); return bytes; }, auth) },
  } }); resources.push(() => host.stop());
  const peerAddr = String(host.getMultiaddrs()[0]), context = { authenticated: true, transport: "noise", protocol, remotePeer: sponsorPeer, localPeer: issuerPeer };
  const gift = await bridge.provisionV4(context, "5000000000", "2030-10-10T00:00:00Z"), credential = `synthetic-only-coupon-${crypto.createHash("sha256").update(gift.coupon).digest("hex")}`;
  const prompt = "SYNTHETIC-PRIVATE-TASK: calculate the sum of 2 and 3";
  provider = http.createServer(async (req, res) => {
    assert.equal(req.url, "/v1/chat/completions"); assert.equal(req.headers.authorization, `Bearer ${credential}`);
    let text = ""; for await (const c of req) text += c; const body = JSON.parse(text); prompts.push(text);
    assert.equal(body.model, "fixture-model"); assert.ok(text.includes(prompt)); creates++;
    // Inspect the actual Pi child, not merely a constructed env object. Pi sets
    // process.title, replacing its cmdline, so bind inspection to this fixture config.
    for (const name of fs.readdirSync("/proc").filter((n) => /^[0-9]+$/.test(n))) {
      let command, childEnv;
      try {
        command = fs.readFileSync(`/proc/${name}/cmdline`, "utf8");
        childEnv = fs.readFileSync(`/proc/${name}/environ`, "utf8");
      } catch { continue; } // unrelated processes can disappear or deny inspection
      const fields = Object.fromEntries(childEnv.split("\0").filter(x => x.includes("=")).map(x => { const at=x.indexOf("="); return [x.slice(0,at),x.slice(at+1)]; }));
      if (fields.ABALONE_DIR === path.join(dir, "recipient") || (ownedHost && fields.ABALONE_OWNED_HOST === "1" && fields.ABALONE_CONFIG === configDir)) {
        argv.push(command); environment.push(childEnv);
        if (ownedHost && fields.ABALONE_OWNED_HOST === "1") {
          assert.ok(fields.ABALONE_DIR, "actual Pi child has managed state");
          assert.equal(fs.statfsSync(fields.ABALONE_DIR).type, 0x01021994, "actual Pi state is tmpfs");
          memoryRuns.add(path.dirname(fields.ABALONE_DIR));
        }
      }
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = (choices, usage) => `data: ${JSON.stringify({ id: "synthetic-session-reply", object: "chat.completion.chunk", created: 1, model: body.model, choices, ...(usage ? { usage } : {}) })}\n\n`;
    res.end(event([{ index: 0, delta: { role: "assistant", content: "The sum is 5 (synthetic fixture)." }, finish_reason: null }]) + event([{ index: 0, delta: {}, finish_reason: "stop" }], { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) + "data: [DONE]\n\n");
  }); await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  const configDir = path.join(dir, "config"), recipient = path.join(dir, "recipient"), work = path.join(dir, "work"), runtime = path.join(dir, "runtime");
  for (const folder of [path.join(configDir, "curated"), recipient, work, runtime]) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const p = { admitted: [], local: [], runners: {}, verifierHosts: [], peers: { admit: { dev: true } }, default: "synthetic-near/fixture-model", couponSession: { mode: "synthetic-loopback", provider: "synthetic-near", baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, models: ["fixture-model"] } };
  fs.writeFileSync(path.join(configDir, "providers.json"), JSON.stringify(p)); fs.copyFileSync(path.join(root, "policy.json"), path.join(configDir, "policy.json")); fs.copyFileSync(path.join(root, "curated/manifest.json"), path.join(configDir, "curated/manifest.json"));
  const env = { ...process.env, ABALONE_CONFIG: configDir, ABALONE_DIR: recipient, XDG_RUNTIME_DIR: runtime, ABALONE_NO_CANARIES: "1", ABALONE_COUPON_FD: "3", ABALONE_COUPON_CONSENT_FD: "4" };
  delete env.ABALONE_COUPON_SOCKET; delete env.SYNTHETIC_COUPON_API_KEY;
  execFileSync(process.execPath, [path.join(root, "tools/rehash-manifest.mjs")], { env, stdio: "pipe" });
  const input = (value, name) => { const file = path.join(dir, name); fs.writeFileSync(file, value + "\n", { mode: 0o600 }); return fs.openSync(file, "r"); };
  const execute = (args, coupon, consent) => {
    const codeFD = input(coupon, "coupon-input"), consentFD = input(consent, "consent-input");
    const child = spawn(path.join(root, "bin/abalone"), ["coupon-session", "--peer", peerAddr, "--model", p.default, ...args], { env, cwd: work, stdio: ["ignore", "pipe", "pipe", codeFD, consentFD] });
    fs.closeSync(codeFD); fs.closeSync(consentFD);
    return new Promise((resolve) => { let text = ""; child.stdout.on("data", (d) => text += d); child.stderr.on("data", (d) => text += d); child.on("exit", (code) => resolve({ code, text })); });
  };
  const seed = fs.readFileSync(path.join(state, "observer.key"));
  const key = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pinFile = path.join(dir, "issuer-pin.json");
  fs.writeFileSync(pinFile, JSON.stringify({ identityPolicy: fixture.identity_policy, expectedIdentityPolicySha256: fixture.identity_policy_sha256, expectedIssuancePolicySha256: fixture.issuance_policy_sha256, expectedIssuerPublicKeySha256: crypto.createHash("sha256").update(crypto.createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32)).digest("hex") }));
  const passFD = input("synthetic trace passphrase", "passphrase-input");
  try { if (!ownedHost) execFileSync(path.join(root, "bin/abalone"), ["trace", "key", "init"], { env: { ...env, ABALONE_PASSPHRASE_FD: "3" }, stdio: ["ignore", "pipe", "pipe", passFD] }); } finally { fs.closeSync(passFD); }
  const profileArgs = ["--attested", "--fixture-local", "--issuer-pin", pinFile, "--incognito", ...(ownedHost ? ["--owned-host"] : [])];
  env.ABALONE_COUPON_POLL_MS = "1000";
  if (ownedHost) {
    const fake=path.join(dir,"no-bwrap"); fs.mkdirSync(fake);
    fs.writeFileSync(path.join(fake,"bwrap"), `#!/bin/sh\necho called >> ${path.join(dir,"bwrap-called")}\nexit 127\n`,{mode:0o700});
    env.PATH=fake+":"+env.PATH;
    const strict=await execute(profileArgs.filter(x=>x!=="--owned-host"),gift.coupon,"");
    assert.equal(strict.code,1);assert.ok(strict.text.includes("Linux sandbox installed before claim"));
    assert.equal(frames.length,0); fs.unlinkSync(path.join(dir,"bwrap-called"));
  }
  stage = "default refusal";
  const denied = await execute([], gift.coupon, "CLAIM SESSION ONLY"); assert.equal(denied.code, 1); assert.ok(denied.text.includes("No coupon was read or sent")); assert.equal(frames.length, 0);
  stage = "cancelled offer";
  const cancelled = await execute(profileArgs, gift.coupon, ""); assert.equal(cancelled.code, 0); assert.ok(cancelled.text.includes("Cancelled. Nothing was claimed")); assert.equal(frames.filter((f) => f.includes('"op":"claim"')).length, 0);
  stage = "actual session";
  const codeFD = input(gift.coupon, "coupon-input"), consentFD = input("CLAIM SESSION ONLY\n" + "WAIT SAME KEYS\n".repeat(8), "consent-input");
  fs.writeFileSync(path.join(state, "async-issuance-gate"), "hold", { mode: 0o600 });
  const grantTimer = setTimeout(() => fs.writeFileSync(path.join(state, "async-issuance-gate"), "grant"), 3500);
  let session;
  try { session = await runPrompt({ command: "coupon-session", args: [...profileArgs, "--peer", peerAddr, "--model", p.default], message: prompt, env, cwd: work, fds: [codeFD, consentFD], onUi: () => { throw new Error("unexpected dialog"); } }); }
  finally { clearTimeout(grantTimer); fs.closeSync(codeFD); fs.closeSync(consentFD); }
  assert.equal(assistantText(session.events), "The sum is 5 (synthetic fixture)."); assert.ok(session.stderr.includes("EXIT OR CRASH LOSES RECOVERY")); assert.ok(session.stderr.includes("Coupon session closed"));
  assert.ok(session.stderr.includes("asynchronous claim is still in progress"));
  assert.ok(session.stderr.includes(ownedHost ? "Incognito closed. No conversation trace retained" : "Strict incognito closed"));
  const claims = frames.filter((f) => f.includes('"op":"claim"')).map(JSON.parse);
  assert.ok(claims.length >= 2); assert.equal(new Set(claims.map((f) => f.recipient_key)).size, 1); assert.equal(new Set(claims.map((f) => f.offer_hash)).size, 1);
  if (ownedHost) {
    assert.equal(fs.existsSync(path.join(dir,"bwrap-called")),false,"explicit owned-host never attempts bwrap");
    assert.ok(session.stderr.includes("local tools have your ordinary account"));
    assert.ok(memoryRuns.size>0);for(const run of memoryRuns)assert.equal(fs.existsSync(run),false,"managed state/socket directory removed on close");
    assert.equal(fs.existsSync(path.join(recipient,"keys")),false,"default has no trace key");
  }
  assert.equal(creates, 1); assert.equal(prompts.length, 1); assert.ok(environment.length > 0);
  for (const content of [...environment, ...argv, ...logs, session.stderr, JSON.stringify(session.events)]) assert.ok(!content.includes(credential) && !content.includes(gift.coupon), "no raw credential or coupon in exercised child/log/transcript channels");
  assert.ok(frames.every((f) => !f.includes(prompt) && !f.includes(credential))); // coupon itself intentionally crosses claim wire
  assert.equal(fs.existsSync(path.join(recipient, "credit")), false);
  assert.deepEqual(fs.readdirSync(runtime), []);
  for (const folder of [recipient, work]) for (const file of fs.readdirSync(folder, { recursive: true })) {
    const full = path.join(folder, file); if (!fs.statSync(full).isFile()) continue;
    const content = fs.readFileSync(full).toString(); assert.ok(!content.includes(credential) && !content.includes(gift.coupon), `no bearer/credential in retained ${file}`);
  }
  assert.equal(fs.readFileSync(path.join(state, "async-provider-effects"), "utf8").trim().split("\n").length, 1);
  originalError(JSON.stringify({ mode: ownedHost ? "synthetic-async-v4-owned-host-Pi-session-e2e" : "synthetic-async-v4-incognito-Pi-session-e2e", production_default_refused: true, cancelled_before_claim: true, useful_direct_response: true, provider_creates: 1, raw_key_in_child_environment: false, no_credential_persistence: true, broker_cleaned_up: true, issuer_verified_for_production: false, vpn_qualified: false }));
} catch (e) { originalError(`Synthetic recipient-session fixture failed at ${stage}: ${e.message}`); throw e; }
finally { console.error = originalError; for (const close of resources.reverse()) await close(); provider?.closeAllConnections(); if (provider) await new Promise((r) => provider.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
