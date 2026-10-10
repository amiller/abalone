// Runs the real `claude` binary in the runner sandbox (same argv builder and egress as ask_frontier) with
// an empty home: prints its init event (tools, MCP servers), its result line, and the egress log.
// No login is needed: the init event comes before any API call. RUNNER_LOGIN=1 uses the real runner login
// (providers.json runners.claude.home) instead, so the run makes one real API call.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, STATE, providers } from "../lib/config.mjs";
import { startEgress } from "../lib/egress.mjs";
import { runnerArgv } from "../lib/sandbox.mjs";

fs.mkdirSync(STATE, { recursive: true });
const tmp = (p) => fs.mkdtempSync(path.join(STATE, p));
const real = !!process.env.RUNNER_LOGIN;
const run = fs.mkdtempSync(path.join(process.env.XDG_RUNTIME_DIR, "abalone-")), home = real ? path.join(ROOT, providers().runners.claude.home) : tmp("home-"), scratch = tmp("scratch-");
process.on("exit", () => [run, scratch, ...(real ? [] : [home])].forEach((d) => fs.rmSync(d, { recursive: true, force: true }))); // never the real runner login
fs.writeFileSync(path.join(scratch, "pour.md"), "say hi");
// A dummy API key (never a real credential) makes claude contact the API, so the egress log shows where it goes.
if (!real) fs.mkdirSync(path.join(home, ".claude"));
if (!real) fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-dummy" } }));
const close = await startEgress(run, [], providers().runners.claude.hosts, [], "runner");
const bin = spawnSync("bash", ["-c", 'readlink -f "$(command -v claude)"'], { encoding: "utf8" }).stdout.trim();
const argv = [...runnerArgv({ run, home, scratch, bin, connectSock: path.join(run, "connect.sock") }),
  "/opt/runner/bin", "-p", "--tools", "", "--strict-mcp-config", "--no-chrome", "--output-format", "stream-json", "--verbose"];
const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
let out = "", err = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (err += d));
child.stdin.end("say hi");
const code = await new Promise((r) => child.on("exit", r));
close();
for (const line of out.split("\n").filter(Boolean)) {
  const ev = JSON.parse(line);
  if (ev.type === "system" && ev.subtype === "init") console.log(`init tools=${JSON.stringify(ev.tools)} mcp_servers=${JSON.stringify(ev.mcp_servers)}`);
  if (ev.type === "result") console.log(`result is_error=${ev.is_error} ${String(ev.result).slice(0, 120)}`);
}
console.log(`exit ${code} ${err.slice(-200)}`);
const log = path.join(STATE, "egress.jsonl");
console.log(fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().replace(/"ts":"[^"]*",/g, "") : "egress: none");
