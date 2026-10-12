// abalone: Pi locked down. Plain `abalone` is the front door: it opens the saved credit's session, or with none takes a pasted
// gift through inspect, consent and redeem into one; `abalone help` lists every subcommand.
// The older sandboxed session (providers.json models, canaries) is `abalone sandbox [folder] [Pi options]`.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { place, ROOT, STATE, AGENT_DIR, LOOPBACK, admittedHosts, localPorts, providers, CFG, RUNNER_HOME, runtimeDir, log } from "../lib/config.mjs";
import * as upstream from "../lib/upstream.mjs";
import { verified, admit } from "../lib/manifest.mjs";
import { download } from "../lib/fetch.mjs";
import { torTransport } from "../lib/tor.mjs";
import { startEgress } from "../lib/egress.mjs";
import { browserBridge } from "../lib/browser.mjs";
import { history } from "../lib/ui/tool-display.mjs";
import { piArgv } from "../lib/sandbox.mjs";
import { memoryRoot, memoryRun, ownedHostEnvironment, OWNED_HOST_NOTICE } from "../lib/owned-host.mjs";
import * as keys from "../lib/keys.mjs";
import * as gift from "../lib/gift.mjs";
import * as consent from "../lib/consent/index.mjs";
import * as p2p from "../lib/p2p.mjs";
import { GIFT, saveLeft } from "../lib/peer.mjs";
import { ask, notebook, showEvidence } from "../lib/private-work.mjs";
import { runRunner } from "../lib/runner.mjs";
import * as approvals from "../lib/approvals.mjs";
import * as canary from "../lib/canary.mjs";
import { separateUser } from "../lib/setup.mjs";
import { report } from "../lib/report.mjs";
import * as trace from "../lib/trace.mjs";
import * as task from "../lib/commission.mjs";
import { admitCouponSessionIssuer, openCouponSession } from "../lib/coupon-session.mjs";
import { couponEntry } from "../lib/coupon-input.mjs";
import { admitAttestedCouponIssuerPin, admitAttestedCouponSessionIssuer, openAttestedCouponSession, readAttestedCouponAdmissionFile,
  ATTESTED_COUPON_WAIT, ATTESTED_COUPON_RECOVER } from "../lib/coupon-attested-session.mjs";
import { couponStagingGuardNotice } from "../lib/coupon-staging.mjs";
import { createCreditManager } from "../lib/credit.mjs";
import { couponNearFirmwareAdvisories, OUT_OF_DATE_TRIAL_NOTICE } from "../lib/coupon-near.mjs";
import { couponInput, creditId, creditPreflight, giftPaste, readPrivate } from "../lib/credit-store.mjs";

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const PEER = () => flag("--peer", process.env.ABALONE_PEER);
let couponSlot = null;

const CREDIT_OPTIONS = { inspect: ["--trial", "--stdin", "--input-file"], redeem: ["--trial", "--stdin", "--input-file", "--accept-offer"],
  recover: ["--credit"], status: ["--credit"], session: ["--credit", "--mode"], forget: ["--credit", "--force"] };
// Never echo an argument that may hold a gift code: any 43+ character base64url run, or a gift link.
const giftLike = (v) => /[A-Za-z0-9_-]{43}/.test(v) || v.includes("#code=");
const shown = (v) => giftLike(v) ? "(not shown: it looks like a gift code, and gift codes never belong in command arguments)" : JSON.stringify(v);
const absolute = (key, what) => (v) => path.isAbsolute(v) ? null : giftLike(v) ? `${key} needs the full path to ${what}, not the gift code itself; gift codes never belong in command arguments.`
  : `${key} path must be absolute: ${v}. Give the full path to ${what}, for example ${key} ${JSON.stringify(path.resolve(v))}.`;
const CREDIT_VALUES = { "--trial": absolute("--trial", "trial.json, as printed by the installer"), "--input-file": absolute("--input-file", "the private 0600 file holding your gift code or link"),
  "--credit": (v) => /^[0-9a-f]{64}$/.test(v) ? null : "--credit needs a 64-character credit id; abalone credit status lists them.",
  "--accept-offer": (v) => /^[0-9a-f]{64}$/.test(v) ? null : "--accept-offer needs the 64-character offerHash printed by abalone credit inspect.",
  "--mode": (v) => v === "rpc" ? null : "--mode accepts only rpc; leave it out for the interactive session." };
// Only these codes carry static messages (argument errors may repeat a non-secret path); anything else is reported without raw detail.
const CREDIT_CODES = new Set(["credit_usage", "credit_store_refused", "credit_provider_unsupported", "credit_record_refused", "credit_locked", "credit_intent_required", "credit_offer_refused",
  "credit_admission_changed", "credit_profile_refused", "credit_redemption_incomplete", "credit_unavailable", "coupon_input_refused", "claim_not_reserved",
  "credit_not_claimed", "claim_pending", "claim_expired", "credit_flock_unavailable", "credit_input_refused", "credit_workspace_refused", "credit_runtime_refused",
  "reconciliation_required", "credential_refused", "staging_approval_expired", "issuer_unverified", "bundle_invalid", "issuer_inputs_missing",
  "issuer_pin_refused", "credit_claim_in_progress", "credit_kind_mismatch", "provider_not_admitted", "source_inputs_missing"]);
// A failed local setup step reports what to repair without raw paths or exception text.
const creditStep = (code, message, fn) => { try { return fn(); } catch { throw Object.assign(new Error(message), { code }); } };
const creditArg = (message) => Object.assign(new Error(message), { code: "credit_usage" });
const creditUsage = () => creditArg("abalone credit takes one of: inspect, redeem, recover, status, session, forget. Usage: abalone credit inspect --trial /abs/trial.json (--stdin | --input-file /abs/private-file); credit redeem (same) --accept-offer <offerHash>; credit recover --credit <id>; credit status [--credit <id>]; credit session --credit <id> [--mode rpc]; credit forget --credit <id> [--force]. Gift codes and keys never belong in command arguments.");

async function creditCmd(action = creditAction) {
  let next;
  try { next = await action(); }
  catch (e) { throw new Error(CREDIT_CODES.has(e?.code) ? e.message : "Credit command failed; details withheld. Run abalone credit status; original keys are never replaced."); }
  if (next) return next();
}

async function creditAction() {
  const command = args[1], allowed = CREDIT_OPTIONS[command], values = {};
  if (!Object.hasOwn(CREDIT_OPTIONS, command)) throw creditUsage();
  for (let i = 2; i < args.length; i++) {
    const key = args[i];
    if (!allowed.includes(key)) throw creditArg(Object.hasOwn(CREDIT_VALUES, key) || ["--stdin", "--force"].includes(key) ? `credit ${command} does not take ${key}. Options: ${allowed.join(", ")}.`
      : `Unexpected argument ${shown(key)} for credit ${command}. Options: ${allowed.join(", ")}. Gift codes go in a private file (--input-file) or a pipe (--stdin).`);
    if (Object.hasOwn(values, key)) throw creditArg(`${key} was given twice; give it once.`);
    if (key === "--stdin" || key === "--force") { values[key] = true; continue; }
    const value = args[++i];
    if (typeof value !== "string") throw creditArg(`${key} needs a value.`);
    const wrong = CREDIT_VALUES[key](value);
    if (wrong) throw creditArg(wrong);
    values[key] = value;
  }
  const manager = createCreditManager({ directory: path.join(STATE, "credit") });
  if (command === "status") return void console.log(JSON.stringify(await manager.status(values["--credit"]), null, 2));
  const needCredit = () => { if (!values["--credit"]) throw creditArg(`credit ${command} needs --credit <id>; abalone credit status lists saved credit ids.`); };
  if (command === "recover") {
    needCredit();
    creditPreflight();
    return void console.log(JSON.stringify(await manager.redeem(values["--credit"], { recover: true }), null, 2));
  }
  if (command === "forget") {
    needCredit();
    creditPreflight();
    manager.forget(values["--credit"], { force: !!values["--force"] });
    return void console.log(`Forgot credit ${values["--credit"]}: its saved record and lock file were removed.
The provider credential was NOT revoked. It stays valid at the provider until it expires or the sponsor or issuer's operator revokes it; revoking would be a request to the issuer that delivered it, which Abalone does not support yet.`);
  }
  if (command === "session") {
    needCredit();
    if (process.platform !== "linux" || gift.coupon()) throw Object.assign(new Error("Saved credit sessions need Linux owned-host incognito and no active routed gift; nothing was replaced."), { code: "credit_unavailable" });
    couponSlot = await manager.session(values["--credit"]);
    creditStep("credit_runtime_refused", "The curated runtime or owned-host runtime directories did not verify. Reinstall the reviewed release; nothing was sent.", () => { verified(); runtimeDir(); memoryRoot(); });
    process.stderr.write(`${OWNED_HOST_NOTICE}\n`);
    // The admission's own firmware line (lib/coupon-near.mjs) reports the OutOfDate condition once; inspect and status keep the notice; /coupon shows the admission's firmware and advisories line.
    console.error(["Saved credit:", ...couponSlot.info().disclosures.filter((d) => d !== OUT_OF_DATE_TRIAL_NOTICE), "Fresh incognito conversation; the saved credit remains available after close."].join("\n"));
    // No decoy file: canaries guard the disclosure filter, which a credit session does not use.
    args.splice(0, args.length, "--incognito", "--owned-host", "--no-canaries", "--model", `${couponSlot.provider.provider}/${couponSlot.provider.model}`,
      ...(values["--mode"] ? ["--mode", "rpc"] : []));
    return session;
  }
  if (!values["--trial"]) throw creditArg(`credit ${command} needs --trial /abs/trial.json; the installer printed its full path.`);
  if (!!values["--stdin"] === !!values["--input-file"]) throw creditArg("Give the gift code exactly one way: --input-file /abs/private-file, or --stdin from a pipe.");
  if (command === "redeem" && !values["--accept-offer"]) throw creditArg("credit redeem needs --accept-offer <offerHash>; run credit inspect first and review the offer it prints.");
  if (values["--stdin"] && process.stdin.isTTY) throw Object.assign(new Error("--stdin reads a pipe only, so a typed gift code is never echoed. At a terminal, save the code or link in a private 0600 file and use --input-file; nothing was claimed."), { code: "credit_input_refused" });
  creditPreflight();
  const admission = await trialAdmission(values["--trial"]);
  let input;
  if (values["--input-file"]) input = creditStep("credit_input_refused", "--input-file must be a regular file you own with mode 0600 (chmod 600 it), holding only the gift code or redeem link; nothing was claimed.", () => readPrivate(values["--input-file"], 2048).toString());
  else {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 2048) throw creditArg("The gift input is longer than 2048 bytes; pipe only the gift code or redeem link. Nothing was claimed."); chunks.push(chunk); }
    input = Buffer.concat(chunks).toString();
  }
  const coupon = couponInput(input);
  const offer = await manager.inspect(coupon, admission);
  if (command === "inspect") return void console.log(JSON.stringify(offer, null, 2));
  if (values["--accept-offer"] !== offer.offerHash) throw Object.assign(new Error("The accepted hash is not this offer's hash. Review credit inspect's nominal amount, sponsor powers and synthetic-only policy; nothing was claimed."), { code: "credit_intent_required" });
  console.log(JSON.stringify(await manager.redeem(creditId(coupon), { offerHash: values["--accept-offer"] }), null, 2));
}

