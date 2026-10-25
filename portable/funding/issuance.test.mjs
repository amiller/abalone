import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat, symlink, chmod, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FundingIssuance, replayEvents } from './issuance.mjs';
import { createBalanceMonitor } from '../../lib/provider-balance.mjs';
import { holdJournalLock } from '../credit-journal/journal.mjs';

const canary = 'CANARY-quote-secret-4b1d';
const proofCanary = 'CANARY-proof-secret-9d2f';
const modulePath = fileURLToPath(new URL('./issuance.mjs', import.meta.url));
const journalPath = path => join(path, 'issuance.json');
const noCanary = value => assert.ok(!String(value).includes(canary) && !String(value).includes(proofCanary), 'raw provider/proof canary must not appear');

// Nonpayable fixture values only: nothing here could pay anyone.
const intent = (id = 'fixture-intent-1') => ({
  id,
  assets: [{ asset: 'ZEC', amountBaseUnits: '100000' }],
  refundRef: 'fixture:refund-reference',
  recipientRef: 'fixture:recipient-reference',
});
const quote = () => ({
  asset: 'ZEC', amountBaseUnits: '100000',
  address: 'NONPAYABLE-FIXTURE-ADDRESS',
  recipient: 'fixture:recipient-reference',
  secretNote: canary,
});
// Injected pure validator grounded in the exact expected intent.
const validator = (expected, received) => {
  if (!received || typeof received !== 'object') return null;
  if (received.asset !== expected.assets[0].asset || received.amountBaseUnits !== expected.assets[0].amountBaseUnits
    || received.recipient !== expected.recipientRef || received.address !== 'NONPAYABLE-FIXTURE-ADDRESS') return null;
  return { address: received.address, asset: received.asset, amount: received.amountBaseUnits };
};
// Injected definitive-refusal validator: by default nothing can positively
// prove a no-side-effect refusal, so nothing may be treated as refused.
const refusalValidator = () => null;
// Injected credit-proof validator: positively correlates a synthetic offline
// proof with the exact invoice evidence, the exact credited account and the
// credited amount. Anything else (wrong invoice, wrong account, wrong amount,
// a bare balance snapshot) returns null — no proof.
const proofValidator = (context, candidate) => {
  if (!candidate || typeof candidate !== 'object') return null;
  if (candidate.invoiceEvidenceRef !== context.invoiceEvidenceRef) return null; // unrelated invoice
  if (candidate.accountRef !== 'NONPAYABLE-FIXTURE-ACCOUNT') return null;      // wrong/absent account
  if (candidate.creditedAmountDecimal !== '12.00') return null;                // wrong credited amount
  if (typeof candidate.observedAt !== 'string') return null;
  return {
    accountRef: candidate.accountRef,
    creditedAmountDecimal: candidate.creditedAmountDecimal,
    observedAt: candidate.observedAt,
    evidenceRef: candidate.evidenceRef,
  };
};
// Synthetic explicitly correlated offline proof fixture (nonpayable).
const proof = (over = {}) => ({
  invoiceEvidenceRef: 'fixture:invoice-receipt',
  accountRef: 'NONPAYABLE-FIXTURE-ACCOUNT',
  creditedAmountDecimal: '12.00',
  observedAt: null, // filled in per test
  evidenceRef: 'fixture:credit-proof-receipt',
  signature: proofCanary, // raw proof material must never be persisted
  ...over,
});

function harness(t, {
  transport, validator: check = validator, refusalValidator: refuse = refusalValidator,
  proofValidator: prove = proofValidator, now = () => Date.now(), proofFreshAfterMs,
} = {}) {
  const calls = [];
  return mkdtemp(join(tmpdir(), 'portable-funding-')).then(async path => {
    t.after(() => rm(path, { recursive: true, force: true }));
    const issuers = [];
    const make = () => {
      const issuer = new FundingIssuance({
        directory: path,
        validator: check,
        refusalValidator: refuse,
        proofValidator: prove,
        quoteTransport: async request => { calls.push(request); return transport(request); },
        quoteTimeoutMs: 60,
        now,
        ...(proofFreshAfterMs !== undefined ? { proofFreshAfterMs } : {}),
      });
      issuers.push(issuer);
      return issuer;
    };
    return { path, make, calls };
  });
}
const goodTransport = () => async () => quote();

