import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBalanceMonitor, ppqBalanceEndpoint } from '../lib/provider-balance.mjs';

const canary = 'CANARY-ppq-credit-id-8f3a';
const okBody = (balance) => JSON.stringify({ balance });
const ok = (extra = {}) => createBalanceMonitor({
  getCredential: async () => canary,
  transport: async () => ({ status: 200, body: okBody(12.34) }),
  ...extra,
});
const noCanary = (value) => assert.ok(!String(value).includes(canary), 'credential canary must not appear');

test('successful refresh returns the exact public observation shape', async () => {
  const monitor = ok();
  const result = await monitor.refresh();
  assert.deepEqual(result, {
    provider: 'ppq', scope: 'account', currency: 'USD', amountDecimal: '12.34',
    observedAt: result.observedAt, providerAsOf: null, freshness: 'fresh', source: 'provider-reported',
  });
  assert.ok(Number.isFinite(Date.parse(result.observedAt)));
  noCanary(JSON.stringify(result));
  // Same observation without a new refresh.
  assert.deepEqual(monitor.snapshot(), result);
});

test('the request targets the documented endpoint and carries only the credit id', async () => {
  let seen = null;
  const monitor = createBalanceMonitor({
    getCredential: async () => ({ creditId: canary }),
    transport: async request => { seen = request; return { status: 200, body: okBody(1) }; },
  });
  await monitor.refresh();
  assert.equal(seen.url, ppqBalanceEndpoint);
  assert.equal(seen.method, 'POST');
  assert.equal(seen.body, JSON.stringify({ credit_id: canary }));
});

test('no observation yet reports unknown, never a fabricated zero', async () => {
  const monitor = createBalanceMonitor({
    getCredential: async () => canary,
    transport: async () => { throw new Error(`connection refused for ${canary}`); },
  });
  const before = monitor.snapshot();
  assert.equal(before.freshness, 'unknown');
  assert.equal(before.amountDecimal, null);
  await assert.rejects(monitor.refresh(), error => {
    assert.equal(error.code, 'transport-failed');
    noCanary(error.message); noCanary(JSON.stringify(error));
    return true;
  });
  const after = monitor.snapshot();
  assert.equal(after.freshness, 'unknown');
  assert.equal(after.amountDecimal, null);
});

test('failed refresh preserves the previous observation as stale, never zero', async () => {
  let fail = false;
  const monitor = createBalanceMonitor({
    getCredential: async () => canary,
    transport: async () => {
      if (fail) throw new Error(`boom ${canary}`);
      return { status: 200, body: okBody(45.5) };
    },
  });
  await monitor.refresh();
  fail = true;
  await assert.rejects(monitor.refresh(), error => { noCanary(error.message); return true; });
  const stale = monitor.snapshot();
  assert.equal(stale.amountDecimal, '45.5');
  assert.equal(stale.freshness, 'stale');
  noCanary(JSON.stringify(stale));
});

test('a fresh observation goes stale by age alone', async () => {
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const monitor = createBalanceMonitor({
    getCredential: async () => canary,
    transport: async () => ({ status: 200, body: okBody(3) }),
    now: () => clock,
    staleAfterMs: 60000,
  });
  await monitor.refresh();
  assert.equal(monitor.snapshot().freshness, 'fresh');
  clock += 61000;
  assert.equal(monitor.snapshot().freshness, 'stale');
  assert.equal(monitor.snapshot().amountDecimal, '3');
});

test('transport timeouts are sanitized and keep the previous amount or stay unknown', async () => {
  const hung = () => new Promise(() => {});
  const a = createBalanceMonitor({ getCredential: async () => canary, transport: hung, requestTimeoutMs: 20 });
  await assert.rejects(a.refresh(), error => { assert.equal(error.code, 'timeout'); noCanary(error.message); return true; });
  assert.equal(a.snapshot().freshness, 'unknown');
  assert.equal(a.snapshot().amountDecimal, null);

  let hang = false;
  const b = createBalanceMonitor({
    getCredential: async () => canary,
    transport: async () => (hang ? hung() : { status: 200, body: okBody(9.5) }),
    requestTimeoutMs: 20,
  });
  await b.refresh();
  hang = true;
  await assert.rejects(b.refresh(), error => { assert.equal(error.code, 'timeout'); noCanary(error.message); return true; });
  assert.equal(b.snapshot().amountDecimal, '9.5');
  assert.equal(b.snapshot().freshness, 'stale');
});

