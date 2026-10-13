// Usability gate parts 3 and 4, offline: a cold run from the redeem link to an open credit session, through the real
// CLI (`credit inspect`, `redeem`, `status`, `session --mode rpc`), once with a valid offer and once with an expired one;
// then through the front door, plain `abalone` at a pseudo-terminal (pty.py), once to an open session and once interrupted.
// Every line a recipient sees is recorded. Synthetic boundaries: issuer-hook.mjs (loopback issuer, synthetic identity
// verdict) and tests/fixtures/near/synthetic-near-hook.mjs (NEAR verdict and transport); nothing else is substituted.
// The expired journey redeems the loopback issuer's own terms with the recorded fixture's deadline; that issuer refuses
// a late claim and reports the window closed, as the real issuer did (a client that sends the claim ends uncertain).
// The recorded expired offer itself is checked on its own (expired-fixture), against its paired producer's issuer.
// Usage: node tests/usability/cold-run.mjs <out-dir>. Prints PASS|FAIL <id>: <what>; writes cold-run.json, session.env.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { issuer, bundle, terms, coupon, id } from "../lib/credit-fixture.mjs";
import { creditOfferBound } from "../../lib/credit.mjs";
import { FIRST_USE_SOURCE_FILES } from "../../tools/coupon-first-use.mjs";
import { OUT_OF_DATE_TRIAL_POLICY } from "../../lib/near.mjs";

const root = path.resolve(import.meta.dirname, "../.."), out = path.resolve(process.argv[2]);
const AGREED = ["banner", "coupon", "status"];
const NEXT = /(^|[.;:!]\s+|\n\s*)(run|ask|retry|use|review|accept|restore|reinstall|start|supply|remove|open|type|request|get|contact|wait|paste|configure)\b/i;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const check = (name, ok, detail = "") => console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
const expiredOffer = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures/expired-offer.json"), "utf8"));
const paired = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/coupon/durable/paired/dstack-v1-recipient-v1.json"), "utf8"));

// The recorded expired offer is well formed for the paired producer's issuer, scope and budget: only a deadline check can refuse it.
const info = paired.issuer_info.response.result;
let wellFormed = true;
try { creditOfferBound("near", expiredOffer.offer, expiredOffer.offer_hash, expiredOffer.coupon, info, { approval: { deliveryProfile: paired.approval.payload.delivery_profile, nativeAuthority: false,
  payload: { provider_scope_commitment: paired.approval.payload.provider_scope_commitment }, maxCouponNanoUsd: paired.approval.payload.max_coupon_nano_usd },
  peerId: paired.config.payload.issuer_peer_id, pin: { identityPolicy: {}, expectedIssuerPublicKeySha256: sha(Buffer.from(info.issuer_public_key_hex, "hex")) } }); }
catch { wellFormed = false; }
check("expired-fixture: the recorded expired offer passes the offer and binding validators", wellFormed && Date.parse(expiredOffer.offer.claim_expires_at) < Date.now());

