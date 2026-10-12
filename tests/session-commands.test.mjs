// The slash commands each session kind registers: the actual curated extension, listed over Pi RPC (no model request).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
async function commands(env) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "abalone-commands-"));
  for (const n of ["state", "agent", "run", "work"]) fs.mkdirSync(path.join(base, n), { mode: 0o700 });
  const child = spawn(process.execPath, [path.join(root, "pi/packages/coding-agent/dist/cli.js"), "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--no-context-files", "--no-mcp", "--no-approve", "-e", path.join(root, "curated/abalone.ts"), "--no-session", "--mode", "rpc"], { cwd: path.join(base, "work"),
    env: { PATH: process.env.PATH, HOME: path.join(base, "agent"), ABALONE_DIR: path.join(base, "state"), ABALONE_CONFIG: root, ABALONE_EGRESS: path.join(base, "run"),
      PI_CODING_AGENT_DIR: path.join(base, "agent"), ABALONE_INCOGNITO: "1", ...env } });
  let out = "", err = "";
  child.stderr.on("data", (b) => (err += b));
  child.stdin.end(JSON.stringify({ id: "c", type: "get_commands" }) + "\n");
  for await (const b of child.stdout) out += b;
  fs.rmSync(base, { recursive: true, force: true });
  const reply = out.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.id === "c");
  assert.ok(reply?.success, err);
  return reply.data.commands.filter((c) => c.source === "extension").map((c) => c.name).sort();
}

test("a credit session registers only /status and /coupon", async () => {
  assert.deepEqual(await commands({ ABALONE_OWNED_HOST: "1", ABALONE_COUPON_SOCKET: "/nonexistent/coupon.sock", ABALONE_COUPON_MODEL: "m", ABALONE_COUPON_PROVIDER: "nearai" }),
    ["coupon", "status"]);
});

test("other sessions keep the full list and have no /coupon or /status", async () => {
  assert.deepEqual(await commands({}), ["about", "browser", "commission", "cost", "decide", "evidence", "fetch", "folder", "gift", "notebook", "privacy", "redeem", "report", "search", "tasks"]);
});

test("a credit session's system prompt names only /status and /coupon", async () => {
  process.env.ABALONE_COUPON_SOCKET = "/nonexistent/coupon.sock"; process.env.ABALONE_OWNED_HOST = "1";
  const { systemPrompt } = await import("../lib/welcome.mjs");
  const prompt = systemPrompt({ cwd: "work", model: "nearai/m", place: "◈ attested", tools: "in-content", usage: "u", browser: null });
  assert.deepEqual([...new Set(prompt.match(/(?<![\w/.])\/[a-z]+\b/g))].sort(), ["/coupon", "/status"]);
});
