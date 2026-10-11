#!/usr/bin/env node
// Development source trial. This wrapper reads public inputs only; coupon entry belongs to /4.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import net from "node:net";
import { multiaddr } from "@multiformats/multiaddr";
import { ROOT, STATE, APPROVALS, RUNNER_HOME, providers, runtimeDir } from "../lib/config.mjs";
import { verified } from "../lib/manifest.mjs";
import { issuerPolicyHash } from "../lib/vendor/dstack-issuer/dstack_issuer.mjs";
import { validateCouponNearProfile, OUT_OF_DATE_TRIAL_POLICY, OUT_OF_DATE_TRIAL_NOTICE } from "../lib/coupon-near.mjs";
import { verifyCouponStagingAdmission, couponStagingGuardNotice } from "../lib/coupon-staging.mjs";
import { keyInfo } from "../lib/trace.mjs";
import * as nodekeys from "../lib/nodekeys.mjs";
import * as gift from "../lib/gift.mjs";
import * as canary from "../lib/canary.mjs";
import { piArgv } from "../lib/sandbox.mjs";
import { memoryRoot, OWNED_HOST_NOTICE } from "../lib/owned-host.mjs";

const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const hex = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const fail = (code, message) => Object.assign(new Error(message), { code });
export const FIRST_USE_SOURCE_FILES = ["tools/coupon-first-use.mjs", "bin/abalone.mjs", "lib/coupon-attested.mjs", "lib/coupon-attested-session.mjs", "lib/coupon-near.mjs", "lib/near.mjs", "lib/coupon-staging.mjs", "lib/coupon-input.mjs", "lib/coupon-socket.mjs", "lib/config.mjs", "lib/welcome.mjs", "lib/status.mjs", "lib/sandbox.mjs", "lib/owned-host.mjs", "lib/canary.mjs", "curated/abalone.ts", "curated/coupon-provider.ts", "curated/manifest.json", "package-lock.json", "pi/package-lock.json", "aci/package-lock.json", "pi/packages/coding-agent/dist/cli.js", "pi/packages/coding-agent/src/core/settings-manager.ts", "pi/packages/coding-agent/dist/core/settings-manager.js"];
function publicFile(base, name) {
  if (typeof name !== "string" || !name || path.isAbsolute(name) || name.split(/[\\/]/).includes("..")) throw fail("bundle_invalid", "Public artifact paths must be relative within the trial bundle.");
  const real = fs.realpathSync(path.resolve(base, name));
  if (!real.startsWith(fs.realpathSync(base) + path.sep)) throw fail("bundle_invalid", "Public artifact escapes the trial bundle.");
  const bytes = fs.readFileSync(real);
  if (bytes.length > 2 * 1024 * 1024) throw fail("bundle_invalid", "Public artifact exceeds the size bound.");
  return bytes;
}
export function loadTrial(file) {
  const base = path.dirname(path.resolve(file)), b = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!exact(b, ["version", "profile", "platform", "issuer", "provider", "source", "vpn"]) || b.version !== 1 || !["debug-staging-incognito-synthetic-prompts", "debug-staging-synthetic-prompts"].includes(b.profile) || !["linux-node24-bubblewrap", "linux-node24-owned-host"].includes(b.platform)) throw fail("bundle_invalid", "Use the exact Linux development trial manifest v1.");
  if (!exact(b.issuer, ["peer", "privateRoute", "pin", "approval", "approvalRoot"]) || typeof b.issuer.privateRoute !== "string" || !b.issuer.privateRoute.trim()) throw fail("issuer_inputs_missing", "Supply the approved private route, advertised issuer multiaddr, identity pin, signed approval and independent approval-root public key.");
  try { if (multiaddr(b.issuer.peer).getComponents().at(-1)?.name !== "p2p") throw new Error(); } catch { throw fail("issuer_inputs_missing", "Supply the actual advertised /p2p issuer multiaddr on the approved private route."); }
  const pin = JSON.parse(publicFile(base, b.issuer.pin));
  if (!exact(pin, ["identityPolicy", "expectedIdentityPolicySha256", "expectedIssuancePolicySha256", "expectedIssuerPublicKeySha256"]) || ![pin.expectedIdentityPolicySha256, pin.expectedIssuancePolicySha256, pin.expectedIssuerPublicKeySha256, b.issuer.approvalRoot].every(hex) || issuerPolicyHash(pin.identityPolicy) !== pin.expectedIdentityPolicySha256) throw fail("issuer_pin_refused", "Issuer policy bytes must match the independently supplied exact public pin.");
  const approval = verifyCouponStagingAdmission(publicFile(base, b.issuer.approval), { approvalRoot: b.issuer.approvalRoot, identityPolicySha256: pin.expectedIdentityPolicySha256, issuancePolicySha256: pin.expectedIssuancePolicySha256, issuerPublicKeySha256: pin.expectedIssuerPublicKeySha256 });
  if (!exact(b.provider, ["baseUrl", "model", "policy", "maxTokens"])) throw fail("provider_not_admitted", "Supply the exact strict direct NEAR profile and explicit model.");
  validateCouponNearProfile(b.provider);
  if (b.provider.policy.gatewayTcb === OUT_OF_DATE_TRIAL_POLICY && (BigInt(approval.maxCouponNanoUsd) > 5_000_000_000n || BigInt(approval.maxTotalNanoUsd) > 5_000_000_000n)) throw fail("provider_not_admitted", "The explicit OutOfDate exception is limited to a signed synthetic-only $5 trial.");
  if (b.provider.maxTokens !== 512) throw fail("provider_not_admitted", "The current recipient entrypoint pins a 512-token limit.");
  if (!exact(b.source, ["profile", "files"]) || b.source.profile !== "reviewed-development-source-v1" || !b.source.files || !FIRST_USE_SOURCE_FILES.every((name) => hex(b.source.files[name])) || !Object.entries(b.source.files).every(([name, hash]) => hex(hash) && !path.isAbsolute(name) && !name.split(/[\\/]/).includes(".."))) throw fail("source_inputs_missing", "Supply the reviewed candidate's selected source and dependency/build file hashes.");
  return { bundle: b, base, pin, approval };
}

