// Broker fixture checks over actual Unix domain sockets with the offline
// loopback sealed transport and stub verifiers. Every case runs offline; no
// provider, credential or live call is involved. Run with
// `node --test portable/inference/broker.test.mjs` under a hard timeout with
// kill-after (see README checks).
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, mkdir, chmod, rm, readdir, readFile, stat, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { createInferenceBroker, deriveChargeBound, INFERENCE_MODEL } from './broker.mjs';
import { inferenceSocketFetch, readSseEvents } from './client.mjs';
import { createLoopbackSealedTransport } from './sealed-transport.mjs';
import { startLoopbackTee, createStubVerifier, sse, assistantTextDelta, toolCallDelta, finishChunk, usageChunk } from './testing.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
const okTranscript = sse([assistantTextDelta('Hello '), assistantTextDelta('world'), finishChunk('stop', 0), usageChunk(100, 50), '[DONE]']);

async function freshEnv() {
  const dir = await mkdtemp(join(tmpdir(), 'inference-broker-'));
  await mkdir(join(dir, 'state'), { recursive: true, mode: 0o700 });
  await mkdir(join(dir, 'sockets'), { recursive: true, mode: 0o700 });
  return dir;
}

// Synthetic contract only: no real provider tariff is admitted by these tests.
const chargePolicy = (input='3', output='7') => ({endpoint:'https://api.ppq.ai/private/v1/chat/completions',externalModel:INFERENCE_MODEL,sealedModel:'gpt-oss-120b',validFromMs:90,validUntilMs:110,evidenceId:'synthetic-contract',billing:'input-output-tokens-only',ledgerUnit:'synthetic-unit',maxBillableInputTokens:131072,maxRequestedOutputTokens:32768,reasoningEfforts:['default','low','medium','high'],outputBound:'request-max-includes-all-billed-reasoning',settlementUsage:'openai-prompt-completion-all-billed-tokens',pricePerInputToken:input,pricePerOutputToken:output});

async function startFixture(overrides = {}) {
  const dir = overrides.dir ?? await freshEnv();
  const tee = overrides.tee ?? await startLoopbackTee({
    socketPath: join(dir, 'sockets', 'tee.sock'),
    scenario: overrides.scenario ?? 'ok',
    script: overrides.script ?? okTranscript,
    chunkDelayMs: overrides.chunkDelayMs ?? 0,
    stallAfterConnect: overrides.stallAfterConnect ?? false,
    expectedKeyId: overrides.expectedKeyId,
  });
  const verifier = createStubVerifier({ mode: overrides.verifierMode ?? 'admitted', release: tee.release });
  const transport = overrides.transport ?? createLoopbackSealedTransport({
    endpoint: { socketPath: tee.socketPath, route: '/v1/chat/completions' },
    inferenceKey: overrides.inferenceKey ?? 'offline-fixture-inference-key',
  });
  const broker = createInferenceBroker({
    socketPath: join(dir, 'sockets', overrides.socketName ?? 'broker.sock'),
    stateDir: join(dir, 'state'),
    peerUid: overrides.peerUid ?? process.getuid(),
    socketGroup: overrides.socketGroup,
    transport, verifier,
    authorizedBudget: overrides.authorizedBudget ?? '10000000',
    chargePolicy: overrides.chargePolicy === null ? undefined : (overrides.chargePolicy ?? chargePolicy(overrides.pricePerInputToken ?? '3', overrides.pricePerOutputToken ?? '7')),
    clock: overrides.clock ?? (() => 100),
    maxRequestBytes: overrides.maxRequestBytes,
    maxResponseBytes: overrides.maxResponseBytes,
    responseIdleTimeoutMs: overrides.responseIdleTimeoutMs,
    responseDeadlineMs: overrides.responseDeadlineMs,
    testingAllowSameUid: overrides.testingAllowSameUid ?? true,
  });
  await broker.start();
  return { dir, tee, verifier, transport, broker };
}

const sendRaw = (fixture, id, body, options = {}) =>
  inferenceSocketFetch(join(fixture.dir, 'sockets', 'broker.sock'), { requestId: id, timeoutMs: options.timeoutMs ?? 600_000, signal: options.signal })(undefined, { body: JSON.stringify(body) });

// Draining send: consumes the whole streamed body so the logical request
// reaches its terminal journal state before the test inspects it.
const send = async (fixture, id, body, options = {}) => {
  const response = await sendRaw(fixture, id, body, options);
  const text = await response.text();
  return {status:response.status,ok:response.ok,text};
};

// An API refusal is a fulfilled fetch Response, not a connection rejection.
const httpRefusal = response => {
  assert.equal(response.ok,false);
  assert.ok(response.status>=400 && response.status<=599);
  const value=JSON.parse(response.text);
  assert.equal(typeof value.error.code,'string');
  assert.equal(typeof value.error.message,'string');
  return {message:value.error.code+': '+value.error.message,status:response.status};
};

const makeBody = (overrides = {}) => ({
  model: INFERENCE_MODEL,
  stream: true,
  max_tokens: 512,
  messages: [{ role: 'user', content: 'Summarize the workspace notes.' }],
  tools: [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }],
  ...overrides,
});

// The trusted maximum-charge bound exactly as the broker derives it, so tests
// can assert reservation amounts without a flat constant.
const sealedOf = body => {
  const { model, tools, ...rest } = body;
  return { model: 'gpt-oss-120b', ...(Array.isArray(body.tools) && body.tools.length > 0 ? { tools } : {}), ...rest };
};
const boundOf = (body, priceIn = '3', priceOut = '7') =>
  deriveChargeBound({ request: body, policy: chargePolicy(priceIn, priceOut), nowMs:100 }).bound;