async function setup(label, claimExpiresAt) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `abalone-usability-${label}-`));
  const [state, home, xdg, work, trial] = ["state", "home", "x", "work", "trial"].map((n) => { const d = path.join(base, n); fs.mkdirSync(d, { mode: 0o700 }); return d; });
  const server = await issuer();
  server.state.offer = bundle({ ...terms(server.host.peerId.toString()), claim_expires_at: claimExpiresAt });
  if (label === "expired") Object.assign(server.state, { claim: "refuse", status: "ready", claimExpired: true });
  const provider = { ...server.admission.provider, policy: { ...server.admission.provider.policy, gatewayTcb: OUT_OF_DATE_TRIAL_POLICY, modelTcb: OUT_OF_DATE_TRIAL_POLICY } };
  fs.writeFileSync(path.join(trial, "pin.json"), JSON.stringify(server.admission.pin));
  fs.writeFileSync(path.join(trial, "approval.json"), Buffer.from(server.admission.approval, "base64"));
  fs.writeFileSync(path.join(trial, "trial.json"), JSON.stringify({ version: 1, profile: "debug-staging-incognito-synthetic-prompts", platform: "linux-node24-owned-host",
    issuer: { peer: server.admission.peer, privateRoute: "loopback synthetic fixture", pin: "pin.json", approval: "approval.json", approvalRoot: server.admission.approvalRoot },
    provider, source: { profile: "reviewed-development-source-v1", files: Object.fromEntries(FIRST_USE_SOURCE_FILES.map((f) => [f, sha(fs.readFileSync(path.join(root, f)))])) }, vpn: null }));
  // What the redeem page hands over: its full link, saved privately.
  const link = path.join(home, "gift-link.txt");
  fs.writeFileSync(link, `https://amiller.github.io/abalone/redeem/#code=${coupon}\n`, { mode: 0o600 });
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: home, ABALONE_DIR: state, XDG_RUNTIME_DIR: xdg, TMPDIR: base, ABALONE_SYNTHETIC_NEAR_LOG: path.join(base, "near.jsonl") };
  return { base, server, trial: path.join(trial, "trial.json"), link, env, work, steps: [] };
}

function runner({ env, work, steps }) {
  const run = (hook, argv, rpc) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", path.join(root, hook), path.join(root, "bin/abalone.mjs"), ...argv], { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", buf = "", commands;
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdout.on("data", (d) => {
      stdout += d; if (!rpc) return; buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (ev.type === "response" && ev.command === "get_commands") { commands = ev.data.commands; child.stdin.end(); }
      }
    });
    if (rpc) child.stdin.write(JSON.stringify({ id: "c", type: "get_commands" }) + "\n"); else child.stdin.end();
    child.on("exit", (code) => { const step = { argv: argv.join(" "), code, stdout, stderr, ...(rpc ? { commands } : {}) }; steps.push(step); resolve(step); });
  });
  // At a terminal: plain `abalone` with both synthetic boundaries, answering its prompts; the whole screen is its stderr.
  const terminal = (argv, replies) => new Promise((resolve) => {
    const child = spawn("python3", ["-I", path.join(import.meta.dirname, "pty.py"), "60", JSON.stringify(replies), "--", process.execPath, "--import", path.join(root, "tests/usability/issuer-hook.mjs"),
      "--import", path.join(root, "tests/fixtures/near/synthetic-near-hook.mjs"), path.join(root, "bin/abalone.mjs"), ...argv], { cwd: work, env, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("exit", () => { const r = JSON.parse(out), screen = r.output.replace(/\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[@-Z\\-_])/g, "").replaceAll("\r", "");
      const step = { argv: `(terminal) abalone ${argv.join(" ")}`.trim(), code: r.code, stdout: "", stderr: screen, unanswered: r.unanswered, timedOut: r.timedOut };
      steps.push(step); resolve(step); });
  });
  return { run, terminal };
}

async function journey(label, claimExpiresAt) {
  const { base, server, trial, link, env, work, steps } = await setup(label, claimExpiresAt), { run } = runner({ env, work, steps });
  const hook = "tests/usability/issuer-hook.mjs", common = ["--trial", trial, "--input-file", link];
  const inspect = await run(hook, ["credit", "inspect", ...common]);
  const offerHash = inspect.code === 0 ? JSON.parse(inspect.stdout).offerHash : "0".repeat(64);
  const redeem = await run(hook, ["credit", "redeem", ...common, "--accept-offer", offerHash]);
  const claims = server.frames.filter((f) => f.op === "claim").length;
  await server.host.stop();
  const status = await run(hook, ["credit", "status"]);
  const session = JSON.parse(redeem.stdout || "{}").state === "installed" ? await run("tests/fixtures/near/synthetic-near-hook.mjs", ["credit", "session", "--credit", id, "--mode", "rpc"], true) : null;
  return { label, base, env, work, steps, inspect, redeem, status, session, claims };
}