// Read-only host observations; no API, peer dial, bearer, shell text or route mutation.
export function inspectVpn(vpn, base, command = spawnSync) {
  if (!exact(vpn, ["profile", "interface", "route4", "route6", "rulesetSha256", "qualification", "qualificationSha256"]) || typeof vpn.profile !== "string" || !vpn.profile.trim() || !/^[A-Za-z0-9_.-]{1,15}$/.test(vpn.interface) || !hex(vpn.rulesetSha256) || !hex(vpn.qualificationSha256)) throw fail("vpn_not_qualified", "VPN qualification pending: supply the reviewed existing Linux OS VPN profile, interface, IPv4/IPv6 routes, pinned lockdown ruleset, and the real traffic/VPN-drop qualification report hash. A route check alone is insufficient.");
  if (net.isIP(vpn.route4) !== 4 || net.isIP(vpn.route6) !== 6) throw fail("vpn_not_qualified", "Supply numeric IPv4 and IPv6 route observation destinations.");
  if (sha(publicFile(base, vpn.qualification)) !== vpn.qualificationSha256) throw fail("vpn_not_qualified", "The real VPN qualification report does not match its reviewed pin.");
  const observe = (exe, argv) => { const r = command(exe, argv, { encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024 }); if (r.status !== 0) throw fail("vpn_not_qualified", `Cannot inspect ${exe}; establish the reviewed VPN/lockdown profile and read permissions first.`); return r.stdout; };
  const rules = observe("nft", ["-j", "list", "ruleset"]);
  if (sha(rules) !== vpn.rulesetSha256) throw fail("vpn_not_qualified", "Observed OS lockdown rules differ from the reviewed pin. Requalify the actual profile; no direct fallback is allowed.");
  for (const [family, target] of [["-4", vpn.route4], ["-6", vpn.route6]]) {
    const routes = JSON.parse(observe("ip", [family, "-j", "route", "get", target]));
    if (!Array.isArray(routes) || !routes.length || routes.some((r) => r.dev !== vpn.interface)) throw fail("vpn_not_qualified", "Host routes do not use the pinned VPN interface.");
  }
  return "Pinned host observations match the supplied qualification report; this check does not repeat a real VPN loss test.";
}

