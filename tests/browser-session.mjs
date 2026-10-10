// Drive one abalone session over Pi's RPC mode through a browser journey; print every event as a JSON line.
// usage: node tests/browser-session.mjs <provider/model> <steps.json> [abalone args…]. Steps, in order:
//   {"cmd": "/browser …"}   a session command (Pi runs it at once); waits for its notice. Dialogs: confirm yes, select/input from "answers".
//   {"prompt": "…"}         waits until the run settles. With "during": {"after": <regex on an assistant message>, "ms": n,
//                           "abort": true | "cmd": "/browser …"}, that is sent n ms after the first matching assistant message.
//   {"human": <url>, "port" or "portFile": <DevTools port>, "on": <host>}   the human navigates the tab now on that host, over CDP.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [model, file, ...extra] = process.argv.slice(2), steps = JSON.parse(fs.readFileSync(file, "utf8"));
const child = spawn(path.join(import.meta.dirname, "..", "bin", "abalone"), ["--mode", "rpc", ...extra, "--model", model], { stdio: ["pipe", "pipe", "inherit"] });
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
let buf = "", waiter = null, step = null, n = 0;
const out = (e) => console.log(JSON.stringify(e));
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); out(ev);
    if (ev.type === "extension_ui_request" && ev.method === "confirm") send({ type: "extension_ui_response", id: ev.id, confirmed: true });
    if (ev.type === "extension_ui_request" && ["select", "input"].includes(ev.method)) send({ type: "extension_ui_response", id: ev.id, value: step.answers.shift() });
    const d = step?.during;
    if (d && !d.sent && ev.type === "message_end" && ev.message.role === "assistant" && new RegExp(d.after).test(JSON.stringify(ev.message.content))) {
      d.sent = true;
      setTimeout(() => { out({ type: "driver", sent: d.abort ? "abort" : d.cmd }); send(d.abort ? { id: `a${n}`, type: "abort" } : { id: `d${n}`, type: "prompt", message: d.cmd }); }, d.ms ?? 0);
    }
    if (waiter?.(ev)) waiter = null;
  }
});
const until = (test) => new Promise((r) => (waiter = (ev) => test(ev) && (r(ev), true)));
for (step of steps) {
  n++;
  out({ type: "driver", step });
  if (step.human) {
    const port = step.port ?? fs.readFileSync(step.portFile, "utf8").split("\n")[0];
    const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page" && new URL(t.url).hostname === step.on);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    ws.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url: step.human } }));
    await new Promise((r) => setTimeout(r, 2000));
    ws.close();
    continue;
  }
  const done = until(step.cmd ? (ev) => ev.type === "extension_ui_request" && ev.method === "notify" : (ev) => ev.type === "agent_settled");
  send({ id: `s${n}`, type: "prompt", message: step.cmd ?? step.prompt });
  await done;
}
child.stdin.end();
child.kill();
process.exit(0);
