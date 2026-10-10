// abalone-mcp over stdio, with the stub private agent working in the demo corpus, and no standing policy (as shipped):
// an answer waits as pending until the human decides it in `abalone approvals` (driven here through a pty with `script`);
// the caller cannot approve (no MCP method; the CLI refuses without a TTY); approve, edit and deny; canary, schema and
// unknown-policy refusals say only "refused"; a standing policy made by the human releases without asking.
// Writes the client-side transcript to $ABALONE_DIR/mcp-transcript.jsonl for tests/canary-transcript.mjs.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, STATE } from "../lib/config.mjs";

const srv = spawn(path.join(ROOT, "bin/abalone-mcp"), ["--model", "stub/script"], { cwd: path.join(ROOT, "local-data/demo-corpus"), stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, STUB_SCRIPT: path.join(ROOT, "tests/fixtures/scripts/private-task.mjs") } });
const transcript = path.join(STATE, "mcp-transcript.jsonl");
let buf = "", next = 1;
const waiting = new Map();
srv.stdout.on("data", (d) => {
  buf += d; fs.appendFileSync(transcript, d);
  let i;
  while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); }
});
const call = (method, params) => new Promise((r) => { const id = next++; waiting.set(id, r); srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const tool = async (name, args) => (await call("tools/call", { name, arguments: args })).result;
const ask = (task, policy) => tool("ask_abalone", { task, policy });
const logs = () => fs.readFileSync(path.join(STATE, "disclosures.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
// The human at their terminal: `abalone approvals --once` in a pty, typing `keys`.
const human = (keys, env = {}) => spawnSync("script", ["-qec", `${path.join(ROOT, "bin/abalone")} approvals --once`, "/dev/null"],
  { input: keys, encoding: "utf8", env: { ...process.env, ...env }, timeout: 30e3 });
let fail = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); fail ||= !ok; };

await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
const { result: { tools } } = await call("tools/list", {});
const d = tools[0].description;
check("two tools; the description says the wording is not enforced, no standing policy, and who approves", tools.map((t) => t.name).join() === "ask_abalone,pour_status"
  && /NOT ENFORCED BY CODE/.test(d) && /Standing \(pre-approved by the user\) policies: none/.test(d) && /abalone approvals/.test(d) && /You cannot approve/.test(d), d.slice(0, 120));

let r = await ask("How many rows does data/participants.csv have?", "metadata_only");
const id = r.structuredContent?.id;
check("as shipped, an answer waits for the human: pending with an id, no answer and no byte count", r.structuredContent?.status === "pending" && !r.structuredContent.answer && !("bytes" in r.structuredContent) && id, JSON.stringify(r.structuredContent));
check("pending is logged with a hash, not the payload", logs().at(-1).label === "pending" && logs().at(-1).payload_sha256 && !("payload" in logs().at(-1)), logs().at(-1).reason);
r = await tool("pour_status", { id, wait_seconds: 0 });
check("pour_status before a decision: still pending", r.structuredContent?.status === "pending", JSON.stringify(r.structuredContent));
const notty = spawnSync(path.join(ROOT, "bin/abalone"), ["approvals", "--once"], { input: "a\n", encoding: "utf8" });
check("the caller's shell cannot approve: abalone approvals refuses without a TTY", notty.status === 1 && /runs only in your own terminal/.test(notty.stderr) && !fs.existsSync(path.join(STATE, "approvals/pending", `${id}.decision.json`)), notty.stderr.trim());
const h = human("a\n");
check("the human sees the exact payload, destination and residual sensitivity", h.stdout.includes('{"files":[{"path":"data/participants.csv","rows_about":60}]}') && h.stdout.includes("to:        mcp-caller ○ outside")
  && h.stdout.includes("NOT checked (an instruction to the private model only)") && h.stdout.includes("numbers: 60"), h.stdout.split("\n").filter((l) => /^(to|policy|gate):/.test(l)).join(" | "));
r = await tool("pour_status", { id, wait_seconds: 5 });
check("approved: released to the caller as the human saw it", r.structuredContent?.status === "released" && JSON.parse(r.structuredContent.answer).files[0].rows_about === 60 && logs().at(-1).approval === "user", JSON.stringify(r.structuredContent));

r = await ask("How many rows does data/participants.csv have?", "metadata_only");
const edited = '{"files":[{"path":"data/participants.csv"}]}';
fs.writeFileSync(path.join(STATE, "editor.sh"), `#!/bin/sh\nprintf '%s' '${edited}' > "$1"\n`, { mode: 0o700 });
human("e\na\n", { EDITOR: path.join(STATE, "editor.sh") });
r = await tool("pour_status", { id: r.structuredContent.id, wait_seconds: 5 });
check("edited: the caller gets the human's text, logged user-edited", r.structuredContent?.answer === edited && logs().at(-1).approval === "user-edited" && logs().at(-1).payload === edited, JSON.stringify(r.structuredContent));

r = await ask("How many rows does data/participants.csv have?", "free_text");
if (!r.structuredContent) console.log("free_text ask:", JSON.stringify(r), logs().at(-1).refused);
human("d\n");
r = await tool("pour_status", { id: r.structuredContent.id, wait_seconds: 5 });
check("denied: the caller gets an error and no text; the log keeps only the hash", r.isError && r.content[0].text === "denied by the user" && !("payload" in logs().at(-1)), r.content[0].text);

for (const [task, policy, why] of [["LEAK a row", "metadata_only", "canary in payload"], ["PROSE please", "metadata_only", "metadata_only must be JSON"], ["anything", "everything", "not in the catalog"]]) {
  r = await ask(task, policy);
  check(`refused before any approval, coarse text only (${why})`, r.isError && r.content[0].text === "refused" && !r.structuredContent && logs().at(-1).refused.includes(why), `caller saw "${r.content[0].text}"; log: ${logs().at(-1).refused.slice(0, 70)}`);
}

fs.writeFileSync(path.join(STATE, "approvals/standing.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(STATE, "approvals/standing.json"))), "mcp-caller": ["metadata_only"] }));
r = await ask("How many rows does data/participants.csv have?", "metadata_only");
check("a standing policy (made by the human) releases without asking, logged standing", r.structuredContent?.status === "released" && logs().at(-1).approval === "standing", JSON.stringify(r.structuredContent));
r = await ask("LONG answer", "metadata_only");
check("over max_bytes under a standing policy still asks the human", r.structuredContent?.status === "pending" && /over max_bytes/.test(logs().at(-1).reason), logs().at(-1).reason);
human("d\n");
await tool("pour_status", { id: r.structuredContent.id, wait_seconds: 5 });

const st = (keys, cmd) => spawnSync("script", ["-qec", `${path.join(ROOT, "bin/abalone")} approvals --standing ${cmd}`, "/dev/null"], { input: keys, encoding: "utf8", timeout: 30e3 }).stdout;
let o = st("yes\n", "add mcp-caller free_text");
const now = () => JSON.parse(fs.readFileSync(path.join(STATE, "approvals/standing.json")))["mcp-caller"].join();
check("--standing add says standing means pre-approved, and a wrong confirmation changes nothing", /STANDING POLICY = PRE-APPROVED/.test(o) && /NOT enforced by code/.test(o) && now() === "metadata_only", now());
o = st("free_text\n", "add mcp-caller free_text");
check("--standing add with the policy id typed back adds it", now() === "metadata_only,free_text" && /mcp-caller\s+metadata_only, free_text/.test(o), now());

const rel = logs().filter((x) => x.via === "ask_abalone" && x.label === "released");
check("every release is logged with its source agent", rel.length === 3 && rel.every((x) => x.from && x.from_place), rel.map((x) => x.approval).join(","));
check("the private agent's full output is kept in private-out/", fs.existsSync(path.join(STATE, "private-out", rel[0].private_out)), rel[0].private_out);
srv.stdin.end();
process.exit(fail ? 1 : 0);