test('records intent durably, calls the transport once, projects only instruction fields', async t => {
  const { path, make, calls } = await harness(t, { transport: goodTransport() });
  const result = await make().issue(intent());
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { intent: intent() }); // the transport sees only validated public fields
  assert.deepEqual(result, {
    id: 'fixture-intent-1', phase: 'quoted', status: 'quoted',
    paymentInstruction: { address: 'NONPAYABLE-FIXTURE-ADDRESS', asset: 'ZEC', amount: '100000' },
  });
  noCanary(JSON.stringify(result));
  const stored = await readFile(journalPath(path), 'utf8');
  noCanary(stored); // raw provider response (including its secret note) is never persisted
  assert.ok(stored.includes('"phase":"quoted"'));
  assert.equal((await stat(journalPath(path))).mode & 0o777, 0o600);
});

test('writer restart resumes the exact accepted instruction with no second POST', async t => {
  const { path, make, calls } = await harness(t, { transport: goodTransport() });
  const first = await make().issue(intent());
  const reopened = make(); // a fresh process would reload from disk the same way
  assert.deepEqual(await reopened.status(), first);
  assert.deepEqual(await reopened.issue(intent()), first); // idempotent resume
  assert.equal(calls.length, 1);
  await assert.rejects(reopened.issue({ ...intent(), id: 'fixture-intent-2' }), /must be reconciled/);
  assert.equal(calls.length, 1);
  await assert.rejects(make().issue({ ...intent(), assets: [{ asset: 'ZEC', amountBaseUnits: '999' }] }), /reused with different intent/);
  assert.equal(calls.length, 1);
  assert.equal((await make().status()).paymentInstruction.amount, '100000');
  void path;
});

test('timeout records an uncertain outcome that survives reopen and forbids reissue', async t => {
  const { make, calls } = await harness(t, { transport: () => new Promise(() => {}) }); // never resolves
  const result = await make().issue(intent());
  assert.equal(result.status, 'needs-reconciliation');
  assert.equal(result.phase, 'uncertain');
  assert.equal(result.paymentInstruction, null);
  assert.equal(calls.length, 1);

  const reopened = make();
  const status = await reopened.status();
  assert.equal(status.status, 'needs-reconciliation');
  assert.equal(status.id, 'fixture-intent-1');
  assert.equal((await reopened.issue(intent())).status, 'needs-reconciliation');
  await assert.rejects(reopened.issue(intent('fixture-intent-2')), /must be reconciled/);
  assert.equal(calls.length, 1); // no automatic reissue, ever
});

test('an invalid quote response is uncertain too and a restart never rePOSTs it', async t => {
  const { make, calls } = await harness(t, { transport: async () => 'not-a-quote-response' });
  const result = await make().issue(intent());
  assert.equal(result.status, 'needs-reconciliation');
  assert.equal(result.phase, 'uncertain');
  noCanary(JSON.stringify(result));
  const reopened = make();
  assert.equal((await reopened.status()).status, 'needs-reconciliation');
  assert.equal((await reopened.issue(intent())).status, 'needs-reconciliation');
  await assert.rejects(reopened.issue(intent('fixture-intent-2')), /must be reconciled/);
  assert.equal(calls.length, 1); // restart never rePOSTs
});

test('transport errors are uncertain too, never silently retried', async t => {
  const { make, calls } = await harness(t, { transport: async () => { throw new Error(`provider exploded ${canary}`); } });
  const result = await make().issue(intent());
  assert.equal(result.status, 'needs-reconciliation');
  assert.equal(result.phase, 'uncertain');
  noCanary(JSON.stringify(result));
  await assert.rejects(make().issue(intent('another')), /must be reconciled/);
  assert.equal(calls.length, 1);
});

test('a mismatched quote keeps the reconciliation obligation: no automatic new attempt', async t => {
  const wrongQuote = () => ({ ...quote(), amountBaseUnits: '1' }); // does not match expected intent
  const { make, calls } = await harness(t, {
    transport: async () => (calls.length <= 1 ? wrongQuote() : quote()),
  });
  const result = await make().issue(intent());
  // Receiving an invalid or mismatched quote does not establish that the
  // provider did nothing: it is uncertain, needs reconciliation, and can
  // never by itself permit an automatic new attempt.
  assert.equal(result.status, 'needs-reconciliation');
  assert.equal(result.phase, 'uncertain');
  assert.equal(result.paymentInstruction, null);
  noCanary(JSON.stringify(result));
  assert.equal((await make().issue(intent())).status, 'needs-reconciliation'); // same id: no second POST
  await assert.rejects(make().issue(intent('fixture-intent-2')), /must be reconciled/);
  assert.equal(calls.length, 1);
});

