// Explicit trusted-owned-host profile. This is retention preparation, not OS isolation.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
export const OWNED_HOST_NOTICE = 'Trusted owned host: local tools have your ordinary account’s filesystem and network access. OS/tool isolation is deferred; the host and same-user processes can inspect this session. Inference still uses the admitted encrypted provider, with no alternate credential or automatic paid replay. No IP anonymity or secure erasure is claimed.';
export function memoryRoot(base = '/dev/shm') {
  if (process.platform !== 'linux' || fs.statfsSync(base).type !== 0x01021994) throw new Error('Owned-host session needs an existing Linux tmpfs; no disk-backed fallback is used.');
  const root = path.join(base, `abalone-${process.getuid()}`);
  try { fs.mkdirSync(root, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const s = fs.lstatSync(root);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700) throw new Error('Owned-host memory directory is not an owner-only directory.');
  return root;
}
// Exclusive flock on an open descriptor, held until this process exits; null when another process holds it.
function flock(fd) {
  const r = spawnSync('flock', ['-n', '-x', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 10000 });
  if (r.status === 1) return null;
  if (r.status !== 0) throw new Error('Owned-host session needs the util-linux flock command to mark its run directory live.');
  return fd;
}
// A run directory is live while its launcher holds the flock on run/alive. alive appears only by rename after
// the lock is taken, so a directory without it is being created (or predates this marker) and is left alone.
export function memoryRun(base) {
  const root = memoryRoot(base);
  for (const name of fs.readdirSync(root).filter((n) => n.startsWith('run-'))) {
    let fd;
    try { fd = fs.openSync(path.join(root, name, 'alive'), fs.constants.O_RDWR | fs.constants.O_NOFOLLOW); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    try { if (flock(fd) !== null) fs.rmSync(path.join(root, name), { recursive: true, force: true }); } finally { fs.closeSync(fd); }
  }
  const run = fs.mkdtempSync(path.join(root, 'run-'));
  for (const name of ['state', 'agent', 'tmp']) fs.mkdirSync(path.join(run, name), { mode: 0o700 });
  flock(fs.openSync(path.join(run, 'alive.new'), 'wx', 0o600));
  fs.renameSync(path.join(run, 'alive.new'), path.join(run, 'alive'));
  return run;
}
export function ownedHostEnvironment(input) {
  const env = {};
  for (const [k,v] of Object.entries(input)) if (/^(?:PATH|HOME|USER|TERM|LANG|COLORTERM|TMPDIR|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|ABALONE_(?:DIR|CONFIG|NO_CANARIES|CANARIES|INCOGNITO|TRACE_RETAINED|OWNED_HOST|SESSION_DESCRIPTOR|EGRESS|COUPON_SOCKET|COUPON_MODEL|COUPON_PROVIDER|COUPON_MAX_TOKENS|VIA)|PI_(?:CODING_AGENT_DIR|RESUME_HINT|QUIET_MANAGED_TOOLS|ADMITTED_HOSTS)|NODE_OPTIONS)$/.test(k)) env[k] = v;
  return env;
}