test('invalid credential shapes are refused without leaking the value', async () => {
  for (const credential of [null, 42, {}, { creditId: 7 }, { creditId: '' }, { creditId: 'x'.repeat(513) }]) {
    const monitor = createBalanceMonitor({ getCredential: async () => credential, transport: async () => ({ status: 200, body: okBody(1) }) });
    await assert.rejects(monitor.refresh(), error => {
      assert.equal(error.code, 'credential-unavailable');
      noCanary(error.message); noCanary(JSON.stringify(error));
      return true;
    });
  }
  assert.equal(monitor0().snapshot().freshness, 'unknown');
  function monitor0() { return createBalanceMonitor({ getCredential: async () => canary, transport: async () => ({ status: 200, body: okBody(1) }) }); }
});

test('malformed responses and invalid amounts are rejected', async () => {
  const cases = [
    { status: 500, body: okBody(1) },
    { status: 201, body: okBody(1) },
    { status: 200, body: '{"balance": -0.01}' },
    { status: 200, body: '{"balance": "12.34"}' },
    { status: 200, body: '{"balance": null}' },
    { status: 200, body: '{"balance": true}' },
    { status: 200, body: '{"balance": 1e21}' },
    { status: 200, body: '{"balance": 12.34, "extra": 1}' },
    { status: 200, body: '{"credit": 12.34}' },
    { status: 200, body: '[]' },
    { status: 200, body: 'not json' },
    { status: 200, body: '' },
    { status: 200 },
    null,
    'string response',
  ];
  for (const response of cases) {
    const monitor = createBalanceMonitor({
      getCredential: async () => canary,
      transport: async () => response,
      requestTimeoutMs: 50,
    });
    await assert.rejects(monitor.refresh(), error => {
      assert.ok(['http-status', 'invalid-schema', 'invalid-response'].includes(error.code), `unexpected code for ${JSON.stringify(response)}: ${error.code}`);
      noCanary(error.message); noCanary(JSON.stringify(error));
      assert.equal(monitor.snapshot().freshness, 'unknown');
      assert.equal(monitor.snapshot().amountDecimal, null);
      return true;
    });
  }
  // A schema failure also downgrades a previously good observation to stale.
  let poisoned = false;
  const monitor = createBalanceMonitor({
    getCredential: async () => canary,
    transport: async () => (poisoned ? { status: 200, body: '{"balance": -1}' } : { status: 200, body: okBody(7.25) }),
  });
  await monitor.refresh();
  assert.equal(monitor.snapshot().freshness, 'fresh');
  poisoned = true;
  await assert.rejects(monitor.refresh(), error => {
    assert.equal(error.code, 'invalid-schema');
    noCanary(error.message);
    return true;
  });
  assert.equal(monitor.snapshot().amountDecimal, '7.25');
  assert.equal(monitor.snapshot().freshness, 'stale');
});

test('zero is a valid balance but failures never produce it implicitly', async () => {
  const monitor = createBalanceMonitor({
    getCredential: async () => canary,
    transport: async () => ({ status: 200, body: okBody(0) }),
  });
  assert.equal((await monitor.refresh()).amountDecimal, '0');
});

