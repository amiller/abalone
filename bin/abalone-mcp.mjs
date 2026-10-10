// abalone-mcp: an MCP server (stdio) for an outside orchestrator such as Claude Code, run in the private folder.
// ask_abalone(task, policy): a private agent does the task in this folder, and its answer goes through the gate.
// Within a standing policy (made by the human with `abalone approvals --standing`; none ship) it comes back at once.
// Otherwise it waits as pending until the human approves, edits or denies it in their own terminal (`abalone
// approvals`); the caller waits with pour_status(id). The caller cannot approve. Refusals say only "refused";
// the reason goes to disclosures.jsonl. Args after the command (e.g. --model) go to the private agent.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PRIVATE_OUT, STATE, catalog, log, standing } from "../lib/config.mjs";
import { checkPour } from "../lib/gate.mjs";
import * as approvals from "../lib/approvals.mjs";
import * as canary from "../lib/canary.mjs";
import { runPrompt, assistantText } from "../lib/rpc.mjs";

const agentArgs = process.argv.slice(2), li = agentArgs.indexOf("--listen"), listen = li >= 0 && agentArgs.splice(li, 2)[1];
const canaries = canary.forSession(process.cwd(), agentArgs.includes("--no-canaries") || process.env.ABALONE_NO_CANARIES === "1");
if (canaries) process.env.ABALONE_CANARIES = canaries;
const budget = { spent: 0, lastWidth: 0, seenOpen: false };
const pols = Object.values(catalog()), pre = standing()["mcp-caller"];
const tools = [{
  name: "ask_abalone",
  description: `Ask abalone's private agent to do a task over the private folder ${process.cwd()}. Only its answer can come back, and only through the gate. ` +
    "CODE checks: canaries, control characters, max_bytes, the session budget, and for metadata_only a JSON schema. " +
    "The policy's allows/forbids wording is NOT ENFORCED BY CODE: it is an instruction to the private model. " +
    `Standing (pre-approved by the user) policies: ${pre.length ? pre.join(", ") : "none"}. ` +
    "Any other answer returns {status: \"pending\", id}: the user reads the exact text in their own terminal (`abalone approvals`) and approves, edits or denies it. " +
    "Then call pour_status with that id. You cannot approve pours. " +
    `Folder canaries: ${canaries ? "on" : "OFF (--no-canaries)"}. Policies: ` + pols.map((p) => `${p.id} (≤${p.max_bytes} bytes: ${p.allows})`).join("; "),
  inputSchema: { type: "object", additionalProperties: false, required: ["task", "policy"],
    properties: { task: { type: "string" }, policy: { type: "string", enum: pols.map((p) => p.id) } } },
}, {
  name: "pour_status",
  description: "Wait for the user's decision on a pending ask_abalone answer. Returns {status: \"released\", answer} (possibly as the user edited it), " +
    "{status: \"pending\"} if the user has not decided within wait_seconds (default 60), or an error \"denied by the user\".",
  inputSchema: { type: "object", additionalProperties: false, required: ["id"],
    properties: { id: { type: "string" }, wait_seconds: { type: "integer", minimum: 0, maximum: 300 } } },
}];
const out = { type: "object", additionalProperties: false, required: ["status"],
  properties: { status: { type: "string", enum: ["released", "pending"] }, id: { type: "string" }, policy: { type: "string" }, bytes: { type: "integer" },
    answer: { type: "string", maxLength: Math.max(...pols.map((p) => p.max_bytes)) } } };