test('only positively validated no-side-effect evidence yields a definitive refusal', async t => {
  // The provider answered with a mismatched quote AND a verifiable signed
  // refusal receipt proving no invoice was created (offline fixture).
  const refusalValidator = (expected, received) => (
    received && typeof received === 'object' && received.providerRefusalReceipt === 'fixture:no-side-effect-receipt'
      && received.address === 'NONPAYABLE-FIXTURE-ADDRESS'
      ? { evidenceRef: 'fixture:refusal-evidence' } : null
  );
  const { make, calls } = await harness(t, {
    transport: async () => (calls.length <= 1
      ? { ...quote(), amountBaseUnits: '1', providerRefusalReceipt: 'fixture:no-side-effect-receipt' }
      : quote()),
    refusalValidator,
  });
  const result = await make().issue(intent());
  assert.equal(result.status, 'refused');
  assert.equal(result.paymentInstruction, null);
  assert.equal((await make().issue(intent())).status, 'refused'); // same id: no second POST
  assert.equal(calls.length, 1);
  // Positive definitive refusal is resolved: a new stable id may start.
  const second = await make().issue(intent('fixture-intent-2'));
  assert.equal(second.status, 'quoted');
  assert.equal(calls.length, 2);
});

test('a malformed refusal verdict is no evidence at all: the outcome stays uncertain', async t => {
  for (const bad of [() => 'refused', () => ({}), () => ({ evidenceRef: 7 }), () => ({ evidenceRef: '' })]) {
    const { make, calls } = await harness(t, {
      transport: async () => ({ ...quote(), amountBaseUnits: '1' }),
      refusalValidator: bad,
    });
    const result = await make().issue(intent());
    assert.equal(result.status, 'needs-reconciliation');
    await assert.rejects(make().issue(intent('fixture-intent-2')), /must be reconciled/);
    assert.equal(calls.length, 1);
  }
});

test('a validator projecting unexpected fields leaves an uncertain outcome, never refused', async t => {
  const sloppy = () => ({ address: 'NONPAYABLE-FIXTURE-ADDRESS', asset: 'ZEC', amount: '100000', raw: quote() });
  const { path, make, calls } = await harness(t, { transport: goodTransport(), validator: () => sloppy() });
  const result = await make().issue(intent());
  assert.equal(result.status, 'needs-reconciliation');
  noCanary(JSON.stringify(result));
  noCanary(await readFile(journalPath(path), 'utf8'));
  await assert.rejects(make().issue(intent('fixture-intent-2')), /must be reconciled/);
  assert.equal(calls.length, 1);
});