// Preparation is local and precedes peer dial, hidden gift entry and CLAIM. Existing
// canary records are checked, never silently replaced when their planted file changed.
export function prepareWorkspace(cwd = process.cwd(), { ownedHost = false } = {}) {
  if (!fs.existsSync(canary.record(cwd))) canary.init(cwd);
  canary.forSession(cwd, false);
  if (ownedHost) { memoryRoot(); return; }
  const runtime = runtimeDir(), owner = fs.lstatSync(runtime);
  if (!owner.isDirectory() || owner.isSymbolicLink() || owner.uid !== process.getuid() || (owner.mode & 0o077)) throw fail("runtime_unavailable", "Use an owner-only runtime directory before gift entry.");
  const run = fs.mkdtempSync(path.join(runtime, "abalone-preflight-"));
  try {
    const argv = piArgv(run, [], cwd, { incognito: true });
    const result = spawnSync("bwrap", [...argv, "--", process.execPath, "-e", "process.exit(0)"], { stdio: "pipe", timeout: 5000 });
    if (result.status !== 0) throw fail("sandbox_unavailable", "The complete incognito mount and runtime preparation failed before gift entry.");
  } finally { fs.rmSync(run, { recursive: true, force: true }); }
}
function checkSource(trial) {
  for (const [name, hash] of Object.entries(trial.bundle.source.files)) if (sha(fs.readFileSync(path.join(ROOT, name))) !== hash) throw fail("source_mismatch", `Reviewed candidate hash mismatch: ${name}`);
  verified();
}
export async function preflight(file, { keepTrace = false } = {}) {
  const trial = loadTrial(file), checks = [], missing = [];
  const check = (name, fn) => { try { checks.push({ name, result: fn() ?? "ready" }); } catch (e) { missing.push({ name, code: e.code ?? "preflight_failed", message: e.code ? e.message : `${name} is unavailable or invalid; repair it before gift entry.` }); } };
  check("issuer guard policy", () => couponStagingGuardNotice(trial.approval.guard) || "Legacy Ethereum Sepolia signed issuer policy; the recipient does not independently verify chain state.");
  check("supported OS", () => { if (process.platform !== "linux" || Number(process.versions.node.split(".")[0]) !== 24) throw fail("unsupported_profile", "This trial requires Linux Node 24 and the explicitly selected local boundary. Native macOS recipient parity is not qualified."); });
  check("ambient configuration", () => { if ((process.env.ABALONE_CONFIG && path.resolve(process.env.ABALONE_CONFIG) !== ROOT) || process.env.NODE_OPTIONS || process.env.ABALONE_NO_CANARIES) throw fail("ambient_configuration_refused", "Remove alternate ABALONE_CONFIG/NODE_OPTIONS/ABALONE_NO_CANARIES before this pinned source trial."); });
  check("local boundary", () => { if (trial.bundle.platform === "linux-node24-owned-host") { memoryRoot(); return OWNED_HOST_NOTICE; } if (spawnSync("bwrap", ["--unshare-all", "--ro-bind", "/", "/", "--", "/usr/bin/true"], { stdio: "pipe", timeout: 5000, env: { PATH: process.env.PATH } }).status !== 0) throw fail("sandbox_unavailable", "Establish a working bubblewrap user/network namespace before gift entry."); runtimeDir(); });
  check("candidate source", () => checkSource(trial));
  check("curated Pi/ACI closure", () => { verified(); });
  if (keepTrace) check("trace key", () => { if (!keyInfo()) throw fail("trace_key_missing", "Run ./bin/abalone trace key init before gift entry."); });
  check("local workspace", () => { canary.forSession(process.cwd(), false); });
  check("runtime directories", () => { const dirs = trial.bundle.platform === "linux-node24-owned-host" ? [STATE, memoryRoot(), runtimeDir()] : [STATE, APPROVALS, RUNNER_HOME, runtimeDir()]; for (const dir of dirs) if (!fs.statSync(dir).isDirectory()) throw fail("runtime_unavailable", "Prepare local runtime directories before gift entry."); });
  check("credential slot", () => { const p = providers(); if (gift.coupon() || nodekeys.load().keys.some((k) => ["near", "nearai"].includes(k.provider)) || Object.keys(process.env).some((k) => /^(NEAR.*(?:KEY|TOKEN)|ABALONE_COUPON_(?:SOCKET|MODEL))$/.test(k) && process.env[k]) || p.admitted.some((a) => ["near", "nearai"].includes(a.id) && process.env[a.keyEnv])) throw fail("credential_slot_occupied", "Use a fresh session profile without an existing gift, NEAR credential or coupon socket."); });
  check("VPN", () => trial.bundle.profile === "debug-staging-incognito-synthetic-prompts" && trial.bundle.vpn === null
    ? "Not selected for standalone incognito; no VPN privacy or qualification is claimed."
    : inspectVpn(trial.bundle.vpn, trial.base));
  return { ...trial, checks, missing, ready: missing.length === 0 };
}
export const firstUseNotice = "Debug staging trial: use synthetic, non-sensitive prompts only. The operator may know, use or revoke the API key. Direct attested NEAR model transport is admitted separately; the issuer is not a prompt relay. Private issuer custody, rollback and settlement are unqualified. Incognito defaults to session-only conversation retention; --keep-trace explicitly retains an encrypted trace; it does not provide OS/VPN anonymity or erase workspace files.";
export function recipientArgv(trial, { keepTrace = false } = {}) {
  const { bundle: b, base } = trial;
  return [path.join(ROOT, "bin/abalone.mjs"), "coupon-session", "--attested", "--peer", b.issuer.peer, "--issuer-pin", path.resolve(base, b.issuer.pin), "--staging-approval", path.resolve(base, b.issuer.approval), "--approval-root", b.issuer.approvalRoot, "--model", `near/${b.provider.model}`, "--incognito", ...(b.platform === "linux-node24-owned-host" ? ["--owned-host"] : []), ...(keepTrace ? ["--keep-trace"] : []), ...(b.provider.policy.gatewayTcb === OUT_OF_DATE_TRIAL_POLICY ? ["--allow-out-of-date-trial"] : [])];
}
export function recipientStdio(env = process.env) {
  const stdio = ["inherit", "inherit", "inherit"], seen = new Set();
  for (const name of ["ABALONE_COUPON_FD", "ABALONE_COUPON_CONSENT_FD", "ABALONE_PASSPHRASE_FD"]) {
    if (env[name] === undefined) continue;
    if (!/^[0-9]+$/.test(env[name]) || Number(env[name]) < 3 || Number(env[name]) > 63 || seen.has(Number(env[name]))) throw fail("input_descriptor_refused", "Secret input descriptors must be distinct descriptors 3 through 63.");
    const fd = Number(env[name]); seen.add(fd);
    if (name === "ABALONE_COUPON_FD" && !/^pipe:\[[0-9]+\]$/.test(fs.readlinkSync(`/proc/self/fd/${fd}`))) throw fail("input_descriptor_refused", "Gift automation requires a dedicated anonymous pipe; the normal entry is hidden terminal input.");
    while (stdio.length <= fd) stdio.push("ignore");
    stdio[fd] = fd;
  }
  return stdio;
}
async function main(argv) {
  const keepTrace = argv.at(-1) === "--keep-trace";
  if (keepTrace) argv = argv.slice(0, -1);
  if (argv.length !== 3 || !["preflight", "run"].includes(argv[0]) || argv[1] !== "--bundle" || !path.isAbsolute(argv[2])) throw fail("usage", "Usage: node tools/coupon-first-use.mjs {preflight|run} --bundle /ABS/trial.json [--keep-trace]");
  // Validate signed public inputs/source before creating any local workspace records.
  checkSource(loadTrial(argv[2]));
  if (argv[0] === "run") {
    prepareWorkspace(process.cwd(), { ownedHost: loadTrial(argv[2]).bundle.platform === "linux-node24-owned-host" });
    if (keepTrace && !keyInfo()) {
      const init = spawn(process.execPath, [path.join(ROOT, "bin/abalone.mjs"), "trace", "key", "init"], { stdio: recipientStdio(), env: { ...process.env } });
      const code = await new Promise((resolve, reject) => { init.once("error", reject); init.once("exit", resolve); });
      if (code !== 0) throw fail("trace_key_missing", "Encrypted trace setup was not completed; no gift was read.");
    }
  }
  const trial = await preflight(argv[2], { keepTrace });
  for (const c of trial.checks) process.stderr.write(`${c.name}: ${c.result}\n`);
  for (const c of trial.missing) process.stderr.write(`${c.code}: ${c.message}\n`);
  if (!trial.ready) { process.exitCode = 2; return; }
  process.stderr.write(`${firstUseNotice}\n`);
  if (trial.bundle.provider.policy.gatewayTcb === OUT_OF_DATE_TRIAL_POLICY) process.stderr.write(`${OUT_OF_DATE_TRIAL_NOTICE}\n`);
  if (argv[0] === "preflight") return;
  // The public profile is pinned to the recipient defaults; bearer entry remains hidden.
  const child = spawn(process.execPath, recipientArgv(trial, { keepTrace }), { stdio: recipientStdio(), env: { ...process.env } });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e.code ?? "preflight_failed"}: ${e.code ? e.message : "Trial inputs are missing or invalid; no gift was read or sent."}\n`); process.exitCode = 2; });
