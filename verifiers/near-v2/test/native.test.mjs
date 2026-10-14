import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { replyKey, open, seal, digest, hex, unhex, utf8 } from '../crypto.mjs';
import { encryptRequest } from '../codec.mjs';
import { prepareExchange } from '../exchange.mjs';

const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1), modelKey = replyKey(seed);
const model = 'synthetic/model', now = 1000;
const policy = { id: 'synthetic-explicit-code-policy', composeHashes: ['a'.repeat(64)], osImageHashes: ['b'.repeat(64)], maxAgeMs: 1000 };
const admission = { model, signingKey: modelKey.publicKey, composeHash: 'a'.repeat(64), osImageHash: 'b'.repeat(64), verifiedAt: 900, expiresAt: 1800 };
const tools = [{ type: 'function', function: { name: 'read', description: 'Read synthetic text', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }, { type: 'function', function: { name: 'edit', parameters: { type: 'object', properties: { status: { type: 'string' } } } } }];
const request = (messages = [{ role: 'user', content: 'SYNTHETIC_SECRET read sample.md' }]) => ({ model, messages, tools: structuredClone(tools), max_tokens: 512, stream: true });
const prepare = (req = request()) => prepareExchange(req, admission, policy, { now });
const stream = (raw, split = 7) => new ReadableStream({ start(controller) { for (let i = 0; i < raw.length; i += split) controller.enqueue(raw.subarray(i, i + split)); controller.close(); } });
function rawReply(exchange, { name = 'read', arguments: args = '{"path":"sample.md"}', content, done = true, finish, badEnvelope = false, responseModel = model } = {}) {
  const encrypted = (text) => badEnvelope ? '00'.repeat(72) : seal(text, exchange.headers['x-client-pub-key']);
  const chunks = content !== undefined ? [{ choices: [{ index: 0, delta: { role: 'assistant', content: encrypted(content) }, finish_reason: 'stop' }] }] : [
    { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'synthetic_call', type: 'function', function: { name: encrypted(name), arguments: encrypted(args.slice(0, 6)) } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: encrypted(args.slice(6)) } }] }, finish_reason: finish ?? 'tool_calls' }] },
  ];
  return utf8(chunks.map((chunk) => `data: ${JSON.stringify({ id: 'synthetic_reply', object: 'chat.completion.chunk', model: responseModel, ...chunk })}\r\n\r\n`).join('') + (done ? 'data: [DONE]\r\n\r\n' : ''));
}
function proof(exchange, raw, patch = {}) {
  const text = `${model}:${digest(exchange.body)}:${digest(raw)}`;
  return { text, signing_address: modelKey.publicKey, signature_kind: 'provider_tee', signing_algo: 'ed25519', signature: hex(ed25519.sign(utf8(text), seed)), ...patch };
}
const parsed = (result) => Buffer.from(result.sse).toString().split('\n\n').filter((line) => line && !line.includes('[DONE]')).map((line) => JSON.parse(line.slice(6)));
function toolsFrom(result) {
  const calls = new Map();
  for (const chunk of parsed(result)) for (const choice of chunk.choices) for (const tool of choice.delta?.tool_calls ?? []) {
    const old = calls.get(tool.index) ?? { name: '', arguments: '' };
    old.name += tool.function?.name ?? ''; old.arguments += tool.function?.arguments ?? ''; calls.set(tool.index, old);
  }
  return [...calls.values()].map((tool) => ({ name: tool.name, args: JSON.parse(tool.arguments) }));
}

test('decrypts executed pinned browser reference vectors including Unicode and empty text', () => {
  const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/browser-v2.json', import.meta.url)));
  const key = replyKey(unhex(vectors.seed));
  assert.equal(key.publicKey, vectors.publicKey);
  for (const vector of vectors.vectors) assert.equal(open(vector.envelope, key.secret), vector.text);
  const bad = vectors.vectors[0].envelope.slice(0, -2) + '00';
  assert.throws(() => open(bad, key.secret));
});

test('seals schemas, function selection, call arguments and tool follow-up text', () => {
  const req = request([{ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'SYNTHETIC_SECRET', arguments: '{"secret":"SYNTHETIC_SECRET"}' } }] }, { role: 'tool', tool_call_id: 'call_1', content: 'SYNTHETIC_SECRET' }]);
  req.tools[0].function.description = 'SYNTHETIC_SECRET';
  req.tools[0].function.parameters.properties.secret = { description: 'SYNTHETIC_SECRET' };
  req.tool_choice = { type: 'function', function: { name: 'SYNTHETIC_SECRET' } };
  const encrypted = encryptRequest(req, modelKey.publicKey);
  assert.ok(!JSON.stringify(encrypted).includes('SYNTHETIC_SECRET'));
  assert.equal(open(encrypted.messages[1].content, modelKey.secret), 'SYNTHETIC_SECRET');
  assert.equal(open(encrypted.tool_choice.function.name, modelKey.secret), 'SYNTHETIC_SECRET');
  assert.equal(JSON.parse(open(encrypted.tools[0].function.parameters, modelKey.secret)).properties.secret.description, 'SYNTHETIC_SECRET');
});

