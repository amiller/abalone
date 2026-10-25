import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat, symlink, chmod, link, readFile, readdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CreditJournal } from './journal.mjs';

async function setup(t) {
  const path = await mkdtemp(join(tmpdir(), 'portable-payment-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return { path, journal: new CreditJournal(path) };
}
const payment = () => ({ id: 'synthetic-1', address: 'NONPAYABLE-FIXTURE', asset: 'ZEC', amount: '100000', expiresAt: new Date(Date.now() + 3600000).toISOString(), recoveryRef: 'fixture-wallet-reference' });

test('restart resumes exact instruction and repeated delivery does not duplicate it', async t => {
  const { path, journal } = await setup(t);
  const value = payment();
  await journal.begin(value);
  const reopened = new CreditJournal(path);
  assert.deepEqual((await reopened.read()).active.instruction, value);
  assert.equal((await reopened.begin(value)).revision, 1);
  await assert.rejects(reopened.begin({ ...value, id: 'second' }), /Pending payment/);
  await assert.rejects(reopened.begin({ ...value, amount: '200000' }), /reused/);
  assert.equal((await stat(join(path, 'payment.json'))).mode & 0o777, 0o600);
});

test('settlement requires ordered evidence and event replay is idempotent', async t => {
  const { journal } = await setup(t);
  await journal.begin(payment());
  const event = phase => ({ instructionId: 'synthetic-1', eventId: phase, phase, evidenceRef: `fixture:${phase}` });
  await assert.rejects(journal.advance(event('credit-ready')), /Invalid payment transition/);
  for (const phase of ['payment-seen', 'confirming', 'converting', 'credit-ready']) await journal.advance(event(phase));
  const result = await journal.advance(event('credit-ready'));
  assert.equal(result.revision, 5);
  assert.equal(result.active.phase, 'credit-ready');
  await assert.rejects(journal.advance({ ...event('credit-ready'), evidenceRef: 'changed' }), /Event ID conflict/);
  await assert.rejects(journal.advance({ ...event('payment-seen'), eventId: 'backward' }), /Invalid payment transition/);
});

test('corruption and interrupted writer fail closed', async t => {
  const { path, journal } = await setup(t);
  await writeFile(join(path, 'payment.json'), 'broken', { mode: 0o600 });
  await assert.rejects(journal.begin(payment()), SyntaxError);
  await rm(join(path, 'payment.json'));
  await writeFile(join(path, 'payment.lock'), 'interrupted writer');
  await assert.rejects(journal.begin(payment()), /reconcile interrupted writer/);
  // The legacy lock is never removed automatically, even by successful-looking retries.
  assert.ok((await stat(join(path, 'payment.lock'))).isFile());
});

test('SIGKILLed lock holder releases the kernel lock; a live competing writer is refused', async t => {
  const { path, journal } = await setup(t);
  const modulePath = fileURLToPath(new URL('./journal.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { holdJournalLock } from ${JSON.stringify(modulePath)};
    const release = await holdJournalLock(${JSON.stringify(path)});
    process.stdout.write('held\\n');
    await new Promise(() => {});
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child never acquired the lock')), 15000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('child exited before holding the lock')); });
  });
  await assert.rejects(journal.begin(payment()), /locked by another writer/);
  assert.equal((await stat(join(path, 'payment.flock'))).mode & 0o777, 0o600);
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  // The orphaned helper must see EOF and exit; the next writer acquires promptly.
  let state;
  for (let i = 0; ; i++) {
    try { state = await journal.begin(payment()); break; }
    catch (error) {
      if (!/locked by another writer/.test(error.message) || i >= 50) throw error;
      await new Promise(r => setTimeout(r, 100));
    }
  }
  assert.equal(state.revision, 1);
  assert.equal((await journal.read()).events.length, 1);
});

test('a substituted FIFO is refused immediately and oversized journals are refused', async t => {
  const { path, journal } = await setup(t);
  const fifo = join(path, 'payment.json');
  assert.equal(spawnSync('python3', ['-I', '-c', 'import os,sys; os.mkfifo(sys.argv[1])', fifo]).status, 0);
  const start = Date.now();
  await assert.rejects(journal.read(), /regular file/);
  await assert.rejects(journal.begin(payment()), /regular file/);
  assert.ok(Date.now() - start < 5000, 'FIFO refusal must not hang');
  await rm(fifo);
  await writeFile(join(path, 'payment.json'), 'x'.repeat(1048577), { mode: 0o600 });
  await assert.rejects(journal.read(), /1MiB/);
});

const capBytes = 1048576;
const future = () => new Date(Date.now() + 3600000).toISOString();
const synthetic = (id, recoveryRef) => ({ id, address: 'NONPAYABLE-FIXTURE', asset: 'ZEC', amount: '1', expiresAt: future(), recoveryRef });

// Commits a valid synthetic history ending just under the 1MiB cap: coarse
// terminal refund cycles, then refill cycles whose reference length is halved
// until the serialized size fits. `room` is the headroom the committed file must
// keep (a later single event must still be committable or refusable on purpose).
async function fillNearCap(path, state, room) {
  const at = '2026-01-01T00:00:00.000Z';
  const push = (id, ref) => {
    state.events.push({ kind: 'begin', instruction: synthetic(id, ref), at });
    for (const [n, phase] of ['payment-seen', 'refund-pending', 'refunded'].entries())
      state.events.push({ kind: 'advance', instructionId: id, eventId: `e-${state.events.length}-${n}`, phase, evidenceRef: ref, at });
    state.active = { instruction: synthetic(id, ref), phase: 'refunded', evidenceRef: ref };
    state.revision = state.events.length;
  };
  const len = () => JSON.stringify(state).length;
  for (let k = 0; len() + 14000 < capBytes; k++) push(`${k}-`.padEnd(2048, 'x'), 'r'.repeat(512));
  while (capBytes - len() > room) {
    const mark = state.events.length, active = state.active;
    for (let ref = 2048; ; ref = ref > 1 ? Math.floor(ref / 2) : 1) {
      push(`f${mark}`, 'r'.repeat(ref));
      // Keep at least `room` bytes of headroom (or, once the reference cannot
      // shrink further, whatever the smallest cycle leaves) so the file stays valid.
      if (len() <= capBytes - room || ref === 1) break;
      state.events.length = mark;
      state.active = active;
    }
  }
  await writeFile(join(path, 'payment.json'), JSON.stringify(state) + '\n', { mode: 0o600 });
}

test('growth across the 1MiB cap is refused and the committed snapshot survives', async t => {
  // A terminal history near the cap: the next begin would cross the limit.
  {
    const { path, journal } = await setup(t);
    const state = { version: 1, revision: 0, active: null, events: [] };
    await fillNearCap(path, state, 4200);
    const file = join(path, 'payment.json');
    const committed = await readFile(file);
    assert.ok(committed.length <= capBytes && committed.length > capBytes - 4300, 'fixture should sit just under the cap');
    await assert.rejects(journal.begin(synthetic('cross-'.padEnd(2048, 'c'), 'c'.repeat(2048))), /1MiB/);
    assert.deepEqual(await readFile(file), committed);
    const reread = await journal.read();
    assert.equal(reread.revision, state.revision);
    assert.equal(reread.events.length, state.events.length);
    // The refusal released the lock; a no-op mutation reads the committed state.
    assert.equal((await journal.mutate(() => false)).revision, state.revision);
    assert.deepEqual(await readFile(file), committed);
  }
  // An open instruction near the cap: the next advance would cross the limit.
  {
    const { path, journal } = await setup(t);
    const state = { version: 1, revision: 0, active: null, events: [] };
    await fillNearCap(path, state, 8000);
    const openId = 'open-'.padEnd(2048, 'o');
    await journal.begin(synthetic(openId, 'o'.repeat(2048))); // still fits, commits
    const file = join(path, 'payment.json');
    const committed = await readFile(file);
    assert.ok(committed.length <= capBytes && committed.length > capBytes - 4300, 'open fixture should sit just under the cap');
    await assert.rejects(journal.advance({ instructionId: openId, eventId: 'cross-cap', phase: 'payment-seen', evidenceRef: 'x'.repeat(2048) }), /1MiB/);
    assert.deepEqual(await readFile(file), committed);
    assert.equal((await journal.read()).active.phase, 'instruction');
    assert.equal((await journal.mutate(() => false)).active.phase, 'instruction');
    assert.deepEqual(await readFile(file), committed);
  }
});

test('an invalid mutated snapshot is refused before the committed file changes', async t => {
  const { path, journal } = await setup(t);
  await journal.begin(payment());
  const file = join(path, 'payment.json');
  const committed = await readFile(file);
  // An event appended without updating the active snapshot disagrees with history.
  await assert.rejects(journal.mutate(s => {
    s.events.push({ kind: 'advance', instructionId: 'synthetic-1', eventId: 'unmatched', phase: 'payment-seen', evidenceRef: 'fixture:unmatched', at: future() });
    return true;
  }), /disagrees/);
  // Claiming a change without making one breaks the revision/history invariant.
  await assert.rejects(journal.mutate(() => true), /Invalid journal/);
  assert.deepEqual(await readFile(file), committed);
  assert.equal((await journal.read()).revision, 1);
});

test('async or non-boolean mutation callbacks are refused without committing', async t => {
  const { path, journal } = await setup(t);
  await journal.begin(payment());
  const file = join(path, 'payment.json');
  const committed = await readFile(file);
  await assert.rejects(journal.mutate(async () => true), /synchronous/);
  await assert.rejects(journal.mutate(() => ({ then() {} })), /thenable/);
  await assert.rejects(journal.mutate(() => 1), /boolean/);
  await assert.rejects(journal.mutate(() => undefined), /boolean/);
  assert.deepEqual(await readFile(file), committed);
  assert.equal((await journal.read()).revision, 1);
});

test('a hard-linked lock file is refused', async t => {
  const { path, journal } = await setup(t);
  await journal.begin(payment());
  await link(join(path, 'payment.flock'), join(path, 'payment.flock.2'));
  const file = join(path, 'payment.json');
  const committed = await readFile(file);
  await assert.rejects(journal.begin(payment()), /no hard links/);
  assert.deepEqual(await readFile(file), committed);
});

test('an orphaned temporary snapshot is never promoted after reopening', async t => {
  const { path, journal } = await setup(t);
  await journal.begin(payment());
  const orphan = join(path, '.payment-stale.tmp');
  const orphanBody = JSON.stringify({ version: 1, revision: 99, active: null, events: [] }) + '\n';
  await writeFile(orphan, orphanBody, { mode: 0o600 });
  const reopened = new CreditJournal(path);
  const state = await reopened.read();
  assert.equal(state.revision, 1); // the committed snapshot wins, never the orphan
  await reopened.advance({ instructionId: 'synthetic-1', eventId: 'seen', phase: 'payment-seen', evidenceRef: 'fixture:seen' });
  assert.equal((await reopened.read()).revision, 2);
  assert.equal(await readFile(orphan, 'utf8'), orphanBody); // untouched, not renamed over payment.json
  assert.deepEqual((await readdir(path)).sort(), ['.payment-stale.tmp', 'payment.flock', 'payment.json']);
});

test('a failing mutation still releases the lock for the next writer', async t => {
  const { journal } = await setup(t);
  await assert.rejects(journal.mutate(() => { throw new Error('boom'); }), /boom/);
  assert.equal((await journal.begin(payment())).revision, 1);
});

test('expired instructions do not silently roll over or erase payment recovery', async t => {
  const { journal } = await setup(t);
  await assert.rejects(journal.begin({ ...payment(), expiresAt: '2000-01-01T00:00:00Z' }), /expired/);
  const value = payment();
  await journal.begin(value);
  await journal.advance({ instructionId: value.id, eventId: 'seen', phase: 'payment-seen', evidenceRef: 'fixture:transaction' });
  await assert.rejects(journal.advance({ instructionId: value.id, eventId: 'cancel', phase: 'cancelled', evidenceRef: 'fixture:expiry' }), /Invalid payment transition/);
});

test('simultaneous new instructions cannot both succeed', async t => {
  const { journal } = await setup(t);
  const value = payment();
  const results = await Promise.allSettled([journal.begin(value), journal.begin({ ...value, id: 'other' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await journal.read()).events.length, 1);
});


test('rejects symlink storage and does not change target permissions', async t => {
  const { path, journal } = await setup(t);
  const other = await mkdtemp(join(tmpdir(), 'payment-target-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  const link = join(path, 'alias');
  await symlink(other, link);
  await assert.rejects(new CreditJournal(link).begin(payment()), /without symlinks/);
  await writeFile(join(other, 'target'), '{}', { mode: 0o600 });
  await symlink(join(other, 'target'), join(path, 'payment.json'));
  await assert.rejects(journal.read());
  assert.equal((await stat(other)).mode & 0o777, 0o700);
});

test('rejects inconsistent history and missing phase after settlement', async t => {
  const { path, journal } = await setup(t);
  await journal.begin(payment());
  const state = await journal.read();
  state.active = null;
  await writeFile(join(path, 'payment.json'), JSON.stringify(state));
  await assert.rejects(journal.read(), /disagrees/);
  await assert.rejects(journal.advance({instructionId: 'synthetic-1', eventId: 'bad', evidenceRef: 'fixture'}), /Invalid payment phase/);
});
