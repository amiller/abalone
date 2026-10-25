import { open, mkdir, rename, unlink, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const maxJournalBytes = 1048576;

const phases = ['instruction', 'payment-seen', 'confirming', 'converting', 'credit-ready'];
const terminal = new Set(['credit-ready', 'refunded', 'cancelled']);
const validPhases = new Set([...phases, 'refund-pending', 'refunded', 'cancelled']);
const bounded = value => typeof value === 'string' && value.length > 0 && value.length <= 2048;
function transition(from, to) {
  if (!validPhases.has(to) || terminal.has(from)) return false;
  return (phases.indexOf(from) >= 0 && phases[phases.indexOf(from) + 1] === to)
    || (from !== 'refund-pending' && to === 'refund-pending')
    || (from === 'refund-pending' && to === 'refunded')
    || (from === 'instruction' && to === 'cancelled');
}

function validate(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.events)
    || !Number.isSafeInteger(state.revision) || state.revision < 0
    || state.revision !== state.events.length) throw new Error('Invalid journal');
  let active = null;
  const ids = new Set(), eventIds = new Set();
  for (const event of state.events) {
    if (!event || !bounded(event.at) || !Number.isFinite(Date.parse(event.at))) throw new Error('Invalid journal event');
    if (event.kind === 'begin') {
      const next = instruction(event.instruction);
      if (ids.has(next.id) || (active && !terminal.has(active.phase))) throw new Error('Conflicting journal instruction');
      ids.add(next.id);
      active = { instruction: next, phase: 'instruction', evidenceRef: null };
    } else if (event.kind === 'advance') {
      if (![event.instructionId, event.eventId, event.evidenceRef].every(bounded)
        || eventIds.has(event.eventId) || !active || active.instruction.id !== event.instructionId
        || !transition(active.phase, event.phase)) throw new Error('Invalid journal transition');
      eventIds.add(event.eventId);
      active.phase = event.phase;
      active.evidenceRef = event.evidenceRef;
    } else throw new Error('Invalid journal event kind');
  }
  if (JSON.stringify(active) !== JSON.stringify(state.active)) throw new Error('Journal snapshot disagrees with history');
  return state;
}

// Store public recovery references only. Wallet seeds and provider credentials
// belong in a separately protected store, never in this journal or agent context.
function instruction(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid instruction');
  for (const name of ['id', 'address', 'asset', 'amount', 'expiresAt', 'recoveryRef']) {
    if (typeof value[name] !== 'string' || !value[name] || value[name].length > 2048) {
      throw new Error(`Invalid instruction ${name}`);
    }
  }
  if (!/^\d+$/.test(value.amount) || BigInt(value.amount) <= 0n) throw new Error('Amount must be positive integer base units');
  if (!Number.isFinite(Date.parse(value.expiresAt))) throw new Error('Invalid expiry');
  return Object.fromEntries(['id', 'address', 'asset', 'amount', 'expiresAt', 'recoveryRef'].map(k => [k, value[k]]));
}

async function checkDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)
    || await realpath(directory) !== directory) throw new Error('Journal requires an owned private directory without symlinks');
}

// Kernel-held lock for one mutation. A python3 stdlib helper flock()s descriptor 3, the
// persistent payment.flock inode, without blocking, then sleeps until its stdin pipe reaches
// EOF. The lock lives exactly as long as the writer: if the writer is killed (even SIGKILL)
// the kernel closes the pipe, the helper exits and the flock is released, so a crashed
// writer never wedges the journal and the next writer resumes from the last committed,
// fsynced, atomically renamed snapshot. A competing live writer is refused immediately.
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

export async function holdJournalLock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await checkDirectory(directory);
  // A payment.lock file can only be a leftover from the legacy exclusive-create scheme:
  // it may mark an interrupted writer whose replacement never committed. Fail closed and
  // require an operator to reconcile offline and remove it by hand; never auto-delete.
  const legacy = await lstat(join(directory, 'payment.lock')).then(s => s, e => { if (e.code !== 'ENOENT') throw e; });
  if (legacy) {
    throw new Error('Legacy payment.lock present: reconcile interrupted writer offline, then remove payment.lock by hand; it is never deleted automatically');
  }
  const lockPath = join(directory, 'payment.flock');
  const file = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  let child;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.nlink !== 1) throw new Error('Journal lock must be an owned private regular file with no hard links');
    child = spawn('python3', ['-I', '-c', lockHelper], { stdio: ['pipe', 'pipe', 'ignore', file.fd] });
    const acquired = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Journal lock helper timed out')), 15000);
      const settle = fn => { clearTimeout(timer); fn(); };
      child.stdout.once('data', c => settle(() => (c.toString() === 'held' ? resolve(true) : reject(new Error('Journal lock helper protocol error')))));
      child.once('error', e => settle(() => reject(e.code === 'ENOENT' ? new Error('python3 with fcntl is required to lock the payment journal') : e)));
      child.once('exit', c => settle(() => (c === 3 ? resolve(false) : reject(new Error('Journal lock helper failed to acquire or hold')))));
    });
    if (!acquired) throw new Error('Payment journal is locked by another writer; retry after it completes');
    const held = await file.stat(), named = await lstat(lockPath);
    if (!named || named.nlink !== 1 || named.ino !== held.ino || named.dev !== held.dev) throw new Error('Journal lock file identity changed during acquisition');
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

