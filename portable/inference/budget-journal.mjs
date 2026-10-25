// Durable authorized-budget journal for the portable inference broker.
//
// Amounts are integer base-unit strings (BigInt semantics, never floats). A
// journal records exactly one `authorize` event (the durable spend cap, set on
// first open; a restart with a different cap is refused — restart never resets
// the budget) followed by per-logical-request events:
//
//   reserve {id, amount}   — durably claim `amount` before any transmission;
//                            the amount is the trusted maximum-charge bound
//                            derived from the validated request, never a
//                            caller-claimed price or a flat constant
//   settle  {id, amount}   — resolved; actual spend is `amount` (usage-priced).
//                            A settlement larger than the reservation is
//                            recorded truthfully (settle at the ACTUAL amount,
//                            plus an explicit `discrepancy` event) and then
//                            throws BudgetDiscrepancyError: spending is
//                            suspended until operator reconciliation, and
//                            `reserve` refuses every further request while
//                            any discrepancy exists. An overspend is never
//                            normalized away as an ordinary settlement and
//                            the actual evidence is never erased.
//   abandon {id}           — resolved as outcome-unknown; the full reservation
//                            is consumed and the id stays burned forever
//
// A restart finds unresolved reserves (the writer may have died between
// transmission and settlement) and `sweepUnresolved` converts each to
// `abandon`: post-transmission loss is always charged, and a caller can never
// translate a failure into an uncharged retry. Duplicate logical ids are
// refused forever after, including after restarts.
//
// Writes are serialized by the kernel flock primitive in lock.mjs (adapted
// from portable/credit-journal, separate files and directories; that module is
// not edited). Each mutation is read-modify-rename-fsync under the lock with
// full revalidation of the serialized snapshot before anything is renamed, so
// a committed journal is always one its own reader will accept. Contention
// with a live writer is retried a bounded number of times, then fails closed.
// Corruption is never treated as an empty budget. Journal size is capped at
// 1MiB; a refused growth leaves the previous committed snapshot intact.
import { open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireStoreLock, StoreLockedError, runLocked } from './lock.mjs';

const maxJournalBytes = 1048576;
const idPattern = /^[A-Za-z0-9_-]{16,64}$/;

export class BudgetDuplicateError extends Error {
  constructor(message = 'logical request id already recorded') { super(message); this.name = 'BudgetDuplicateError'; this.code = 'DUPLICATE_REQUEST'; }
}
export class BudgetExhaustedError extends Error {
  constructor(message = 'authorized budget exhausted') { super(message); this.name = 'BudgetExhaustedError'; this.code = 'BUDGET_EXHAUSTED'; }
}
export class BudgetDiscrepancyError extends Error {
  constructor(message = 'a settlement exceeded its reserved bound; spending is suspended pending reconciliation') {
    super(message); this.name = 'BudgetDiscrepancyError'; this.code = 'SETTLEMENT_DISCREPANCY';
  }
}

const amountString = value => typeof value === 'string' && /^\d{1,19}$/.test(value) && BigInt(value) > 0n;
const settleString = value => typeof value === 'string' && /^\d{1,19}$/.test(value);
const bounded = value => typeof value === 'string' && value.length > 0 && value.length <= 2048;
const fail = () => new Error('Invalid budget journal');

function replay(events) {
  let authorized = null, spent = 0n, outstanding = 0n;
  const byId = new Map();
  for (const event of events) {
    if (!event || !bounded(event.at) || !Number.isFinite(Date.parse(event.at))) throw fail();
    if (event.kind === 'authorize') {
      if (authorized !== null || !amountString(event.total)) throw fail();
      authorized = BigInt(event.total);
    } else if (event.kind === 'reserve') {
      if (authorized === null || !idPattern.test(event.id ?? '') || !amountString(event.amount) || byId.has(event.id)) throw fail();
      byId.set(event.id, { amount: BigInt(event.amount), resolved: null, settled: null });
      outstanding += BigInt(event.amount);
    } else if (event.kind === 'settle') {
      const entry = byId.get(event.id);
      if (!entry || entry.resolved !== null || !settleString(event.amount)) throw fail();
      entry.resolved = 'settle';
      entry.settled = BigInt(event.amount);
      outstanding -= entry.amount;
      spent += BigInt(event.amount);
    } else if (event.kind === 'discrepancy') {
      // Truthful reconciliation evidence: the settle event one step earlier
      // recorded the actual (over-reservation) spend; this event names the
      // reserved and actual amounts explicitly and suspends further spending.
      const entry = byId.get(event.id);
      if (!entry || entry.resolved !== 'settle' || !settleString(event.reserved) || !settleString(event.actual)) throw fail();
      if (BigInt(event.reserved) !== entry.amount || BigInt(event.actual) !== entry.settled || BigInt(event.actual) <= BigInt(event.reserved)) throw fail();
    } else if (event.kind === 'abandon') {
      const entry = byId.get(event.id);
      if (!entry || entry.resolved !== null) throw fail();
      entry.resolved = 'abandon';
      outstanding -= entry.amount;
      spent += entry.amount; // outcome unknown consumes the full reservation
    } else throw fail();
  }
  if (authorized === null) throw fail();
  return { totals: { authorized: authorized.toString(), spent: spent.toString(), outstanding: outstanding.toString() }, byId };
}