async function trialAdmission(file) {
  const { loadTrial } = await import("../tools/coupon-first-use.mjs");
  const trial = loadTrial(file);
  return { peer: trial.bundle.issuer.peer, pin: trial.pin, approval: fs.readFileSync(path.join(trial.base, trial.bundle.issuer.approval)).toString("base64"),
    approvalRoot: trial.bundle.issuer.approvalRoot, provider: trial.bundle.provider };
}

async function couponSessionCmd() {
  args.shift();
  const attested = args.includes("--attested");
  const peerAddr = PEER(), experimental = !attested && args.includes("--experimental-local");
  if (experimental) args.splice(args.indexOf("--experimental-local"), 1);
  if (attested) { args.splice(args.indexOf("--attested"), 1); return attestedCouponSessionCmd(peerAddr); }
  const p = providers();
  // Separate issuer adapter: peer authentication is not approved issuance code.
  admitCouponSessionIssuer({ experimental, peerAddr, admit: p.peers?.admit });
  const seen = new Set();
  for (let n = 0; n < args.length; n++) {
    const a = args[n];
    if (seen.has(a)) throw new Error("Duplicate coupon-session options are refused. Nothing was claimed.");
    seen.add(a);
    if (a === "--model") { if (!args[++n]?.startsWith("synthetic-near/")) throw new Error("Select an admitted synthetic model. Nothing was claimed."); }
    else if (a === "--mode") { if (args[++n] !== "rpc") throw new Error("The only automated coupon-session mode is RPC. Nothing was claimed."); }
    else if (!["--incognito", "--keep-trace", "--no-canaries"].includes(a)) throw new Error("Coupon-session accepts only --peer, --model, --experimental-local, --incognito, --no-canaries and --mode rpc. Never put a coupon in command arguments. Nothing was claimed.");
  }
  const i = args.indexOf("--model"), selected = i >= 0 && args[i + 1];
  if (!selected?.startsWith("synthetic-near/")) throw new Error("Select an admitted synthetic model: --model synthetic-near/<model>. Nothing was claimed.");
  if (args.some((a) => ["--resume", "-r", "--continue", "-c", "--session", "--with-trace", "--api-key", "-e", "--extension", "--skill"].includes(a))) throw new Error("Coupon sessions cannot resume another session or load extra code. Retained credential recovery is not implemented; nothing was claimed.");
  if (args.some((a) => REFUSED.has(a))) throw new Error("This coupon session refuses flags that change ambient resources. Nothing was claimed.");
  await prepareRetention();
  canary.forSession(process.cwd(), args.includes("--no-canaries") || process.env.ABALONE_NO_CANARIES === "1");
  if (gift.coupon()) throw new Error("An existing routed gift is active. Nothing was replaced or claimed; use a fresh synthetic profile.");
  verified();
  runtimeDir();
  if (process.platform !== "linux" || spawnSync("bwrap", ["--version"], { stdio: "pipe" }).status !== 0) throw new Error("This synthetic session requires the Linux sandbox installed before claim. Nothing was claimed.");
  couponSlot = await openCouponSession({ peerAddr, admit: p.peers.admit, config: p, model: selected.slice("synthetic-near/".length), experimental,
    occupied: keys.list().some((k) => k.provider === "synthetic-near"), ambient: !!process.env.SYNTHETIC_COUPON_API_KEY || !!process.env.ABALONE_COUPON_SOCKET });
  const code = await couponEntry("ABALONE_COUPON_FD", "Paste the synthetic coupon (hidden; not a command argument): ", true);
  const offer = await couponSlot.inspect(code);
  process.stderr.write(`${offer.text}\n`);
  const consent = await couponEntry("ABALONE_COUPON_CONSENT_FD", "Type CLAIM SESSION ONLY to accept this offer, or Enter to cancel: ");
  if (consent !== "CLAIM SESSION ONLY") { await couponSlot.close(); couponSlot = null; process.stderr.write("Cancelled. Nothing was claimed or installed.\n"); return; }
  try { await couponSlot.claim({ offerHash: offer.offerHash, consent }); }
  catch (e) {
    process.stderr.write(`${e.message}\n`);
    const retry = await couponEntry("ABALONE_COUPON_CONSENT_FD", "Type RETRY SAME KEYS for same-process recovery, or Enter to stop (keys will be lost): ");
    await couponSlot.recover({ consent: retry });
  }
  process.stderr.write("Installed a synthetic credential for this process only. Inference uses the local provider socket, not dsmack. Balance and provider expiry remain unknown. /coupon shows state; /coupon forget closes this process.\n");
  await session();
}

