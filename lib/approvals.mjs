// Pours waiting for the human, and `abalone approvals`, where the human decides them in their own terminal.
// abalone-mcp writes <APPROVALS>/pending/<id>.json; only this UI writes <id>.decision.json and standing.json.
// No MCP method approves. A process running as the same user can still write these files: see docs/threat-model.md.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { APPROVALS, catalog, policy, readJson, standing } from "./config.mjs";
import { CONTROL, SHAPES, checkPour } from "./gate.mjs";

const dir = path.join(APPROVALS, "pending");
const file = (id, kind = "") => { if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`not a pour id: ${id}`); return path.join(dir, `${id}${kind}.json`); };
export function propose(rec) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file(rec.id), JSON.stringify(rec, null, 1)); }
export const get = (id) => readJson(file(id));
export const decision = (id) => fs.existsSync(file(id, ".decision")) ? readJson(file(id, ".decision")) : null;
export const close = (id) => [file(id), file(id, ".decision")].forEach((f) => fs.rmSync(f, { force: true }));
export const pending = () => (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => /^[0-9a-f-]{36}\.json$/.test(f))
  .map((f) => readJson(path.join(dir, f))).filter((r) => !decision(r.id)).sort((a, b) => a.ts.localeCompare(b.ts));

// What the gate did not check, for the human reading the payload.
export function residual(payload, policyId) {
  const nums = [...new Set(payload.match(/\d[\d,.:/-]*\d|\d/g) ?? [])];
  const names = [...new Set(payload.match(/(?<![.!?]\s+|^\s*)\b[A-Z][\w-]+/g) ?? [])];
  const mails = payload.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
  return [`checked by code: bytes, session budget, control characters, canaries${SHAPES[policyId] ? `, the ${policyId} JSON schema` : ""}`,
    `NOT checked (an instruction to the private model only): forbids ${catalog()[policyId].forbids}`,
    nums.length && `numbers: ${nums.slice(0, 12).join(", ")}${nums.length > 12 ? ", …" : ""}`,
    names.length && `capitalized words (names?): ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""}`,
    mails.length && `email addresses: ${mails.join(", ")}`,
    policyId === "metadata_only" && "metadata_only is not free of free text: paths and column names are a letters-only channel (about 1,000 letters per pour, 6,000 bytes per session within the caps); read the names"].filter(Boolean);
}

