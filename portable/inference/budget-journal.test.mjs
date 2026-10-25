// Budget journal checks: durable integer accounting, restart semantics,
// contention, fail-closed corruption handling. Run with
// `node --test portable/inference/budget-journal.test.mjs`.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { BudgetJournal, BudgetDuplicateError, BudgetExhaustedError, BudgetDiscrepancyError } from './budget-journal.mjs';
import { acquireStoreLock } from './lock.mjs';

const fresh = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inference-budget-'));
  await mkdir(join(dir, 'budget'), { recursive: true });
  await chmod(dir, 0o700);
  return { dir, journal: new BudgetJournal(join(dir, 'budget')) };
};

test('authorize is durable: idempotent for the same cap, refused for a different one', async () => {
  const { dir, journal } = await fresh();
  await journal.ensureAuthorized('1000');
  await journal.ensureAuthorized('1000');
  await assert.rejects(journal.ensureAuthorized('2000'), /refusing to reset/);
  const reopened = new BudgetJournal(join(dir, 'budget'));
  await assert.rejects(reopened.ensureAuthorized('1'), /refusing to reset/);
  await rm(dir, { recursive: true, force: true });
});

test('reserve, settle and abandon keep integer base-unit totals', async () => {
  const { dir, journal } = await fresh();
  await journal.ensureAuthorized('1000');
  await journal.reserve({ id: 'a'.repeat(16), amount: '300' });
  await journal.settle({ id: 'a'.repeat(16), amount: '250' });
  await journal.reserve({ id: 'b'.repeat(16), amount: '100' });
  await journal.abandon({ id: 'b'.repeat(16) });
  let snap = await journal.snapshot();
  assert.equal(snap.spent, '350');
  assert.equal(snap.outstanding, '0');
  assert.equal(snap.authorized, '1000');
  // Reopening recomputes the same totals from the event history.
  snap = await new BudgetJournal(join(dir, 'budget')).snapshot();
  assert.equal(snap.spent, '350');
  await rm(dir, { recursive: true, force: true });
});

test('duplicate logical ids are refused forever, including after restart', async () => {
  const { dir, journal } = await fresh();
  await journal.ensureAuthorized('1000');
  await journal.reserve({ id: 'duplicate-id-0001', amount: '10' });
  await assert.rejects(journal.reserve({ id: 'duplicate-id-0001', amount: '10' }), BudgetDuplicateError);
  const reopened = new BudgetJournal(join(dir, 'budget'));
  await assert.rejects(reopened.reserve({ id: 'duplicate-id-0001', amount: '10' }), BudgetDuplicateError);
  await rm(dir, { recursive: true, force: true });
});

test('the durable cap gates admissions: spent + outstanding + amount must fit', async () => {
  const { dir, journal } = await fresh();
  await journal.ensureAuthorized('100');
  await journal.reserve({ id: 'aaaaaaaaaaaaaaaa', amount: '60' });
  await assert.rejects(journal.reserve({ id: 'bbbbbbbbbbbbbbbb', amount: '50' }), BudgetExhaustedError);
  await journal.settle({ id: 'aaaaaaaaaaaaaaaa', amount: '10' });
  await journal.reserve({ id: 'bbbbbbbbbbbbbbbb', amount: '50' }); // 10 spent + 50 outstanding fits
  await assert.rejects(journal.reserve({ id: 'cccccccccccccccc', amount: '50' }), BudgetExhaustedError); // 10 + 50 + 50 exceeds
  await rm(dir, { recursive: true, force: true });
});

test('concurrent reservations race to exactly one admission under the lock', async () => {
  const { dir, journal } = await fresh();
  await journal.ensureAuthorized('100');
  const results = await Promise.allSettled([
    journal.reserve({ id: 'race-one-aaaaaaaaa', amount: '100' }),
    journal.reserve({ id: 'race-two-bbbbbbbbb', amount: '100' }),
  ]);
  const admitted = results.filter(r => r.status === 'fulfilled').length;
  const exhausted = results.filter(r => r.status === 'rejected' && r.reason instanceof BudgetExhaustedError).length;
  assert.equal(admitted, 1);
  assert.equal(exhausted, 1);
  const snap = await journal.snapshot();
  assert.equal(snap.outstanding, '100');
  assert.equal(snap.spent, '0');
  await rm(dir, { recursive: true, force: true });
});

