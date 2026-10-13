// The session's first screen and /about. The header is a few lines from runtime state: where you are, the model and
// its place, and the hints that matter. What abalone is built from (Pi, extensions, skills) is under /about.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE, manifest, place } from "./config.mjs";
import { wrap } from "./ui/layout.mjs";
import { protocol } from "./intools.mjs";
import { sessionPolicy } from "./ui/session-policy.mjs";

export function header({ cwd, model, width, policy }) {
  const home = os.homedir(), where = cwd === home || cwd.startsWith(home + "/") ? "~" + cwd.slice(home.length) : cwd;
  const n = fs.readdirSync(cwd).length;
  if (policy) return [...wrap(`abalone · ${where} (${n} entries)`, width),
    ...sessionPolicy({ ...policy, model }).flatMap((row) => typeof row === "string" ? [row] : wrap(`${row.label}: ${row.text}`, width)),
    ...wrap(n ? "@file to include a file" : 'Empty folder: try "Explain private inference in two sentences."', width),
    ...wrap(`/banner art · ${process.env.ABALONE_COUPON_SOCKET ? "/status · /coupon" : "/privacy · /evidence"}`, width)];
  // Strict incognito has no approval route, so its header says what it allows instead.
  const rule = process.env.ABALONE_OWNED_HOST === "1" ? "incognito on a trusted host: admitted inference; local tools are not isolated" : process.env.ABALONE_INCOGNITO === "1" ? "strict incognito: only this computer and admitted TEEs (◈) receive anything; nothing else can leave"
    : "nothing goes to an outside model unless you approve it";
  return [...wrap(`abalone · ${where} (${n} entries) · abalone reads files here on this computer; ${rule}`, width),
    ...wrap(`Model: ${model}${process.env.ABALONE_COUPON_SOCKET ? "" : " · /model to change"}`, width),
    ...wrap(process.env.ABALONE_COUPON_SOCKET ? "@file to include a file · /status · /coupon · /quit closes this session"
      : process.env.ABALONE_INCOGNITO === "1" ? "@file to include a file · /model for another ⌂ or ◈ model · /evidence · /privacy · /quit closes this session"
      : "@file to include a file · /model to choose where work runs · /folder to switch folders · /evidence · /notebook · /about", width)];
}

export function about() {
  const pi = JSON.parse(fs.readFileSync(new URL("../vendor/pi/packages/coding-agent/package.json", import.meta.url), "utf8"));
  // The component list first, so the lines a reader looks for (Pi, Tor, missing tools) stay on screen at the bottom.
  return ["Loaded only from agents/pi/admitted.json (checked by sha256 at every start):",
    ...manifest().entries.map((e) => `  ${e.kind.padEnd(9)} ${e.path}  ${e.sha256?.slice(0, 12) ?? ""}`),
    `abalone is built on Pi ${pi.version} (vendor/pi/packages/coding-agent), with Pi's own providers, extensions and skills off.`,
    "Pi can explain its own features and look up its docs: ask it how to use or extend Pi.",
    "Tor: built in (Arti compiled to WebAssembly, tor-js 0.4.1, adapted from Agent Boost's route), started by the launcher on the first sealed /fetch; state in <ABALONE_DIR>/tor (0700).",
    ...[["fd", "@ autocomplete lists fewer files"], ["rg", "Pi's grep tool cannot run; the NEAR tool protocol's grep uses the system grep"]]
      .map(([t, effect]) => `${t}: ${spawnSync("bash", ["-c", `command -v ${t}`]).status === 0 ? "installed" : `not installed, so ${effect}`}`)].join("\n");
}