test('missing seams are refused: there is no default fetch', async () => {
  assert.throws(() => createBalanceMonitor({}), /requires injected/);
  assert.throws(() => createBalanceMonitor({ getCredential: async () => canary }), /requires injected/);
  assert.throws(() => createBalanceMonitor({ transport: async () => ({ status: 200, body: okBody(1) }) }), /requires injected/);
  assert.throws(() => createBalanceMonitor({
    getCredential: async () => canary, transport: async () => ({}), requestTimeoutMs: 0,
  }), /RangeError|requestTimeoutMs/);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
test('overlapping refreshes share a delayed request and release the slot after settlement', async () => {
  const pending = [];
  let credentials = 0;
  const monitor = ok({ getCredential: async () => { credentials++; return canary; },
    transport: () => new Promise(resolve => pending.push(resolve)) });
  const first = monitor.refresh(), second = monitor.refresh();
  assert.equal(first, second);
  await tick();
  assert.equal(credentials, 1); assert.equal(pending.length, 1);
  pending[0]({ status: 200, body: okBody(10) });
  assert.equal((await first).amountDecimal, '10'); await second;
  const third = monitor.refresh(); await tick();
  assert.equal(pending.length, 2);
  pending[1]({ status: 200, body: okBody(20) });
  assert.equal((await third).amountDecimal, '20');
});

test('timeout aborts but owns attempt until late completion; refresh never overlaps', async () => {
  const pending = []; let signal;
  const monitor = ok({ requestTimeoutMs: 25,
    transport: (request, options) => { signal = options.signal; return new Promise(resolve => pending.push(resolve)); } });
  const first = monitor.refresh(); await assert.rejects(first, { code: 'timeout' });
  assert.equal(signal.aborted, true);
  const blocked = monitor.refresh(); assert.equal(blocked, first);
  await assert.rejects(blocked, { code: 'timeout' }); assert.equal(pending.length, 1);
  pending[0]({ status: 200, body: okBody(10) }); await tick();
  assert.equal(monitor.snapshot().freshness, 'unknown');
  const next = monitor.refresh(); await tick();
  pending[1]({ status: 200, body: okBody(20) }); await next;
  assert.equal(monitor.snapshot().amountDecimal, '20');
});

test('credential deadline prevents transport even after late credential resolution', async () => {
  let release, signal, calls = 0;
  const monitor = ok({ requestTimeoutMs: 20,
    getCredential: options => { signal = options.signal; return new Promise(resolve => { release = resolve; }); },
    transport: async () => { calls++; return { status: 200, body: okBody(99) }; } });
  const request = monitor.refresh(); await assert.rejects(request, { code: 'timeout' });
  assert.equal(signal.aborted, true); assert.equal(monitor.refresh(), request);
  release(canary); await tick(); assert.equal(calls, 0);
  assert.equal(monitor.snapshot().freshness, 'unknown'); await monitor.close();
});

test('close rejects visible request promptly but awaits actual drain and is reentrant', async () => {
  let release, nested, calls = 0;
  const monitor = ok({ transport: (request, { signal }) => {
    calls++; signal.addEventListener('abort', () => { nested = monitor.close(); });
    return new Promise(resolve => { release = resolve; });
  } });
  const request = monitor.refresh(); await tick();
  let done = false; const close = monitor.close(); close.then(() => { done = true; });
  await assert.rejects(request, { code: 'closed' }); await tick();
  assert.equal(nested, close); assert.equal(done, false);
  await assert.rejects(monitor.refresh(), { code: 'closed' });
  release({ status: 200, body: okBody(88) }); await close;
  assert.equal(calls, 1); assert.equal(monitor.snapshot().freshness, 'unknown');
});

test('failed refresh preserves stale observation while ignored abort is still draining', async () => {
  let release, hang = false;
  const monitor = ok({ requestTimeoutMs: 20, transport: () => hang ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ status: 200, body: okBody(3) }) });
  await monitor.refresh(); hang = true;
  await assert.rejects(monitor.refresh(), { code: 'timeout' });
  assert.equal(monitor.snapshot().amountDecimal, '3'); assert.equal(monitor.snapshot().freshness, 'stale');
  release({ status: 200, body: okBody(999) }); await tick();
  assert.equal(monitor.snapshot().amountDecimal, '3'); assert.equal(monitor.snapshot().freshness, 'stale');
  await monitor.close();
});

test('invalid and backward clocks preserve stale observations until a valid refresh', async () => {
  let time = 100000;
  const monitor = ok({ now: () => time });
  await monitor.refresh();
  for (const invalid of [99999, NaN, Infinity, -Infinity, 1e20, '100000']) {
    time = invalid;
    assert.equal(monitor.snapshot().freshness, 'stale');
    await assert.rejects(monitor.refresh(), { code: 'invalid-clock' });
    assert.equal(monitor.snapshot().amountDecimal, '12.34');
    time = 100001;
    assert.equal(monitor.snapshot().freshness, 'stale');
    await monitor.refresh();
  }
  const empty = ok({ now: () => NaN });
  await assert.rejects(empty.refresh(), { code: 'invalid-clock' });
  assert.equal(empty.snapshot().freshness, 'unknown');
  const throwing = ok({ now: () => { throw new Error(canary); } });
  await assert.rejects(throwing.refresh(), error => { noCanary(error.message); return error.code === 'invalid-clock'; });
  assert.throws(() => ok({ now: 0 }), /now must be a function/);
});

test('clock rollback during a delayed response refuses publication', async () => {
  let time = 100000, release;
  const monitor = ok({ now: () => time, transport: () => new Promise(resolve => { release = resolve; }) });
  const request = monitor.refresh(); await tick(); time = 90000;
  release({ status: 200, body: okBody(20) });
  await assert.rejects(request, { code: 'invalid-clock' });
  assert.equal(monitor.snapshot().freshness, 'unknown');
});