test('settlement requires ordered evidence and credit requires an explicitly correlated proof', async t => {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const { make } = await harness(t, { transport: goodTransport(), now: () => clock, proofFreshAfterMs: 60000 });
  const issued = await make().issue(intent());
  const id = issued.id;
  // Receipts for an unknown instruction are refused.
  await assert.rejects(make().recordBridgeReceipt({ id: 'unknown', evidenceRef: 'fixture:bridge' }), /Unknown active issuance/);
  // Credit proof before settlement is refused.
  await assert.rejects(make().recordCreditProof({ id, proof: proof({ observedAt: new Date(clock).toISOString() }) }), /invoice-settled/);
  const bridged = await make().recordBridgeReceipt({ id, evidenceRef: 'fixture:bridge-receipt' });
  assert.equal(bridged.phase, 'bridge-success');
  assert.notEqual(bridged.phase, 'provider-credit-ready');
  await assert.rejects(make().recordCreditProof({ id, proof: proof({ observedAt: new Date(clock).toISOString() }) }), /invoice-settled/);
  const invoiced = await make().recordInvoiceSettled({ id, evidenceRef: 'fixture:invoice-receipt' });
  assert.equal(invoiced.phase, 'invoice-settled');
  // Bridge receipt + invoice receipt alone must not become spendable credit.
  assert.equal((await make().status()).phase, 'invoice-settled');

  // Fresh provider-reported balance totals — zero, preexisting, matching, even
  // exactly the public balance.mjs snapshot shape — prove nothing about this
  // invoice and are never accepted as funding evidence.
  for (const notProof of [
    null,
    { provider: 'ppq', scope: 'account', currency: 'USD', amountDecimal: '0', observedAt: new Date(clock).toISOString(), providerAsOf: null, freshness: 'fresh', source: 'provider-reported' },
    { provider: 'ppq', scope: 'account', currency: 'USD', amountDecimal: '45.50', observedAt: new Date(clock).toISOString(), providerAsOf: null, freshness: 'fresh', source: 'provider-reported' },
    { provider: 'ppq', scope: 'account', currency: 'USD', amountDecimal: '12.00', observedAt: new Date(clock).toISOString(), providerAsOf: null, freshness: 'fresh', source: 'provider-reported' },
    { provider: 'other', scope: 'account', currency: 'USD', amountDecimal: '12.00', observedAt: new Date(clock).toISOString(), freshness: 'fresh', source: 'self-reported' },
  ]) {
    await assert.rejects(make().recordCreditProof({ id, proof: notProof }), /could not be verified/i);
    assert.equal((await make().status()).phase, 'invoice-settled');
  }

  // Explicitly correlated proofs still fail every invariant that matters:
  for (const [label, bad] of [
    ['zero credited amount', proof({ creditedAmountDecimal: '0' })],
    ['zero-padded credited amount', proof({ creditedAmountDecimal: '0.00' })],
    ['unrelated invoice', proof({ invoiceEvidenceRef: 'fixture:someone-elses-invoice' })],
    ['unrelated account', proof({ accountRef: 'SOMEONE-ELSES-ACCOUNT' })],
    ['observation predating the settlement', proof({ observedAt: new Date(clock - 1000).toISOString() })],
    ['future forged observation', proof({ observedAt: new Date(clock + 60000).toISOString() })],
  ]) {
    await assert.rejects(make().recordCreditProof({ id, proof: bad }), error => {
      assert.ok(/provenance|credited amount|could not be verified|predates|future/i.test(error.message), `${label}: ${error.message}`);
      return true;
    });
    assert.equal((await make().status()).phase, 'invoice-settled', `${label} must not prove a funded invoice`);
  }

  // A post-settlement observation still ages out of the supervisor freshness window.
  clock += 120000;
  await assert.rejects(make().recordCreditProof({
    id, proof: proof({ observedAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + 1000).toISOString() }),
  }), /sufficiently recent/); // observed after the settlement, but too old for the supervisor clock
  assert.equal((await make().status()).phase, 'invoice-settled');

  // Only a valid explicitly correlated synthetic proof reaches provider-credit-ready.
  const settled = await make().recordCreditProof({ id, proof: proof({ observedAt: new Date(clock).toISOString() }) });
  assert.equal(settled.phase, 'provider-credit-ready');
  assert.equal(settled.paymentInstruction.amount, '100000');
  assert.equal(settled.provenance, undefined); // the projection never exposes proof internals
  // Terminal: no further evidence events apply.
  await assert.rejects(make().recordBridgeReceipt({ id, evidenceRef: 'fixture:again' }), /transition/);
});

test('the durable journal stores only the bounded provenance projection', async t => {
  let clock = Date.parse('2026-02-01T00:00:00.000Z');
  const { path, make } = await harness(t, { transport: goodTransport(), now: () => clock });
  const issued = await make().issue(intent());
  await make().recordBridgeReceipt({ id: issued.id, evidenceRef: 'fixture:bridge-receipt' });
  await make().recordInvoiceSettled({ id: issued.id, evidenceRef: 'fixture:invoice-receipt' });
  await make().recordCreditProof({ id: issued.id, proof: proof({ observedAt: new Date(clock).toISOString() }) });
  const stored = await readFile(journalPath(path), 'utf8');
  noCanary(stored); // raw proof material (signature) is never persisted
  assert.ok(stored.includes('"accountRef":"NONPAYABLE-FIXTURE-ACCOUNT"'));
  assert.ok(stored.includes('"creditedAmountDecimal":"12.00"'));
  assert.ok(stored.includes('"phase":"provider-credit-ready"'));
  // After a completed provider-credit-ready cycle a new attempt may start.
  const next = await make().issue(intent('fixture-intent-next'));
  assert.equal(next.status, 'quoted');
});