// The system prompt: who the agent is and what the user can do, from config and the selected model. Never Pi's.
export function systemPrompt({ cwd, model, place, tools, usage, browser }) {
  const coupon = !!process.env.ABALONE_COUPON_SOCKET;
  return `You are abalone, a private research agent working for one person on their own computer. You help them read,
understand and organize the material in their workspace folder, and you keep it private.

Workspace folder: ${cwd}. ${process.env.ABALONE_OWNED_HOST === "1" ? `Local tools have this ordinary account’s filesystem and network access. They are not OS-isolated. Use only the user-selected files and tasks; do not claim the shell has no network.` : browser ? `The workspace has no network. The user has granted you one browser tab (below);
you cannot reach any other website, tab or browser, and cannot search the web.` : `The workspace has no network and no browser: you cannot open websites, search the web or
reach anything outside this computer. When asked to, say so plainly${coupon ? "" : ", and say the user can grant a browser tab with /browser"}.`}
Selected model (you): ${model}, ${place === "⌂ local" ? "running on this computer" : place === "◈ attested" ? "running in a remote TEE that abalone verified before the first byte" : "outside"}.

What the user can do in this session:
- @path in a message includes that file; abalone reads it on this computer and adds it to the message.
${coupon ? `- /status shows usage, what abalone keeps and who can see it; /coupon shows the saved credit's state and limits.
  No other abalone command works in this session; the model is fixed for it.` : `- /model chooses where work runs: ⌂ local (this computer), ◈ attested (a verified TEE), or ○ outside (for example
  Claude on the user's own subscription). An outside model never sees the conversation: abalone's private side
  reads it first and the user approves the exact text that leaves.
- /folder <path> switches to another folder (abalone restarts there; only that folder is visible), as does
  starting abalone with the folder: abalone sandbox <folder>.
- /fetch <https url> or /fetch arxiv:<id> brings a public document into the folder. You cannot fetch anything
  yourself; when a public paper would help, suggest the exact /fetch line and the user decides.
- /evidence shows what was verified; /notebook and /search are the user's private notebook; /cost shows spend;
  /privacy shows what abalone keeps and who can see it; /about lists components.
- /browser grant lets you use one tab of a browser on the sites the user chooses. The user controls it: /browser take
  takes the tab from you and /browser give hands it back; /browser stop (or Esc) cancels your op in flight;
  /browser detach and /browser reconnect leave and rejoin the tab; /browser revoke ends the grant.`}

${tools === "in-content" ? protocol(browser) : (process.env.ABALONE_OWNED_HOST === "1" ? "Use your tools to look at the user-selected workspace; bash has ordinary-account access and is not isolated." : "Use your tools to look at the workspace (bash runs in a sandbox with no network).")}

${INCOGNITO()}Session usage, from abalone's accounting (you have no other way to see it): ${usage.replace(/\n/g, " ")}
${coupon ? "/status shows it to the user, with what abalone keeps on disk and who can see what." : "/cost shows it to the user; /privacy shows what abalone keeps on disk and who can see what."}

Do not tell the user where their data goes or that "nothing leaves this machine": after each answer abalone shows a
"sent to" line from measured state (which model and place received the conversation, and which files were read
into it). If asked, point to that line and to ${coupon ? "/status" : "/privacy"}.

Answer from the material you can see, and cite file lines as [L<n>] when you rely on them; for a PDF also give the page
([p<n> L<m>]), and the section number when the document numbers its sections. Where the exact wording matters, quote
the words you rely on, and no more. If you need a file you cannot see, say which one and how to include it. Never describe yourself as Pi or as a demonstration.`;
}

// Strict incognito, from the launcher's session descriptor (not from a setting the model or user can change here).
const descriptor = () => process.env.ABALONE_INCOGNITO === "1" ? JSON.parse(fs.readFileSync(process.env.ABALONE_SESSION_DESCRIPTOR, "utf8")) : null;
const INCOGNITO = () => { const d = descriptor(); if (d?.local_boundary === "trusted-owned-host") return `This is an INCOGNITO SESSION ON A TRUSTED OWNED HOST. Model inference remains pinned to the admitted coupon provider and encrypted to its verified model; no other inference credential or automatic paid replay is used. Local tools are NOT isolated: they have your ordinary account’s filesystem and network access. /fetch, /browser and /folder remain off. The host administrator and same-user processes can inspect this session. ${d.retention.kind === "encrypted-trace" ? "An encrypted conversation trace is retained by explicit choice." : "No conversation trace is retained."} Pi’s managed state and logs use tmpfs; it can swap, and workspace/tool-created files and terminal output can remain. This is not secure erasure or IP anonymity.\n\n`; return d ? `This session is STRICT INCOGNITO (abalone sandbox --incognito). It overrides anything above about outside models, /fetch,
/browser and /folder: those are off. Inference goes only to ⌂ local or ◈ attested models; nothing goes to an outside party; the shell
has no network. ${d.retention.kind === "encrypted-trace" ? `The conversation is recorded as an encrypted trace, ${d.retention.trace}, encrypted to trace key ${d.retention.key_id} (kept outside the folder under the user's passphrase). This session cannot read it back.` : "Session-only retention: no conversation trace is retained. This does not erase workspace files or terminal output."} Pi's
session, logs and scratch are kept in memory only. Files written in the folder are ordinary unencrypted files.

` : ""; };
export const incognitoPlain = () => { const d = descriptor(); return d && [d.local_boundary === "trusted-owned-host" ? "Mode: incognito on trusted owned host; no OS/tool isolation." : `Mode: strict incognito.`,
  d.retention.kind === "encrypted-trace" ? `Recorded: this conversation, as an encrypted trace: ${d.retention.trace}. It is encrypted to trace key ${d.retention.key_id}; only that key's passphrase unlocks it (${d.retention.key_file}, outside this folder). This session cannot read it back.` : "Recorded: no conversation trace. This session keeps its conversation in memory only.",
  `Not recorded: Pi's session files, logs, notebook and scratch are in memory only and are gone when the session ends. abalone keeps the host names this session connects to (egress.jsonl).`,
  `Not encrypted: files you or the agent write in ${d.workspace}; what your terminal shows.`,
  d.local_boundary === "trusted-owned-host" ? "Who can see your words: the admitted model and anyone who can inspect this ordinary account or host. Local tool filesystem/network access is not isolated; no inference fallback is used." : `Who can see your words: the model below, and anyone who can read this computer's memory or your key and passphrase. No outside model, website, browser tab or shell network: they are off in this mode.`,
  d.retention.kind === "encrypted-trace" ? `After closing: abalone trace open ${d.workspace} <id> reads it; abalone sandbox --incognito ${d.workspace} --with-trace <id> continues from it; abalone trace delete removes it.` : `After closing: there is no transcript to reopen.${process.env.ABALONE_COUPON_SOCKET ? "" : " Choose --keep-trace before starting if you want an encrypted retained trace."}`, ""].join("\n"); };

// /privacy: what abalone keeps, where, in what mode, measured now; who can see what, from the capability document.
const KEPT = [["agent/sessions", "conversation transcripts (Pi sessions), including file text read into them"], ["notebook", "notebook sources, quotes, conclusions, decisions and index"],
  ["disclosures.jsonl", "every pour: released text, or hash and size when not sent"], ["agents.jsonl", "agent spawns and first-crack reads (file names and hashes)"],
  ["egress.jsonl", "every outbound connection: host and whether it was allowed"], ["private-out", "private answers kept for ask_abalone"], ["approvals", "pending pours and standing policies"],
  ["evidence.json", "the latest verifier result per model"], ["canaries", "the canary values for each workspace"], ["credit", "saved credits, and configured provider API keys with when each was last used"], ["coupon.json", "a redeemed gift's device key"]];
export function privacy({ cwd, model, doc }) {
  const mode = (p) => { const s = fs.statSync(p); return `${s.isDirectory() ? "dir" : "file"} ${(s.mode & 0o777).toString(8)}`; };
  return [`Privacy (measured now; model text cannot change this)`,
    `Workspace: ${cwd}. Tools and @file reads run on this computer; the selected model is ${place(model.provider)} ${model.provider}/${model.id}.`,
    `Kept on this computer under ${STATE}, ${doc.encrypted_at_rest ? "encrypted" : "not encrypted"} at rest:`,
    ...KEPT.filter(([p]) => fs.existsSync(path.join(STATE, p))).map(([p, what]) => `  ${p} (${mode(path.join(STATE, p))}): ${what}`),
    "Nothing is deleted automatically; /notebook rm and deleting the files above are the ways out.",
    "Who sees what:", ...doc.observers.map((o) => `  ${o.observer}: ${o.sees}`),
    "Limits:", ...doc.limitations.map((l) => `  - ${l}`)].join("\n");
}

// Spend, from the usage abalone recorded for each answer in this session, and the gift balance the gift peer reported.
// A coupon session's model has no price: it shows reported tokens, never a $0 figure.
export function usage(entries, couponSession = false) {
  const us = entries.filter((e) => e.type === "message" && e.message.role === "assistant" && e.message.usage).map((e) => e.message.usage);
  const sum = (k) => us.reduce((s, u) => s + (k === "cost" ? u.cost.total : u[k]), 0);
  if (couponSession) return us.some((u) => u.input || u.output) ? `This session: ${us.length} answers, ${sum("input")} input and ${sum("output")} output tokens as the provider reported (not priced; balance unknown).`
    : `This session: ${us.length} answers; usage: not reported.`;
  return `This session: ${us.length} answers, ${sum("input")} input and ${sum("output")} output tokens, $${sum("cost").toFixed(4)} at list price.`;
}
export function spend({ entries, coupon, couponSession = false }) {
  if (couponSession) return usage(entries, true);
  const charge = entries.filter((e) => e.type === "custom" && e.customType === "gift-charge").at(-1);
  const usd = (micro) => `$${(micro / 1e6).toFixed(4)}`;
  return [usage(entries),
    coupon ? (charge ? `Gift from ${coupon.from}: ${usd(charge.data.remaining)} left of ${usd(coupon.amount)} (as the gift peer reported after the last answer).`
      : `Gift from ${coupon.from}: ${usd(coupon.amount)} at redemption; no answer charged to it in this session yet.`) : "No gift on this computer: spend goes to the configured key."].join("\n");
}

// /privacy for a researcher; the version with the technical terms is /privacy --details.
export function privacyPlain({ cwd, model, run }) {
  const where = place(model.provider);
  if (descriptor()) return incognitoPlain() + `Model: ${model.provider}/${model.id} (${where}).`;
  // This session's connections, from the launcher's egress log (each entry carries the session's run id).
  const egress = path.join(STATE, "egress.jsonl"), seen = {};
  for (const e of fs.existsSync(egress) ? fs.readFileSync(egress, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.run === run) : [])
    seen[`${e.host}${e.allowed ? "" : " (refused)"}`] = (seen[`${e.host}${e.allowed ? "" : " (refused)"}`] ?? 0) + 1;
  return [`What abalone keeps: your conversations, your notebook, and a record of anything sent to an outside model.`,
    `Where: on this computer, in ${STATE}. Only your user account can open those files. They are not encrypted, so anyone who can log in as you can read them.`,
    `Nothing is deleted automatically. /notebook rm removes a source and everything derived from it; deleting ${path.join(STATE, "agent", "sessions")} removes the conversations.`,
    "",
    "Who can see your words:",
    "- This computer: everything.",
    where === "⌂ local" ? `- The model (${model.id}) runs on this computer.`
      : where === "◈ attested" ? `- The model (${model.id}) runs in a secure enclave that abalone checked before sending anything. Your messages are encrypted to it; the company running it cannot read them if that check holds, but sees when you use it and how much.`
      : `- The outside model (${model.provider}/${model.id}) sees only text you approved in the review prompt, and its company sees when you sent it and how much.`,
    "- Outside models (for example Claude) see nothing unless you approve the exact text first.",
    `- Files: abalone reads files in ${cwd} on this computer. The model gets the folder's file names and sizes with each message, and a file's text only when you mention it with @ or the model asks to read it.`,
    "",
    "",
    `This session's connections from this computer: ${Object.keys(seen).length ? Object.entries(seen).map(([h, n]) => `${h} ×${n}`).join(", ") : "none yet"}.`,
    "More: /privacy --details (the full list of files, the operators involved and the known limits); /evidence (what was verified)."].join("\n");
}
