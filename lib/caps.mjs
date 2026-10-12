// One capability table: the harness checks tool calls against it, `abalone caps` prints it,
// and the observer view is derived from it. A capability is (holder, action, object, granted_by, expires).
import fs from "node:fs";
import path from "node:path";
import { APPROVALS, ROOT, STATE, PRIVATE_OUT, catalog, localPorts, manifest, policy, providers, standing } from "./config.mjs";
import { resolveToCwd } from "../pi/packages/coding-agent/dist/core/tools/path-utils.js";
import * as nodekeys from "./nodekeys.mjs";

// Strict incognito (abalone sandbox --incognito): set by the launcher in the session's environment.
export const incognito = () => process.env.ABALONE_INCOGNITO === "1";
const OUTSIDE = (r) => r.action === "spawn:open" || r.action === "browse" || r.action === "pour" || r.holder.startsWith("runner:") || r.holder.startsWith("launcher") || r.holder.startsWith("mcp-caller");

export function table(cwd) {
  const rows = allRows(cwd);
  return incognito() ? rows.filter((r) => !OUTSIDE(r)) : rows;
}

function allRows(cwd) {
  const p = providers(), st = standing();
  const cap = (holder, action, object, granted_by) => ({ holder, action, object, granted_by, expires: "session" });
  const runnerHosts = Object.entries(p.runners).flatMap(([r, v]) => v.hosts.map((h) => cap(`runner:${r} ○ outside`, "net", h, "providers.json runners")));
  return [
    ...[cwd, PRIVATE_OUT, path.join(ROOT, "skills")].map((d) => cap("private-agent", "read", path.join(d, "**"), "bin/abalone")),
    cap("private-agent", "write", path.join(cwd, "**"), "bin/abalone"),
    cap("private-agent", "write", path.join(PRIVATE_OUT, "**"), "bin/abalone"),
    ...p.admitted.map((a) => cap("private-agent", "infer", a.upstreams ? `${a.id}/<models whose every upstream session is ${Object.keys(a.upstreams.admit).join(" or ")}, TEE+TCB+GPU asserted> ◈ attested via ${a.upstreams.via}`
      : `${a.id}/* ◈ attested (${a.transport === "aci/1" ? "aci gate" : "per-model attestation"})`, a.upstreams ? "providers.json upstreams (lib/upstream.mjs)" : "providers.json")),
    ...p.local.map((l) => cap("private-agent", "infer", `${l.id}/* ⌂ local (${l.baseUrl})`, "providers.json local")),
    ...[...p.admitted.flatMap((a) => a.hosts), ...p.verifierHosts].map((h) => cap("private-agent", "net", h, "providers.json")),
    ...localPorts().map((port) => cap("private-agent", "net", `127.0.0.1:${port}`, "providers.json local (loopback only)")),
    cap("private-agent", "exec", process.env.ABALONE_OWNED_HOST === "1" ? "bash (ordinary account; filesystem/network not isolated)" : "bash (sandbox, no net)", "curated/manifest.json"),
    ...manifest().entries.flatMap((e) => (e.tools ?? []).map((t) => cap("private-agent", "exec", `tool:${t}`, `curated/manifest.json ${e.path}`))),
    ...Object.entries(st).filter(([a]) => a !== "mcp-caller").flatMap(([a, ids]) => [cap("private-agent", "spawn:open", a === "nearai-outside" ? a : `runner:${a}`, "policy.json answerers"),
      ...ids.map((s) => cap("private-agent", "pour", `${s} → ${a}`, "approvals/standing.json (abalone approvals --standing)"))]),
    cap("private-agent", "browse", "one browser tab the user grants with /browser grant (abalone profile, or a Chrome they attach): page, goto, click, type on the granted sites", "lib/browser.mjs (bridge in the launcher)"),
    cap("bash ⌂ local", "read", process.env.ABALONE_OWNED_HOST === "1" ? "ordinary account filesystem (not isolated)" : `sandbox view (/usr, ${cwd}, the repo and node) minus ${STATE} and the runner logins`, process.env.ABALONE_OWNED_HOST === "1" ? "trusted-owned-host" : "bwrap (lib/sandbox.mjs)"),
    cap("bash ⌂ local", "write", process.env.ABALONE_OWNED_HOST === "1" ? "ordinary account filesystem/network (not isolated)" : path.join(cwd, "**"), process.env.ABALONE_OWNED_HOST === "1" ? "trusted-owned-host" : "bwrap"),
    ...Object.keys(p.runners).map((r) => cap(`runner:${r} ○ outside`, "read", "/work (pour files only)", "bwrap")),
    ...runnerHosts,
    cap("launcher (/fetch, user only)", "net", "any https host on the public route: an arXiv paper ID, or a URL the user chose to fetch publicly", "lib/fetch.mjs"),
    cap("launcher (/fetch, user only)", "net", "the Tor network on the sealed route (built-in Arti, tor-js 0.4.1)", "lib/tor.mjs"),
    cap("mcp-caller ○ outside", "spawn:private", "private-agent", "abalone-mcp"),
    cap("mcp-caller ○ outside", "pour", "* ← ask_abalone, after the user approves it in abalone approvals", "abalone-mcp"),
    ...st["mcp-caller"].map((s) => cap("mcp-caller ○ outside", "pour", `${s} ← ask_abalone (standing: no approval)`, "approvals/standing.json (abalone approvals --standing)")),
  ];
}