test('a legitimate pre-existing balance displays independently of unproven funding', async t => {
  // Display information only: a synthetic pre-existing credit on the account.
  const monitor = createBalanceMonitor({
    getCredential: async () => 'fixture-credit-id',
    transport: async () => ({ status: 200, body: JSON.stringify({ balance: 45.5 }) }),
  });
  const balance = await monitor.refresh();
  assert.equal(balance.amountDecimal, '45.5');
  assert.equal(balance.freshness, 'fresh');
  // Funding path: invoice settled, credit provenance not supplied.
  const { make } = await harness(t, { transport: goodTransport() });
  const issued = await make().issue(intent());
  await make().recordBridgeReceipt({ id: issued.id, evidenceRef: 'fixture:bridge-receipt' });
  await make().recordInvoiceSettled({ id: issued.id, evidenceRef: 'fixture:invoice-receipt' });
  // The fresh, positive, pre-existing balance total cannot prove the invoice
  // was funded — no spendable-ready claim is fabricated from it.
  await assert.rejects(make().recordCreditProof({ id: issued.id, proof: balance }), /could not be verified/i);
  assert.equal((await make().status()).phase, 'invoice-settled');
  // The display is preserved independently of the pending funding attempt.
  assert.deepEqual(monitor.snapshot(), balance);
});

test('invalid intents and amounts are rejected before any durable write', async t => {
  const { path, make, calls } = await harness(t, { transport: goodTransport() });
  for (const bad of [
    { ...intent(), assets: [{ asset: 'ZEC', amountBaseUnits: '0' }] },
    { ...intent(), assets: [{ asset: 'ZEC', amountBaseUnits: '-5' }] },
    { ...intent(), assets: [{ asset: 'ZEC', amountBaseUnits: '1.5' }] },
    { ...intent(), assets: [{ asset: 'ZEC', amountBaseUnits: 100 }] },
    // Digit strings beyond the bound are refused before BigInt ever parses them.
    { ...intent(), assets: [{ asset: 'ZEC', amountBaseUnits: '1'.repeat(79) }] },
    { ...intent(), assets: [{ asset: 'ZEC', amountBaseUnits: '9'.repeat(100000) }] },
    { ...intent(), assets: [] },
    { ...intent(), refundRef: '' },
    { ...intent(), recipientRef: 'x'.repeat(2049) },
    { ...intent(), id: 7 },
    { ...intent(), assets: [{ asset: 'ZEC', amountBaseUnits: '1' }, { asset: 'ZEC', amountBaseUnits: '2' }] },
  ]) {
    await assert.rejects(make().issue(bad), /intent/i);
  }
  assert.equal(calls.length, 0);
  await assert.rejects(() => readFile(journalPath(path)), /ENOENT/); // nothing committed
});

test('a missing journal directory is an error on read, never an empty journal', async t => {
  const issuer = new FundingIssuance({
    directory: join(tmpdir(), 'portable-funding-nonexistent-4f17'),
    validator, refusalValidator, proofValidator, quoteTransport: goodTransport(),
  });
  await assert.rejects(issuer.status(), /ENOENT/); // a wrong path must not read as "no instruction"
  void t;
});

test('an existing directory with no state file reads as no-instruction', async t => {
  const { make } = await harness(t, { transport: goodTransport() });
  assert.deepEqual(await make().status(), {
    id: null, phase: 'none', status: 'no-instruction', paymentInstruction: null,
  });
});