test('synthetic native read, question and exact edit only act after full proof', async () => {
  let file = 'Status: draft\nOwner: Priya Raman\n', effects = 0;
  const first = prepare(), raw = rawReply(first);
  let allowProof;
  const pending = first.complete(stream(raw), () => new Promise((resolve) => { allowProof = resolve; }), { now });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(effects, 0);
  allowProof(proof(first, raw));
  const result = await pending;
  assert.deepEqual(toolsFrom(result), [{ name: 'read', args: { path: 'sample.md' } }]); effects++;
  const second = prepare(request([{ role: 'assistant', content: null, tool_calls: [{ id: 'synthetic_call', type: 'function', function: { name: 'read', arguments: '{"path":"sample.md"}' } }] }, { role: 'tool', tool_call_id: 'synthetic_call', content: file }, { role: 'user', content: 'Who owns this?' }]));
  const answer = rawReply(second, { content: 'Priya Raman owns the synthetic note.' });
  const answered = await second.complete(stream(answer, 1), proof(second, answer), { now });
  assert.match(Buffer.from(answered.sse).toString(), /Priya Raman/);
  const third = prepare(request([{ role: 'user', content: 'Change only Status to ready.' }]));
  const edited = rawReply(third, { name: 'edit', arguments: '{"status":"ready"}' });
  const edits = toolsFrom(await third.complete(stream(edited), proof(third, edited), { now }));
  assert.deepEqual(edits, [{ name: 'edit', args: { status: 'ready' } }]);
  file = file.replace('Status: draft', 'Status: ready'); effects++;
  assert.equal(file, 'Status: ready\nOwner: Priya Raman\n'); assert.equal(effects, 2);
});

for (const [name, options, patch] of [
  ['missing proof', {}, null], ['wrong signer', {}, { signing_address: '00'.repeat(32) }], ['wrong model', {}, { text: 'different-model' }], ['gateway signature', {}, { signature_kind: 'gateway' }], ['signature tamper', {}, { signature: '00'.repeat(64) }], ['truncated stream', { done: false }, {}], ['decrypt failure', { badEnvelope: true }, {}], ['malformed tool args', { arguments: 'incomplete' }, {}], ['unfinished tool turn', { finish: 'stop' }, {}], ['length cutoff', { finish: 'length' }, {}], ['content filter', { finish: 'content_filter' }, {}], ['response model mismatch', { responseModel: 'another/model' }, {}],
]) test(`${name}: no tool effects released`, async () => {
  let effects = 0; const exchange = prepare(), raw = rawReply(exchange, options);
  const signed = patch === null ? null : proof(exchange, raw, patch);
  await assert.rejects(async () => { const result = await exchange.complete(stream(raw), signed, { now }); effects += toolsFrom(result).length; });
  assert.equal(effects, 0);
});

test('raw byte tamper and unframed EOF reject despite valid decrypted data', async () => {
  for (const mutate of [(raw) => utf8(Buffer.from(raw).toString().replace('data:', 'data: ')), (raw) => raw.subarray(0, raw.length - 2)]) {
    const exchange = prepare(), raw = rawReply(exchange);
    await assert.rejects(exchange.complete(stream(mutate(raw)), proof(exchange, raw), { now }));
  }
});

test('reader failure, abort and oversized stream do not release tools', async () => {
  let effects = 0;
  const exchange = prepare(), raw = rawReply(exchange);
  const broken = new ReadableStream({ start(controller) { controller.enqueue(raw.subarray(0, 30)); controller.error(new Error('synthetic interrupted read')); } });
  await assert.rejects(exchange.complete(broken, proof(exchange, raw), { now }));
  const aborted = prepare(), signal = AbortSignal.abort();
  await assert.rejects(aborted.complete(stream(raw), null, { now, signal }));
  const large = prepare(); await assert.rejects(large.complete(stream(raw), null, { now, maxResponseBytes: 10 }));
  assert.equal(effects, 0);
});

test('explicit known code hashes and admission freshness required; policy cannot be relaxed later', async () => {
  assert.throws(() => prepareExchange(request(), admission, undefined, { now }));
  assert.throws(() => prepareExchange(request(), { ...admission, composeHash: 'c'.repeat(64) }, policy, { now }));
  assert.throws(() => prepareExchange(request(), { ...admission, osImageHash: undefined }, policy, { now }));
  assert.throws(() => prepareExchange(request(), { ...admission, model: 'wrong' }, policy, { now }));
  assert.throws(() => prepareExchange(request(), { ...admission, expiresAt: now }, policy, { now }));
  const exchange = prepare(), raw = rawReply(exchange);
  await assert.rejects(exchange.complete(stream(raw), proof(exchange, raw), { now: 1900 }));
});

