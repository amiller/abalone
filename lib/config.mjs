// Paths and config shared by the launcher, the curated extension, sealed-mcp and `sealed caps`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const CFG = process.env.ABALONE_CONFIG ?? ROOT; // providers.json, curated/manifest.json, policy.json
export const STATE = process.env.ABALONE_DIR ?? path.join(os.homedir(), ".abalone");
// Everything abalone and its children write (logs, notebook, sessions, private-out, exports) is owner-only: files 0600, dirs 0700.
process.umask(0o077);
export const AGENT_DIR = path.join(STATE, "agent");
export const PEER_DIR = path.join(STATE, "peer");
export const PRIVATE_OUT = path.join(STATE, "private-out");
export const RUNNER_HOME = path.join(ROOT, "runner-home");
// The human's approvals: standing.json (standing policies) and pending/ (pours waiting for `abalone approvals`).
// Only `abalone approvals` writes here; the private sandbox sees it read-only. The repo ships no standing policy.
export const APPROVALS = path.join(STATE, "approvals");

export const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
export const providers = () => readJson(path.join(CFG, "providers.json"));
export const manifest = () => readJson(path.join(CFG, "curated", "manifest.json"));
export const policy = () => readJson(path.join(CFG, "policy.json"));
export const standing = () => {
  const f = path.join(APPROVALS, "standing.json"), s = fs.existsSync(f) ? readJson(f) : {};
  return Object.fromEntries(policy().answerers.map((a) => [a, s[a] ?? []]));
};
export const catalog = () => Object.fromEntries(readJson(path.join(ROOT, policy().catalog)).policies.map((p) => [p.id, p]));
export const admittedHosts = () => { const p = providers(); return [...p.admitted.flatMap((a) => a.hosts), ...p.verifierHosts]; };
export const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
// ⌂ local providers must be on loopback. The egress forwards only these ports, and only to 127.0.0.1.
export function localPorts() {
  return providers().local.map((l) => {
    const u = new URL(l.baseUrl);
    if (!LOOPBACK.includes(u.hostname)) throw new Error(`✗ refused: local provider ${l.id} baseUrl ${l.baseUrl} is not on loopback`);
    return Number(u.port || 80);
  });
}
// "gift" (lib/peer.mjs) is NEAR's TEE reached through a gift peer, which sees only E2EE ciphertext: ◈ like NEAR itself.
export const place = (provider) => (provider === "nearai" && process.env.ABALONE_COUPON_SOCKET) ? "◈ attested" : (provider === "synthetic-near" && process.env.ABALONE_COUPON_SOCKET) || providers().local.some((l) => l.id === provider) ? "⌂ local" : provider === "gift" || providers().admitted.some((a) => a.id === provider) ? "◈ attested" : "○ outside";

export function log(name, rec) {
  fs.mkdirSync(STATE, { recursive: true });
  fs.appendFileSync(path.join(STATE, name), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n");
}

// Where a session's sockets live (a unix socket path may not exceed 107 bytes). Linux: $XDG_RUNTIME_DIR, which the
// login session provides. macOS has none, so the platform's dir is /tmp/abalone-<uid>, created 0700; an existing one
// that is not a directory owned by this user with mode 0700 is refused.
export function runtimeDir() {
  if (process.platform !== "darwin") {
    if (!process.env.XDG_RUNTIME_DIR) throw new Error("✗ refused: XDG_RUNTIME_DIR is not set. abalone keeps its sockets in a short per-user runtime dir; set it (normally /run/user/$(id -u))");
    return process.env.XDG_RUNTIME_DIR;
  }
  const d = `/tmp/abalone-${process.getuid()}`;
  try { fs.mkdirSync(d, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  const st = fs.lstatSync(d);
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700) throw new Error(`✗ refused: ${d} exists but is not a directory owned by you with mode 0700; remove it and start again`);
  return d;
}