// abalone coupon-session --attested --peer <issuer multiaddr> --issuer-pin <file>
//   (--fixture-local --model synthetic-near/<model>  |  --staging-approval <file> --approval-root <hex> --model near/<model>)
//   [--incognito] [--no-canaries] [--mode rpc]. Version 4: issuer discovery and fresh identity
// verification, asynchronous claim, encrypted delivery, and the scoped provider-use broker.
async function attestedCouponSessionCmd(peerAddr) {
  const p = providers();
  if (args.some((a) => ["--resume", "-r", "--continue", "-c", "--session", "--with-trace", "--api-key", "-e", "--extension", "--skill"].includes(a))) throw new Error("Coupon sessions cannot resume another session or load extra code. Retained credential recovery is not implemented; nothing was claimed.");
  if (args.some((a) => REFUSED.has(a))) throw new Error("This coupon session refuses flags that change ambient resources. Nothing was claimed.");
  if (args.includes("--experimental-local")) throw new Error("--experimental-local is the version 3 profile; the attested session takes --fixture-local or --staging-approval. Nothing was claimed.");
  const seen = new Set();
  let profile, approvalFile, approvalRoot, issuerPinFile, model, allowOutOfDateTrial = false;
  for (let n = 0; n < args.length; n++) {
    const a = args[n];
    if (seen.has(a)) throw new Error("Duplicate coupon-session options are refused. Nothing was claimed.");
    seen.add(a);
    const value = () => { if (!args[n + 1] || args[n + 1].startsWith("--")) throw new Error(`${a} needs a value. Nothing was claimed.`); return args[++n]; };
    if (a === "--fixture-local") { if (profile) throw new Error("Choose exactly one attested profile. Nothing was claimed."); profile = "fixture-local"; }
    else if (a === "--staging-approval") { if (profile) throw new Error("Choose exactly one attested profile. Nothing was claimed."); profile = "debug-staging"; approvalFile = value(); }
    else if (a === "--allow-out-of-date-trial") allowOutOfDateTrial = true;
    else if (a === "--approval-root") approvalRoot = value();
    else if (a === "--issuer-pin") issuerPinFile = value();
    else if (a === "--model") model = value();
    else if (a === "--mode") { if (value() !== "rpc") throw new Error("The only automated coupon-session mode is RPC. Nothing was claimed."); }
    else if (!["--incognito", "--keep-trace", "--no-canaries", "--owned-host"].includes(a)) throw new Error("An attested coupon session accepts only --peer, --attested, --fixture-local, --staging-approval <file>, --approval-root <hex>, --issuer-pin <file>, --model, --allow-out-of-date-trial, --incognito, --no-canaries and --mode rpc. Never put a coupon in command arguments. Nothing was claimed.");
  }
  if (!profile) throw new Error("An attested coupon session needs a profile: --fixture-local (synthetic loopback issuer), or --staging-approval <file> --approval-root <hex> (signed debug staging). Nothing was claimed.");
  if (allowOutOfDateTrial && profile !== "debug-staging") throw new Error("--allow-out-of-date-trial is available only with signed synthetic debug staging. Nothing was claimed.");
  if (allowOutOfDateTrial) process.stderr.write("WARNING: Explicit synthetic, non-sensitive $5 trial accepts verified gateway and model OutOfDate firmware/advisories. All cryptographic checks remain required. Actual verified status/advisories will be shown before provider use; private guarantees are not qualified.\n");
  if (profile === "debug-staging" && (!approvalFile || !approvalRoot)) throw new Error("The debug-staging profile needs both --staging-approval <file> and --approval-root <hex>. Nothing was claimed.");
  if (profile === "fixture-local" && (approvalFile || approvalRoot)) throw new Error("The fixture-local profile takes no staging approval; use --staging-approval for the debug-staging profile. Nothing was claimed.");
  if (!issuerPinFile) throw new Error("An attested coupon session needs --issuer-pin <file>: the issuer identity policy and the three pinned hashes. Nothing was claimed.");
  if (approvalRoot !== undefined && !/^[0-9a-f]{64}$/.test(approvalRoot)) throw new Error("--approval-root must be the 64-hex-char Ed25519 public key of the approval authority you pinned. Nothing was claimed.");
  const prefix = profile === "fixture-local" ? "synthetic-near/" : "near/";
  if (typeof model !== "string" || !model.startsWith(prefix)) throw new Error(profile === "fixture-local" ? "Select the admitted synthetic model: --model synthetic-near/<model>. Nothing was claimed." : "Select the near model explicitly: --model near/<model>. Nothing was claimed.");
  await prepareRetention();
  canary.forSession(process.cwd(), args.includes("--no-canaries") || process.env.ABALONE_NO_CANARIES === "1");
  if (gift.coupon()) throw new Error("An existing routed gift is active. Nothing was replaced or claimed; use a fresh profile.");
  verified();
  runtimeDir();
  if (args.includes("--owned-host")) {
    if (!args.includes("--incognito") || process.platform !== "linux") throw new Error("--owned-host requires Linux incognito. Nothing was claimed.");
    memoryRoot(); process.stderr.write(`${OWNED_HOST_NOTICE}\n`);
  } else if (process.platform !== "linux" || spawnSync("bwrap", ["--version"], { stdio: "pipe" }).status !== 0) throw new Error("This coupon session requires the Linux sandbox installed before claim. Nothing was claimed.");
  // Everything admission-related is checked and read before any coupon is entered or sent.
  let pin;
  try { pin = admitAttestedCouponIssuerPin(JSON.parse(readAttestedCouponAdmissionFile(issuerPinFile, 262_144).toString("utf8"))); }
  catch (e) { throw new Error(e.code === "issuer_pin_refused" || e.code === "admission_file_refused" ? e.message : `The issuer pin file must be the exact JSON pin object. Nothing was claimed.`); }
  const stagingApproval = profile === "debug-staging" ? { bytes: readAttestedCouponAdmissionFile(approvalFile, 65_536), approvalRoot } : undefined;
  const slotProvider = profile === "fixture-local" ? "synthetic-near" : "nearai";
  const nearKeyEnv = p.admitted?.find((a) => a.id === "nearai")?.keyEnv;
  const poll = Number(process.env.ABALONE_COUPON_POLL_MS ?? 30_000);
  admitAttestedCouponSessionIssuer({ profile, peerAddr, admit: p.peers?.admit, issuerPin: pin, stagingApproval, allowOutOfDateTrial, model: model.slice(prefix.length),
    config: p, ...(profile === "fixture-local" ? { syntheticQuoteVerifier: async (hex) => JSON.parse(Buffer.from(hex, "hex").toString()) } : {}),
    occupied: keys.list().some((k) => k.provider === slotProvider),
    ambient: profile === "fixture-local" ? !!process.env.SYNTHETIC_COUPON_API_KEY || !!process.env.ABALONE_COUPON_SOCKET : !!process.env.ABALONE_COUPON_SOCKET || !!(nearKeyEnv && process.env[nearKeyEnv]) });
  couponSlot = await openAttestedCouponSession({ peerAddr, admit: p.peers?.admit, profile, issuerPin: pin, stagingApproval, allowOutOfDateTrial, model: model.slice(prefix.length), config: p,
    ...(profile === "fixture-local" ? { syntheticQuoteVerifier: async (hex) => JSON.parse(Buffer.from(hex, "hex").toString()) } : {}),
    occupied: keys.list().some((k) => k.provider === slotProvider),
    ambient: profile === "fixture-local" ? !!process.env.SYNTHETIC_COUPON_API_KEY || !!process.env.ABALONE_COUPON_SOCKET : !!process.env.ABALONE_COUPON_SOCKET || !!(nearKeyEnv && process.env[nearKeyEnv]),
    ...(Number.isSafeInteger(poll) && poll >= 1000 && poll <= 600_000 ? { pollRoundMs: poll } : {}) });
  const guardNotice = couponStagingGuardNotice(couponSlot.stagingAdmission?.guard);
  if (guardNotice) process.stderr.write(`${guardNotice}\n`);
  const code = await couponEntry("ABALONE_COUPON_FD", "Paste the coupon (hidden; not a command argument): ", true);
  const offer = await couponSlot.inspect(code);
  process.stderr.write(`${offer.text}\n`);
  const consent = await couponEntry("ABALONE_COUPON_CONSENT_FD", `Type ${couponSlot.admission.consent} to accept this offer, or Enter to cancel: `);
  if (consent !== couponSlot.admission.consent) { await couponSlot.close(); couponSlot = null; process.stderr.write("Cancelled. Nothing was claimed or installed.\n"); return; }
  const stopKeys = async (message) => { await couponSlot.close(); couponSlot = null; process.stderr.write(message); process.exit(1); };
  let action = () => couponSlot.claim({ offerHash: offer.offerHash, consent });
  for (;;) {
    try { await action(); break; }
    catch (e) {
      if (e.code === "reconciliation_required") await stopKeys("Issuance requires operator reconciliation. Nothing was installed; an earlier provider effect may still exist. This session has closed and its original keys are gone. Restarting cannot recover its delivery. Ask the issuer's operator to reconcile; do not retry or claim a replacement.\n");
      process.stderr.write(`${e.message}\n`);
      if (e.code === "claim_pending" || e.code === "claim_cancelled") {
        const wait = await couponEntry("ABALONE_COUPON_CONSENT_FD", `Type ${ATTESTED_COUPON_WAIT} to keep polling with the original keys, or Enter to stop (the claim stays unresolved; leaving loses this process's keys): `);
        if (wait !== ATTESTED_COUPON_WAIT) await stopKeys("Stopped waiting. The issuer's job may still deliver, but only this process's original keys could receive it, and they are now gone. Ask the issuer's operator to reconcile; do not claim a replacement with new keys.\n");
        action = () => couponSlot.resume({ consent: wait });
        continue;
      }
      if (e.code === "claim_uncertain" || e.code === "claim_not_reserved") {
        const retry = await couponEntry("ABALONE_COUPON_CONSENT_FD", `Type ${ATTESTED_COUPON_RECOVER} for same-process recovery, or Enter to stop (keys will be lost): `);
        if (retry !== ATTESTED_COUPON_RECOVER) await stopKeys("Stopped. The original claim's outcome is unknown and this process's keys are gone. Ask the issuer's operator to reconcile; do not claim a replacement with new keys.\n");
        action = () => couponSlot.recover({ consent: retry });
        continue;
      }
      throw e;
    }
  }
  const expiry = couponSlot.info().providerExpiry, unknowns = expiry === "unknown" ? "Balance and provider expiry remain unknown." : `Balance remains unknown; the provider key expires ${expiry}.`;
  process.stderr.write(profile === "debug-staging"
    ? `Installed the delivered credential for this process only, under the signed debug-staging admission (operator secret access; not private issuance; synthetic-only prompts). Inference uses the local provider socket through the selected NEAR policy; the explicit trial exception is disclosed when selected. ${unknowns} /coupon shows state; /coupon forget closes this process.\n`
    : `Installed the attested fixture credential for this process only. Inference uses the local provider socket, not dsmack. ${unknowns} /coupon shows state; /coupon forget closes this process.\n`);
  // Admission flags belong to the launcher. Pi receives only its selected socket provider/model.
  const sessionArgs = ["--model", `${couponSlot.provider.provider}/${couponSlot.provider.model}`];
  for (const flag of ["--incognito", "--keep-trace", "--no-canaries", "--owned-host"]) if (args.includes(flag)) sessionArgs.push(flag);
  if (args.includes("--mode")) sessionArgs.push("--mode", "rpc");
  args.splice(0, args.length, ...sessionArgs);
  await session();
}