const show = (s) => s.replace(CONTROL, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
// One line reader for the whole run (cooked terminal: the tty echoes and edits the line), so typed-ahead lines queue.
let rl, lines;
async function ask(q) {
  process.stdout.write(q);
  const { value, done } = await lines.next();
  if (done) throw new Error("input closed: nothing decided");
  return value.trim();
}

function screen(r, payload) {
  if (r.canaries) process.env.ABALONE_CANARIES = r.canaries; else delete process.env.ABALONE_CANARIES;
  const pol = catalog()[r.policy], v = checkPour({ policyId: r.policy, payload, answerer: r.to }, { spent: 0, lastWidth: 0, seenOpen: false });
  console.log([`\n── pour ${r.id} waiting for you ${"─".repeat(20)}`,
    `to:        ${r.to} ○ outside, via ${r.via}. It receives exactly the text below.`,
    `it asked:  ${show(r.task).slice(0, 400)}`,
    `policy:    ${r.policy} (≤${pol.max_bytes} bytes; allows ${pol.allows})`,
    `gate:      ${v.verdict === "block" ? `BLOCKED: ${v.reason}` : v.verdict === "go" ? "within a standing policy" : `needs you: ${v.reason}`}`,
    `size:      ${Buffer.byteLength(payload)} bytes`,
    `canaries:  ${r.canaries ?? "OFF (started with --no-canaries)"}`,
    `from:      ${r.from_place ?? "?"} private agent${r.attestation ? `, attestation ${r.attestation.slice(0, 16)}…` : ""}`,
    "residual sensitivity:", ...residual(payload, r.policy).map((l) => `  - ${l}`),
    `── exact payload ${"─".repeat(40)}`, payload, "─".repeat(57)].join("\n"));
  return v;
}

async function review(r) {
  let payload = r.payload;
  for (;;) {
    const v = screen(r, payload);
    const k = (await ask(v.verdict === "block" ? "[e]dit  [d]eny  [s]kip > " : "[a]pprove once  [e]dit  [d]eny  [s]kip > ")).toLowerCase();
    if (k === "a" && v.verdict !== "block") return fs.writeFileSync(file(r.id, ".decision"), JSON.stringify({ decision: "approve", payload, edited: payload !== r.payload, at: new Date().toISOString() }));
    if (k === "d") return fs.writeFileSync(file(r.id, ".decision"), JSON.stringify({ decision: "deny", at: new Date().toISOString() }));
    if (k === "s") return "skip";
    if (k === "e") {
      const tmp = path.join(dir, `${r.id}.edit.txt`);
      fs.writeFileSync(tmp, payload);
      const ed = spawnSync(process.env.EDITOR ?? "vi", [tmp], { stdio: "inherit" });
      if (ed.status !== 0) throw new Error(`editor exited ${ed.status}`);
      payload = fs.readFileSync(tmp, "utf8").replace(/\n$/, "");
      fs.rmSync(tmp);
    }
  }
}

const BANNER = `STANDING POLICY = PRE-APPROVED. A pour to the answerer under that policy leaves WITHOUT asking you,
up to the policy's max_bytes and the session budget (${policy().session_budget_bytes} bytes). Code still blocks canaries, control
characters and schema violations. It does not check the policy's wording: that is an instruction to the private model.`;

async function standingCmd([op, answerer, id]) {
  const s = standing();
  if (op) {
    if (!(answerer in s)) throw new Error(`unknown answerer ${answerer}; policy.json answerers: ${Object.keys(s).join(", ")}`);
    const pol = catalog()[id];
    if (!pol) throw new Error(`unknown policy ${id}; catalog: ${Object.keys(catalog()).join(", ")}`);
    if (op === "add") {
      console.log(`${BANNER}\n\nPre-approve ${id} for ${answerer}: ≤${pol.max_bytes} bytes per pour.\n  allows:  ${pol.allows}\n  forbids: ${pol.forbids} (NOT enforced by code)`);
      if (await ask(`Type ${id} to pre-approve it: `) !== id) return console.log("not changed");
      s[answerer] = [...new Set([...s[answerer], id])];
    } else if (op === "rm") s[answerer] = s[answerer].filter((x) => x !== id);
    else throw new Error("usage: abalone approvals --standing [add|rm <answerer> <policy>]");
    fs.mkdirSync(APPROVALS, { recursive: true });
    fs.writeFileSync(path.join(APPROVALS, "standing.json"), JSON.stringify(s, null, 1));
  }
  console.log(`${BANNER}\n\nStanding policies (${path.join(APPROVALS, "standing.json")}):`);
  for (const [a, ids] of Object.entries(standing())) console.log(`  ${a.padEnd(15)} ${ids.length ? ids.join(", ") : "none: every pour asks you"}`);
}

// abalone approvals [--once]            review pending pours (waits for new ones unless --once)
// abalone approvals --standing [add|rm <answerer> <policy>]
export async function run(args) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("✗ refused: abalone approvals runs only in your own terminal (stdin and stdout a TTY), so an agent's shell tool cannot approve its own pours");
  rl = readline.createInterface({ input: process.stdin, terminal: false });
  lines = rl[Symbol.asyncIterator]();
  try { await (args[0] === "--standing" ? standingCmd(args.slice(1)) : watch(args)); } finally { rl.close(); }
}

async function watch(args) {
  const skipped = new Set();
  for (let waiting = false; ;) {
    const ps = pending().filter((r) => !skipped.has(r.id));
    for (const r of ps) if ((await review(r)) === "skip") skipped.add(r.id);
    if (args.includes("--once")) return console.log(ps.length ? "" : "no pending pours");
    if (!ps.length && !waiting) console.log("waiting for pours (Ctrl-C to quit)…");
    waiting = !ps.length;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
