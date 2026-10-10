// An open runner (○ outside): one frontier CLI run on one pour, in the runner sandbox (lib/sandbox.mjs runnerArgv).
// Its scratch dir <STATE>/runs/<id> holds only pour.md; it reaches only providers.json runners.<name>.hosts through
// the egress CONNECT proxy in `egress` (a dir holding connect.sock). Used by ask_frontier and by `abalone ask --frontier`.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ROOT, STATE, providers } from "./config.mjs";
import { runnerArgv } from "./sandbox.mjs";

// No file or tool reference: with --tools "" a preamble naming pour.md made claude try to read it and stall (2026-10-08, live).
export const PREAMBLE = "Another agent asks the question below. Answer it directly: you have no tools and no files.\n\n";
export const home = (name) => path.join(ROOT, providers().runners[name].home);
export const findClaude = () => process.env.ABALONE_RUNNER_CLAUDE ?? spawnSync("bash", ["-c", 'readlink -f "$(command -v claude)"'], { encoding: "utf8" }).stdout.trim();

// Inside the private sandbox the runner logins are not mounted, so the launcher runs the runner (bin/abalone.mjs ctl.sock).
const viaLauncher = (name, payload) => new Promise((resolve, reject) => {
  let b = "";
  const s = net.connect(path.join(process.env.ABALONE_EGRESS, "ctl.sock"), () => s.end(JSON.stringify(["runner", name, payload])));
  s.on("data", (d) => (b += d));
  s.on("error", reject);
  s.on("end", () => { const r = JSON.parse(b); r.code === 0 ? resolve(JSON.parse(r.out)) : reject(new Error(r.err)); });
});

export function runRunner(name, payload, { egress, bin }) {
  if (process.env.ABALONE_SANDBOX) return viaLauncher(name, payload);
  if (!bin) throw new Error(`runner:${name} is not installed (no claude binary was found)`);
  if (!fs.existsSync(home(name))) throw new Error(`runner:${name} has no login: run  HOME=${home(name)} claude  once`);
  const id = crypto.randomUUID(), scratch = path.join(STATE, "runs", id);
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, "pour.md"), payload);
  const argv = [...runnerArgv({ run: egress, home: home(name), scratch, bin, connectSock: path.join(egress, "connect.sock") }),
    "/opt/runner/bin", "-p", "--tools", "", "--strict-mcp-config", "--no-chrome", "--output-format", "text"];
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    // The scratch dir holds the pour; it goes when the run ends, whatever the outcome (the released text is in disclosures.jsonl).
    child.on("close", (code) => {
      fs.rmSync(scratch, { recursive: true, force: true });
      code === 0 ? resolve({ id, answer: out }) : reject(new Error(`runner:${name} exited ${code}: ${(err || out).slice(-500)}`));
    });
    child.on("error", (e) => { fs.rmSync(scratch, { recursive: true, force: true }); reject(e); });
    child.stdin.end(PREAMBLE + payload);
  });
}
