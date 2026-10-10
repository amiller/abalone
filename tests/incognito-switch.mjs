// I2 in session: list the models a session can switch to, then try to switch to runner/claude (○ outside).
// usage: node tests/incognito-switch.mjs [--incognito]; prints {available: [provider/id …], set: <response>}.
import { spawn } from "node:child_process";
import path from "node:path";
const child = spawn(path.join(import.meta.dirname, "..", "bin", "abalone"), ["--mode", "rpc", ...process.argv.slice(2), "--model", "stub-e2ee/script"], { stdio: ["pipe", "pipe", "inherit"] });
const got = {};
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (ev.type === "response") got[ev.id] = ev;
    if (got.m && got.s) { console.log(JSON.stringify({ available: got.m.data.models.map((m) => `${m.provider}/${m.id}`), set: got.s })); child.stdin.end(); }
  }
});
child.stdin.write(JSON.stringify({ id: "m", type: "get_available_models" }) + "\n");
child.stdin.write(JSON.stringify({ id: "s", type: "set_model", provider: "runner", modelId: "claude" }) + "\n");