test('unsupported fields, modalities, types and schema cycles fail before ciphertext can be sent', () => {
  for (const patch of [{ metadata: { secret: 'private' } }, { messages: [{ role: 'user', content: [{ type: 'text', text: 'private' }] }] }, { tools: [] }, { stop: 'private' }, { stream: false }, { tool_choice: { type: 'custom', function: { name: 'x' } } }]) assert.throws(() => prepare({ ...request(), ...patch }));
  const cycle = {}; cycle.loop = cycle;
  assert.throws(() => prepare({ ...request(), tools: [{ type: 'function', function: { name: 'read', parameters: cycle } }] }));
});

test('reply key substitution fails to decrypt; detection does not undo relay disclosure', async () => {
  const exchange = prepare(), attackKey = replyKey(new Uint8Array(32).fill(42));
  const attacked = { ...exchange, headers: { ...exchange.headers, 'x-client-pub-key': attackKey.publicKey } };
  const raw = rawReply(attacked, { content: 'synthetic reply visible to attacker' });
  const chunk = JSON.parse(Buffer.from(raw).toString().split('\r\n')[0].slice(6));
  assert.equal(open(chunk.choices[0].delta.content, attackKey.secret), 'synthetic reply visible to attacker');
  await assert.rejects(exchange.complete(stream(raw), proof(exchange, raw), { now }));
});


test('streaming message coexistence, wrong role and undeclared tool cannot release effects', async () => {
  for (const transform of [
    (chunk) => { chunk.choices[0].message = { tool_calls: [{ index: 1, function: { name: 'ignored', arguments: 'ignored' } }] }; },
    (chunk) => { chunk.choices[0].delta.role = 'tool'; },
  ]) {
    const exchange = prepare(); const lines = Buffer.from(rawReply(exchange)).toString().split('\r\n\r\n');
    const first = JSON.parse(lines[0].slice(6)); transform(first); lines[0] = 'data: ' + JSON.stringify(first);
    const raw = utf8(lines.join('\r\n\r\n'));
    await assert.rejects(exchange.complete(stream(raw), proof(exchange, raw), { now }));
  }
  const exchange = prepare(), raw = rawReply(exchange, { name: 'undeclared' });
  await assert.rejects(exchange.complete(stream(raw), proof(exchange, raw), { now }));
});

test('caller mutations cannot alter policy, model or request bytes after preparation', async () => {
  const mutablePolicy = structuredClone(policy), mutableRequest = request();
  const exchange = prepareExchange(mutableRequest, admission, mutablePolicy, { now }), original = exchange.body;
  mutablePolicy.composeHashes.length = 0; mutablePolicy.osImageHashes.length = 0; mutablePolicy.maxAgeMs = 1;
  mutableRequest.model = 'wrong/model'; mutableRequest.tools.length = 0;
  const exposed = exchange.body; exposed.fill(0);
  assert.deepEqual(exchange.body, original);
  const raw = rawReply(exchange);
  assert.equal(toolsFrom(await exchange.complete(stream(raw), proof(exchange, raw), { now }))[0].name, 'read');
});


test('active abort while proof lookup is pending refuses without releasing tools', async () => {
  const exchange = prepare(), raw = rawReply(exchange), controller = new AbortController();
  const pending = exchange.complete(stream(raw), () => new Promise(() => {}), { now, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error('synthetic proof timeout'));
  await assert.rejects(pending, /synthetic proof timeout/);
});

test('one exchange cannot be completed twice or used after close', async () => {
  const exchange = prepare(), raw = rawReply(exchange);
  await exchange.complete(stream(raw), proof(exchange, raw), { now });
  await assert.rejects(exchange.complete(stream(raw), proof(exchange, raw), { now }), /already consumed/);
  const unused = prepare(); unused.close();
  await assert.rejects(unused.complete(stream(raw), null, { now }), /already consumed/);
});


test('none and fixed tool choices constrain released native calls', async () => {
  const none = prepare({ ...request(), tool_choice: 'none' }), noneRaw = rawReply(none);
  await assert.rejects(none.complete(stream(noneRaw), proof(none, noneRaw), { now }));
  const fixed = prepare({ ...request(), tool_choice: { type: 'function', function: { name: 'read' } } }), fixedRaw = rawReply(fixed, { name: 'edit' });
  await assert.rejects(fixed.complete(stream(fixedRaw), proof(fixed, fixedRaw), { now }));
  assert.throws(() => prepare({ ...request(), tool_choice: { type: 'function', function: { name: 'undeclared' } } }));
});