tools.forEach((t) => (t.outputSchema = out));

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
// A refused payload stays private: only its hash and byte count are logged.
const refuse = (rec, reason, text = "refused") => {
  const { payload, ...meta } = rec;
  log("disclosures.jsonl", { ...meta, ...(payload !== undefined && { payload_sha256: sha(payload) }), label: "refused", approval: "refused", refused: reason });
  return { isError: true, content: [{ type: "text", text }] };
};
const release = (rec, approval) => {
  budget.spent += rec.bytes;
  log("disclosures.jsonl", { ...rec, label: "released", approval });
  const structuredContent = { status: "released", policy: rec.policy, answer: rec.payload };
  return { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
};

async function askAbalone({ task, policy: policyId }) {
  const id = crypto.randomUUID();
  const rec = { id, direction: "private→outside", via: "ask_abalone", to: "mcp-caller", to_place: "○ outside", policy: policyId, schema: policyId };
  const pol = catalog()[policyId];
  if (!pol) return refuse(rec, `policy ${policyId} is not in the catalog`);
  log("agents.jsonl", { event: "spawn-request", id, parent: "mcp-caller", domain: "private", by: "ask_abalone" });
  const message = `${task}\n\n---\nYour final reply leaves abalone for an outside caller under the disclosure policy "${policyId}".\n` +
    `Allowed: ${pol.allows}.\nForbidden: ${pol.forbids}.\n${pol.format ? `Format: ${pol.format}.\n` : ""}At most ${pol.max_bytes} bytes. Reply with only the text that may leave.`;
  let events;
  try {
    ({ events } = await runPrompt({ args: agentArgs, message, onUi: () => ({ confirmed: false }), env: { ...process.env, ABALONE_PARENT: id } }));
  } catch (e) {
    fs.mkdirSync(PRIVATE_OUT, { recursive: true });
    fs.writeFileSync(path.join(PRIVATE_OUT, `${id}.error.txt`), String(e.stack ?? e));
    return refuse(rec, `private agent failed: see ${path.join(PRIVATE_OUT, `${id}.error.txt`)}`);
  }
  const answer = assistantText(events).trim();
  fs.mkdirSync(PRIVATE_OUT, { recursive: true });
  fs.writeFileSync(path.join(PRIVATE_OUT, `${id}.json`), JSON.stringify({ id, task, policy: policyId, answer, events }, null, 1));
  const end = fs.readFileSync(path.join(STATE, "agents.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter((r) => r.event === "end" && r.parent === id).at(-1);
  const v = checkPour({ policyId, payload: answer, answerer: "mcp-caller" }, budget);
  const full = { ...rec, bytes: v.bytes, payload: answer, from: end?.id ?? null, from_place: end?.place ?? null, attestation: end?.attestation ?? null, private_out: `${id}.json` };
  if (v.verdict === "block") return refuse(full, v.reason);
  if (v.verdict === "go") return release(full, "standing");
  approvals.propose({ ...full, ts: new Date().toISOString(), task, reason: v.reason, canaries });
  const { payload, ...meta } = full;
  log("disclosures.jsonl", { ...meta, payload_sha256: sha(payload), label: "pending", approval: "pending", reason: v.reason });
  const structuredContent = { status: "pending", id, policy: policyId }; // no byte count: it would leak before approval
  return { structuredContent, content: [{ type: "text", text: `pending: ${id}. The user reviews it in their own terminal with \`abalone approvals\`; call pour_status to wait.` }] };
}

async function pourStatus({ id, wait_seconds = 60 }) {
  const until = Date.now() + Math.min(wait_seconds, 300) * 1000;
  const { ts, task, reason, canaries: _, ...rec } = approvals.get(id);
  let d;
  while (!(d = approvals.decision(id)) && Date.now() < until) await new Promise((ok) => setTimeout(ok, 250));
  if (!d) return { structuredContent: { status: "pending", id }, content: [{ type: "text", text: `still pending: ${id}` }] };
  approvals.close(id);
  if (d.decision !== "approve") return refuse(rec, "denied by the user", "denied by the user");
  // The approved text, edited or not, goes through the gate again: a canary, control character or schema violation still blocks.
  const v = checkPour({ policyId: rec.policy, payload: d.payload, answerer: "mcp-caller" }, budget);
  const full = { ...rec, bytes: v.bytes, payload: d.payload, edited: d.edited };
  if (v.verdict === "block") return refuse(full, v.reason);
  return release(full, d.edited ? "user-edited" : "user");
}

const calls = { ask_abalone: askAbalone, pour_status: pourStatus };
// One JSON-RPC connection: stdio, or (hardened mode, --listen) one client of the unix socket.
function serve(input, output) {
  const reply = (id, result) => output.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  let buf = "";
  input.on("data", async (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.method === "initialize") reply(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "abalone", version: "0.2.0" } });
      else if (msg.method === "tools/list") reply(msg.id, { tools });
      else if (msg.method === "tools/call") {
        // An exception's text may hold private data: the caller sees only "error", the message goes to errors.jsonl.
        try { reply(msg.id, await calls[msg.params.name](msg.params.arguments)); } catch (e) { log("errors.jsonl", { via: "abalone-mcp", error: String(e.stack ?? e) }); reply(msg.id, { isError: true, content: [{ type: "text", text: "error" }] }); }
      }
      else if (msg.method === "ping") reply(msg.id, {});
      else if (msg.id !== undefined) output.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } }) + "\n");
    }
  });
}
// --listen <socket>: the hardened mode (docs/threat-model.md). The socket is 0660, so the caller reaches it through its group.
if (listen) net.createServer((c) => serve(c, c)).listen(listen, () => fs.chmodSync(listen, 0o660));
else serve(process.stdin, process.stdout);
