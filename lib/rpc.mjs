// Drive one abalone session over Pi's RPC mode: send a prompt, answer extension UI dialogs with
// onUi(request) → response fields, and return every event once the run settles.
import { spawn } from "node:child_process";
import path from "node:path";
import { ROOT } from "./config.mjs";

export function runPrompt({ args = [], command, message, onUi, env = process.env, cwd = process.cwd(), fds = [] }) {
  const child = spawn(path.join(ROOT, "bin", "abalone"), [...(command ? [command] : []), "--mode", "rpc", ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe", ...fds] });
  const events = [];
  let buf = "", err = "";
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  return new Promise((resolve, reject) => {
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => (events.some((e) => e.type === "agent_settled") ? resolve({ events, stderr: err }) : reject(new Error(`abalone exited ${code} before the run settled: ${err.slice(-1000)}`))));
    child.stdout.on("data", async (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const ev = JSON.parse(buf.slice(0, i).replace(/\r$/, ""));
        buf = buf.slice(i + 1);
        events.push(ev);
        if (ev.type === "response" && !ev.success) { child.kill(); return reject(new Error(`rpc ${ev.command}: ${ev.error}`)); }
        if (ev.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(ev.method)) send({ type: "extension_ui_response", id: ev.id, ...onUi(ev) });
        if (ev.type === "agent_settled") child.stdin.end();
      }
    });
    send({ id: "p1", type: "prompt", message });
  });
}

export const assistantText = (events) => events.filter((e) => e.type === "message_end" && e.message.role === "assistant")
  .map((e) => e.message.content.filter((c) => c.type === "text").map((c) => c.text).join("")).filter(Boolean).at(-1) ?? "";
