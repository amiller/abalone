// Usability gate part 1 (docs/release.md): realistic tasks in RPC mode on a real saved credit, through the
// real `abalone credit session --mode rpc` with the caller's own ABALONE_DIR. Spends from that credit. Run via live.sh.
// Per task: stop reasons, output and reasoning tokens, time to first token, stderr lines. Pass: exit 0, every turn
// settled, no `length` stop or dialog, at most one warning line, and the task's own check (the edit landed, or the
// answer names the facts in the synthetic fixtures).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const [credit, out] = process.argv.slice(2), root = path.resolve(import.meta.dirname, "../..");
const TASKS = [
  { name: "summarize", prompts: ["Summarize @memo.md in five bullet points."] },
  { name: "question", prompts: ["In @rota.txt, who waters on Thursday?"], answered: (turns) => /Priya Raman/.test(turns[0].answer) && /Joan Castellanos/.test(turns[0].answer) },
  { name: "edit", prompts: ["Edit rota.txt so Priya Raman moves from Thursday to Friday. Change only that line pair."],
    check: (work) => /^Thursday: Joan Castellanos$/m.test(fs.readFileSync(path.join(work, "rota.txt"), "utf8")) && /^Friday: Priya Raman/m.test(fs.readFileSync(path.join(work, "rota.txt"), "utf8")) },
  { name: "follow-up", answered: (turns) => /28 March/.test(turns[0].answer), prompts: ["What decision does @memo.md ask for, and by when?", "Who is responsible for the grant application?", "Draft a two-sentence reminder to that person."] },
];
const WARNING = /warning|⚠|INTEL-SA|out ?of ?date/i;

function task({ name, prompts, check, answered }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `abalone-usability-live-${name}-`));
  for (const f of ["memo.md", "rota.txt"]) fs.copyFileSync(path.join(import.meta.dirname, "fixtures", f), path.join(work, f));
  const child = spawn(process.execPath, [path.join(root, "bin/abalone.mjs"), "credit", "session", "--credit", credit, "--mode", "rpc"], { cwd: work, stdio: ["pipe", "pipe", "pipe"] });
  const turns = []; let stderr = "", buf = "", turn;
  const send = () => { const message = prompts[turns.length]; turn = { prompt: message, start: Date.now(), ttftMs: null, stopReasons: [], outputTokens: 0, reasoningTokens: null, answer: "" };
    turns.push(turn); child.stdin.write(JSON.stringify({ id: `p${turns.length}`, type: "prompt", message }) + "\n"); };
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0;) {
      const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (ev.type === "message_update" && turn.ttftMs === null) turn.ttftMs = Date.now() - turn.start;
      if (ev.type === "message_end" && ev.message.role === "assistant") {
        const u = ev.message.usage ?? {};
        turn.stopReasons.push(ev.message.stopReason); turn.outputTokens += u.output ?? 0;
        if (u.reasoning !== undefined) turn.reasoningTokens = (turn.reasoningTokens ?? 0) + u.reasoning;
        turn.answer += ev.message.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      }
      if (ev.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(ev.method)) { turn.dialog = ev.method; child.kill(); }
      if (ev.type === "agent_settled") { turn.ms = Date.now() - turn.start; turns.length < prompts.length ? send() : child.stdin.end(); }
    }
  });
  send();
  return new Promise((resolve) => child.on("exit", (code) => {
    const lines = stderr.split("\n").filter(Boolean), warnings = lines.filter((l) => WARNING.test(l));
    const settled = turns.length === prompts.length && turns.every((t) => t.ms !== undefined);
    const result = { name, exitCode: code, stderrLines: lines.length, warningLines: warnings.length, stderr: lines, turns: turns.map(({ start, ...t }) => t),
      ...(check ? { edited: check(work) } : {}), ...(answered ? { answered: settled && answered(turns) } : {}) };
    result.pass = code === 0 && settled && !turns.some((t) => t.stopReasons.includes("length") || t.dialog) && warnings.length <= 1 && result.edited !== false && result.answered !== false;
    fs.rmSync(work, { recursive: true, force: true });
    console.log(`${result.pass ? "PASS" : "FAIL"} ${name}: stops ${turns.map((t) => t.stopReasons.join("+")).join(", ")}; output ${turns.map((t) => t.outputTokens).join(", ")}; reasoning ${turns.map((t) => t.reasoningTokens).join(", ")}; ttft ms ${turns.map((t) => t.ttftMs).join(", ")}; stderr lines ${lines.length} (${warnings.length} warning)`);
    resolve(result);
  }));
}

const tasks = [];
for (const t of TASKS) tasks.push(await task(t));
const pass = tasks.every((t) => t.pass);
fs.writeFileSync(path.join(out, "live.json"), JSON.stringify({ credit, at: new Date().toISOString(), pass, tasks }, null, 1) + "\n");
console.log(`usability live: ${pass ? "PASS" : "FAIL"} (${path.join(out, "live.json")})`); process.exit(pass ? 0 : 1);