const rawRequest = (fixture, { method = 'POST', path = '/v1/chat/completions', headers = {}, body = '' }) => new Promise((resolve, reject) => {
  const request = http.request({ socketPath: join(fixture.dir, 'sockets', 'broker.sock'), path, method, headers }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  request.on('error', reject);
  request.end(body);
});

async function readFiles(root) {
  const out = [];
  const walk = async dir => {
    for (const name of await readdir(dir)) {
      const full = join(dir, name);
      const info = await stat(full);
      if (info.isDirectory()) await walk(full);
      else out.push([full, await readFile(full, 'utf8')]);
    }
  };
  await walk(root).catch(() => {});
  return out;
}

const cleanup = async fixture => {
  await fixture.broker.stop().catch(() => {});
  await fixture.tee.stop().catch(() => {});
  await rm(fixture.dir, { recursive: true, force: true }).catch(() => {});
};

// --- streaming over an actual Unix socket, with delayed chunks -------------

test('a delayed upstream stream arrives delayed and in order over the actual socket', async () => {
  const fixture = await startFixture({ chunkDelayMs: 60 });
  try {
    const arrivals = [];
    const response = await sendRaw(fixture, 'delayed-stream-01', makeBody());
    const reader = response.body.getReader();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push(Date.now());
      text += new TextDecoder().decode(value);
    }
    assert.ok(arrivals.length >= 3, 'the stream should arrive in several delayed chunks');
    const span = arrivals[arrivals.length - 1] - arrivals[0];
    assert.ok(span >= 100, `chunk arrivals should be spread out (span ${span}ms)`);
    const events = await readSseEvents(new Response(text));
    assert.equal(events.at(-1).done, true);
    assert.equal(events[0].choices[0].delta.content, 'Hello ');
    assert.equal(events[1].choices[0].delta.content, 'world');
    assert.deepEqual(events.at(-2).usage, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  } finally { await cleanup(fixture); }
});

// --- native tool roundtrips --------------------------------------------------

test('native read and edit tool roundtrips keep OpenAI shapes end to end', async () => {
  const script = (body, round) => {
    const messages = body.messages ?? [];
    const hasToolResult = id => messages.some(m => m.role === 'tool' && m.tool_call_id === id);
    if (!hasToolResult('call-read-01')) {
      return sse([toolCallDelta('call-read-01', 'read', '{"path":"notes.txt"}'), finishChunk('tool_calls'), '[DONE]']);
    }
    if (!hasToolResult('call-edit-01')) {
      return sse([toolCallDelta('call-edit-01', 'edit', '{"path":"notes.txt","new":"done"}'), finishChunk('tool_calls'), '[DONE]']);
    }
    return sse([assistantTextDelta('Notes updated.'), finishChunk('stop'), usageChunk(210, 90), '[DONE]']);
  };
  const fixture = await startFixture({ script, pricePerInputToken: '3', pricePerOutputToken: '7' });
  try {
    const messages = makeBody().messages;
    const tools = makeBody().tools;
    for (const round of [['call-read-01', 'the notes are empty'], ['call-edit-01', 'ok']]) {
      const response = await sendRaw(fixture, `tool-round-${round[0]}`, { model: INFERENCE_MODEL, stream: true, max_tokens: 512, messages, tools });
      const events = await readSseEvents(response);
      const call = events.find(e => e.choices?.[0]?.delta?.tool_calls)?.choices[0].delta.tool_calls[0];
      assert.ok(call, `round should emit a native tool call (${round[0]})`);
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: call.function }] });
      messages.push({ role: 'tool', tool_call_id: call.id, content: round[1] });
    }
    const final = await sendRaw(fixture, 'tool-round-final01', { model: INFERENCE_MODEL, stream: true, max_tokens: 512, messages, tools });
    const events = await readSseEvents(final);
    assert.equal(events[0].choices[0].delta.content, 'Notes updated.');

    // Sealed bodies seen by the endpoint: model mapped, tools untouched,
    // tool results in original shape, private model id preserved on header.
    const [first, second, third] = fixture.tee.state.recorded;
    assert.equal(first.body.model, 'gpt-oss-120b');
    assert.equal(first.headers['x-private-model'], INFERENCE_MODEL);
    assert.deepEqual(first.body.tools, tools);
    assert.equal(second.body.messages.at(-1).role, 'tool');
    assert.equal(second.body.messages.at(-1).tool_call_id, 'call-read-01');
    assert.equal(third.body.messages.filter(m => m.role === 'tool').length, 2);
    // Settlement in integer base units: the tool rounds report no usage, so
    // each consumes its full derived reservation; the final round settles by
    // usage: 210*3 + 90*7 = 1260.
    const snap = await fixture.broker.journalRef.snapshot();
    const reserveOf = id => snap.entries.find(e => e.kind === 'reserve' && e.id === id)?.amount;
    const settleOf = id => snap.entries.find(e => e.kind === 'settle' && e.id === id)?.amount;
    assert.ok(BigInt(reserveOf('tool-round-call-read-01')) > 0n);
    assert.equal(settleOf('tool-round-call-read-01'), reserveOf('tool-round-call-read-01'));
    assert.equal(settleOf('tool-round-call-edit-01'), reserveOf('tool-round-call-edit-01'));
    assert.equal(settleOf('tool-round-final01'), '1260');
    assert.equal(snap.spent, String(BigInt(reserveOf('tool-round-call-read-01')) + BigInt(reserveOf('tool-round-call-edit-01')) + 1260n));
  } finally { await cleanup(fixture); }
});

test('an empty tools array is normalized away inside the sealed body', async () => {
  const fixture = await startFixture({});
  try {
    await send(fixture, 'empty-tools-000001', makeBody({ tools: [] }));
    assert.ok(!('tools' in fixture.tee.state.recorded[0].body), 'empty tools must not reach the sealed body');
  } finally { await cleanup(fixture); }
});

// --- override rejection -------------------------------------------------------

test('endpoint, model and target overrides in the body are refused', async () => {
  const fixture = await startFixture({});
  try {
    for (const key of ['baseUrl', 'endpoint', 'url', 'target', 'api_key', 'apiKey', 'authorization', 'headers', 'provider', 'fetch']) {
      const body = makeBody({ [key]: 'https://example.invalid/v1' });
      const error = await send(fixture, `override-${key}-0001`, body).then(httpRefusal, e => e);
      assert.ok(error, `${key} must be refused`);
      assert.match(error.message, /override-refused/);
    }
    for (const model of ['gpt-oss-120b', 'private/other-model', 'openai/gpt-4o']) {
      const error = await send(fixture, `model-override-${model.length}`, makeBody({ model })).then(httpRefusal, e => e);
      assert.match(error.message, /unknown-model/);
    }
    assert.equal(fixture.tee.state.posts, 0, 'nothing may be transmitted for refused overrides');
  } finally { await cleanup(fixture); }
});

