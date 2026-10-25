// Kernel-held advisory lock for one mutation of a durable store file in this
// subsystem's own directories.
//
// The technique is adapted from portable/credit-journal (that file is not
// edited or imported): a stdlib `python3` helper flock()s descriptor 3 — a
// persistent lock-file inode — without blocking, then sleeps until its stdin
// pipe reaches EOF. The lock lives exactly as long as the mutating writer: if
// the writer dies, even by SIGKILL, the kernel closes the pipe, the helper
// exits on EOF and the flock is released, so a crashed writer never wedges the
// store and the next writer resumes from the last committed, fsynced,
// atomically renamed snapshot. An orphaned helper cannot retain the lock: it
// exits as soon as its stdin pipe reaches EOF. A competing live writer is
// refused immediately (non-blocking), never queued; callers that need
// serialized progress implement a bounded retry (see budget-journal.mjs).
import { open, mkdir, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const lockHelper = `
import fcntl, sys
try:
    fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    sys.exit(3)
sys.stdout.write("held")
sys.stdout.flush()
sys.stdin.buffer.read(1)
`;

export class StoreLockedError extends Error {
  constructor(message = 'store is locked by another live writer') {
    super(message);
    this.name = 'StoreLockedError';
    this.code = 'STORE_LOCKED';
  }
}

// Bounded, explicit contention handling: a competing live writer is refused
// immediately by the kernel, and the caller retries a small bounded number of
// times before failing closed. Never an unbounded queue.
export async function runLocked(directory, fileName, work, { maxLockAttempts = 40, lockRetryDelayMs = 15 } = {}) {
  if (!Number.isSafeInteger(maxLockAttempts) || maxLockAttempts < 1 || maxLockAttempts > 1000
    || !Number.isSafeInteger(lockRetryDelayMs) || lockRetryDelayMs < 1 || lockRetryDelayMs > 1000) {
    throw new Error('invalid lock retry bounds');
  }
  let attempt = 0;
  for (;;) {
    let release;
    try {
      release = await acquireStoreLock(directory, fileName);
    } catch (error) {
      if (error instanceof StoreLockedError && ++attempt < maxLockAttempts) {
        await new Promise(resolve => setTimeout(resolve, lockRetryDelayMs));
        continue;
      }
      throw error;
    }
    try {
      return await work(release);
    } finally {
      await release();
    }
  }
}

// `directory` must already be an owned private directory (callers check);
// `fileName` names the persistent lock inode inside it.
export async function acquireStoreLock(directory, fileName) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, fileName);
  const file = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  let child;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.nlink !== 1) {
      throw new Error('Store lock must be an owned private regular file with no hard links');
    }
    child = spawn('python3', ['-I', '-c', lockHelper], { stdio: ['pipe', 'pipe', 'ignore', file.fd] });
    const acquired = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Store lock helper timed out')), 15000);
      const settle = fn => { clearTimeout(timer); fn(); };
      child.stdout.once('data', c => settle(() => (c.toString() === 'held' ? resolve(true) : reject(new Error('Store lock helper protocol error')))));
      child.once('error', e => settle(() => (e.code === 'ENOENT' ? reject(new Error('python3 with fcntl is required to lock the inference broker store')) : reject(e))));
      child.once('exit', c => settle(() => (c === 3 ? resolve(false) : reject(new Error('Store lock helper failed to acquire or hold')))));
    });
    if (!acquired) throw new StoreLockedError();
    const held = await file.stat(), named = await lstat(lockPath);
    if (!named || named.nlink !== 1 || named.ino !== held.ino || named.dev !== held.dev) {
      throw new Error('Store lock file identity changed during acquisition');
    }
  } catch (error) {
    if (child) { try { child.kill('SIGKILL'); } catch {} try { child.stdin.destroy(); } catch {} }
    await file.close().catch(() => {});
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await new Promise(resolve => {
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        try { child.stdin.end(); } catch { try { child.kill('SIGKILL'); } catch {} }
      });
    } finally {
      try { child.stdin.destroy(); } catch {}
      await file.close().catch(() => {});
    }
  };
}