function validate(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.events)
    || !Number.isSafeInteger(state.revision) || state.revision < 0
    || state.revision !== state.events.length) throw fail();
  if (state.events.length === 0) throw fail(); // an empty journal still has no authorize; caller distinguishes via readEmpty
  const { totals } = replay(state.events);
  if (JSON.stringify(state.totals) !== JSON.stringify(totals)) throw new Error('Budget journal snapshot disagrees with history');
  return state;
}

function emptyState() {
  return { version: 1, revision: 0, totals: null, events: [] };
}

export class BudgetJournal {
  constructor(directory, { maxLockAttempts = 40, lockRetryDelayMs = 15 } = {}) {
    if (!Number.isSafeInteger(maxLockAttempts) || maxLockAttempts < 1 || maxLockAttempts > 1000
      || !Number.isSafeInteger(lockRetryDelayMs) || lockRetryDelayMs < 1 || lockRetryDelayMs > 1000) throw fail();
    this.directory = resolve(directory);
    this.maxLockAttempts = maxLockAttempts;
    this.lockRetryDelayMs = lockRetryDelayMs;
  }

  // Returns the committed snapshot, or the empty state when no journal exists.
  // Corruption always throws; it is never treated as an empty budget.
  async read() {
    let file;
    try {
      file = await open(join(this.directory, 'budget.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState();
      throw error;
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.nlink !== 1) {
        throw new Error('Budget journal requires an owned private regular file with no hard links');
      }
      if (info.size > maxJournalBytes) throw new Error('Budget journal exceeds the 1MiB read limit');
      const buffer = Buffer.alloc(maxJournalBytes);
      const { bytesRead } = await file.read(buffer, 0, maxJournalBytes, 0);
      let parsed;
      try { parsed = JSON.parse(buffer.toString('utf8', 0, bytesRead)); } catch { throw fail(); }
      return validate(parsed);
    } finally {
      await file.close().catch(() => {});
    }
  }

  async mutate(change) {
    return runLocked(this.directory, 'budget.flock', async release => {
      const temporary = join(this.directory, `.budget-${randomUUID()}.tmp`);
      try {
        const state = await this.read();
        const changed = change(state);
        // The callback must answer synchronously with a boolean; a promise or
        // thenable would commit a change that was never applied.
        if (changed !== null && typeof changed === 'object' && typeof changed.then === 'function') {
          throw new Error('mutate callback must return a synchronous boolean, not a promise');
        }
        if (typeof changed !== 'boolean') throw new Error('mutate callback must return a boolean');
        if (!changed) return state;
        state.revision = state.events.length;
        const serialized = JSON.stringify(state) + '\n';
        if (Buffer.byteLength(serialized) > maxJournalBytes) throw new Error('Mutation would exceed the 1MiB budget journal limit');
        validate(JSON.parse(serialized));
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
        await rename(temporary, join(this.directory, 'budget.json'));
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        return state;
      } finally {
        try { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
        finally { await release(); }
      }
    }, { maxLockAttempts: this.maxLockAttempts, lockRetryDelayMs: this.lockRetryDelayMs });
  }

  snapshot() {
    return this.read().then(state => {
      if (state.revision === 0) return { authorized: null, spent: '0', outstanding: '0', entries: [], discrepancies: [] };
      const { totals, byId } = replay(state.events);
      return {
        authorized: totals.authorized, spent: totals.spent, outstanding: totals.outstanding,
        entries: state.events.map(e => ({ ...e, ...(byId.has(e.id) ? { resolved: byId.get(e.id).resolved } : {}) })),
        discrepancies: state.events.filter(e => e.kind === 'discrepancy').map(e => ({ id: e.id, reserved: e.reserved, actual: e.actual })),
      };
    });
  }

  // First open writes the durable cap; a later open with the same cap is
  // idempotent, a different cap is refused. The cap is never reset.
  async ensureAuthorized(total) {
    if (!amountString(total)) throw new Error('authorized budget must be a positive integer base-unit string');
    return this.mutate(state => {
      const existing = state.events.find(e => e.kind === 'authorize');
      if (existing) {
        if (existing.total !== total) throw new Error(`Budget cap already durably authorized as ${existing.total}; refusing to reset it to ${total}`);
        return false;
      }
      state.totals = { authorized: total, spent: '0', outstanding: '0' };
      state.events.push({ kind: 'authorize', total, at: new Date().toISOString() });
      return true;
    });
  }

  async reserve({ id, amount }) {
    if (!idPattern.test(id ?? '')) throw new Error('Invalid logical request id');
    if (!amountString(amount)) throw new Error('Reservation must be a positive integer base-unit string');
    return this.mutate(state => {
      if (state.events.some(e => (e.kind === 'reserve') && e.id === id)) throw new BudgetDuplicateError();
      const { totals } = replay(state.events);
      // A recorded settlement discrepancy suspends all further spending until
      // an operator reconciles it; this is durable across restarts.
      if (state.events.some(e => e.kind === 'discrepancy')) {
        throw new BudgetDiscrepancyError('spending is suspended: a recorded settlement discrepancy awaits operator reconciliation');
      }
      const spent = BigInt(totals.spent), outstanding = BigInt(totals.outstanding), authorized = BigInt(totals.authorized);
      if (spent + outstanding + BigInt(amount) > authorized) throw new BudgetExhaustedError();
      state.events.push({ kind: 'reserve', id, amount, at: new Date().toISOString() });
      state.totals = {
        authorized: totals.authorized,
        spent: totals.spent,
        outstanding: (outstanding + BigInt(amount)).toString(),
      };
      return true;
    });
  }

  async settle({ id, amount }) {
    if (!idPattern.test(id ?? '') || !settleString(amount)) throw new Error('Invalid settlement');
    let overReservation = false;
    await this.mutate(state => {
      const entry = state.events.find(e => e.kind === 'reserve' && e.id === id);
      if (!entry) throw new Error('Unknown logical request id');
      if (state.events.some(e => (e.kind === 'settle' || e.kind === 'abandon') && e.id === id)) {
        throw new Error('Logical request already resolved');
      }
      const { totals } = replay(state.events);
      // The actual amount is recorded truthfully even when it exceeds the
      // reservation (or the cap): spent reflects reality, and an explicit
      // discrepancy event suspends further spending instead of normalizing
      // the overspend as an ordinary settlement.
      overReservation = BigInt(amount) > BigInt(entry.amount);
      const at = new Date().toISOString();
      state.events.push({ kind: 'settle', id, amount, at });
      if (overReservation) state.events.push({ kind: 'discrepancy', id, reserved: entry.amount, actual: amount, at });
      state.totals = {
        authorized: totals.authorized,
        spent: (BigInt(totals.spent) + BigInt(amount)).toString(),
        outstanding: (BigInt(totals.outstanding) - BigInt(entry.amount)).toString(),
      };
      return true;
    });
    if (overReservation) {
      throw new BudgetDiscrepancyError(`settlement ${amount} exceeded the reserved bound for ${id}; the actual spend is recorded and spending is suspended pending reconciliation`);
    }
  }

  // Outcome unknown: the full reservation is consumed and the id stays burned.
  async abandon({ id }) {
    if (!idPattern.test(id ?? '')) throw new Error('Invalid logical request id');
    return this.mutate(state => {
      const entry = state.events.find(e => e.kind === 'reserve' && e.id === id);
      if (!entry) throw new Error('Unknown logical request id');
      if (state.events.some(e => (e.kind === 'settle' || e.kind === 'abandon') && e.id === id)) {
        throw new Error('Logical request already resolved');
      }
      const { totals } = replay(state.events);
      state.events.push({ kind: 'abandon', id, at: new Date().toISOString() });
      state.totals = {
        authorized: totals.authorized,
        spent: (BigInt(totals.spent) + BigInt(entry.amount)).toString(),
        outstanding: (BigInt(totals.outstanding) - BigInt(entry.amount)).toString(),
      };
      return true;
    });
  }

  // Convert every unresolved reservation to `abandon` (outcome unknown),
  // returning {id, amount} pairs so callers account the actually-reserved
  // bound per id. Used at broker start after a restart: post-transmission
  // loss is charged at its own reservation, never refunded, and the budget
  // is never reset.
  async sweepUnresolved() {
    const abandoned = [];
    for (;;) {
      const state = await this.read();
      const unresolved = state.events.filter(e => e.kind === 'reserve'
        && !state.events.some(r => (r.kind === 'settle' || r.kind === 'abandon') && r.id === e.id));
      const next = unresolved[0];
      if (!next) return abandoned;
      await this.abandon({ id: next.id });
      abandoned.push({ id: next.id, amount: next.amount });
    }
  }
}