test('restart never resets the budget: unresolved reservations are swept to abandoned (charged)', async () => {
  const { dir, journal } = await fresh();
  await journal.ensureAuthorized('100');
  await journal.reserve({ id: 'lost-in-flight-01', amount: '70' });
  await journal.reserve({ id: 'lost-in-flight-02', amount: '30' });
  const reopened = new BudgetJournal(join(dir, 'budget'));
  const abandoned = await reopened.sweepUnresolved();
  assert.deepEqual([...abandoned].sort((a, b) => a.id.localeCompare(b.id)), [{ id: 'lost-in-flight-01', amount: '70' }, { id: 'lost-in-flight-02', amount: '30' }]);
  const snap = await reopened.snapshot();
  assert.equal(snap.spent, '100');
  assert.equal(snap.outstanding, '0');
  await assert.rejects(reopened.reserve({ id: 'after-sweep-0001', amount: '1' }), BudgetExhaustedError);
  await rm(dir, { recursive: true, force: true });
});

test('a settlement above its reservation is recorded truthfully as a discrepancy and suspends spending', async () => {
  const { dir, journal } = await fresh();
  await journal.ensureAuthorized('1000');
  await journal.reserve({ id: 'overspend-bound-01', amount: '100' });
  // cap 1000, reservation 100, actual 250: spent exceeds the reservation and
  // is recorded at the ACTUAL amount — never normalized, never erased.
  await assert.rejects(journal.settle({ id: 'overspend-bound-01', amount: '250' }), BudgetDiscrepancyError);
  const snap = await journal.snapshot();
  assert.equal(snap.spent, '250', 'the actual overspend stays recorded');
  assert.equal(snap.outstanding, '0');
  assert.deepEqual(snap.discrepancies, [{ id: 'overspend-bound-01', reserved: '100', actual: '250' }]);
  // Spending is blocked: new reservations refuse, durably, across restarts.
  await assert.rejects(journal.reserve({ id: 'blocked-after-disc1', amount: '1' }), BudgetDiscrepancyError);
  const reopened = new BudgetJournal(join(dir, 'budget'));
  await assert.rejects(reopened.reserve({ id: 'blocked-after-disc2', amount: '1' }), BudgetDiscrepancyError);
  // The committed snapshot still validates and the evidence survives reopen.
  const snap2 = await reopened.snapshot();
  assert.equal(snap2.spent, '250');
  assert.deepEqual(snap2.discrepancies, [{ id: 'overspend-bound-01', reserved: '100', actual: '250' }]);
  await rm(dir, { recursive: true, force: true });
});

