import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadTrial, preflight, inspectVpn, recipientArgv, recipientStdio, firstUseNotice, FIRST_USE_SOURCE_FILES } from "../tools/coupon-first-use.mjs";
import { syntheticIssuerIdentity } from "./fixtures/coupon/issuer-v2.mjs";
import { syntheticStagingSigner, syntheticBaseGuard } from "./fixtures/coupon/staging-signer.mjs";

const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const root = path.resolve(import.meta.dirname, "..");
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coupon-first-use-"));
  const identity = syntheticIssuerIdentity(), signer = syntheticStagingSigner();
  const pin = { identityPolicy: identity.policy, expectedIdentityPolicySha256: identity.info.identity_policy_sha256,
    expectedIssuancePolicySha256: identity.info.issuance_policy_sha256, expectedIssuerPublicKeySha256: sha(Buffer.from(identity.info.issuer_public_key_hex, "hex")) };
  const approval = signer.sign({ identityPolicySha256: pin.expectedIdentityPolicySha256, issuancePolicySha256: pin.expectedIssuancePolicySha256,
    issuerPublicKeySha256: pin.expectedIssuerPublicKeySha256, providerScopeCommitment: "cd".repeat(32) });
  fs.writeFileSync(path.join(directory, "issuer-pin.json"), JSON.stringify(pin));
  fs.writeFileSync(path.join(directory, "approval.json"), approval.bytes);
  const bundle = JSON.parse(fs.readFileSync(path.join(root, "docs/coupon-first-use.example.json")));
  Object.assign(bundle.issuer, { peer: "/ip4/127.0.0.1/tcp/1234/p2p/12D3KooWDbxDummy", privateRoute: "SYNTHETIC fixture route, never a live qualification", approval: "approval.json", approvalRoot: signer.rootHex });
  bundle.provider.model = "selected/model";
  for (const name of FIRST_USE_SOURCE_FILES) bundle.source.files[name] = sha(fs.readFileSync(path.join(root, name)));
  const file = path.join(directory, "trial.json");
  return { directory, bundle, file, save: () => fs.writeFileSync(file, JSON.stringify(bundle)) };
}
test("public bundle pins exact staging and NEAR profiles; invocation selects /4 incognito and exposes no bearer", () => {
  const f = fixture();
  try {
    f.save(); const trial = loadTrial(f.file), argv = recipientArgv(trial);
    assert.ok(argv.includes("--attested") && argv.includes("--incognito"));
    assert.ok(argv.includes("near/selected/model"));
    assert.ok(!argv.includes("--keep-trace"));
    assert.ok(recipientArgv(trial, { keepTrace: true }).includes("--keep-trace"));
    assert.ok(!argv.includes("--experimental-local") && !argv.includes("--fixture-local"));
    assert.equal(trial.approval.promptPolicy, "synthetic-only");
    assert.ok(firstUseNotice.includes("issuer is not a prompt relay"));
    f.bundle.coupon = "forbidden bearer"; f.save(); assert.throws(() => loadTrial(f.file), { code: "bundle_invalid" }); delete f.bundle.coupon;
    f.bundle.provider.policy.gpuSignature = "reported"; f.save(); assert.throws(() => loadTrial(f.file)); f.bundle.provider.policy.gpuSignature = "required";
    f.bundle.provider.baseUrl = "http://127.0.0.1:80/v1"; f.save(); assert.throws(() => loadTrial(f.file)); f.bundle.provider.baseUrl = "https://cloud-api.near.ai/v1";
    f.bundle.issuer.approvalRoot = "ee".repeat(32); f.save(); assert.throws(() => loadTrial(f.file), { code: "staging_admission_refused" });
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
test("relocated public files cannot escape the bundle and missing live pins remain missing", () => {
  const f = fixture();
  try {
    f.bundle.issuer.pin = "../outside.json"; f.save(); assert.throws(() => loadTrial(f.file), { code: "bundle_invalid" });
    f.bundle.issuer.pin = "issuer-pin.json"; f.bundle.issuer.peer = null; f.save(); assert.throws(() => loadTrial(f.file), { code: "issuer_inputs_missing" });
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
test("VPN observations are bounded and require pinned real qualification inputs; mock observations are not a loss test", () => {
  const f = fixture(), rules = "synthetic nft fixture output", calls = [];
  try {
    assert.throws(() => inspectVpn(null, f.directory), { code: "vpn_not_qualified" });
    fs.writeFileSync(path.join(f.directory, "qualification.txt"), "SYNTHETIC test report, not live evidence");
    const vpn = { profile: "SYNTHETIC reviewed profile", interface: "wg0", route4: "192.0.2.1", route6: "2001:db8::1", rulesetSha256: sha(rules), qualification: "qualification.txt", qualificationSha256: sha("SYNTHETIC test report, not live evidence") };
    const command = (exe, argv, options) => { calls.push([exe, argv]); assert.equal(options.timeout, 5000); return { status: 0, stdout: exe === "nft" ? rules : '[{"dev":"wg0"}]' }; };
    assert.ok(inspectVpn(vpn, f.directory, command).includes("does not repeat a real VPN loss test"));
    assert.deepEqual(calls.map(([exe]) => exe), ["nft", "ip", "ip"]);
    assert.throws(() => inspectVpn({ ...vpn, rulesetSha256: "ee".repeat(32) }, f.directory, command), { code: "vpn_not_qualified" });
    assert.throws(() => inspectVpn(vpn, f.directory, () => ({ status: 0, stdout: '[{"dev":"eth0"}]' })), { code: "vpn_not_qualified" });
    assert.throws(() => inspectVpn({ ...vpn, interface: "wg0; evil" }, f.directory, command), { code: "vpn_not_qualified" });
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
test("descriptor syntax rejects stdin, duplicates and arbitrary gift files; terminal mode inherits normal streams", () => {
  assert.deepEqual(recipientStdio({}), ["inherit", "inherit", "inherit"]);
  assert.throws(() => recipientStdio({ ABALONE_COUPON_FD: "0" }), { code: "input_descriptor_refused" });
  assert.throws(() => recipientStdio({ ABALONE_COUPON_CONSENT_FD: "3", ABALONE_PASSPHRASE_FD: "3" }), { code: "input_descriptor_refused" });
  const fd = fs.openSync(new URL(import.meta.url), "r");
  try { assert.throws(() => recipientStdio({ ABALONE_COUPON_FD: String(fd) }), { code: "input_descriptor_refused" }); }
  finally { fs.closeSync(fd); }
});
test("standalone incognito does not require VPN; broader preview retains its qualification refusal", async () => {
  const f = fixture();
  try {
    assert.equal(f.bundle.profile, "debug-staging-incognito-synthetic-prompts");
    f.save();
    const standalone = await preflight(f.file);
    assert.ok(!standalone.missing.some((c) => c.name === "VPN"));
    assert.ok(standalone.checks.find((c) => c.name === "VPN").result.includes("no VPN privacy"));
    f.bundle.profile = "debug-staging-synthetic-prompts"; f.save();
    const preview = await preflight(f.file);
    assert.equal(preview.missing.find((c) => c.name === "VPN").code, "vpn_not_qualified");
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("signed $5 trial explicitly carries the paired firmware exception to the recipient; default and larger approvals remain strict", () => {
  const f = fixture();
  try {
    f.save(); assert.ok(!recipientArgv(loadTrial(f.file)).includes("--allow-out-of-date-trial"));
    f.bundle.provider.policy.gatewayTcb = f.bundle.provider.policy.modelTcb = "UpToDate-or-OutOfDate-with-warning";
    f.save(); assert.ok(recipientArgv(loadTrial(f.file)).includes("--allow-out-of-date-trial"));
    f.bundle.provider.policy.modelTcb = "UpToDate"; f.save(); assert.throws(() => loadTrial(f.file));
    f.bundle.provider.policy.modelTcb = f.bundle.provider.policy.gatewayTcb;
    const pin = JSON.parse(fs.readFileSync(path.join(f.directory, "issuer-pin.json"))), signer = syntheticStagingSigner();
    const approval = signer.sign({ identityPolicySha256: pin.expectedIdentityPolicySha256, issuancePolicySha256: pin.expectedIssuancePolicySha256,
      issuerPublicKeySha256: pin.expectedIssuerPublicKeySha256, providerScopeCommitment: "cd".repeat(32), maxCouponNanoUsd: "5000000000", maxTotalNanoUsd: "5000000001" });
    f.bundle.issuer.approvalRoot = signer.rootHex;
    fs.writeFileSync(path.join(f.directory, "approval.json"), approval.bytes);
    f.save(); assert.throws(() => loadTrial(f.file), { code: "provider_not_admitted" });
    f.bundle.provider.policy.gatewayTcb = f.bundle.provider.policy.modelTcb = "UpToDate";
    f.save(); assert.ok(loadTrial(f.file), "larger approvals retain their original strict policy");
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("Base RPC-safe signed admission is disclosed before gift entry without changing model governance", async () => {
  const f = fixture();
  try {
    const pin = JSON.parse(fs.readFileSync(path.join(f.directory, "issuer-pin.json"))), signer = syntheticStagingSigner();
    const approval = signer.sign({ identityPolicySha256: pin.expectedIdentityPolicySha256, issuancePolicySha256: pin.expectedIssuancePolicySha256,
      issuerPublicKeySha256: pin.expectedIssuerPublicKeySha256, providerScopeCommitment: "cd".repeat(32), guard: syntheticBaseGuard() });
    f.bundle.issuer.approvalRoot = signer.rootHex;
    fs.writeFileSync(path.join(f.directory, "approval.json"), approval.bytes);
    f.save();
    const trial = await preflight(f.file);
    assert.match(trial.checks.find((c) => c.name === "issuer guard policy").result, /Ethereum L1 finality is not independently verified/);
    assert.deepEqual(trial.bundle.provider.policy.composeRegistry, { rpc: "https://mainnet.base.org", chainId: 8453 });
    assert.ok(!recipientArgv(trial).includes("--allow-out-of-date-trial"), "guard confirmation does not relax provider attestation");
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("pre-bearer workspace setup checks normal canaries and refuses tampering instead of resetting", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "friend-readiness-"));
  const work = path.join(directory, "work"), state = path.join(directory, "state"), runtime = path.join(directory, "run");
  for (const dir of [work, state, runtime]) fs.mkdirSync(dir, { mode: 0o700 });
  const script = `import fs from "node:fs"; import {prepareWorkspace} from ${JSON.stringify(new URL("../tools/coupon-first-use.mjs", import.meta.url).href)}; import * as canary from ${JSON.stringify(new URL("../lib/canary.mjs", import.meta.url).href)};
    prepareWorkspace(); const file = JSON.parse(fs.readFileSync(canary.record(process.cwd()))).canaries[0].file;
    prepareWorkspace(); fs.writeFileSync(file, "changed planted file");
    try { prepareWorkspace(); process.exit(7); } catch { console.log("tamper refused"); }`;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: work, env: { PATH: process.env.PATH, ABALONE_DIR: state, XDG_RUNTIME_DIR: runtime }, encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "tamper refused");
    assert.deepEqual(fs.readdirSync(runtime), [], "preflight sockets and DNS scratch are removed");
    assert.ok(!fs.existsSync(path.join(state, "keys", "trace-active")), "default setup needs no trace passphrase");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("owned-host is an explicit pinned boundary; unknown profiles and implicit fallback are refused", async () => {
  const f = fixture();
  try {
    f.bundle.platform = "linux-node24-owned-host"; f.save();
    assert.ok(recipientArgv(loadTrial(f.file)).includes("--owned-host"));
    const result = await preflight(f.file);
    assert.match(result.checks.find(c => c.name === "local boundary").result, /ordinary account.*filesystem and network access/);
    f.bundle.platform = "linux-node24-bubblewrap"; f.save();
    assert.ok(!recipientArgv(loadTrial(f.file)).includes("--owned-host"));
    f.bundle.platform = "linux-node24-auto"; f.save();
    assert.throws(() => loadTrial(f.file), { code: "bundle_invalid" });
  } finally { fs.rmSync(f.directory, {recursive:true,force:true}); }
});

test("fresh owned-host preflight needs no legacy approvals or runner-home setup", () => {
  const f = fixture(), work = path.join(f.directory,"work"), state = path.join(f.directory,"state"), runtime = path.join(f.directory,"runtime");
  for (const dir of [work,state,runtime]) fs.mkdirSync(dir,{mode:0o700});
  try {
    f.bundle.platform = "linux-node24-owned-host"; f.save();
    const script = `import fs from 'node:fs'; import {prepareWorkspace,preflight} from ${JSON.stringify(new URL("../tools/coupon-first-use.mjs",import.meta.url).href)};
      prepareWorkspace(process.cwd(),{ownedHost:true});
      if(fs.existsSync(process.env.ABALONE_DIR+'/approvals'))throw Error('unexpected legacy setup');
      const result=await preflight(${JSON.stringify(f.file)});
      const failure=result.missing.find(c=>c.name==='runtime directories');
      if(failure)throw Error('fresh owned-host directories refused');
      if(!result.ready)throw Error('fresh owned-host preflight refused');
      console.log('fresh owned-host ready without legacy directories');`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:work,env:{PATH:process.env.PATH,ABALONE_DIR:state,XDG_RUNTIME_DIR:runtime},encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'fresh owned-host ready without legacy directories');
    assert.equal(fs.existsSync(path.join(state,'approvals')),false);
    f.bundle.platform='linux-node24-bubblewrap';f.save();
    const strictScript=script.replace("if(failure)throw Error('fresh owned-host directories refused');", "if(!failure)throw Error('strict missing legacy directories accepted');").replace("if(!result.ready)throw Error('fresh owned-host preflight refused');",'');
    const strict=spawnSync(process.execPath,['--input-type=module','-e',strictScript],{cwd:work,env:{PATH:process.env.PATH,ABALONE_DIR:state,XDG_RUNTIME_DIR:runtime},encoding:'utf8',timeout:15000});
    assert.equal(strict.status,0,strict.stderr);
  } finally {fs.rmSync(f.directory,{recursive:true,force:true});}
});

test("first-use public inputs dispatch an independently pinned Mac policy and distinct signed approval", async () => {
  const { macIssuerPolicyHash } = await import("../lib/mac-coupon-issuer.mjs");
  const { canonicalCouponJson, MAC_COUPON_APPROVAL_DOMAIN } = await import("../lib/coupon-staging.mjs");
  const f = fixture();
  try {
    const oldPin = JSON.parse(fs.readFileSync(path.join(f.directory, "issuer-pin.json"))), rootPair = crypto.generateKeyPairSync("ed25519");
    const policy = { version: 1, profile: "mac-appattest-coupon-v1", app_id: "DC9JH5DRMY.dev.dsmack.provider", challenge_ttl_ms: 30000,
      max_enrollment_age_seconds: 43200, approved_measurements: [{ cdhash: "ab".repeat(32), compose_sha256: "cd".repeat(32) }], custody: "operator-kms-readable" };
    const pin = { ...oldPin, identityPolicy: policy, expectedIdentityPolicySha256: macIssuerPolicyHash(policy) };
    const payload = { ...JSON.parse(fs.readFileSync(path.join(f.directory, "approval.json"))).payload, version: 2, issuer_profile: policy.profile,
      app_id: "SYNTHETIC-Mac-runtime", cdhash: "ab".repeat(32), compose_hash: "cd".repeat(32), identity_policy_sha256: pin.expectedIdentityPolicySha256 };
    const domain = MAC_COUPON_APPROVAL_DOMAIN;
    fs.writeFileSync(path.join(f.directory, "approval.json"), canonicalCouponJson({ domain, payload, signature_hex: crypto.sign(null, Buffer.from(domain + "\0" + canonicalCouponJson(payload)), rootPair.privateKey).toString("hex") }));
    fs.writeFileSync(path.join(f.directory, "issuer-pin.json"), JSON.stringify(pin));
    f.bundle.issuer.approvalRoot = rootPair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex"); f.save();
    const loaded = loadTrial(f.file); assert.equal(loaded.approval.issuerProfile, policy.profile);
    assert.ok(recipientArgv(loaded).includes("--attested"));
    pin.identityPolicy.custody = "private-enclave"; fs.writeFileSync(path.join(f.directory, "issuer-pin.json"), JSON.stringify(pin)); assert.throws(() => loadTrial(f.file));
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test("a durable recipient-v1 trial loads its signed profile but the session-only first-use entry refuses it before any gift", () => {
  const f = fixture();
  try {
    const identity = JSON.parse(fs.readFileSync(path.join(f.directory, "issuer-pin.json")));
    const signer = syntheticStagingSigner();
    fs.writeFileSync(path.join(f.directory, "approval.json"), signer.sign({ identityPolicySha256: identity.expectedIdentityPolicySha256, issuancePolicySha256: identity.expectedIssuancePolicySha256,
      issuerPublicKeySha256: identity.expectedIssuerPublicKeySha256, providerScopeCommitment: "cd".repeat(32), deliveryProfile: "x25519-aesgcm-recipient-v1" }).bytes);
    f.bundle.issuer.approvalRoot = signer.rootHex; f.save();
    assert.equal(loadTrial(f.file).approval.deliveryProfile, "x25519-aesgcm-recipient-v1");
    const r = spawnSync(process.execPath, [path.join(root, "tools/coupon-first-use.mjs"), "preflight", "--bundle", f.file], { encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH, ABALONE_DIR: path.join(f.directory, "state") } });
    assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, /^durable_trial_refused: .*abalone credit/m);
  } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