// A passphrase: from the terminal (hidden), or, for automation, from the file descriptor in ABALONE_PASSPHRASE_FD.
async function passphrase(prompt) {
  if (process.env.ABALONE_PASSPHRASE_FD) return fs.readFileSync(Number(process.env.ABALONE_PASSPHRASE_FD), "utf8").split("\n")[0];
  if (!process.stdin.isTTY) throw new Error("no terminal to ask for the trace key passphrase (or set ABALONE_PASSPHRASE_FD)");
  // Read by a child, so this process never consumes stdin that the session (Pi) inherits next.
  return spawnSync("bash", ["-c", 'IFS= read -rs -p "$1" p; echo >&2; printf %s "$p"', "_", prompt], { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" }).stdout;
}

async function readSecret(prompt) {
  if (process.stdin.isTTY) { process.stderr.write(prompt); spawnSync("stty", ["-echo"], { stdio: "inherit" }); }
  let s = "";
  for await (const chunk of process.stdin) { s += chunk; if (process.stdin.isTTY && s.includes("\n")) break; }
  if (process.stdin.isTTY) { spawnSync("stty", ["echo"], { stdio: "inherit" }); process.stderr.write("\n"); }
  return s.split("\n")[0];
}

// abalone key add <provider> [--label l] [--input-file /abs/0600-file] | key list | key forget <provider> [--label l].
// The key comes from hidden stdin or a private file, never from arguments. A provider's newest key is the one used.
async function keyCmd() {
  const label = flag("--label"), file = flag("--input-file"), [, cmd, prov, extra] = args;
  if (cmd === "add" && prov && !extra) {
    let key;
    if (file) try { key = readPrivate(file, 4096).toString(); } catch { throw new Error("--input-file must be a regular file you own with mode 0600 (chmod 600 it), holding only the key."); }
    else key = await readSecret(`paste the ${prov} API key (hidden): `);
    await keys.add(prov, label ?? "default", key);
    return console.log(`added ${prov} key ${label ?? "default"}: ${keys.TERMS}`);
  }
  if (cmd === "list" && !prov && !label && !file) {
    for (const k of keys.list()) console.log([k.provider, k.label, `added ${k.added.slice(0, 10)}`, `last used ${k.lastUsed?.slice(0, 10) ?? "never"}`, keys.TERMS].join("  "));
    return;
  }
  if (cmd === "forget" && prov && !extra && !file) { const k = keys.forget(prov, label); return console.log(`forgot ${k.provider} key ${k.label}`); }
  throw new Error("usage: abalone key add <provider> [--label <label>] [--input-file /abs/0600-file] | abalone key list | abalone key forget <provider> [--label <label>]. Keys come from hidden stdin or a private file, never from arguments.");
}

// abalone peer serve [--listen /ip4/0.0.0.0/tcp/4001] [--relay <relay multiaddr>] [--evidence appattest --probe <App.app> | --evidence dev]
// abalone peer serve --evidence macrunner --relay <relay multiaddr> --reserve 6usd --ledger /abalone-ledger   (inside the Mac runner)
//                    --reserve 6usd [--ledger dir] [--model id] [--issuer pubhex] [--chain <rpc url> --registry <address>]
async function servePeer() {
  const { serve } = await import("../lib/node.mjs");
  const evidence = { kind: flag("--evidence", "appattest"), app: flag("--probe") }, reserve = flag("--reserve");
  // Under the Mac runner the guest has no NIC: it listens only on /p2p-circuit through the relay, reached by CONNECT.
  if (evidence.kind === "macrunner" && (args.includes("--listen") || evidence.app || !args.includes("--relay"))) throw new Error("--evidence macrunner needs --relay <multiaddr> and takes no --listen or --probe");
  const listen = [flag("--listen", "/ip4/0.0.0.0/tcp/4001")], relays = [flag("--relay")].filter(Boolean);
  // Under the Mac runner the provider key stays with the runner; otherwise it is this machine's configured nearai key.
  const k = evidence.kind === "macrunner" ? { key: null, label: "runner" } : keys.active("nearai");
  if (!k) throw new Error("no nearai key configured: abalone key add nearai");
  if (!reserve) throw new Error("--reserve <amount>usd: the credit prepaid on this peer's NEAR key that gifts may claim");
  if (evidence.kind === "appattest" && !evidence.app) throw new Error("--evidence appattest needs --probe <the approved App Attest app>");
  // The issuer's public key. Inside the Mac runner it must be given (the guest must not invent an issuer); elsewhere
  // the local issuer key is the default.
  const issuer = flag("--issuer") ?? process.env.ABALONE_ISSUER_PUB ?? (evidence.kind === "macrunner" ? null : gift.pubHex(gift.issuerKey()));
  if (!/^[0-9a-f]{64}$/.test(issuer ?? "")) throw new Error("--issuer <64-hex Ed25519 public key>: the issuer whose grants this peer honours (abalone gift --issuer-pub on the issuer's machine)");
  const model = flag("--model", "z-ai/glm-5.3-flash"), dir = flag("--ledger"), rpc = flag("--chain"), registry = flag("--registry");
  if (!rpc !== !registry) throw new Error("--chain <rpc url> and --registry <CouponRegistry address> go together");
  // --tasks owner-operated|independent: also offer agent tasks (lib/task.mjs). --task-rate is µ$ per guest-second
  // (0 = a sponsored development offer); --task-executor runner needs --task-image <name@sha256:…>.
  const op = flag("--tasks"), executor = flag("--task-executor", evidence.kind === "macrunner" ? "runner" : "local"), image = flag("--task-image");
  if (op && !["owner-operated", "independent"].includes(op)) throw new Error("--tasks owner-operated|independent: who runs this worker, as the offer will state it");
  if (op && executor === "runner" && !/@sha256:[0-9a-f]{64}$/.test(image ?? "")) throw new Error("--task-executor runner needs --task-image <name>@sha256:<digest>, an image the runner admits");
  const tasks = op && { operator: op, label: flag("--task-label", `${os.hostname()} (${process.platform})`), executor, image, perSecond: Number(flag("--task-rate", "200")) };
  const { p, slice, near, chain, offer } = await serve({ key: k.key, label: k.label, issuer, model, dir, listen, relays, evidence, reserve: gift.usd(reserve), chain: rpc && { rpc, address: registry }, tasks });
  if (offer) console.log(`tasks: offer ${offer.offer_id.slice(0, 12)}… ${offer.worker.operator}, ${offer.runtime.image}, ${offer.tariff.execution_per_second} µ$/s${offer.tariff.sponsored ? " (sponsored: development runs are not paid execution)" : ""}, executor ${executor}`);
  if (chain) console.log(`chain: peer address ${chain.address}, restored checkpoint n=${chain.n} (safe head)`);
  console.log(`abalone peer ${p.peerId} (${evidence.kind}), slice ${slice.slice(0, 12)}…, nearai/${k.label}${k.key ? ` …${k.key.slice(-4)}` : " (key held by the runner)"}, issuer ${issuer.slice(0, 12)}…, model ${model}`);
  console.log(`NEAR ${model}: TEE key ${near.model_signing_address}, gateway TCB ${near.gateway_tcb}, TLS pin ${near.tls_pin ?? "this peer (SPKI)"}${near.runner_report_sha256 ? `, runner report ${near.runner_report_sha256.slice(0, 16)}… matches (freshness: ${near.runner_report_freshness})` : ""}`);
  // With a relay, report addresses only once the relay holds our reservation.
  if (relays.length) await new Promise((ok, fail) => {
    const done = () => p.getMultiaddrs().some((a) => String(a).includes("p2p-circuit")) && ok();
    p.addEventListener("self:peer:update", done); done();
    setTimeout(() => fail(new Error(`no reservation from relay ${relays[0]} within 60 s`)), 60e3).unref();
  });
  console.log(`addresses:\n${[...new Set([...p.getMultiaddrs().map(String).filter((a) => !relays.length || !a.includes("p2p-circuit")), ...relays.map((r) => `${r}/p2p-circuit/p2p/${p.peerId}`)])].map((a) => `  ${a}`).join("\n")}`);
}

// abalone peer relay [--listen /ip4/0.0.0.0/tcp/4002] [--ws-listen /ip4/127.0.0.1/tcp/4003/ws] [--seed-file f]
//                    [--announce <multiaddr>[,…]] [--onion /onion3/<addr>:<port>] [--addrs-file f]
// The minimal circuit relay v2 we run (no attestation needed: it carries Noise-encrypted bytes between peers and clients
// that verify each other). With a seed file its PeerId survives restarts. --announce names its public addresses (a
// Cloudflare quick tunnel's /dns4/<host>/tcp/443/wss), which change when the tunnel restarts. An onion address is not
// announced to libp2p (its address manager cannot parse /onion3 in reservation replies) and is only listed. --addrs-file
// gets all public addresses, each ending /p2p/<relay id>, for whoever issues gifts.
async function relayPeer() {
  const seedFile = flag("--seed-file"), ws = flag("--ws-listen"), announce = (flag("--announce") ?? "").split(",").filter(Boolean), onion = flag("--onion"), addrsFile = flag("--addrs-file");
  if (seedFile && !fs.existsSync(seedFile)) fs.writeFileSync(seedFile, (await import("node:crypto")).randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  const key = seedFile && await (await import("@libp2p/crypto/keys")).generateKeyPairFromSeed("Ed25519", Buffer.from(fs.readFileSync(seedFile, "utf8"), "hex"));
  const r = await p2p.relay([flag("--listen", "/ip4/0.0.0.0/tcp/4002"), ...(ws ? [ws] : [])], key, announce);
  const pub = [...announce, ...(onion ? [onion] : [])].map((a) => `${a}/p2p/${r.peerId}`);
  if (addrsFile) fs.writeFileSync(addrsFile, JSON.stringify({ relay: r.peerId.toString(), public: pub, started: new Date().toISOString() }, null, 1) + "\n");
  console.log(`abalone relay ${r.peerId}\n${r.getMultiaddrs().map((a) => `  ${a}`).join("\n")}${pub.length ? `\npublic:\n${pub.map((a) => `  ${a}`).join("\n")}` : ""}`);
}

// Issuer and recipient commands reach a peer through an attested libp2p client.
const viaPeer = async (addr, fn) => {
  if (!addr) throw new Error("which peer? pass --peer <multiaddr> (or set ABALONE_PEER)");
  const g = await p2p.giftClient(addr, providers().peers.admit);
  try { return await fn(g); } finally { await g.close(); }
};

// abalone gift --setup 6usd           record credit prepaid at the peer (match the peer's --reserve)
// abalone gift 5usd --peer <multiaddr> [--days 30] [--from NAME] [--allow-promotion]
// Issuing is local: the signed grant rides with the code, so no peer is contacted.
async function giftCmd() {
  if (args.includes("--issuer-pub")) return console.log(gift.pubHex(gift.issuerKey()));
  const b = gift.book(), setup = flag("--setup");
  if (setup) {
    b.funded += gift.usd(setup);
    gift.saveBook(b);
    return console.log(`Recorded ${gift.fmt(gift.usd(setup))} of credit prepaid at the peer. You can now give up to ${gift.fmt(b.funded - gift.committed(b))} in gifts.`);
  }
  const peer = PEER(), days = Number(flag("--days", "30")), from = flag("--from", "Andrew"), allowPromotion = args.includes("--allow-promotion");
  if (!peer) throw new Error("which peer will hold this gift? pass --peer <multiaddr> (or set ABALONE_PEER)");
  const amount = gift.usd(args[1]), code = gift.newCode(), expiry = Date.now() + days * 864e5;
  if (amount > b.funded - gift.committed(b)) throw new Error(`You have ${gift.fmt(b.funded - gift.committed(b))} left to give. Add more with: abalone gift --setup <amount>usd`);
  // Gift terms state noPromotion explicitly; the CLI's choice is no promotion on any surface for the gift's life.
  const terms = consent.parseTerms({ noPromotion: allowPromotion ? false : { scope: consent.SURFACES, until: new Date(expiry).toISOString() } });
  const token = gift.makeGift(code, { amount, expiry, from, terms });
  b.gifts.push({ account: gift.account(code), token, amount, expiry, from, peer, made: new Date().toISOString() });
  gift.saveBook(b);
  // With a landing page (ABALONE_LANDING, e.g. https://gift.example), the gift is a link; the code rides in its fragment.
  const landing = process.env.ABALONE_LANDING;
  const send = landing ? `Send this link. It works once; whoever opens it and runs the command first gets the ${gift.fmt(amount)}:\n\n  ${landing.replace(/\/$/, "")}/#peer=${encodeURIComponent(peer)}&t=${token}` : `Send this command. It works once; whoever runs it first gets the ${gift.fmt(amount)}:\n\n  abalone redeem --peer ${peer} ${token}`;
  const onion = peer.split(",").some((a) => a.trim().startsWith("/onion3/")) ? "\n(The onion address is a backup, tried only if the first does not answer; it needs Tor installed on the friend's computer.)" : "";
  console.log(`Gift: ${gift.fmt(amount)} from ${from}, good until ${new Date(expiry).toDateString()}.\n${send}${onion}\n\nLeft to give: ${gift.fmt(b.funded - gift.committed(b))}`);
}

async function giftsCmd() {
  const s = await viaPeer(PEER(), (g) => gift.issue(g.url, { type: "status" }));
  console.log(`peer slice ${s.slice.slice(0, 12)}…  key ${s.provider}  funded ${gift.fmt(s.funded)}  committed ${gift.fmt(s.committed)}  left to give ${gift.fmt(s.available)}`);
  for (const g of s.gifts) console.log(`  ${g.account}…  ${gift.fmt(g.amount).padStart(8)}  spent ${gift.fmt(g.spent).padStart(9)}  left ${gift.fmt(g.remaining).padStart(9)}  until ${new Date(g.expiry).toDateString()}  ${g.redeemed ? "redeemed" : "not redeemed"}`);
}

// abalone offers [--peer P]                       the worker's agent-task offer, checked against its handshake
// abalone commission [--peer P] --repo DIR --label open|released --cap 0.20usd [--check "<cmd>"] [--detach] "<prompt>"
// abalone commission --retry <task id>            resend the same signed authorization (idempotent)
// abalone tasks [list | attach | watch | status | stop | collect] [<task id>]
// The peer defaults to the redeemed gift's (the credit is held there).
const taskPeer = () => PEER() ?? gift.coupon()?.peer;
// A worker that cannot be reached: nothing was sent, nothing charged, and its running tasks are unaffected.
const viaWorker = async (addr, fn) => {
  if (!addr) throw new Error("which worker? pass --peer <multiaddr>, or redeem a gift first");
  const g = await p2p.giftClient(addr, providers().peers.admit).catch((e) => { throw e.message.startsWith("✗") ? e : new Error(`The worker is unreachable (worker_unavailable). Nothing was sent or charged; tasks already running there keep running, and you can reconnect later.\ndetails: ${e.message}`); });
  try { return await fn(g); } finally { await g.close(); }
};
async function offersCmd() {
  await viaWorker(taskPeer(), async (g) => console.log(task.describe(await task.offer(g), g.verdict)));
}
async function commissionCmd() {
  const id = flag("--retry");
  if (id) return viaWorker(task.record(id).peer, async (g) => { const hd = await task.retry(g, id); console.log(`Retried ${id}: the worker answered with the existing task (${hd.state}, ${hd.seq} events). Nothing new was started or reserved.`); });
  const repo = flag("--repo"), label = flag("--label"), cap = flag("--cap"), chk = flag("--check"), detach = args.includes("--detach"), preview = args.includes("--preview"), prompt = args.slice(1).filter((a) => !["--detach", "--preview"].includes(a)).join(" ");
  if (!repo || !["open", "released"].includes(label) || !cap || !prompt) throw new Error('usage: abalone commission --repo <dir> --label open|released --cap <amount>usd [--check "<test command>"] "<task>"');
  await viaWorker(taskPeer(), async (g) => {
    const o = await task.offer(g);
    // --preview: exactly what would be authorized and uploaded, with the offer's key terms; nothing is sent or reserved.
    if (preview) return console.log(task.authorizing(task.authorize(o, { prompt, repo, label, cap: gift.usd(cap), check: chk }).authorization, o).replace(/^Authorize task \S+/, "Would authorize a task") + "\n" +
      task.describe(o, g.verdict).split("\n").filter((l) => /^(Worker| {9}|Sees|Price|At cap)/.test(l)).join("\n"));
    console.log(task.describe(o, g.verdict) + "\n");
    const { authorization: au, handle: hd } = await task.commission(g, o, { prompt, repo, label, cap: gift.usd(cap), check: chk });
    console.log(`${task.authorizing(au, o)}\nCommissioned task ${au.task_id} (${hd.state}) from ${repo}.`);
    if (detach || !process.stdin.isTTY) return console.log(`It runs at the worker without you. ${process.env.ABALONE_EGRESS ? "/tasks attach" : "abalone tasks attach"} ${au.task_id} watches and steers it.`);
    await attachTask(g, au.task_id);
  });
}
async function attachTask(g, id) {
  console.log(`Attached to ${id}. Type to steer the agent; /take pauses it and gives you the shell (/bash <cmd>), /release hands back, /stop cancels, /detach leaves it running.`);
  const c = await task.attach(g, id);
  if (c) { const b = await task.collect(g, id); console.log(task.summary(b.completion, b.dir)); }
  // From the session (/tasks attach) the terminal goes back to abalone afterwards: let the user read the result first.
  if (c && process.env.ABALONE_TASK_PAUSE) { console.log("\nPress Enter to return to abalone."); const rl = readline.createInterface({ input: process.stdin }); await new Promise((r) => rl.once("line", r)); rl.close(); }
}
async function tasksCmd() {
  const [sub = "list", id] = args.slice(1);
  if (sub === "list") {
    const rs = task.records();
    if (!rs.length) return console.log("No commissioned tasks on this computer.");
    for (const r of rs) {
      const done = fs.existsSync(path.join(STATE, "tasks", r.task_id, "bundle/completion.json")) && JSON.parse(fs.readFileSync(path.join(STATE, "tasks", r.task_id, "bundle/completion.json"), "utf8"));
      console.log(`${r.task_id}  ${done ? `${done.status}, collected` : `seen ${r.last_seq} events`}  ${r.offer.worker.label} (${r.offer.worker.operator})  "${r.body.authorization.task.prompt.slice(0, 60)}"`);
    }
    return;
  }
  if (!id) throw new Error(`usage: abalone tasks ${shown(sub)} <task id>`);
  await viaWorker(task.record(id).peer, async (g) => {
    if (sub === "attach") return attachTask(g, id);
    if (sub === "watch") { const c = await task.watch(g, id); return c && console.log(task.summary(c)); }
    if (sub === "status") { const s = await task.call(g, "status", id); return console.log(s.completion ? task.summary(s.completion) : `${s.state}, control ${s.control}, ${s.seq} events, charged ${gift.fmt(s.usage.charged)} of ${gift.fmt(s.usage.cap)} (execution ${gift.fmt(s.usage.execution.charge)}, inference ${gift.fmt(s.usage.inference.charge)})`); }
    if (sub === "stop") { const s = await task.call(g, "stop", id, { reason: "stopped by the client" }, `stop:${id}`); return console.log(`Stop sent; the task is ${s.state}. abalone tasks collect ${id} once it has ended.`); }
    if (sub === "collect") { const b = await task.collect(g, id); return console.log(task.summary(b.completion, b.dir)); }
    throw new Error(`unknown: abalone tasks ${shown(sub)}`);
  });
}

async function redeemCmd() {
  const peer = PEER();
  const token = args[1] ?? (() => { throw new Error("No gift code found. Open the link you were sent and copy the command from there."); })();
  gift.parseGift(token);
  const j = await viaPeer(peer, async (g) => ({ ...(await gift.redeem(g.url, peer, token)), verdict: g.verdict }));
  if (!j.already) consent.applyGift(j.coupon.account, j.terms);
  saveLeft(j.coupon.account, j.remaining);
  const np = j.terms.noPromotion;
  console.log(`${j.already ? "This gift is already set up here." : "Set up this gift on this computer."}
  From ${j.from}: ${gift.fmt(j.remaining)} of ${gift.fmt(j.amount)} left, good until ${new Date(j.expiry).toDateString()}.
  Terms (as the sender signed them): ${np ? `no promotional offers on ${np.scope.join(", ")} until ${new Date(np.until).toDateString()}` : "the sender allowed promotional offers"}. Using it gives nobody rights to your data.
  Model: ${j.model} (private: messages are encrypted to a verified NEAR TEE). Server: ${peer.split("/p2p/").at(-1).slice(0, 16)}… (${j.verdict.place}${j.verdict.cdhash ? `, CDHash ${j.verdict.cdhash.slice(0, 12)}…` : ""}).${j.already ? "" : "\n  The code you pasted is now used, so it's fine to leave it in your shell history."}`);
}

// abalone trace key init|export|import, trace list|open|delete: the strict-incognito trace store (docs/protocols/trace-store.md).
async function traceCmd([cmd, a, b]) {
  if (cmd === "key" && a === "init") {
    const pw = await passphrase("new passphrase for the trace key: ");
    if (!process.env.ABALONE_PASSPHRASE_FD && await passphrase("again: ") !== pw) throw new Error("the passphrases differ; nothing was created");
    const k = await trace.createKey(pw);
    return console.log(`Created trace key ${k.kid}: ${k.file} (encrypted under your passphrase), recipient ${k.recipient}.
Strict-incognito sessions encrypt their trace to it; only the passphrase unlocks them. There is no escrow: lose the key or
the passphrase and the traces are gone. Keep a copy in your password manager: abalone trace key export`);
  }
  if (cmd === "key" && a === "export") return console.log(await trace.exportKey(await passphrase("trace key passphrase: ")));
  if (cmd === "key" && a === "import") {
    const id = await readSecret("paste the AGE-SECRET-KEY line (hidden): ");
    const k = await trace.importKey(id, await passphrase("new passphrase for this key on this computer: "));
    return console.log(`Imported trace key ${k.kid} into ${k.file}.`);
  }
  if (!a) throw new Error("usage: abalone trace key init|export|import, or abalone trace list|open|delete <folder> [id|--all]");
  if (cmd === "list") {
    const ts = trace.list(a);
    if (!ts.length) return console.log(`no traces in ${trace.dir(a)}`);
    for (const t of ts) console.log(`${t.id}  ${String(t.bytes).padStart(8)} bytes  ${t.frames} records  key ${t.kid}  ${t.hwm ? (t.hwm.closed ? "closed" : `not closed (${t.hwm.frames} records recorded here)`) : "written elsewhere (no high-water mark here)"}`);
    return;
  }
  if (cmd === "open") {
    const t = trace.find(a, b), o = await trace.open(t.file, await passphrase(`passphrase for trace key ${t.kid}: `));
    console.log(trace.transcript(o.records));
    return console.log(`\n[${t.file}: ${o.frames} records verified; ${o.closed ? "closed cleanly" : "NOT CLOSED: the session was interrupted, or the end was cut off (the two look the same)"}; ${o.hwm}${o.partial ? "; a partly written last line was ignored" : ""}. Nothing was added to any session.]`);
  }
  if (cmd === "delete") {
    for (const f of trace.remove(a, b)) console.log(`deleted ${f}`);
    return console.log(`Not covered: copies made elsewhere (backups, a copied folder, sync), blocks an SSD or copy-on-write disk keeps, what the TEE provider processed, files the agent wrote, and host names in ${path.join(STATE, "egress.jsonl")}. Deleting the trace key makes every copy unreadable.`);
  }
  throw new Error(`unknown: abalone trace ${shown(cmd)}`);
}

// caps.mjs resolves paths as Pi does, so it imports pi/: loaded only here, never on the peer serve/relay path,
// whose image has no pi/ (tests/peer-image-smoke.sh).
async function printCaps(json) {
  const doc = (await import("../lib/caps.mjs")).document(process.cwd());
  if (json) return console.log(JSON.stringify(doc, null, 1));
  console.log(`${doc.contract}  claim: ${doc.claim}\n\nACTIVE KEYS`);
  for (const [p, k] of Object.entries(doc.active_keys)) console.log(`  ${p.padEnd(10)} ${k}`);
  console.log("\nCAPABILITIES (holder × action → object, granted by)");
  for (const c of doc.capabilities) console.log(`  ${c.holder.padEnd(18)} ${c.action.padEnd(12)} ${c.object.padEnd(52)} ${c.granted_by}`);
  console.log("\nOBSERVERS");
  for (const o of doc.observers) console.log(`  ${o.observer.padEnd(26)} ${o.sees}\n  ${"".padEnd(26)} mechanism: ${o.mechanism}${o.axis ? `; axis: ${o.axis}` : ""}`);
  console.log("\nGUARANTEES");
  for (const [k, v] of Object.entries(doc)) if (typeof v === "boolean") console.log(`  ${k}: ${v}`);
  console.log("\nENFORCED BY CODE ON EVERY RELEASE"); for (const l of doc.enforced_by_code) console.log(`  - ${l}`);
  console.log("\nLIMITATIONS"); for (const l of doc.limitations) console.log(`  - ${l}`);
}

const REDEEM_PAGE = "https://amiller.github.io/abalone/redeem/";
const REDEEM_STEPS = ["  abalone credit inspect --trial /abs/trial.json --input-file /abs/gift.txt",
  "  abalone credit redeem --trial /abs/trial.json --input-file /abs/gift.txt --accept-offer <offerHash>"];
const KEY_GUIDE = path.join(ROOT, "guides/acquiring-private-inference/README.md");
const HELP = `abalone: an incognito AI session paid for by a gifted credit (Dsmack handles redemption).

  abalone                                 the front door: opens your saved credit's session (lists them if you have several).
                                          With none saved, paste a gift link or code: it shows the offer's terms, asks you to
                                          accept, redeems the gift and opens the session, all in one step.
  abalone --trial /abs/trial.json         the same, with a trial.json other than the one installed with this copy
  abalone help                            this text

No gift yet, or no install? Start at ${REDEEM_PAGE}
Bought a provider key instead? abalone key add <provider> saves it for abalone sandbox (plain abalone does not use it); see ${KEY_GUIDE}

The same steps one at a time (scripts, recovery):
  abalone credit inspect|redeem ...       review a gift's offer and claim deadline, then redeem and save it:
${REDEEM_STEPS.map((l) => `  ${l}`).join("\n")}
  abalone credit status [--credit <id>]   saved credits and their state
  abalone credit recover --credit <id>    finish an interrupted redeem with the same keys
  abalone credit forget --credit <id>     remove a saved credit and its lock file (does not revoke it)
  abalone credit session --credit <id> [--mode rpc]   open a session with one saved credit
  abalone key add|list|forget <provider>  configure your own provider API key (from stdin, never arguments)

Older and developer commands:
  abalone sandbox [folder] [Pi options]   the bubblewrap-sandboxed session using providers.json models
  caps, approvals, canary init, trace, notebook, ask, report, show evidence, verify, setup,
  gift, gifts, redeem, offers, commission, tasks, coupon-session, peer serve|relay`;
const NEXT = { offered: (c) => `${c.claimWindow} Redeem it with abalone credit redeem ... --accept-offer ${c.offerHash}`, expired: (c) => c.claimWindow,
  claiming: (c) => `A claim may be in progress; finish it with abalone credit recover --credit ${c.creditId}`, reconciliation_required: () => "The issuer's operator must reconcile this claim before it can be used.",
  refused: (c) => `This saved credit was refused (${c.code}); abalone credit status --credit ${c.creditId} shows why.` };
NEXT.uncertain = NEXT.claiming;
const WAYS_IN = ["Two ways in:", "  1. Paste a gift link or code here (or the full path of a private 0600 file holding it).", `  2. Or bring a provider key: abalone key add <provider> saves it for abalone sandbox, not plain abalone; see ${KEY_GUIDE}`,
  "abalone help lists every command."];

// Reads one line at the terminal; hidden input is not echoed.
function terminalLine(prompt, hidden = false) {
  const r = spawnSync("bash", ["-c", `IFS= read -r${hidden ? "s" : ""} -p "$1" p; ${hidden ? "echo >&2; " : ""}printf %s "$p"`, "_", prompt], { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8", maxBuffer: 4096 });
  if (r.status !== 0) throw Object.assign(new Error("Input ended before anything was entered; nothing was claimed. Run abalone again."), { code: "credit_input_refused" });
  return r.stdout;
}

function installedTrial() {
  const dir = path.join(ROOT, "..", "public-credit"), found = fs.existsSync(dir) ? fs.readdirSync(dir).map((b) => path.join(dir, b, "trial.json")).filter((f) => fs.existsSync(f)) : [];
  if (found.length === 1) return found[0];
  throw creditArg(found.length ? `Several installed credit trials:\n${found.map((f) => `  ${f}`).join("\n")}\nRun abalone --trial <one of them>; nothing was claimed.`
    : `This copy of abalone has no installed credit trial. Install it with sh install.sh --credit (see ${REDEEM_PAGE}), or run abalone --trial /abs/trial.json; nothing was claimed.`);
}

// Plain `abalone`: the one saved credit's session; several are listed; with none, explain the ways in and take a pasted gift.
async function frontDoor() {
  const trialFile = args[1], wrong = trialFile && CREDIT_VALUES["--trial"](trialFile);
  if (wrong) throw new Error(wrong);
  const dir = path.join(STATE, "credit"), all = fs.existsSync(dir) ? await createCreditManager({ directory: dir }).status() : [];
  const ready = all.filter((c) => c.state === "installed"), waiting = all.filter((c) => c.state !== "installed");
  if (ready.length === 1) { args.splice(0, args.length, "credit", "session", "--credit", ready[0].creditId); return creditCmd(); }
  if (ready.length) throw new Error([`You have ${ready.length} saved credits. Open one with:`,
    ...ready.map((c) => `  abalone credit session --credit ${c.creditId}   (${c.model}, $${c.nominalCapUsd} nominal cap)`)].join("\n"));
  const text = [waiting.length ? "No saved credit is ready to use yet:" : "No saved credit yet.", ...waiting.map((c) => `  ${c.creditId}  ${c.state}: ${NEXT[c.state](c)}`),
    ...(keys.list().length ? ["A configured key exists; use abalone sandbox (plain abalone opens coupon credit only, #21)."] : []), ...WAYS_IN].join("\n");
  if (!process.stdin.isTTY) throw Object.assign(new Error(text), { exit: 2 });
  console.error(text);
  return creditCmd(() => redeemPasted(trialFile ?? installedTrial()));
}

async function redeemPasted(trialFile) {
  creditPreflight();
  const admission = await trialAdmission(trialFile), coupon = giftPaste(terminalLine("Gift link, code or file (hidden as you paste): ", true));
  const manager = createCreditManager({ directory: path.join(STATE, "credit") }), offer = await manager.inspect(coupon, admission);
  console.log(JSON.stringify(offer, null, 2));
  if (offer.state !== "installed") {
    if (offer.state !== "offered") throw Object.assign(new Error(NEXT[offer.state](offer)), { code: "credit_unavailable" });
    const consent = offer.offerHash.slice(0, 8);
    if (terminalLine(`Review the terms above. To accept and redeem, type ${consent}; anything else stops here: `).trim() !== consent)
      throw Object.assign(new Error("Not accepted, so nothing was claimed. Run abalone again and paste the gift when you are ready."), { code: "credit_intent_required" });
    await manager.redeem(offer.creditId, { offerHash: offer.offerHash });
    console.error("Redeemed and saved. Opening the session.");
  }
  args.splice(0, args.length, "credit", "session", "--credit", offer.creditId);
  return creditAction();
}

// Flags that would re-enable ambient resources or bring outside text into the system prompt.
const REFUSED = new Set(["--approve", "-a", "--system-prompt", "--append-system-prompt", "--prompt-template", "--theme", "--api-key"]);

async function prepareRetention() {
  if (args.includes("--keep-trace") && !args.includes("--incognito")) throw new Error("--keep-trace requires --incognito.");
  if (args.includes("--keep-trace") && !trace.keyInfo()) await traceCmd(["key", "init"]);
}

async function session() {
  // abalone sandbox <folder>: work in that folder. The sandbox binds the working directory, and nothing else of the home.
  const shell = process.cwd(); // where the user typed the command, for the reopen line
  if (args[0] && !args[0].startsWith("-") && fs.statSync(args[0], { throwIfNoEntry: false })?.isDirectory()) process.chdir(args.shift());
  // abalone sandbox --incognito <folder>: strict incognito (docs/protocols/trace-store.md). Only this flag turns it on.
  const incognito = args.includes("--incognito"), keepTrace = args.includes("--keep-trace"), withTrace = flag("--with-trace");
  const ownedHost = args.includes("--owned-host");
  if (ownedHost && (!incognito || !couponSlot)) throw new Error("Owned-host mode requires an explicit incognito coupon session; no ambient provider is substituted.");
  await prepareRetention();
  if (incognito && args[args.indexOf("--incognito") + 1] && !args[args.indexOf("--incognito") + 1].startsWith("-")) process.chdir(args.splice(args.indexOf("--incognito") + 1, 1)[0]);
  if (withTrace && !incognito) throw new Error("✗ refused: --with-trace adds a decrypted trace to a session's context, so it works only with --incognito");
  if (incognito && ["--resume", "-r", "--continue", "-c", "--session"].some((f) => args.includes(f))) throw new Error("✗ refused: strict incognito keeps no Pi session to resume; reopen a trace with --with-trace <id>");
  const key = keepTrace && trace.keyInfo();
  // Unlocking an old trace is explicit: this flag, and its passphrase. The transcript stays in this process's memory.
  let reopened = null;
  if (withTrace) {
    const t = trace.find(process.cwd(), withTrace), o = await trace.open(t.file, await passphrase(`passphrase for trace key ${t.kid}: `));
    reopened = { id: t.id, closed: o.closed, n: o.records.length, text: trace.transcript(o.records), shown: history(t.id, o.records) };
  }
  const entries = verified();
  const loads = [];
  const user = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (REFUSED.has(a)) throw new Error(`✗ refused: ${a} is not available in abalone (ambient resources and project trust stay off)`);
    if (a === "-e" || a === "--extension") loads.push("-e", admit(entries, args[++i], "extension"));
    else if (a === "--skill") loads.push("--skill", admit(entries, args[++i], "skill"));
    // abalone sandbox --resume <id> (the line printed on exit) is Pi's --session <id>; a bare --resume opens Pi's picker.
    else if (a === "--resume" && args[i + 1] && !args[i + 1].startsWith("-")) user.push("--session", args[++i]);
    else if (!["--no-canaries", "--incognito", "--keep-trace", "--owned-host"].includes(a)) user.push(a);
  }
  const canaries = canary.forSession(process.cwd(), args.includes("--no-canaries") || process.env.ABALONE_NO_CANARIES === "1");
  const p = providers();
  const ports = couponSlot ? [] : localPorts(), hosts = couponSlot ? [] : admittedHosts();
  // With a gift, the launcher (outside the sandbox) holds an attested libp2p connection to the peer and gives the
  // sandbox a loopback endpoint for it. The peer was verified before that endpoint exists.
  // A gift counts as an admitted TEE destination in strict incognito too: end-to-end encrypted to NEAR's attested model,
  // through a peer whose attestation this client verified, with NEAR's signature checked on every reply.
  const c = !couponSlot && gift.coupon();
  const g = c && await p2p.giftClient(c.peer, p.peers.admit);
  if (g) { ports.push(Number(new URL(g.url).port)); if (!user.includes("--model")) user.unshift("--model", `${GIFT}/${c.model}`); }
  // The default model is abalone's (providers.json "default"), not whichever provider Pi finds first; a resumed
  // session keeps its own.
  if (!["--model", "--session", "--continue", "-c", "--resume", "-r"].some((f) => user.includes(f))) user.unshift("--model", p.default);
  // Reasoning off unless asked for: glm-5.3-flash otherwise thinks for tens of seconds before each answer (/thinking changes it).
  if (!user.includes("--thinking")) user.push("--thinking", "off");
  if (incognito) {
    const m = user[user.indexOf("--model") + 1].split("/")[0];
    // The gift peer qualifies only when its handshake showed attested evidence (a dev peer only where config admits dev peers, i.e. tests).
    const giftOk = m === GIFT && g && (g.verdict.place.startsWith("◈ attested") || p.peers.admit.dev === true);
    const couponOk = couponSlot && m === couponSlot.provider.provider;
    if (!giftOk && !couponOk && (m === GIFT || (place(m) !== "⌂ local" && !p.admitted.some((a) => a.id === m)))) throw new Error(`✗ refused: ${shown(m)} is not a ⌂ local or ◈ admitted provider; strict incognito sends nothing elsewhere`);
    user.push("--no-session"); // Pi keeps its session in memory only; the launcher writes the encrypted trace
  }
  const env = { ...process.env, PI_RESUME_HINT: `Resume with: abalone sandbox ${/\s/.test(process.cwd()) ? JSON.stringify(process.cwd()) : process.cwd()} --resume {id}`, PI_QUIET_MANAGED_TOOLS: "1", ABALONE_DIR: STATE, PI_CODING_AGENT_DIR: AGENT_DIR, PI_ADMITTED_HOSTS: [...hosts, ...LOOPBACK].join(","), ABALONE_SANDBOX: "1" };
  delete env.ABALONE_COUPON_FD; delete env.ABALONE_COUPON_CONSENT_FD;
  delete env.ABALONE_COUPON_SOCKET; delete env.ABALONE_COUPON_MODEL; delete env.ABALONE_COUPON_PROVIDER; delete env.ABALONE_COUPON_MAX_TOKENS;
  if (canaries) env.ABALONE_CANARIES = canaries; else env.ABALONE_NO_CANARIES = "1";
  delete env.ABALONE_INCOGNITO; delete env.ABALONE_TRACE_RETAINED;
  if (keepTrace) env.ABALONE_TRACE_RETAINED = "1";
  if (incognito) env.ABALONE_INCOGNITO = "1";
  if (g) Object.assign(env, { ABALONE_GIFT_URL: g.url, ABALONE_GIFT_PEER: `${g.peerId.slice(0, 16)}… ${g.verdict.place}${g.direct ? "" : " via relay"}`, ABALONE_GIFT_PLACE: g.verdict.place });
  for (const l of (couponSlot ? [] : p.local.filter((l) => l.builtin))) { loads.push("-e", `builtin:${l.builtin}`); env.LLAMA_BASE_URL = l.baseUrl; }
  const via = {}; // provider/model → "via RedPill → Phala TEE", for the place labels
  for (const a of p.admitted) {
    delete env[a.keyEnv]; // the agent never holds a provider key of its own
    if (couponSlot) continue; // synthetic sessions cannot fall back to another credential/provider
    // An ACI provider attests at load, and Chutes needs a key to verify anything: with no configured key either could
    // serve nothing, so it is not contacted at all.
    const k = keys.active(a.id);
    if ((a.transport === "aci/1" || a.needsKey) && !k) continue;
    // Behind an ACI aggregator, only models whose every upstream our policy admits (lib/upstream.mjs, issue 0007).
    // A provider whose listing fails, or that has no admitted model, is not loaded: its models are refused.
    if (a.upstreams) {
      const v = await upstream.vet(a).catch((e) => ({ error: e.message, admitted: {} }));
      log("upstreams.jsonl", { provider: a.id, ...v });
      if (!Object.keys(v.admitted).length) { console.error(`✗ ${a.id}: no model admitted (${v.error ?? "no model's upstreams are all admitted"}); see ${path.join(STATE, "upstreams.jsonl")}`); continue; }
      env[a.allowlistEnv] = Object.keys(v.admitted).join(",");
      for (const [id, l] of Object.entries(v.admitted)) via[`${a.id}/${id}`] = l;
    }
    loads.push("-e", admit(entries, path.join(ROOT, a.extension), "provider extension"));
    if (k) { keys.used(k.id); env[a.keyEnv] = k.key; env.ABALONE_PROVIDER_KEYS = [env.ABALONE_PROVIDER_KEYS, `${a.id}:${k.label}:${k.key.slice(-4)}`].filter(Boolean).join(","); }
  }
  env.ABALONE_VIA = JSON.stringify(via);
  for (const e of entries) {
    if (e.kind === "extension") loads.push("-e", e.abs);
    if (e.kind === "skill") loads.push("--skill", e.abs);
    if (e.kind === "preload") env.NODE_OPTIONS = `--import ${e.abs}`;
  }
  // Sockets live in a short per-user runtime dir: a unix socket path may not exceed 107 bytes.
  const run = ownedHost ? memoryRun() : fs.mkdtempSync(path.join(runtimeDir(), "abalone-"));
  process.on("exit", () => fs.rmSync(run, { recursive: true, force: true })); // also when startup throws
  env.ABALONE_EGRESS = run;
  delete env.ABALONE_OWNED_HOST;
  if (ownedHost) { env.ABALONE_OWNED_HOST = "1"; env.ABALONE_DIR = path.join(run, "state"); delete env.ABALONE_SANDBOX; env.TMPDIR = path.join(run, "tmp"); }
  if (couponSlot) {
    const socketPath = path.join(run, "coupon.sock");
    let shown;
    await couponSlot.broker(socketPath, { onState: (state) => state === "installed" && shown === state ? undefined : (shown = state, console.error(state === "usage_not_recorded" ? "Warning: the last answer's token usage was not recorded; the session continues." : `Coupon session: ${state}. Check /coupon; no alternate key is tried.`)) });
    env.ABALONE_COUPON_SOCKET = socketPath; env.ABALONE_COUPON_MODEL = couponSlot.provider.model; env.ABALONE_COUPON_PROVIDER = couponSlot.provider.provider;
    if (couponSlot.provider.provider === "nearai") env.ABALONE_COUPON_MAX_TOKENS = String(couponSlot.provider.maxTokens);
    loads.push("-e", admit(entries, path.join(ROOT, "curated/coupon-provider.ts"), "coupon provider extension"));
    env.PI_RESUME_HINT = couponSlot.savedCredit ? "This incognito conversation is not resumable. The saved credit remains: abalone credit session --credit <id> starts a fresh one."
      : "Coupon session credentials are session-only and cannot be resumed after exit.";
  }
  // In strict incognito Pi's own dir (settings, crash and debug logs) is in the run dir, removed at exit.
  const agentDir = incognito ? path.join(run, "agent") : AGENT_DIR;
  env.PI_CODING_AGENT_DIR = agentDir;
  fs.mkdirSync(agentDir, { recursive: true });
  // Pi's startup listing (its self-description, skills, extensions) is not abalone's first screen; /about has it.
  // Model reasoning starts collapsed to one line, so the answer comes first; ctrl+t shows it (and Pi keeps that choice).
  const sf = path.join(agentDir, "settings.json");
  fs.writeFileSync(sf, JSON.stringify({ hideThinkingBlock: true, ...(fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : {}), quietStartup: "header", ...(couponSlot ? { retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, compaction: { enabled: false }, cacheWarming: "off" } : {}) }, null, 1));
  const close = await startEgress(run, hosts, incognito ? [] : Object.values(p.runners).flatMap((r) => r.hosts), ports, "pi");
  // The encrypted trace: written only here, outside the sandbox, with a stream key that never enters the sandbox.
  const tw = keepTrace && await trace.writer(process.cwd(), key.recipient, crypto.randomBytes(8).toString("hex"));
  let traced = 0;
  if (tw) {
    tw.append({ t: "start", mode: "strict-incognito", folder: process.cwd(), model: user[user.indexOf("--model") + 1], at: new Date().toISOString(), reopened: reopened?.id ?? null });
  }
  if (incognito) {
    env.ABALONE_SESSION_DESCRIPTOR = path.join(run, "session.json");
    fs.writeFileSync(env.ABALONE_SESSION_DESCRIPTOR, JSON.stringify({ version: 1, mode: ownedHost ? "owned-host-incognito" : "strict-incognito", workspace: process.cwd(), local_boundary: ownedHost ? "trusted-owned-host" : "bubblewrap",
      inference: ownedHost ? "Pinned admitted coupon inference only; alternate inference credentials, ask_frontier, /fetch and gift control commands are disabled. Ordinary-account tools retain filesystem/network access." : "⌂ local and ◈ admitted providers only (providers.json); outside providers, ask_frontier, /fetch and the gift peer are off",
      network: ownedHost ? { shell: "ordinary account network access; not isolated", public_web: true, egress: "tool network is not confined; inference remains pinned to the admitted coupon provider" } : { shell: "none", public_web: false, egress: "admitted TEE hosts, their verifier hosts and loopback model ports" },
      retention: tw ? { kind: "encrypted-trace", format: "abalone-trace/2", trace: tw.file, key_id: key.kid, key_file: key.file, encrypted: true,
        session_can_read_back: false, other_harness_writes: "tmpfs (memory), gone at exit", reopened: reopened?.id ?? null } : { kind: "session-only", session_can_read_back: false, other_harness_writes: "tmpfs (memory), gone at exit", reopened: reopened?.id ?? null } }, null, 1), { mode: 0o400 });
  }
  // /redeem and /gift in the session need the network, which the sandbox lacks: the session asks the launcher to run
  // exactly these CLI commands. ask_frontier's runner runs here too, since the runner logins are not in the sandbox.
  // Only the session's own process can reach the socket (it is in the run dir, which the bash sandbox does not see).
  const claude = process.env.ABALONE_RUNNER_CLAUDE ?? spawnSync("bash", ["-c", "readlink -f \"$(command -v claude)\""], { encoding: "utf8" }).stdout.trim();
  let next = null; // /folder: the folder the session restarts in after Pi exits; /redeem: the same folder and conversation
  // The built-in Tor transport (started on first sealed use; state in <STATE>/tor). Its status file feeds the strip.
  const tor = torTransport({ dataDir: path.join(STATE, "tor"), onStatus: (st) => fs.writeFileSync(path.join(run, "tor-status"), st) });
  const ctl = net.createServer({ allowHalfOpen: true }, (s) => {
    let b = "";
    s.on("data", (d) => (b += d));
    s.on("end", () => {
      const argv = JSON.parse(b);
      if (couponSlot && !["trace-append", "trace-context"].includes(argv[0])) return s.end(JSON.stringify(argv[0] === "coupon-info" ? { code: 0, out: JSON.stringify({ ...couponSlot.info(), advisories: couponNearFirmwareAdvisories() }) }
        : { code: 2, out: "", err: "This coupon session does not run outside launcher commands or restart. Its original keys must stay in this process." }));
      if (incognito) {
        if (argv[0] === "trace-append") { if (tw) { for (const e of argv[1]) tw.append({ t: "entry", e }); traced += argv[1].length; } return s.end(JSON.stringify({ code: 0, out: "" })); }
        if (argv[0] === "trace-context") return s.end(JSON.stringify({ code: 0, out: reopened ? JSON.stringify(reopened) : "" }));
        return s.end(JSON.stringify({ code: 2, out: "", err: `✗ refused: ${argv[0]} is not available in strict incognito` }));
      }
      if (argv[0] === "runner") return runRunner(argv[1], argv[2], { egress: run, bin: claude })
        .then((r) => s.end(JSON.stringify({ code: 0, out: JSON.stringify(r) })), (e) => s.end(JSON.stringify({ code: 1, out: "", err: e.message })));
      // /fetch: the session decided the route and the user saw why; the download happens here, where the network is.
      if (argv[0] === "fetch") {
        return download(new URL(argv[1]), argv[2], process.cwd(), tor).then((r) => s.end(JSON.stringify({ code: 0, out: JSON.stringify(r) })), (e) => s.end(JSON.stringify({ code: 1, out: "", err: e.message })));
      }
      if (argv[0] === "folder") {
        const dir = path.resolve(process.cwd(), argv[1].replace(/^~(?=\/|$)/, os.homedir()));
        if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return s.end(JSON.stringify({ code: 1, out: "", err: `${dir} is not a folder` }));
        // Never make abalone's own code, config, state or runner logins the workspace.
        const real = fs.realpathSync(dir), overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
        if ([STATE, ROOT, CFG, RUNNER_HOME].some((p) => overlaps(real, fs.realpathSync(p)))) return s.end(JSON.stringify({ code: 1, out: "", err: `${dir} holds or is inside abalone's own code or state; choose a project folder` }));
        // Check the code now, while this session is still open: a refusal is reported here, not after Pi has exited.
        try { verified(); } catch (e) { return s.end(JSON.stringify({ code: 1, out: "", err: `${e.message}\nYou are still in ${process.cwd()}.` })); }
        next = [dir];
        return s.end(JSON.stringify({ code: 0, out: `abalone restarts in ${dir}; only that folder is visible to it` }));
      }
      // /tasks attach: the terminal belongs to the attachment until /detach or the task ends; then the session resumes.
      if (argv[0] === "task-attach") {
        const c = spawn(process.execPath, [import.meta.filename, "tasks", "attach", argv[1]], { stdio: "inherit", env: { ...process.env, ABALONE_TASK_PAUSE: "1" } });
        return c.on("exit", (code) => {
          const st = spawnSync(process.execPath, [import.meta.filename, "tasks", "status", argv[1]], { encoding: "utf8" });
          s.end(JSON.stringify({ code: 0, out: `Back from task ${argv[1]}${code ? ` (attachment exited ${code})` : ""}. Its transcript was not added to this conversation.\n${(st.stdout + st.stderr).trim()}` }));
        });
      }
      if (!["redeem", "gift", "gifts", "report", "offers", "commission", "tasks"].includes(argv[0])) return s.end(JSON.stringify({ code: 2, out: "", err: `✗ refused: ${argv[0]} is not a gift or report command` }));
      const c = spawn(process.execPath, [import.meta.filename, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (err += d));
      c.on("exit", (code) => { if (argv[0] === "redeem" && code === 0) next = [process.cwd(), "--continue"]; s.end(JSON.stringify({ code, out, err })); });
    });
  }).listen(path.join(run, "ctl.sock"));
  // The browser bridge: the one tab the user grants with /browser, reached by the session through <run>/browser.sock.
  const closeBrowser = browserBridge(run, { incognito });
  const pi = path.join(ROOT, "pi/packages/coding-agent/dist/cli.js");
  if (claude) env.ABALONE_RUNNER_CLAUDE = claude;
  const settingsFd = incognito && !ownedHost ? fs.openSync(sf, "r") : undefined;
  const prefix = ownedHost ? [] : [...piArgv(run, hosts, process.cwd(), { incognito, gift: !!g, ...(incognito ? { settingsFd: 3 } : {}) }), "--", process.execPath];
  const child = spawn(ownedHost ? process.execPath : "bwrap", [...prefix, pi,
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-mcp", "--no-approve",
    ...loads, ...user], { stdio: settingsFd !== undefined ? ["inherit", "inherit", "inherit", settingsFd] : "inherit", env: ownedHost ? ownedHostEnvironment(env) : env });
  if (settingsFd !== undefined) fs.closeSync(settingsFd);
  process.on("SIGINT", () => {});
  for (const s of ["SIGTERM", "SIGHUP"]) process.on(s, () => child.kill(s)); // the child exits, then the run dir is removed
  let sig = null;
  const code = await new Promise((r) => child.on("exit", (c, s) => { sig = s; r(c ?? (s ? 1 : 0)); }));
  if (tw) {
    tw.close({ t: "close", at: new Date().toISOString(), entries: traced, reason: sig ? `the session ended on ${sig}` : `the session exited with code ${code}` });
    const here = path.relative(shell, process.cwd()) || ".";
    console.error(`\nStrict incognito closed.
Kept: an encrypted trace in .abalone/traces/ (${tw.frames()} records), opened only with your trace passphrase. Files written here stay as ordinary files${g ? ", the gift's balance stays in abalone's state" : ""}, and abalone's egress log keeps the host names contacted.
Not kept: Pi's session, logs and scratch (memory only).
Reopen: abalone sandbox --incognito ${/\s/.test(here) ? JSON.stringify(here) : here} --with-trace ${tw.id}`);
  }
  if (incognito && !tw) console.error("Incognito closed. No conversation trace retained; Pi sessions, logs and scratch were memory-only. Workspace files, terminal output and egress hostname metadata may remain. This is not secure erasure or IP anonymity.");
  close();
  ctl.close();
  closeBrowser();
  tor.close();
  if (g) await g.close();
  if (couponSlot) { const saved = couponSlot.savedCredit; await couponSlot.close(); couponSlot = null; console.error(saved ? "Incognito session closed. Saved credit remains available for a fresh process; no ordinary conversation trace was saved." : "Coupon session closed. Local coupon identity, delivery key and credential were forgotten by this process. This is not upstream revocation or secure erasure. Conversation and workspace retention follow the session mode."); }
  if (next) process.exit(spawnSync(process.execPath, [import.meta.filename, "sandbox", ...next, ...args], { stdio: "inherit" }).status);
  process.exit(code);
}

try {
  if (!args.length || (args[0] === "--trial" && args.length === 2)) await frontDoor();
  else if (["help", "--help", "-h"].includes(args[0])) console.log(HELP);
  else if (args[0] === "sandbox") { args.shift(); await session(); }
  else if (args[0] === "caps") await printCaps(args[1] === "--json");
  else if (args[0] === "key") await keyCmd();
  else if (args[0] === "peer" && args[1] === "serve") await servePeer();
  else if (args[0] === "peer" && args[1] === "relay") await relayPeer();
  else if (args[0] === "gift") await giftCmd();
  else if (args[0] === "gifts") await giftsCmd();
  else if (args[0] === "redeem") await redeemCmd();
  else if (args[0] === "coupon-session") await couponSessionCmd();
  else if (args[0] === "credit") await creditCmd();
  else if (args[0] === "offers") await offersCmd();
  else if (args[0] === "commission") await commissionCmd();
  else if (args[0] === "tasks") await tasksCmd();
  else if (args[0] === "ask") await ask(args.slice(1));
  else if (args[0] === "trace") await traceCmd(args.slice(1));
  else if (args[0] === "notebook") notebook(args.slice(1));
  else if (args[0] === "approvals") await approvals.run(args.slice(1));
  else if (args[0] === "setup" && args[1] === "--separate-user") { const m = flag("--model"); console.log(separateUser(args[2], m)); }
  else if (args[0] === "canary" && args[1] === "init" && args[2]) {
    const c = canary.init(args[2]);
    console.log(`Planted ${c.file} (two random values). Recorded them outside the folder in ${c.record}.\nThe gate now blocks any release holding either value. Keep the file; abalone refuses to start here if it is missing or changed.`);
  }
  else if (args[0] === "report") {
    const into = flag("--into", process.env.ABALONE_REPORT_DIR ?? ROOT), title = flag("--title"), turn = flag("--turn"), includeText = args.includes("--include-text");
    const r = report(args.filter((a) => a !== "--include-text")[1], { includeText, title, turn: turn && Number(turn), into });
    console.log(`Wrote ${r.issue}\nand ${r.fixture}/ (fixture.json, expect.json). Local files only: nothing was sent.`);
  }
  else if (args[0] === "show" && args[1] === "evidence") showEvidence(args[2]);
  else if (args[0] === "verify" && args[1]) {
    const { verifyBundle, describe } = await import("../lib/bundle.mjs");
    const expect = flag("--expect"), seen = flag("--seen"), a = expect && JSON.parse(fs.readFileSync(expect, "utf8"));
    const r = verifyBundle(args[1], { admit: providers().peers.admit, expect: a?.authorization ?? a,
      seen: seen ? fs.readFileSync(seen, "utf8").split("\n").filter(Boolean).map((l) => { const [task_id, record] = l.split(" "); return { task_id, record }; }) : [] });
    console.log(describe(r));
    process.exit(r.ok ? 0 : 1);
  }
  else throw Object.assign(new Error(`Unknown command ${shown(args[0])}. The older sandboxed session is now abalone sandbox [folder] [options].\n\n${HELP}`), { exit: 2 });
} catch (e) {
  if (couponSlot) await couponSlot.close().catch(() => {});
  console.error(e.message);
  process.exit(e.exit ?? 1);
}
