#!/usr/bin/env node
// The task guest's entrypoint (docs/protocols/task-v1.md, runner-task.md). NDJSON on stdin/stdout to the peer:
//   peer → guest  {t:"init", prompt, model, tools, check?}  once, first
//                 {t:"pi", cmd}                             a Pi RPC command (steer, follow_up, prompt, abort, clear_queue, bash)
//                 {t:"infer-head", id, status} {t:"infer-data", id, b64} {t:"infer-end", id}   the peer's model replies
//                 {t:"finish", reason}                      write /out and exit
//   guest → peer  {t:"ev", kind, data}                      compact agent events
//                 {t:"infer", id, body}                     a model request from Pi (the guest has no network)
//                 {t:"outputs", files: [{path, sha256, bytes}]}   what was written to /out, then exit 0
// /in holds the granted files (read-only); the agent works on a copy in /work; /out gets patch.diff, test.log, files/.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";

const IN = process.env.TASK_IN ?? "/in", OUT = process.env.TASK_OUT ?? "/out", WORK = process.env.TASK_WORK ?? "/work";
const STATE = process.env.TASK_STATE ?? "/task-state";
const PI = path.join(path.dirname(import.meta.filename), "../pi/packages/coding-agent/dist/cli.js");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const clip = (s, n = 4000) => (s = String(s ?? ""), s.length > n ? s.slice(0, n) + `… (${s.length - n} more chars)` : s);
const text = (content) => (Array.isArray(content) ? content : [content]).map((c) => typeof c === "string" ? c : c?.type === "text" ? c.text : "").join("");
const git = (...a) => { const r = spawnSync("git", a, { cwd: WORK, encoding: "utf8", maxBuffer: 64 << 20 }); if (r.status !== 0) throw new Error(`git ${a[0]}: ${r.stderr}`); return r.stdout; };

const replies = new Map();
let pi, init, finishing = false;
const early = [];
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (l) => {
  const m = JSON.parse(l);
  if (m.t === "init") return start(m);
  if (m.t === "pi") return pi ? pi.stdin.write(JSON.stringify(m.cmd) + "\n") : early.push(m.cmd); // before Pi has started: after its prompt
  if (m.t === "finish") return finish(m.reason);
  const r = replies.get(m.id);
  if (m.t === "infer-head") r.writeHead(m.status, { "content-type": m.status === 200 ? "text/event-stream" : "application/json" });
  if (m.t === "infer-data") r.write(Buffer.from(m.b64, "base64"));
  if (m.t === "infer-end") { r.end(); replies.delete(m.id); }
});
lines.on("close", () => finish("stdin closed"));

// Pi's model endpoint: an OpenAI-compatible loopback server whose every request goes to the peer over stdout.
let seq = 0;
const server = http.createServer(async (req, res) => {
  let b = "";
  for await (const c of req) b += c;
  const id = ++seq;
  replies.set(id, res);
  send({ t: "infer", id, body: b });
});

async function start(m) {
  init = m;
  fs.cpSync(IN, WORK, { recursive: true });
  if (!fs.existsSync(path.join(WORK, ".git"))) { git("init", "-q"); git("add", "-A"); git("-c", "user.name=task", "-c", "user.email=task@abalone", "commit", "-qm", "inputs"); }
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const agent = path.join(STATE, "agent");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "models.json"), JSON.stringify({ providers: { task: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "peer-metered", models: [{ id: m.model }] } } }));
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ shellPath: "/bin/sh" }));
  pi = spawn(process.execPath, [PI, "--mode", "rpc", "--provider", "task", "--model", m.model, "--tools", m.tools.join(","), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--session-dir", path.join(STATE, "sessions")],
    { cwd: WORK, env: { PATH: process.env.PATH, HOME: STATE, PI_CODING_AGENT_DIR: agent }, stdio: ["pipe", "pipe", "pipe"] });
  readline.createInterface({ input: pi.stdout }).on("line", (l) => event(JSON.parse(l)));
  pi.stderr.on("data", (d) => send({ t: "ev", kind: "diagnostic", data: { text: clip(d) } }));
  pi.on("exit", (code, signal) => finishing || finish(`agent exited (${signal ?? code})`));
  for (const c of [{ type: "prompt", message: m.prompt }, ...early.splice(0)]) pi.stdin.write(JSON.stringify(c) + "\n");
}

function event(e) {
  const ev = (kind, data) => send({ t: "ev", kind, data });
  if (e.type === "agent_start") ev("agent_start", {});
  if (e.type === "agent_settled") ev("agent_settled", { aborted: e.aborted });
  if (e.type === "tool_execution_start") ev("tool_start", { tool: e.toolName, args: e.args });
  if (e.type === "tool_execution_end") ev("tool_end", { tool: e.toolName, error: e.isError, result: clip(text(e.result?.content)) });
  if (e.type === "message_end" && e.message.role === "assistant") ev("assistant", { text: clip(text(e.message.content), 8000), error: e.message.errorMessage });
  if (e.type === "response") ev("response", { command: e.command, success: e.success, error: e.error, output: e.command === "bash" ? clip(e.data?.output) : undefined, exit: e.data?.exitCode });
}

// /out: the agent's change as a patch, the check's output, and each changed file. Then the list, and exit.
function finish(reason) {
  if (finishing) return;
  finishing = true;
  pi?.kill("SIGTERM");
  const files = [];
  const put = (p, data) => { fs.mkdirSync(path.dirname(path.join(OUT, p)), { recursive: true }); fs.writeFileSync(path.join(OUT, p), data); files.push({ path: p, sha256: crypto.createHash("sha256").update(data).digest("hex"), bytes: data.length }); };
  if (init) {
    git("add", "-A");
    put("patch.diff", git("diff", "--cached", "--binary", "HEAD"));
    for (const f of git("diff", "--cached", "--name-only", "HEAD").split("\n").filter(Boolean)) if (fs.existsSync(path.join(WORK, f))) put(`files/${f}`, fs.readFileSync(path.join(WORK, f)));
    if (init.check) { const r = spawnSync("/bin/sh", ["-c", init.check], { cwd: WORK, encoding: "utf8", timeout: 300e3 }); put("test.log", `$ ${init.check}\n${r.stdout}${r.stderr}\nexit ${r.status ?? r.signal}\n`); }
  }
  put("finish.json", JSON.stringify({ reason }));
  send({ t: "outputs", files });
  process.stdout.end(() => process.exit(0));
}