export class CreditJournal {
  constructor(directory) { this.directory = resolve(directory); }

  async checkDirectory() { return checkDirectory(this.directory); }

  async read() {
    try {
      await this.checkDirectory();
      // O_NONBLOCK so a FIFO substituted for the journal cannot hang open(); fstat then
      // refuses it as a non-regular file. Reads are capped at 1MiB before parsing.
      const file = await open(join(this.directory, 'payment.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.nlink !== 1) throw new Error('Journal requires an owned private regular file');
        if (info.size > maxJournalBytes) throw new Error('Journal exceeds the 1MiB read limit');
        const buffer = Buffer.alloc(maxJournalBytes);
        const { bytesRead } = await file.read(buffer, 0, maxJournalBytes, 0);
        return validate(JSON.parse(buffer.toString('utf8', 0, bytesRead)));
      } finally { await file.close(); }
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, revision: 0, active: null, events: [] };
      throw error; // Corruption must never be treated as an empty wallet.
    }
  }

  async mutate(change) {
    const release = await holdJournalLock(this.directory);
    const temporary = join(this.directory, `.payment-${randomUUID()}.tmp`);
    try {
      const state = await this.read();
      const changed = change(state);
      // The callback must answer synchronously with a boolean. A promise or thenable
      // is truthy and would otherwise commit a change that was never applied.
      if (changed !== null && typeof changed === 'object' && typeof changed.then === 'function') throw new Error('mutate callback must return a synchronous boolean, not a promise or thenable');
      if (typeof changed !== 'boolean') throw new Error('mutate callback must return a boolean');
      if (!changed) return state;
      state.revision += 1;
      // Serialize and validate the complete updated state, and enforce the same 1MiB
      // cap the reader applies, before creating or renaming anything: a commit must
      // never leave a snapshot a reopened journal would refuse, so a rejected growth
      // keeps the previous committed payment.json intact.
      const serialized = JSON.stringify(state) + '\n';
      if (Buffer.byteLength(serialized) > maxJournalBytes) throw new Error('Mutation would exceed the 1MiB journal limit');
      validate(JSON.parse(serialized));
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(serialized); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, join(this.directory, 'payment.json'));
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return state;
    } finally {
      // Release the kernel lock even when temp cleanup itself fails.
      try { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
      finally { await release(); }
    }
  }

  async begin(value) {
    const next = instruction(value);
    return this.mutate(state => {
      const previous = state.events.find(e => e.kind === 'begin' && e.instruction.id === next.id);
      if (previous) {
        if (JSON.stringify(previous.instruction) !== JSON.stringify(next)) throw new Error('Instruction ID reused with different payment details');
        return false;
      }
      if (state.active && !terminal.has(state.active.phase)) throw new Error('Pending payment must be reconciled before creating another instruction');
      if (Date.parse(next.expiresAt) <= Date.now()) throw new Error('Cannot begin an expired instruction');
      state.active = { instruction: next, phase: 'instruction', evidenceRef: null };
      state.events.push({ kind: 'begin', instruction: next, at: new Date().toISOString() });
      return true;
    });
  }

  async advance({ instructionId, eventId, phase, evidenceRef }) {
    if (!validPhases.has(phase)) throw new Error('Invalid payment phase');
    if (![instructionId, eventId, evidenceRef].every(x => typeof x === 'string' && x.length > 0 && x.length <= 2048)) throw new Error('Missing bounded event identifiers or evidence reference');
    return this.mutate(state => {
      const previous = state.events.find(e => e.eventId === eventId);
      if (previous) {
        if (previous.instructionId !== instructionId || previous.phase !== phase || previous.evidenceRef !== evidenceRef) throw new Error('Event ID conflict');
        return false;
      }
      const active = state.active;
      if (!active || active.instruction.id !== instructionId) throw new Error('Unknown active instruction');
      const from = active.phase;
      if (!transition(from, phase)) throw new Error(`Invalid payment transition ${from} -> ${phase}`);
      active.phase = phase;
      active.evidenceRef = evidenceRef;
      state.events.push({ kind: 'advance', instructionId, eventId, phase, evidenceRef, at: new Date().toISOString() });
      return true;
    });
  }
}