test('settlement beyond the authorized cap is recorded truthfully, not refused', async () => {
  const { dir, journal } = await fresh();
  await journal.ensureAuthorized('100');
  await journal.reserve({ id: 'beyond-cap-000001', amount: '60' });
  await assert.rejects(journal.settle({ id: 'beyond-cap-000001', amount: '120' }), BudgetDiscrepancyError);
  const snap = await journal.snapshot();
  assert.equal(snap.spent, '120');
  assert.equal(snap.authorized, '100');
  assert.equal(snap.discrepancies.length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('settlements within the reservation remain ordinary and create no discrepancy', async () => {
  const { dir, journal } = await fresh();
  await journal.ensureAuthorized('1000');
  await journal.reserve({ id: 'within-bound-00001', amount: '100' });
  await journal.settle({ id: 'within-bound-00001', amount: '100' });
  await journal.reserve({ id: 'within-bound-00002', amount: '100' });
  await journal.settle({ id: 'within-bound-00002', amount: '40' });
  const snap = await journal.snapshot();
  assert.equal(snap.spent, '140');
  assert.deepEqual(snap.discrepancies, []);
  await journal.reserve({ id: 'within-bound-00003', amount: '100' }); // not suspended
  await rm(dir, { recursive: true, force: true });
});

test('corruption fails closed: it is never treated as an empty budget', async () => {
  const { dir, journal } = await fresh();
  await journal.ensureAuthorized('100');
  await writeFile(join(dir, 'budget', 'budget.json'), '{not json', { mode: 0o600 });
  await assert.rejects(journal.snapshot(), /Invalid budget journal/);
  await rm(dir, { recursive: true, force: true });
});

test('a substituted FIFO or foreign-owned journal is refused', async () => {
  const { dir, journal } = await fresh();
  await journal.ensureAuthorized('100');
  await rm(join(dir, 'budget', 'budget.json'));
  await new Promise((resolve, reject) => {
    const child = spawn('mkfifo', [join(dir, 'budget', 'budget.json')]);
    child.on('error', reject); child.on('exit', resolve);
  });
  await assert.rejects(journal.snapshot(), /regular file/);
  await rm(dir, { recursive: true, force: true });
});

test('the mutation callback must answer synchronously with a boolean', async () => {
  const { dir, journal } = await fresh();
  await journal.ensureAuthorized('100');
  await assert.rejects(journal.mutate(() => Promise.resolve(true)), /synchronous boolean/);
  await assert.rejects(journal.mutate(() => 'yes'), /must return a boolean/);
  const state = await journal.mutate(() => false);
  assert.equal(state.revision, 1); // authorize event committed, nothing else
  await rm(dir, { recursive: true, force: true });
});

test('cap-crossing growth is refused and leaves the committed snapshot intact', async () => {
  const { dir, journal } = await fresh();
  await journal.ensureAuthorized('1000000000000');
  // Fill to just under the 1MiB cap in one committed mutation (pop back to the
  // boundary), then refuse the single mutation that would cross it.
  const at = new Date().toISOString();
  const event = id => ({ kind: 'reserve', id: `capfill-${String(id).padStart(8, '0')}`, amount: '1', at });
  await journal.mutate(state => {
    state.events.push(...Array.from({ length: 12400 }, (_, id) => event(id)));
    while (JSON.stringify(state).length > 1048576 - 1) state.events.pop();
    state.totals = { authorized: state.totals.authorized, spent: '0', outstanding: String(state.events.length - 1) };
    return true;
  });
  await assert.rejects(journal.reserve({ id: 'one-past-the-cap1', amount: '1' }), /1MiB/);
  const snap = await new BudgetJournal(join(dir, 'budget')).snapshot();
  assert.equal(snap.authorized, '1000000000000');
  assert.equal(snap.outstanding, String(snap.entries.filter(e => e.kind === 'reserve').length));
  await rm(dir, { recursive: true, force: true });
});

test('a SIGKILLed lock holder releases the flock; the next writer proceeds', async () => {
  const { dir, journal } = await fresh();
  await journal.ensureAuthorized('100');
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
import { acquireStoreLock } from ${JSON.stringify(new URL('./lock.mjs', import.meta.url).href)};
const release = await acquireStoreLock(${JSON.stringify(join(dir, 'budget'))}, 'budget.flock');
console.log('held');
setInterval(() => {}, 1000);
`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(resolve => holder.stdout.once('data', resolve));
  holder.kill('SIGKILL');
  await new Promise(resolve => holder.once('exit', resolve));
  await journal.reserve({ id: 'after-sigkill-001', amount: '1' });
  const snap = await journal.snapshot();
  assert.equal(snap.outstanding, '1');
  await rm(dir, { recursive: true, force: true });
});

test('bounded lock retry serializes concurrent writers instead of refusing them', async () => {
  const { dir, journal } = await fresh();
  await journal.ensureAuthorized('300');
  const release = await acquireStoreLock(join(dir, 'budget'), 'budget.flock');
  const pending = Promise.all([
    journal.reserve({ id: 'retry-one-aaaaaaaa', amount: '100' }),
    journal.reserve({ id: 'retry-two-bbbbbbbb', amount: '100' }),
  ]);
  setTimeout(() => release(), 50);
  await pending;
  const snap = await journal.snapshot();
  assert.equal(snap.outstanding, '200');
  await rm(dir, { recursive: true, force: true });
});