test('extra headers, wrong credentials and wrong methods are refused', async () => {
  const fixture = await startFixture({});
  try {
    const extra = await rawRequest(fixture, { headers: { authorization: 'Bearer inference-broker-session', 'content-type': 'application/json', 'x-inference-request-id': 'raw-extra-header-1', 'x-model': 'other' }, body: JSON.stringify(makeBody()) });
    assert.equal(extra.status, 403);
    assert.match(extra.body, /header-refused/);
    const wrongAuth = await rawRequest(fixture, { headers: { authorization: 'Bearer real-secret-key', 'content-type': 'application/json', 'x-inference-request-id': 'raw-wrong-auth-001' }, body: JSON.stringify(makeBody()) });
    assert.equal(wrongAuth.status, 401);
    const noId = await rawRequest(fixture, { headers: { authorization: 'Bearer inference-broker-session', 'content-type': 'application/json' }, body: JSON.stringify(makeBody()) });
    assert.equal(noId.status, 400);
    assert.equal(fixture.tee.state.posts, 0);
  } finally { await cleanup(fixture); }
});

// --- no account or management API on the scoped socket -----------------------

test('no account or management API is reachable through the scoped socket', async () => {
  const fixture = await startFixture({});
  try {
    for (const [method, path] of [['GET', '/v1/account'], ['POST', '/v1/account'], ['GET', '/v1/models'], ['GET', '/account'], ['POST', '/admin/keys'], ['GET', '/v1/chat/completions']]) {
      const result = await rawRequest(fixture, { method, path });
      assert.equal(result.status, 404, `${method} ${path} must not exist`);
      assert.match(result.body, /no-such-route/);
    }
    assert.equal(fixture.tee.state.posts, 0, 'the endpoint only ever receives inference');
  } finally { await cleanup(fixture); }
});

// --- verifier gate: no attestation, no release, no fallback ------------------

test('a missing attestation refuses before any transmission, with no fallback', async () => {
  const fixture = await startFixture({ verifierMode: 'missing-attestation' });
  try {
    const error = await send(fixture, 'no-attestation-01', makeBody()).then(httpRefusal, e => e);
    assert.match(error.message, /attestation-refused/);
    assert.equal(fixture.tee.state.posts, 0);
    assert.equal(fixture.verifier.calls.length, 1);
  } finally { await cleanup(fixture); }
});

test('a missing key release refuses before any transmission, with no fallback', async () => {
  const fixture = await startFixture({ verifierMode: 'missing-release' });
  try {
    const error = await send(fixture, 'no-release-000001', makeBody()).then(httpRefusal, e => e);
    assert.match(error.message, /release-missing/);
    assert.equal(fixture.tee.state.posts, 0);
  } finally { await cleanup(fixture); }
});

test('a missing sealed response refuses after exactly one POST, with no fallback', async () => {
  const fixture = await startFixture({ scenario: 'unsealed-response' });
  try {
    const error = await send(fixture, 'unsealed-resp-0001', makeBody()).then(httpRefusal, e => e);
    assert.match(error.message, /transport-failure:unsealed-response/);
    assert.equal(fixture.tee.state.posts, 1, 'exactly one raw encrypted POST, never a plain fallback');
    await tick(50);
    const snap = await fixture.broker.journalRef.snapshot();
    assert.equal(snap.spent, boundOf(makeBody()), 'the failed request still consumed its full derived reservation');
  } finally { await cleanup(fixture); }
});

// --- at-most-once transmission ------------------------------------------------

test('a key mismatch is refused, never re-keyed and never retried', async () => {
  const fixture = await startFixture({ scenario: 'key-mismatch' });
  try {
    const error = await send(fixture, 'key-mismatch-0001', makeBody()).then(httpRefusal, e => e);
    assert.match(error.message, /transport-failure:key-mismatch/);
    assert.equal(fixture.tee.state.posts, 1);
    await tick(50);
    const snap = await fixture.broker.journalRef.snapshot();
    assert.equal(snap.spent, boundOf(makeBody()));
  } finally { await cleanup(fixture); }
});

test('an endpoint redirect is refused exactly; it is never followed', async () => {
  const fixture = await startFixture({ scenario: 'redirect' });
  try {
    const error = await send(fixture, 'redirect-00000001', makeBody()).then(httpRefusal, e => e);
    assert.match(error.message, /transport-failure:endpoint-redirect/);
    assert.equal(fixture.tee.state.posts, 1);
  } finally { await cleanup(fixture); }
});

