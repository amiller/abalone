import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { loadTrial, preflight, inspectVpn, recipientArgv, recipientStdio, firstUseNotice, FIRST_USE_SOURCE_FILES } from "../tools/coupon-first-use.mjs";
import { syntheticIssuerIdentity } from "./fixtures/coupon/issuer-v2.mjs";
import { syntheticStagingSigner } from "./fixtures/coupon/staging-signer.mjs";

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