test('a crashed writer leaves a request mark that reopens as needs-reconciliation', async t => {
  const { path, make, calls } = await harness(t, { transport: () => new Promise(() => {}) });
  // Simulate a crash between the durable request mark and the outcome: only
  // the committed state file remains, as if the process died mid-call.
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { FundingIssuance } from ${JSON.stringify(modulePath)};
    const issuer = new FundingIssuance({
      directory: ${JSON.stringify(path)},
      validator: ${validator.toString()},
      refusalValidator: () => null,
      proofValidator: () => null,
      quoteTransport: () => new Promise(() => {}),
      quoteTimeoutMs: 60000,
    });
    process.stdout.write('go\\n');
    await issuer.issue(${JSON.stringify(intent())});
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child never started issuing')), 15000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
  });
  // Wait until the request mark is committed, then the child is mid-call.
  let marked = false;
  for (let i = 0; i < 200 && !marked; i++) {
    try { marked = /"requested"/.test(await readFile(journalPath(path), 'utf8')); } catch { /* not yet */ }
    if (!marked) await new Promise(r => setTimeout(r, 25));
  }
  assert.ok(marked, 'durable request mark must be committed before the transport call');
  // A concurrent or replacement writer must refuse a second provider call.
  const result = await make().issue(intent());
  assert.equal(result.status, 'needs-reconciliation');
  assert.equal((await make().issue(intent())).status, 'needs-reconciliation');
  await assert.rejects(make().issue(intent('fixture-intent-9')), /must be reconciled/);
  assert.equal(calls.length, 0); // this writer never called the provider
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  const reopened = make();
  assert.equal((await reopened.status()).status, 'needs-reconciliation');
  assert.equal((await reopened.issue(intent())).status, 'needs-reconciliation');
});

test('a live competing writer holding the shared kernel lock is refused', async t => {
  const { path, make } = await harness(t, { transport: goodTransport() });
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { holdJournalLock } from ${JSON.stringify(fileURLToPath(new URL('../credit-journal/journal.mjs', import.meta.url)))};
    const release = await holdJournalLock(${JSON.stringify(path)});
    process.stdout.write('held\\n');
    await new Promise(() => {});
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child never acquired the lock')), 15000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('child exited before holding')); });
  });
  await assert.rejects(make().issue(intent()), /locked by another writer/);
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  let result;
  for (let i = 0; ; i++) {
    try { result = await make().issue(intent()); break; }
    catch (error) {
      if (!/locked by another writer/.test(error.message) || i >= 50) throw error;
      await new Promise(r => setTimeout(r, 100));
    }
  }
  assert.equal(result.status, 'quoted');
});

test('substituted symlink state files and loose permissions are refused', async t => {
  const { path, make } = await harness(t, { transport: goodTransport() });
  await make().issue(intent());
  const file = journalPath(path);
  await rm(file);
  const elsewhere = await mkdtemp(join(tmpdir(), 'funding-target-'));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  await writeFile(join(elsewhere, 'real'), '{}', { mode: 0o600 });
  await symlink(join(elsewhere, 'real'), file);
  // O_NOFOLLOW refuses the symlinked state file (Linux reports ELOOP).
  await assert.rejects(make().status(), /ELOOP|regular file|without symlinks/);
  assert.equal((await stat(join(elsewhere, 'real'))).mode & 0o777, 0o600);
  await rm(file);
  await writeFile(file, JSON.stringify({ version: 1, revision: 0, attempt: null, events: [] }), { mode: 0o644 });
  await assert.rejects(make().status(), /private regular file/);
  await rm(file);
  await writeFile(file, 'corrupt', { mode: 0o600 });
  await assert.rejects(make().status(), SyntaxError);
});

test('oversized state is refused on read, and growth across the cap leaves the committed file intact', async t => {
  const capBytes = 1048576;
  const { path, make } = await harness(t, { transport: goodTransport() });
  // Build a valid refused-cycle history just under the cap, hand-computed via replay.
  const events = [];
  const at = '2026-01-01T00:00:00.000Z';
  const cycle = k => {
    const pad = label => `${label}-${k}-`.padEnd(2048, 'x');
    const value = { id: pad('id'), assets: [{ asset: pad('asset'), amountBaseUnits: '1' }], refundRef: pad('refund'), recipientRef: pad('recipient') };
    events.push({ kind: 'record-intent', intent: value, at });
    events.push({ kind: 'mark-requested', id: value.id, at });
    events.push({ kind: 'mark-outcome', id: value.id, outcome: { kind: 'refused', reason: 'no-side-effect-refusal', evidenceRef: pad('refusal') }, at });
  };
  const size = () => Buffer.byteLength(JSON.stringify({ version: 1, revision: events.length, attempt: replayEvents(events), events }));
  for (let k = 0; size() < capBytes - 22000; k++) cycle(k);
  const state = { version: 1, revision: events.length, attempt: replayEvents(events), events };
  await writeFile(journalPath(path), JSON.stringify(state) + '\n', { mode: 0o600 });
  assert.ok((await stat(journalPath(path))).size <= capBytes);
  const committed = await readFile(journalPath(path));
  // A new attempt with maximum-length fields must cross the cap and be refused.
  const big = {
    id: 'big-'.padEnd(2048, 'b'),
    assets: Array.from({ length: 16 }, (_, i) => ({ asset: `asset-${i}-`.padEnd(2048, 'a'), amountBaseUnits: '1' })),
    refundRef: 'r'.repeat(2048), recipientRef: 'p'.repeat(2048),
  };
  await assert.rejects(make().issue(big), /1MiB/);
  assert.deepEqual(await readFile(journalPath(path)), committed);
  // The committed state still reads back and refuses nothing else.
  const status = await make().status();
  assert.equal(status.status, 'refused');
  // Reads of an oversized file are refused outright.
  await writeFile(journalPath(path), 'x'.repeat(capBytes + 1), { mode: 0o600 });
  await assert.rejects(make().status(), /1MiB/);
});