test('duplicate logical ids are refused without retransmission, including after a restart', async () => {
  const fixture = await startFixture({ scenario: 'drop-after-transmit' });
  try {
    const error = await send(fixture, 'restart-dup-00001', makeBody()).then(httpRefusal, e => e);
    assert.match(error.message, /transport-failure:connection-lost|unavailable/);
    assert.equal(fixture.tee.state.posts, 1);
  } finally {
    const { dir, tee } = fixture;
    await fixture.broker.stop();
    // Same durable state, same endpoint fixture: a restart never resets budget
    // or id history.
    const restarted = await startFixture({ dir, tee, scenario: 'drop-after-transmit' });
    try {
      const duplicate = await send(restarted, 'restart-dup-00001', makeBody()).then(httpRefusal, e => e);
      assert.match(duplicate.message, /duplicate-request/);
      assert.equal(tee.state.posts, 1, 'the duplicate must not be transmitted again');
      const snap = await restarted.broker.journalRef.snapshot();
      assert.equal(snap.spent, boundOf(makeBody()), 'the lost request stays charged after restart');
    } finally {
      await restarted.broker.stop();
      await tee.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

// --- durable budget ------------------------------------------------------------

test('a restart with a different budget cap is refused; the cap never resets', async () => {
  const fixture = await startFixture({ authorizedBudget: '500000' });
  const { dir, tee } = fixture;
  try {
    await send(fixture, 'cap-first-0000001', makeBody());
    await fixture.broker.stop();
    await assert.rejects(startFixture({ dir, tee, authorizedBudget: '1000000', script: okTranscript }), /refusing to reset/);
  } finally {
    await fixture.broker.stop().catch(() => {});
    await tee.stop();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('concurrent requests race for the budget: exactly one reservation is admitted', async () => {
  // The cap is exactly one derived maximum-charge bound: the boundary case.
  const cap = boundOf(makeBody());
  const fixture = await startFixture({ authorizedBudget: cap });
  try {
    const results = await Promise.allSettled([
      send(fixture, 'race-request-aaaaa', makeBody()),
      send(fixture, 'race-request-bbbbb', makeBody()),
    ]);
    const ok = results.filter(r => r.status === 'fulfilled' && r.value.ok);
    const exhausted = results.filter(r => r.status === 'fulfilled' && r.value.status===429 && JSON.parse(r.value.text).error.code==='budget-exhausted');
    assert.equal(ok.length, 1);
    assert.equal(exhausted.length, 1);
    assert.equal(fixture.tee.state.posts, 1);
    await tick(150);
    const snap = await fixture.broker.journalRef.snapshot();
    assert.equal(snap.spent, '650', 'the admitted request settles by usage: 100*3 + 50*7');
    assert.deepEqual(snap.discrepancies, []);
  } finally { await cleanup(fixture); }
});

test('usage-priced settlement records integer base units, not floats', async () => {
  const fixture = await startFixture({ pricePerInputToken: '3', pricePerOutputToken: '7' });
  try {
    await send(fixture, 'usage-settle-00001', makeBody());
    const snap = await fixture.broker.journalRef.snapshot();
    assert.equal(snap.spent, '650'); // 100*3 + 50*7 from the fixture usage chunk
    assert.ok(BigInt(snap.entries.find(e => e.kind === 'reserve' && e.id === 'usage-settle-00001').amount) >= 650n,
      'the reservation is the derived worst-case bound, never below the actual');
    const journalRaw = await readFile(join(fixture.dir, 'state', 'budget', 'budget.json'), 'utf8');
    assert.ok(!/\d+\.\d+/.test(journalRaw.replace(/"at":"[^"]+"/g, '')), 'no float amounts in the journal');
  } finally { await cleanup(fixture); }
});

// --- trusted maximum-charge bound (budget blocker) ---------------------------

test('a request without max_tokens (unknown bound) is refused before any transmission', async () => {
  const fixture = await startFixture({});
  try {
    const body = makeBody();
    delete body.max_tokens;
    const error = await send(fixture, 'no-max-tokens-0001', body).then(httpRefusal, e => e);
    assert.ok(error, 'the request must be refused');
    assert.match(error.message, /max_tokens is required/);
    assert.equal(fixture.tee.state.posts, 0);
    const snap = await fixture.broker.journalRef.snapshot();
    assert.equal(snap.entries.length, 1, 'only the authorize event exists');
  } finally { await cleanup(fixture); }
});

test('reviewed policy reserves full context and scales with the output cap', async () => {
  const fixture = await startFixture({ script: sse([assistantTextDelta('ok'), finishChunk('stop', 0), usageChunk(10, 1), '[DONE]']) });
  try {
    const small = makeBody({ max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], tools: [] });
    const large = makeBody({ max_tokens: 32768, messages: [{ role: 'user', content: 'x'.repeat(4096) }] });
    const smallId = 'bound-small-00001', largeId = 'bound-large-00001';
    await send(fixture, smallId, small);
    await send(fixture, largeId, large);
    const snap = await fixture.broker.journalRef.snapshot();
    const reserveOf = id => snap.entries.find(e => e.kind === 'reserve' && e.id === id).amount;
    assert.equal(reserveOf(smallId), boundOf(small));
    assert.equal(reserveOf(largeId), boundOf(large));
    assert.ok(BigInt(reserveOf(largeId)) > BigInt(reserveOf(smallId)), 'a larger output cap requires a larger reservation');
    assert.equal(snap.discrepancies.length, 0);
  } finally { await cleanup(fixture); }
});

test('an actual settlement above the reserved bound is recorded as a discrepancy and suspends spending', async () => {
  // The upstream reports far more completion tokens than the enforced
  // max_tokens cap: the actual spend exceeds the trusted bound.
  const body = makeBody({ max_tokens: 8, tools: [] });
  const bound = BigInt(boundOf(body));
  const completion = Number((bound + 1000n) / 7n);
  const overshoot = sse([assistantTextDelta('over'), finishChunk('stop', 0), usageChunk(10, completion), '[DONE]']);
  const fixture = await startFixture({ script: overshoot });
  try {
    const actual = String(10 * 3 + completion * 7);
    assert.ok(BigInt(actual) > bound, 'fixture: the actual settlement must exceed the bound');
    await send(fixture, 'overshoot-0000001', body);
    const snap = await fixture.broker.journalRef.snapshot();
    assert.equal(snap.spent, actual, 'the actual overspend is recorded truthfully, never erased');
    assert.deepEqual(snap.discrepancies, [{ id: 'overshoot-0000001', reserved: bound.toString(), actual }]);
    // Spending is suspended: the next request is refused with no POST.
    const error = await send(fixture, 'overshoot-0000002', makeBody()).then(httpRefusal, e => e);
    assert.match(error.message, /settlement-discrepancy/);
    assert.equal(fixture.tee.state.posts, 1);
    const logs = await fixture.broker.logRef.readAll();
    assert.ok(logs.some(e => e.id === 'overshoot-0000001' && e.code === 'settlement-discrepancy'), 'the discrepancy is visible in the outcome log');
  } finally { await cleanup(fixture); }
});

test('a settlement discrepancy suspends spending across a restart until reconciled', async () => {
  const dir = await freshEnv();
  const body = makeBody({ max_tokens: 8, tools: [] });
  const bound = BigInt(boundOf(body));
  const completion = Number((bound + 500n) / 7n);
  const overshoot = sse([finishChunk('stop', 0), usageChunk(5, completion), '[DONE]']);
  const tee = await startLoopbackTee({ socketPath: join(dir, 'sockets', 'tee.sock'), script: overshoot });
  const fixture = await startFixture({ dir, tee });
  try {
    await send(fixture, 'restart-disc-00001', body);
    let snap = await fixture.broker.journalRef.snapshot();
    assert.equal(snap.discrepancies.length, 1);
    await fixture.broker.stop();
    const restarted = await startFixture({ dir, tee });
    try {
      snap = await restarted.broker.journalRef.snapshot();
      assert.equal(snap.discrepancies.length, 1, 'the discrepancy is durable');
      const error = await send(restarted, 'restart-disc-00002', makeBody()).then(httpRefusal, e => e);
      assert.match(error.message, /settlement-discrepancy/);
      assert.equal(tee.state.posts, 1, 'no further POST after the discrepancy');
    } finally { await restarted.broker.stop(); }
  } finally {
    await fixture.broker.stop().catch(() => {});
    await tee.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// --- fail closed on journal or log failure -------------------------------------

test('a budget-journal write failure fails closed: nothing is transmitted', async () => {
  const fixture = await startFixture({});
  try {
    await chmod(join(fixture.dir, 'state', 'budget'), 0o500);
    const error = await send(fixture, 'journal-fail-00001', makeBody()).then(httpRefusal, e => e);
    assert.match(error.message, /journal-failure/);
    assert.equal(fixture.tee.state.posts, 0);
    await chmod(join(fixture.dir, 'state', 'budget'), 0o700);
  } finally { await cleanup(fixture); }
});

test('a request-log write failure fails closed: nothing is transmitted', async () => {
  const fixture = await startFixture({});
  try {
    // One successful request creates the log file; the next one must fail
    // closed when the log becomes unwritable.
    await send(fixture, 'log-ok-000000001', makeBody());
    await chmod(join(fixture.dir, 'state', 'requests', 'requests.log'), 0o400);
    const error = await send(fixture, 'log-fail-00000001', makeBody()).then(httpRefusal, e => e);
    assert.match(error.message, /log-failure/);
    assert.equal(fixture.tee.state.posts, 1, 'only the first (logged) request is transmitted');
    await chmod(join(fixture.dir, 'state', 'requests', 'requests.log'), 0o600);
  } finally { await cleanup(fixture); }
});

test('a settlement that cannot be recorded durably is a terminal failure, never a successful response', async () => {
  const fixture = await startFixture({});
  try {
    const journal = fixture.broker.journalRef;
    journal.settle = async () => { throw new Error('durable settlement write failed'); };
    const response = await sendRaw(fixture, 'settle-fail-00001', makeBody());
    await assert.rejects(response.text(), undefined, 'the response must be destroyed, not completed');
    await tick(100);
    const logs = await fixture.broker.logRef.readAll();
    const entry = logs.find(e => e.id === 'settle-fail-00001' && e.outcome === 'abandoned');
    assert.ok(entry, 'an abandoned/settlement-failed outcome is logged');
    assert.equal(entry.code, 'settlement-failed');
    // The broker fails closed for everything after a settlement failure.
    const error = await send(fixture, 'settle-fail-00002', makeBody()).then(httpRefusal, e => e);
    assert.match(error.message, /journal-failure/);
    assert.equal(fixture.tee.state.posts, 1);
  } finally { await cleanup(fixture); }
});

// --- post-transmission cancel and loss -----------------------------------------

test('a caller cancel after transmission is outcome-unknown, charged and unretryable', async () => {
  const fixture = await startFixture({ chunkDelayMs: 70 });
  try {
    const controller = new AbortController();
    const response = await sendRaw(fixture, 'cancel-mid-000001', makeBody(), { signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    await tick(300);
    const snap = await fixture.broker.journalRef.snapshot();
    assert.equal(snap.spent, boundOf(makeBody()), 'the canceled request consumed its full derived reservation');
    const duplicate = await send(fixture, 'cancel-mid-000001', makeBody()).then(httpRefusal, e => e);
    assert.match(duplicate.message, /duplicate-request/);
    assert.equal(fixture.tee.state.posts, 1, 'canceled logical requests are never retransmitted');
  } finally { await cleanup(fixture); }
});

test('a cancellation during the verifier wait never triggers the POST', async () => {
  const fixture = await startFixture({ verifierMode: 'hanging' });
  try {
    const controller = new AbortController();
    const pending = sendRaw(fixture, 'cancel-early-00001', makeBody(), { signal: controller.signal }).then(() => 'ok', e => e.message);
    await tick(150); // the broker is now parked in the verifier wait
    controller.abort();
    const outcome = await pending;
    assert.match(String(outcome), /unavailable|cancel/i);
    await tick(200);
    assert.equal(fixture.tee.state.posts, 0, 'no POST after an earlier cancellation');
    const snap = await fixture.broker.journalRef.snapshot();
    assert.equal(snap.entries.filter(e => e.id === 'cancel-early-00001').length, 0, 'nothing was reserved');
    const logs = await fixture.broker.logRef.readAll();
    assert.ok(!logs.some(e => e.id === 'cancel-early-00001'), 'no durable trace for a pre-reservation cancellation');
  } finally { await cleanup(fixture); }
});

test('a stalled upstream first byte is bounded by the idle timeout from request entry', async () => {
  const fixture = await startFixture({ stallAfterConnect: 'first', responseIdleTimeoutMs: 1000, responseDeadlineMs: 30000 });
  try {
    const error = await send(fixture, 'first-byte-stall1', makeBody(), { timeoutMs: 10000 }).then(httpRefusal, e => e);
    assert.ok(error, 'a stalled first byte must fail the request');
    await tick(150);
    const snap = await fixture.broker.journalRef.snapshot();
    assert.equal(snap.spent, boundOf(makeBody()), 'outcome-unknown: the reservation is consumed');
    // The handler settled and the broker keeps serving under its bounds.
    const ok2 = await send(fixture, 'first-byte-ok-0001', makeBody());
    assert.equal(ok2.status,200);assert.equal(ok2.ok,true);
    assert.equal(fixture.tee.state.posts, 2);
  } finally { await cleanup(fixture); }
}, { timeout: 30000 });

test('an abort while drain-blocked settles the handler; nothing outlives the request', async () => {
  const lines = 1400;
  const bigTranscript = sse([...Array.from({ length: lines }, (_, i) => assistantTextDelta(`chunk-${i}-${'p'.repeat(900)}`)), '[DONE]']);
  const fixture = await startFixture({ script: bigTranscript });
  try {
    const controller = new AbortController();
    const response = await sendRaw(fixture, 'drain-abort-00001', makeBody(), { signal: controller.signal });
    const reader = response.body.getReader();
    await reader.read();   // first chunk, then stop reading: the broker's
    await tick(400);       // res.write() drain wait is now pending
    controller.abort();    // cancel while the relay is drain-blocked
    await tick(400);
    const snap = await fixture.broker.journalRef.snapshot();
    const entry = snap.entries.find(e => e.kind === 'abandon' && e.id === 'drain-abort-00001');
    assert.ok(entry, 'the drain-blocked handler settled to a terminal state');
    assert.equal(snap.outstanding, '0');
  } finally { await cleanup(fixture); }
}, { timeout: 30000 });

// --- frame bounds ----------------------------------------------------------------

test('request frames beyond the bound are refused before any transmission', async () => {
  const fixture = await startFixture({ maxRequestBytes: 2048 });
  try {
    const big = makeBody({ messages: [{ role: 'user', content: 'x'.repeat(8192) }] });
    const result = await rawRequest(fixture, {
      headers: { authorization: 'Bearer inference-broker-session', 'content-type': 'application/json', 'x-inference-request-id': 'oversize-request-1' },
      body: JSON.stringify(big),
    });
    assert.equal(result.status, 413);
    assert.match(result.body, /frame-too-large/);
    assert.equal(fixture.tee.state.posts, 0);
  } finally { await cleanup(fixture); }
});

test('a response beyond its bound aborts the relay and consumes the reservation', async () => {
  const fixture = await startFixture({ scenario: 'oversize', maxResponseBytes: 8192 });
  try {
    const error = await send(fixture, 'oversize-resp-0001', makeBody()).then(httpRefusal, e => e);
    assert.ok(error, 'the oversize response must fail the request');
    await tick(200);
    const snap = await fixture.broker.journalRef.snapshot();
    assert.equal(snap.spent, boundOf(makeBody()));
    assert.ok(fixture.tee.state.oversizeBytesSent > 8192);
  } finally { await cleanup(fixture); }
});

// --- uid separation ----------------------------------------------------------------

test('the broker refuses to start as the caller uid without an explicit testing flag', async () => {
  const dir = await freshEnv();
  try {
    const tee = await startLoopbackTee({ socketPath: join(dir, 'sockets', 'tee.sock'), script: okTranscript });
    const verifier = createStubVerifier({ release: tee.release });
    const transport = createLoopbackSealedTransport({ endpoint: { socketPath: tee.socketPath, route: '/v1/chat/completions' }, inferenceKey: 'offline-fixture-inference-key' });
    const broker = createInferenceBroker({
      socketPath: join(dir, 'sockets', 'broker.sock'), stateDir: join(dir, 'state'), peerUid: process.getuid(),
      transport, verifier, authorizedBudget: '1000',
    });
    await assert.rejects(broker.start(), /separate/);
    await tee.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a separate-uid configuration without a shared IPC group refuses to start', async () => {
  const dir = await freshEnv();
  try {
    const tee = await startLoopbackTee({ socketPath: join(dir, 'sockets', 'tee.sock'), script: okTranscript });
    const transport = createLoopbackSealedTransport({ endpoint: { socketPath: tee.socketPath, route: '/v1/chat/completions' }, inferenceKey: 'offline-fixture-inference-key' });
    const broker = createInferenceBroker({
      socketPath: join(dir, 'sockets', 'broker.sock'), stateDir: join(dir, 'state'), peerUid: 4242,
      transport, verifier: createStubVerifier({ release: tee.release }), authorizedBudget: '1000',
    });
    await assert.rejects(broker.start(), /shared IPC group/);
    await tee.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the shared IPC group socket is 0660 group-owned on a searchable, non-writable parent', async () => {
  const dir = await freshEnv();
  await chmod(join(dir, 'sockets'), 0o710);
  const fixture = await startFixture({ dir, socketGroup: process.getgid() });
  try {
    const info = await lstat(join(dir, 'sockets', 'broker.sock'));
    assert.equal(info.gid, process.getgid());
    assert.equal(info.mode & 0o777, 0o660);
    await send(fixture, 'group-socket-0001', makeBody());
  } finally { await cleanup(fixture); }
});

test('a group-writable socket parent directory is refused', async () => {
  const dir = await freshEnv();
  try {
    await chmod(join(dir, 'sockets'), 0o770);
    const tee = await startLoopbackTee({ socketPath: join(dir, 'sockets', 'tee.sock'), script: okTranscript });
    const transport = createLoopbackSealedTransport({ endpoint: { socketPath: tee.socketPath, route: '/v1/chat/completions' }, inferenceKey: 'offline-fixture-inference-key' });
    const broker = createInferenceBroker({
      socketPath: join(dir, 'sockets', 'broker.sock'), stateDir: join(dir, 'state'), peerUid: 4242, socketGroup: 4242,
      transport, verifier: createStubVerifier({ release: tee.release }), authorizedBudget: '1000',
    });
    await assert.rejects(broker.start(), /not group- or other-writable/);
    await tee.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('connections from the wrong uid are destroyed before any response', async () => {
  // A second fixture in its OWN state directory, configured for a peer uid
  // that is not this process: our connection must be refused pre-parser.
  const other = await startFixture({ peerUid: 4242, socketName: 'other-uid.sock' });
  try {
    const error = await inferenceSocketFetch(join(other.dir, 'sockets', 'other-uid.sock'), { requestId: 'wrong-uid-0000001', timeoutMs: 5000 })(undefined, { body: JSON.stringify(makeBody()) }).then(() => null, e => e);
    assert.ok(error, 'the connection must fail');
    assert.match(error.message, /unavailable|destroyed|socket/i, 'no structured broker response may reach a wrong-uid connection');
    assert.equal(other.tee.state.posts, 0);
    // Defense in depth: the wrong-uid connection must leave no durable
    // trace either (no journal entry, no request-log entry).
    const entries = (await other.broker.journalRef.snapshot()).entries.filter(e => e.id === 'wrong-uid-0000001');
    assert.deepEqual(entries, []);
    const logs = await other.broker.logRef.readAll();
    assert.ok(!logs.some(e => e.id === 'wrong-uid-0000001'), 'no request-log entry for a wrong-uid connection');
  } finally { await cleanup(other); }
});

test('a broken peer-credential helper fails closed: the connection is destroyed', async () => {
  // A PATH-shadowed python3 misbehaves only for the SO_PEERCRED helper
  // (journal locks still delegate to the real python3). Both failure shapes
  // must destroy the connection before any response, with no durable trace.
  for (const [name, behavior] of [['silent-exit', 'exit 0'], ['garbage', 'echo not-credentials; exit 0']]) {
    const dir = await freshEnv();
    const fakeBin = join(dir, 'fakebin');
    await mkdir(fakeBin);
    await writeFile(join(fakeBin, 'python3'), `#!/bin/sh\ncase "$*" in\n  *SO_PEERCRED*) ${behavior} ;;\n  *) exec /usr/bin/python3 "$@" ;;\nesac\n`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath}`;
    try {
      const fixture = await startFixture({ dir });
      try {
        const error = await send(fixture, `peercred-${name}-001`, makeBody(), { timeoutMs: 5000 }).then(httpRefusal, e => e);
        assert.ok(error, `the ${name} helper must destroy the connection`);
        assert.match(error.message, /unavailable|destroyed|socket/i, 'no structured response may reach an unverifiable connection');
        const snap = await fixture.broker.journalRef.snapshot();
        assert.equal(snap.entries.filter(e => e.id === `peercred-${name}-001`).length, 0, 'no durable trace');
        assert.equal(fixture.tee.state.posts, 0);
      } finally { await cleanup(fixture); }
    } finally { process.env.PATH = previousPath; }
  }
}, { timeout: 30000 });

// --- socket hygiene ----------------------------------------------------------------

test('a stale socket file is probed and replaced; a live broker is never taken over', async () => {
  const dir = await freshEnv();
  const socketPath = join(dir, 'sockets', 'broker.sock');
  // Stale: a listener killed without cleanup leaves the socket file behind.
  const stale = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('listening'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(resolve => stale.stdout.once('data', resolve));
  stale.kill('SIGKILL');
  await new Promise(resolve => stale.once('exit', resolve));
  assert.ok(await stat(socketPath).then(() => true, () => false), 'stale socket file present');
  const fixture = await startFixture({ dir });
  try {
    await send(fixture, 'stale-socket-0001', makeBody());
  } finally {
    // Stop this broker but keep the directory for the live-takeover check.
    await fixture.broker.stop().catch(() => {});
    await fixture.tee.stop().catch(() => {});
  }

  const live = await startFixture({ dir });
  try {
    await assert.rejects(startFixture({ dir: live.dir, tee: live.tee }), /live broker/);
  } finally { await cleanup(live); }
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}, { timeout: 30000 });

// --- lifetime exclusive state ownership ---------------------------------------------

test('a second live broker cannot start against the same state, even on another socket', async () => {
  const dir = await freshEnv();
  const tee = await startLoopbackTee({ socketPath: join(dir, 'sockets', 'tee.sock'), chunkDelayMs: 80, script: okTranscript });
  const fixture = await startFixture({ dir, tee });
  try {
    // First broker has an active in-flight stream (an outstanding reservation).
    const streaming = sendRaw(fixture, 'active-stream-0001', makeBody()).then(response => response.text());
    await tick(50);
    const second = await startFixture({ dir, tee, socketName: 'second.sock' }).then(() => null, e => e);
    assert.ok(second, 'the second live broker must refuse to start');
    assert.match(second.message, /another live broker/);
    // The original journal was NOT swept: no restart-sweep abandon of the
    // first broker's outstanding request.
    const mid = await fixture.broker.journalRef.snapshot();
    assert.ok(!mid.entries.some(e => e.id === 'active-stream-0001' && e.kind === 'abandon'), 'the live broker\'s reservation was never touched');
    // The first stream completes and settles normally afterwards.
    const text = await streaming;
    assert.ok(text.includes('[DONE]'));
    const snap = await fixture.broker.journalRef.snapshot();
    assert.equal(snap.outstanding, '0');
    assert.ok(snap.entries.some(e => e.id === 'active-stream-0001' && e.kind === 'settle'));
    assert.deepEqual(snap.discrepancies, []);
    // After the first broker stops, a new broker may own the state again.
    await fixture.broker.stop();
    const third = await startFixture({ dir, tee, socketName: 'third.sock' });
    await third.broker.stop();
  } finally {
    await fixture.broker.stop().catch(() => {});
    await tee.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, { timeout: 30000 });

test('stop() aborts and drains in-flight handlers, settles them, and releases state ownership', async () => {
  const dir = await freshEnv();
  const tee = await startLoopbackTee({ socketPath: join(dir, 'sockets', 'tee.sock'), stallAfterConnect: true, script: okTranscript });
  const fixture = await startFixture({ dir, tee });
  try {
    const pending = send(fixture, 'drain-on-stop-0001', makeBody()).then(httpRefusal, e => e);
    await tick(150); // the request is now stalled waiting for the first upstream byte
    await fixture.broker.stop(); // must return: destroy before close, abort, await settlement
    const outcome = await pending;
    assert.ok(outcome, 'the in-flight request failed closed');
    const snap = await fixture.broker.journalRef.snapshot();
    assert.equal(snap.outstanding, '0', 'the outstanding reservation reached a terminal state');
    assert.ok(snap.entries.some(e => e.id === 'drain-on-stop-0001' && e.kind === 'abandon'), 'charged as outcome-unknown');
    // Ownership was released: a fresh broker takes over the same state and
    // sweeps nothing (already resolved).
    const next = await startFixture({ dir, tee });
    await next.broker.stop();
  } finally {
    await fixture.broker.stop().catch(() => {});
    await tee.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, { timeout: 30000 });

// --- streaming backpressure ----------------------------------------------------------

test('explicit backpressure: a paused client slows the endpoint, then the stream completes', async () => {
  const lines = 1400;
  const bigTranscript = sse([...Array.from({ length: lines }, (_, i) => assistantTextDelta(`chunk-${i}-${'p'.repeat(900)}`)), '[DONE]']);
  const fixture = await startFixture({ script: bigTranscript });
  try {
    const response = await sendRaw(fixture, 'backpressure-0001', makeBody());
    const reader = response.body.getReader();
    let text = '';
    const first = await reader.read(); // first chunk, then stop reading
    if (first.value) text += new TextDecoder().decode(first.value);
    await tick(600);    // paused: the whole chain must apply backpressure
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    const events = await readSseEvents(new Response(text));
    assert.equal(events.length, lines + 1); // every delta plus [DONE]
    assert.ok(fixture.tee.state.backpressure.writesReturnedFalse >= 1, 'the endpoint write must have blocked while the client paused');
    assert.ok(fixture.tee.state.backpressure.slowestDrainMs >= 200, `a blocked endpoint drain should reflect the pause (got ${fixture.tee.state.backpressure.slowestDrainMs}ms)`);
  } finally { await cleanup(fixture); }
});

// --- endpoint immutability -------------------------------------------------------------

test('the loopback transport snapshots its endpoint: later mutation cannot redirect a POST', async () => {
  const dir = await freshEnv();
  const tee = await startLoopbackTee({ socketPath: join(dir, 'sockets', 'tee.sock'), script: okTranscript });
  const endpoint = { socketPath: tee.socketPath, route: '/v1/chat/completions' };
  const transport = createLoopbackSealedTransport({ endpoint, inferenceKey: 'offline-fixture-inference-key' });
  try {
    // The caller mutates its endpoint object after construction.
    endpoint.socketPath = join(dir, 'sockets', 'evil.sock');
    endpoint.route = '/v1/other';
    // The transport's public view is frozen primitives, not a writable alias.
    assert.throws(() => { transport.endpoint.socketPath = '/tmp/x'; }, TypeError);
    const fixture = await startFixture({ dir, tee, transport });
    try {
      await send(fixture, 'immutable-endp-01', makeBody());
      assert.equal(tee.state.posts, 1, 'the POST still went to the original exact endpoint');
      assert.equal(tee.state.recorded[0].headers['x-private-model'], INFERENCE_MODEL);
    } finally { await fixture.broker.stop(); }
  } finally {
    await tee.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// --- fixture teardown ------------------------------------------------------------------

test('a held-open fixture connection cannot hang stop(); owned timers are cancelled', async () => {
  const dir = await freshEnv();
  const tee = await startLoopbackTee({ socketPath: join(dir, 'sockets', 'tee.sock'), stallAfterConnect: true, script: okTranscript });
  try {
    // A half-sent request holds a fixture connection open (the 60s stall
    // timer is pending): stop() must destroy it before awaiting close.
    const holder = net.connect(tee.socketPath);
    holder.write('POST /v1/chat/completions HTTP/1.1\r\ncontent-length: 999\r\n\r\npartial');
    await tick(100);
    await Promise.race([
      tee.stop(),
      tick(5000).then(() => { throw new Error('tee.stop() hung on a held-open connection'); }),
    ]);
    holder.destroy();
  } finally {
    await tee.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}, { timeout: 20000 });

// --- credential canary ---------------------------------------------------------------

test('a credential canary never appears in errors, events or artifacts', async () => {
  const canary = `CANARY-INFERENCE-KEY-${randomBytes(16).toString('hex')}`;
  const seen = [];
  const observe = error => { if (error?.message) seen.push(error.message); return null; };
  const scenarios = [
    { key: 'canary-budget', fixture: { authorizedBudget: boundOf(makeBody()) }, second: true },
    { key: 'canary-keymismatch', fixture: { scenario: 'key-mismatch' } },
    { key: 'canary-unsealed', fixture: { scenario: 'unsealed-response' } },
    { key: 'canary-redirect', fixture: { scenario: 'redirect' } },
    { key: 'canary-drop', fixture: { scenario: 'drop-after-transmit' } },
    { key: 'canary-noattest', fixture: { verifierMode: 'missing-attestation' } },
    { key: 'canary-norelease', fixture: { verifierMode: 'missing-release' } },
    { key: 'canary-logfail', fixture: {}, logFail: true, second: true },
    { key: 'canary-badcode', fixture: {}, badTransportCode: true },
  ];
  for (const scenario of scenarios) {
    const fixture = await startFixture({ ...scenario.fixture, inferenceKey: canary });
    try {
      if (scenario.badTransportCode) {
        // An injected transport error carrying a hostile non-enum code must
        // be enum-normalized before it reaches any response or log.
        fixture.transport.post = async () => {
          const error = new Error(`injected ${canary}`);
          error.code = `leak-${canary}`;
          throw error;
        };
        await send(fixture, `${scenario.key}-000000002`, makeBody()).then(() => {}, observe);
      }
      if (scenario.logFail) {
        await send(fixture, `${scenario.key}-000000001`, makeBody()).then(() => {}, observe);
        await chmod(join(fixture.dir, 'state', 'requests', 'requests.log'), 0o400);
      }
      if (!scenario.badTransportCode) await send(fixture, `${scenario.key}-000000002`, makeBody()).then(() => {}, observe);
      if (scenario.second) await send(fixture, `${scenario.key}-000000003`, makeBody()).then(() => {}, observe);
      await tick(100);
      // All durable artifacts of this run: journal, request log, sockets dir.
      for (const [, contents] of await readFiles(join(fixture.dir, 'state'))) seen.push(contents);
      const logs = await fixture.broker.logRef.readAll().catch(() => []);
      seen.push(JSON.stringify(logs));
      // The hostile transport code must never be projected verbatim.
      const logs2 = await fixture.broker.logRef.readAll().catch(() => []);
      for (const entry of logs2) assert.ok(!String(entry.code ?? '').includes('leak-'), 'injected error codes are enum-normalized');
    } finally { await cleanup(fixture); }
  }
  for (const message of seen) {
    assert.ok(!message.includes(canary), `canary leaked: ${String(message).slice(0, 200)}`);
  }
});

// --- static hygiene --------------------------------------------------------------------

test('no mastercredit id or credential concept exists in this subsystem', async () => {
  const files = [];
  const walk = async dir => {
    for (const name of await readdir(dir)) {
      const full = join(dir, name);
      if ((await stat(full)).isDirectory()) await walk(full);
      else if (/\.(mjs|md)$/.test(name) && !/\.test\.mjs$/.test(name)) files.push(await readFile(full, 'utf8'));
    }
  };
  await walk(here);
  assert.ok(files.length >= 8);
  for (const source of files) {
    assert.ok(!/mastercredit/i.test(source), 'mastercredit_id must not appear in portable/inference');
  }
});

test('the broker source performs no fetch of its own', async () => {
  const source = await readFile(join(here, 'broker.mjs'), 'utf8');
  assert.ok(!/(^|[^.\w])fetch\s*\(/.test(source), 'the broker must not call fetch directly');
  assert.ok(!/require\(['"]node:https?['"]\)/.test(source), 'no direct https client');
});


test('missing or expired charge policy refuses before any reservation or POST', async () => {
  for (const overrides of [{chargePolicy:null},{clock:()=>110}]) {
    const f=await startFixture(overrides);
    try {
      const refused=await send(f,'unknown-contract-001',makeBody());
      assert.equal(refused.ok,false);assert.equal(refused.status,503);
      assert.equal(JSON.parse(refused.text).error.code,'charge-bound-refused');
      assert.equal(f.tee.state.posts,0);
      const snap=await f.broker.journalRef.snapshot();
      assert.equal(snap.entries.filter(e=>e.kind==='reserve').length,0);
    } finally { await cleanup(f); }
  }
});

test('tariff expiration during attestation refuses raw POST and settles known zero cost', async () => {
  let now=100;
  const f=await startFixture({clock:()=>now});
  const original=f.verifier.verify.bind(f.verifier);
  f.verifier.verify=async(...args)=>{const result=await original(...args);now=110;return result;};
  try {
    const refused=await send(f,'expiring-contract-01',makeBody());
      assert.equal(refused.ok,false);assert.equal(refused.status,503);
      assert.equal(JSON.parse(refused.text).error.code,'charge-bound-refused');
    assert.equal(f.tee.state.posts,0);
    const snap=await f.broker.journalRef.snapshot();
    assert.equal(snap.spent,'0');
    assert.equal(snap.outstanding,'0');
    assert.ok(snap.entries.some(e=>e.kind==='settle'&&e.id==='expiring-contract-01'&&e.amount==='0'));
  } finally { await cleanup(f); }
});