const has = (rows, holder, action, test) => rows.some((r) => r.holder.startsWith(holder) && r.action === action && test(r.object));
const under = (p, root) => p === root || p.startsWith(root + path.sep);
// The path a Pi tool will touch, resolved as Pi resolves it (~, @ prefix), then through symlinks when it exists.
const target = (p, cwd) => { const r = resolveToCwd(p ?? ".", cwd); return fs.existsSync(r) ? fs.realpathSync(r) : r; };

// The capability a tool call needs, checked against the table. Returns null, or the missing capability.
export function missing(rows, tool, args, cwd) {
  for (const [action, tools] of [["read", ["read", "grep", "find", "ls"]], ["write", ["edit", "write"]]]) {
    if (!tools.includes(tool)) continue;
    const t = target(args.path, cwd);
    if (under(t, path.join(target(".", cwd), ".abalone"))) return `${action}(${t})`; // the trace store is not workspace
    return has(rows, "private-agent", action, (o) => under(t, target(o.replace(/\/\*\*$/, ""), cwd))) ? null : `${action}(${t})`;
  }
  if (tool === "bash") return null;
  if (tool === "ask_frontier" && incognito()) return "spawn:open (strict incognito has no outside answerer)";
  if (tool === "ask_frontier") return has(rows, "private-agent", "spawn:open", (o) => o === `runner:${args.answerer ?? "claude"}`) ? null : `spawn:open(runner:${args.answerer})`;
  return has(rows, "private-agent", "exec", (o) => o === `tool:${tool}`) ? null : `tool:${tool}`;
}

export function activeKeys() {
  return Object.fromEntries(providers().admitted.map((a) => { const k = nodekeys.active(a.id); return [a.id, k ? `node ⌂ dev (unattested) key ${k.label} …${k.key.slice(-4)}` : "no key"]; }));
}

export function observers() {
  const p = providers();
  const op = p.admitted.map((a) => `${a.id}: ${a.axes.operator}`).join(", ");
  return [
    { observer: "The researcher's machine", sees: "Everything", mechanism: "it runs the harness" },
    { observer: "TEE provider operator", sees: "Nothing in plaintext if attestation holds; operator axis is " + op + ", so operator access is possible, see docs/security.md", mechanism: "ACI §9.1 gate + TCB + production OS, SPKI pinned at handshake; NEAR's code is admitted by its DstackApp on Base", axis: "hw, operator, code" },
    { observer: "Local model server", sees: "Private data (prompts and answers) on this machine", mechanism: "loopback only: providers.json local, egress forwards 127.0.0.1 ports", axis: "place ⌂ local" },
    { observer: "Node (dev)", sees: "Provider API keys; no prompts", mechanism: "devNode: the agent reads the local node keystore. Unattested until the gateway exists", axis: "none" },
    { observer: "Gateway operator", sees: "Not in the path yet (no gateway)", mechanism: "gateway/ not built" },
    { observer: "Frontier vendor", sees: "Released payloads only, plus byte counts, timing and pour counts", mechanism: "runner sandbox: scratch dir holds only the pour; disclosures.jsonl", axis: "gate" },
    { observer: "Intel PCS", sees: "FMSPC/CA of the provider's platform, request timing", mechanism: "collateral fetch during the handshake" },
    { observer: "Tor relays (sealed /fetch)", sees: "The entry relay sees this machine's address, not the destination; the exit relay sees the destination host and timing, not this machine's address", mechanism: "lib/tor.mjs: Arti in WebAssembly, run by the launcher; no direct fallback" },
    { observer: "A /fetch destination", sees: "The URL and timing; on the public route also this machine's address, on the sealed route a Tor exit address", mechanism: "lib/fetch.mjs decide(): public only for a bare arXiv paper URL unless the user overrides" },
    { observer: "Chain", sees: "Nothing yet (no coupons)", mechanism: "contracts/ not wired" },
  ];
}