test('mutation callbacks must answer synchronously, and snapshot/history disagreement is refused', async t => {
  const { path, make } = await harness(t, { transport: goodTransport() });
  const issuer = make();
  await issuer.issue(intent());
  const file = journalPath(path);
  const committed = await readFile(file);
  await assert.rejects(issuer.mutate(async () => true), /synchronous/);
  await assert.rejects(issuer.mutate(() => ({ then() {} })), /thenable/);
  await assert.rejects(issuer.mutate(() => 'yes'), /boolean/);
  await assert.rejects(issuer.mutate(() => true), /append at least one event/);
  assert.deepEqual(await readFile(file), committed);
  const state = JSON.parse(committed);
  state.attempt = null;
  await writeFile(file, JSON.stringify(state) + '\n', { mode: 0o600 });
  await assert.rejects(issuer.status(), /disagrees/);
  void path;
});

test('a refused outcome without validated no-side-effect evidence cannot be replayed', async t => {
  const { path, make } = await harness(t, { transport: goodTransport() });
  const file = journalPath(path);
  const base = [
    { kind: 'record-intent', intent: intent(), at: '2026-01-01T00:00:00.000Z' },
    { kind: 'mark-requested', id: 'fixture-intent-1', at: '2026-01-01T00:00:00.000Z' },
  ];
  for (const forgedOutcome of [
    // The old, unproven semantics: a bare mismatched refusal.
    { kind: 'refused', reason: 'mismatched-quote' },
    // Right reason, but no validated evidence reference.
    { kind: 'refused', reason: 'no-side-effect-refusal' },
    { kind: 'refused', reason: 'no-side-effect-refusal', evidenceRef: '' },
  ]) {
    const events = [...base, { kind: 'mark-outcome', id: 'fixture-intent-1', outcome: forgedOutcome, at: '2026-01-01T00:00:00.000Z' }];
    await writeFile(file, JSON.stringify({
      version: 1, revision: events.length,
      attempt: { id: 'fixture-intent-1', intent: intent(), phase: 'refused', reason: forgedOutcome.reason },
      events,
    }) + '\n', { mode: 0o600 });
    await assert.rejects(make().status(), /Invalid issuance outcome reason/);
  }
});

test('constructor requires the injected seams', () => {
  const directory = '/nonexistent-fixture';
  const seams = { validator, refusalValidator, proofValidator, quoteTransport: async () => ({}) };
  assert.throws(() => new FundingIssuance({ directory }), /validator/);
  assert.throws(() => new FundingIssuance({ directory, validator }), /refusal validator/);
  assert.throws(() => new FundingIssuance({ directory, validator, refusalValidator }), /proof/);
  assert.throws(() => new FundingIssuance({ directory, validator, refusalValidator, proofValidator }), /quote transport/);
  assert.throws(() => new FundingIssuance({ ...seams, quoteTimeoutMs: 0 }), /quoteTimeoutMs/);
  assert.throws(() => new FundingIssuance({ ...seams, proofFreshAfterMs: -1 }), /proofFreshAfterMs/);
  assert.throws(() => new FundingIssuance({ ...seams, proofFreshAfterMs: 1.5 }), /proofFreshAfterMs/);
});
