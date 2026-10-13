#!/usr/bin/env node
// Optional acquisition entry: never imports the launcher or opens an agent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { creditId, creditPreflight, giftPaste, readPrivate } from "../../lib/credit-store.mjs";
import { terminalLine } from "../../lib/coupon-input.mjs";

export const HELP = `Redeem a gift for private inference access, without opening an agent.
  node plugins/coupon/acquire.mjs --trial /path/trial.json
  node plugins/coupon/acquire.mjs --trial /path/trial.json --input-file /private/gift.txt
  node plugins/coupon/acquire.mjs --recover CREDIT_ID
  node plugins/coupon/acquire.mjs --status
The gift is read privately; never put its code in command arguments.
This acquisition tool currently needs Linux and flock. It keeps the existing
credential and recovery records; it does not export keys or change Pi settings.`;
const usageError = (message) => Object.assign(new Error(message), { safeMessage: true });

export function acquisitionArgs(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--status" && !options.status) { options.status = true; continue; }
    if (!["--trial", "--input-file", "--recover"].includes(flag) || options[flag]) throw usageError("Use --help for acquisition options. Gift codes never belong in arguments.");
    const value = args[++i];
    if (!value || value.startsWith("--")) throw usageError("An acquisition option is missing its value; use --help.");
    options[flag] = value;
  }
  if (options["--recover"] && !/^[0-9a-f]{64}$/.test(options["--recover"])) throw usageError("Recovery needs the saved credit ID, not a gift code.");
  if ((options.status || options["--recover"]) && (options["--trial"] || options["--input-file"]) || options.status && options["--recover"])
    throw usageError("Choose status, recovery, or redemption; use --help.");
  if (!options.status && !options["--recover"] && !options["--trial"]) throw usageError("Redemption needs --trial /path/trial.json from the gift's public bundle.");
  return options;
}

const safe = (s) => String(s ?? "unknown").replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 200);
export const offerText = (s) => ["Private inference gift", `Model: ${safe(s.model)}`,
  `Access: $${safe(s.nominalCapUsd)} nominal cap; remaining balance unknown`,
  `Claim window: ${safe(s.claimWindow ?? s.claimWindowExpiresAt)}`, `Provider expires: ${safe(s.providerExpiry)}`,
  `Sponsor powers: ${Array.isArray(s.sponsorPowers) && s.sponsorPowers.length ? s.sponsorPowers.map(safe).join(", ") : "none stated"}`,
  `Per request: ${safe(s.requestMaxTokens)} output tokens`,
  `Firmware policy: ${s.outOfDateException ? "verified outdated firmware accepted with warning" : safe(s.providerTcbPolicy)}`,
  `State: ${safe(s.state)}`,
  "The operator can access and revoke this credential; caps may overshoot. Synthetic material only.",
  `Saved credit: ${s.creditId}`].join("\n");

// Dependency seams let the refusal and interrupted-claim paths be exercised
// without contacting an issuer. Production uses the reviewed credit manager.
export async function acquire({ options, manager, admission, input, confirm, output = console.log }) {
  if (options.status) {
    const records = await manager.status();
    output(records.length ? records.map(offerText).join("\n\n") : "No saved coupon access. Open your gift link to begin.");
    return;
  }
  const id = options["--recover"];
  if (id) {
    await manager.redeem(id, { recover: true });
    output(`Recovered private inference access. Saved credit: ${id}\nOpen it with the existing Abalone client: abalone credit session --credit ${id}`);
    return;
  }
  const coupon = giftPaste(await input());
  const offer = await manager.inspect(coupon, admission);
  output(offerText(offer));
  if (offer.state === "installed") { output(`Already redeemed. Open it with: abalone credit session --credit ${offer.creditId}`); return; }
  if (offer.state !== "offered") { output("This gift cannot be claimed now. Check its deadline or recover an interrupted claim; no new claim was sent."); return; }
  const consent = offer.offerHash.slice(0, 8);
  if ((await confirm(`To accept this offer, type ${consent}; anything else cancels: `)).trim() !== consent) {
    output("Cancelled. Nothing was claimed."); return;
  }
  try { await manager.redeem(offer.creditId, { offerHash: offer.offerHash }); }
  catch (error) {
    if (error?.code === "credit_not_claimed") { output("No authorized claim is reserved. Run redemption again with the original gift and review its terms before accepting; keep the saved records."); return false; }
    if (error?.code === "claim_expired") { output("The gift's claim window closed. Ask its sender for new access; recovery cannot reopen it."); return false; }
    if (error?.code === "reconciliation_required") { output("This claim needs the issuer's operator to reconcile it. Keep the saved records; do not start another claim."); return false; }
    if (["credit_intent_required", "credit_locked", "credit_store_refused", "credit_record_refused", "credit_provider_unsupported", "staging_approval_expired"].includes(error?.code)) {
      output("Redemption was refused before a usable result. Check saved status and the matching public bundle; do not replace recovery records."); return false;
    }
    output(`Redemption did not complete. Keep the saved recovery records. Recover with:\nnode plugins/coupon/acquire.mjs --recover ${creditId(coupon)}`);
    return false;
  }
  output(`Private inference access saved. No agent was opened.\nOpen it with the existing Abalone client: abalone credit session --credit ${offer.creditId}\nThis NEAR coupon is not a Chutes credential.`);
}

export async function main(args = process.argv.slice(2)) {
  const options = acquisitionArgs(args);
  if (options.help) return void console.log(HELP);
  creditPreflight();
  const { createCreditManager } = await import("../../lib/credit.mjs");
  let admission;
  if (options["--trial"]) {
    const { loadTrial } = await import("../../tools/coupon-first-use.mjs");
    const trial = loadTrial(path.resolve(options["--trial"]));
    admission = { peer: trial.bundle.issuer.peer, pin: trial.pin,
      approval: fs.readFileSync(path.join(trial.base, trial.bundle.issuer.approval)).toString("base64"),
      approvalRoot: trial.bundle.issuer.approvalRoot, provider: trial.bundle.provider };
  }
  const manager = createCreditManager({ directory: path.join(process.env.ABALONE_DIR ?? path.join(os.homedir(), ".abalone"), "credit") });
  const result = await acquire({ options, manager, admission,
    input: () => options["--input-file"] ? readPrivate(path.resolve(options["--input-file"]), 2048).toString()
      : terminalLine("Gift link or code (hidden): ", { hidden: true }),
    confirm: (prompt) => terminalLine(prompt, { fresh: true }) });
  if (result === false) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    const message = error.safeMessage ? error.message : error.code === "credit_flock_unavailable" ? "Coupon acquisition currently needs Linux and the flock command."
      : error.code === "claim_expired" ? "The claim window closed. Ask the sender for a new gift."
      : error.code === "reconciliation_required" ? "This claim needs the issuer's operator to reconcile it; keep the saved recovery records."
      : error.code === "credit_not_claimed" ? "This gift was not claimed. Run redemption with the original gift and review its terms."
      : error.code === "claim_not_reserved" ? `The earlier claim is uncertain. Keep the original records and recover with: node plugins/coupon/acquire.mjs --recover ${process.argv.slice(2).includes("--recover") ? process.argv[process.argv.indexOf("--recover") + 1] : "CREDIT_ID"}`
      : "Coupon acquisition stopped. Check the public bundle, input permissions and saved status. No agent was opened; use --help for options.";
    console.error(message); process.exitCode = 1;
  });
}