export function document(cwd) {
  return {
    contract: "org.abalone.caps/0.1",
    claim: process.env.ABALONE_OWNED_HOST === "1" ? "admitted encrypted coupon inference; trusted local host and tools with ordinary-account access, no OS isolation" : incognito() ? "only ⌂ local and ◈ attested providers see plaintext; no outside party receives anything; the session record is encrypted to a key outside the folder"
      : "only attested providers see plaintext, and outside parties see only logged pours",
    guarantees_confidentiality_against_operator: false,
    guarantees_pours_reveal_nothing: false,
    canaries_are_proof: false,
    direct_fallback: false,
    provider_retry_on_failure: false,
    key_rotation_on_failure: false,
    active_keys: activeKeys(),
    capabilities: table(cwd),
    observers: observers(),
    policy_wording_enforced_by_code: false,
    encrypted_at_rest: process.env.ABALONE_OWNED_HOST === "1" ? (process.env.ABALONE_TRACE_RETAINED === "1" ? "optional session trace only (abalone-trace/2); workspace/tool-created files are not encrypted by Abalone" : "no retained conversation trace; workspace/tool-created files are not encrypted by Abalone") : incognito() ? "session trace only (abalone-trace/1 in <folder>/.abalone/traces); files written in the folder are plaintext" : false,
    mode: process.env.ABALONE_OWNED_HOST === "1" ? "owned-host-incognito" : incognito() ? "strict-incognito" : "ordinary",
    enforced_by_code: ["bytes ≤ max_bytes", "session budget", "no control or bidi characters", "no canary value", "metadata_only is JSON matching its schema", "answerer listed in policy.json", "standing or a human approval"],
    policy: { standing: standing(), session_budget_bytes: policy().session_budget_bytes, catalog: Object.keys(catalog()) },
    limitations: [
      ...(process.env.ABALONE_OWNED_HOST === "1" ? ["Local filesystem and tool-network isolation are deferred. Bash runs with ordinary-account access; same-user processes and the host can inspect session memory and files. Managed state is tmpfs, which can swap; tool-created/workspace files and terminal output may persist."] : []),
      "PRECONDITION: the calling agent must have no shell or file tools (launch it with claude --tools \"\"), or abalone must run as a separate user (abalone setup --separate-user). On a single-user machine an agent with a shell IS the user: it can read the folder and approve its own pours",
      "byte counts, latency and pour counts are side channels visible to the frontier vendor",
      "canaries are a plumbing check, not proof of confidentiality",
      "a stock Claude Code session opened on this machine can still read private-out/",
      "a policy's allows/forbids wording is an instruction to the private model; code checks only the items in enforced_by_code",
      ...(incognito() && process.env.ABALONE_OWNED_HOST !== "1" ? ["strict incognito: the session trace is encrypted to the key in $ABALONE_DIR/keys; any process running as this user (or root) can read that key and the live session's memory; tmpfs can swap; the terminal keeps what it showed; files written in the folder are plaintext; deleting the trace file cannot be distinguished from an interrupted close"]
        : process.env.ABALONE_OWNED_HOST === "1" ? [] : ["plaintext at rest: private-out/, agent/sessions/, approvals/pending/ and disclosures.jsonl hold private text unencrypted (files 0600, dirs 0700)"]),
      "without canaries (--no-canaries) nothing deterministic catches a verbatim copy of a file under a policy the user approves",
      "the node is a dev stand-in (devNode): keys are read locally and nothing is attested",
    ],
  };
}
