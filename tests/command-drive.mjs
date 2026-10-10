// Run one session command over Pi's RPC mode (commands start no agent run): answer its dialogs in order from CHOICES,
// stop at the first notice matching DONE (a regex), then print every event as a JSON line.
// usage: CHOICES='["cancel: fetch nothing"]' DONE='Fetched|Nothing was fetched' node tests/command-drive.mjs <provider/model> "/fetch ..."
import { spawn } from "node:child_process";
import path from "node:path";
const [model, command] = process.argv.slice(2), choices = JSON.parse(process.env.CHOICES ?? "[]"), done = new RegExp(process.env.DONE);
const child = spawn(path.join(import.meta.dirname, "..", "bin", "abalone"), ["--mode", "rpc", "--model", model], { stdio: ["pipe", "pipe", "inherit"] });
const events = [];
let buf = "";
const timer = setTimeout(() => { child.kill(); console.error("timed out"); process.exit(1); }, Number(process.env.TIMEOUT_MS ?? 90_000));
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); events.push(ev);
    if (ev.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(ev.method)) {
      const c = choices.shift();
      if (c === undefined) throw new Error(`unexpected ${ev.method}: ${ev.title}`);
      child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: ev.id, value: c }) + "\n");
    }
    if (ev.type === "extension_ui_request" && ev.method === "notify" && done.test(ev.message)) {
      clearTimeout(timer); child.kill();
      for (const e of events) console.log(JSON.stringify(e));
      if (choices.length) throw new Error(`unused choices: ${JSON.stringify(choices)}`);
      process.exit(0);
    }
  }
});
child.stdin.write(JSON.stringify({ id: "c1", type: "prompt", message: command }) + "\n");
