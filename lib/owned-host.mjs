// Explicit trusted-owned-host profile. This is retention preparation, not OS isolation.
import fs from 'node:fs';
import path from 'node:path';
export const OWNED_HOST_NOTICE = 'Trusted owned host: local tools have your ordinary account’s filesystem and network access. OS/tool isolation is deferred; the host and same-user processes can inspect this session. Inference still uses the admitted encrypted provider, with no alternate credential or automatic paid replay. No IP anonymity or secure erasure is claimed.';
export function memoryRoot(base = '/dev/shm') {
  if (process.platform !== 'linux' || fs.statfsSync(base).type !== 0x01021994) throw new Error('Owned-host session needs an existing Linux tmpfs; no disk-backed fallback is used.');
  const root = path.join(base, `abalone-${process.getuid()}`);
  try { fs.mkdirSync(root, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const s = fs.lstatSync(root);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700) throw new Error('Owned-host memory directory is not an owner-only directory.');
  return root;
}
export function memoryRun() {
  const run = fs.mkdtempSync(path.join(memoryRoot(), 'run-'));
  for (const name of ['state', 'agent', 'tmp']) fs.mkdirSync(path.join(run, name), { mode: 0o700 });
  return run;
}
export function ownedHostEnvironment(input) {
  const env = {};
  for (const [k,v] of Object.entries(input)) if (/^(?:PATH|HOME|USER|TERM|LANG|COLORTERM|TMPDIR|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|ABALONE_(?:DIR|CONFIG|NO_CANARIES|CANARIES|INCOGNITO|TRACE_RETAINED|OWNED_HOST|SESSION_DESCRIPTOR|EGRESS|COUPON_SOCKET|COUPON_MODEL|COUPON_PROVIDER|VIA)|PI_(?:CODING_AGENT_DIR|RESUME_HINT|QUIET_MANAGED_TOOLS|ADMITTED_HOSTS)|NODE_OPTIONS)$/.test(k)) env[k] = v;
  return env;
}