// The front door at a terminal: plain `abalone` explains the ways in, takes the pasted link (with a stray second line that
// must not answer the consent prompt), shows the terms, asks for the offer hash's first 8 characters, redeems and opens the
// session (quit with ctrl-d). "door-interrupted" pastes the private
// link file instead, first declines the offer, then accepts while its issuer fails the claim, so the redemption is left for credit recover.
async function frontDoor(label) {
  const { base, server, trial, link, env, work, steps } = await setup(label, "2030-10-10T00:00:00Z"), { run, terminal } = runner({ env, work, steps });
  if (label === "door-interrupted") Object.assign(server.state, { claim: "refuse", status: "ready" });
  const hook = "tests/usability/issuer-hook.mjs", explain = await run(hook, []), paste = ["Gift link, code or file", `${label === "door" ? `https://amiller.github.io/abalone/redeem#code=${coupon}\rstray-second-line` : link}\r`];
  const declined = label === "door" ? null : await terminal(["--trial", trial], [paste, ["type ([0-9a-f]{8});", "no\r"]]);
  const claimsBeforeAccept = server.frames.filter((f) => f.op === "claim").length, credit = path.join(env.ABALONE_DIR, "credit");
  const leftAfterDecline = fs.existsSync(credit) ? fs.readdirSync(credit) : [];
  const door = await terminal(["--trial", trial], [paste, ["type ([0-9a-f]{8});", "{1}\r"], ...(label === "door" ? [["────", "\x04"]] : [])]);
  const claims = server.frames.filter((f) => f.op === "claim").length;
  await server.host.stop();
  const after = await run(hook, label === "door" ? ["credit", "status"] : []);
  return { label, base, steps, explain, declined, claimsBeforeAccept, leftAfterDecline, door, after, claims };
}

const valid = await journey("valid", "2030-10-10T00:00:00Z"), expired = await journey("expired", expiredOffer.offer.claim_expires_at);
const door = await frontDoor("door"), interrupted = await frontDoor("door-interrupted");
const parsed = (step) => { try { return JSON.parse(step.stdout); } catch { return null; } };
check("cold-valid-inspect: a valid offer inspects as offered", valid.inspect.code === 0 && parsed(valid.inspect)?.state === "offered", valid.inspect.stderr.trim().split("\n").at(-1));
check("cold-valid-redeem: redeeming with the shown offer hash installs the credit", valid.redeem.code === 0 && parsed(valid.redeem)?.state === "installed", valid.redeem.stderr.trim().split("\n").at(-1));
check("cold-valid-session: the saved credit opens a session", valid.session?.code === 0 && Array.isArray(valid.session.commands), valid.session?.stderr.trim().split("\n").at(-1));
const names = (valid.session?.commands ?? []).filter((c) => c.source === "extension").map((c) => c.name).sort();
check(`commands: a credit session shows exactly /${AGREED.join(" /")}`, JSON.stringify(names) === JSON.stringify(AGREED), `shown: /${names.join(" /")}`);
check("cold-expired-inspect: an expired offer inspects as expired and says what to do next", parsed(expired.inspect)?.state === "expired" && NEXT.test(expired.inspect.stdout + expired.inspect.stderr), `state: ${parsed(expired.inspect)?.state}`);
check("cold-expired-no-claim: redeem sends no claim for an expired offer", expired.claims === 0, `claims sent: ${expired.claims}`);
check("cold-expired-redeem: redeem of an expired offer says it expired and what to do next", expired.redeem.code !== 0 && /expired|claim window closed/i.test(expired.redeem.stderr) && NEXT.test(expired.redeem.stderr),
  expired.redeem.stderr.trim().split("\n").at(-1) || parsed(expired.redeem)?.state);
check("door-explain: plain abalone with nothing saved names both ways in; without a terminal it exits 2", door.explain.code === 2
  && ["Paste a gift link or code into abalone at your terminal", "not a terminal", "abalone credit inspect --trial", "abalone key add <provider>", "guides/acquiring-private-inference/"].every((t) => door.explain.stderr.includes(t)), door.explain.stderr.trim().split("\n").at(-1));
check("door-terms: a pasted link shows the inspect terms, then asks for the offer hash's first 8 characters", ["\"nominalCapUsd\"", "\"model\"", "\"providerExpiry\"", "\"sponsorPowers\"", "\"claimWindow\"", "\"disclosures\""]
  .every((t) => door.door.stderr.includes(t)) && /type [0-9a-f]{8};/.test(door.door.stderr));
check("door-redeem: typing them redeems and saves the credit", door.door.stderr.includes("Redeemed and saved") && parsed(door.after)?.[0]?.state === "installed" && door.claims === 1, `claims sent: ${door.claims}`);
check("door-session: the same run opens the session", door.door.code === 0 && !door.door.timedOut && !door.door.unanswered.length && door.door.stderr.includes("Fresh incognito conversation"),
  `exit ${door.door.code}, unanswered: ${door.door.unanswered.join(" | ")}`);
check("door-decline: typing anything else stops without a claim, says so and leaves nothing on disk", interrupted.declined.code === 1 && interrupted.claimsBeforeAccept === 0
  && interrupted.declined.stderr.includes("Not accepted, so nothing was claimed") && !interrupted.leftAfterDecline.length, `${interrupted.declined.stderr.trim().split("\n").at(-1)}; left: ${interrupted.leftAfterDecline.join(" ")}`);
check("door-paste-drain: a stray second pasted line answers no prompt and never reaches the session", door.door.stderr.includes("Redeemed and saved") && !door.door.stderr.includes("stray-second-line"));
check("door-no-echo: the pasted gift never appears on screen", ![door.door, interrupted.declined, interrupted.door].some((s) => s.stderr.includes(coupon)));
check("door-recover: an interrupted redemption says to run credit recover, and plain abalone then names the recover command", interrupted.claims === 1 && interrupted.door.code === 1
  && interrupted.door.stderr.includes(`Run abalone credit recover --credit ${id}.`) && interrupted.after.code === 2 && interrupted.after.stderr.includes(`abalone credit recover --credit ${id}`), interrupted.door.stderr.trim().split("\n").at(-1));
const errors = [...valid.steps, ...expired.steps, ...door.steps, ...interrupted.steps].filter((s) => s.code !== 0);
const silent = errors.filter((s) => !NEXT.test(s.stderr.split("\n").filter((l) => !l.startsWith("SYNTHETIC FIXTURE")).join("\n")));
check("cold-errors: every error a recipient sees says what to do next", silent.length === 0, silent.map((s) => s.argv.split(" --")[0]).join(", "));

const keep = ({ label, steps, claims }) => ({ label, claimsSent: claims, steps: steps.map(({ argv, code, stdout, stderr, commands }) => ({ argv: argv.replaceAll(/\/tmp\/[^ ]+\//g, "<tmp>/"), code,
  stdout: stdout.split("\n").filter(Boolean), stderr: stderr.split("\n").filter(Boolean), ...(commands ? { commands: commands.map((c) => `${c.source}:${c.name}`) } : {}) })) });
fs.writeFileSync(path.join(out, "cold-run.json"), JSON.stringify({ valid: keep(valid), expired: keep(expired), door: keep(door), interrupted: keep(interrupted) }, null, 1) + "\n");
// The TUI capture reuses the valid journey's saved credit and folder.
fs.writeFileSync(path.join(out, "session.env"), Object.entries({ ...valid.env, USABILITY_WORK: valid.work, USABILITY_CREDIT: id, USABILITY_BASES: [valid, expired, door, interrupted].map((j) => j.base).join(" ") })
  .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join("\n") + "\n");
