import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak256 } from '../lib/keccak.mjs';
import { encrypt, decrypt } from '../lib/near.mjs';
import { NEAR_NATIVE_PI_COMPAT, encryptNearNativeRequest, nearNativeHeaders, authenticateNearNativeResponse, authenticatedNearNativeSse } from '../lib/near-native-qualification.mjs';

const modelKey = crypto.createECDH('secp256k1'); modelKey.generateKeys();
const clientKey = crypto.createECDH('secp256k1'); clientKey.generateKeys();
const address = key => '0x' + keccak256(key.getPublicKey().subarray(1)).subarray(12).toString('hex');
const profile = { model: 'synthetic/model', model_signing_address: address(modelKey), gateway_signing_address: '0x' + '11'.repeat(20) };
const seal = value => encrypt(value, clientKey.getPublicKey('hex'));
const schemaCanary = 'synthetic-schema-canary', promptCanary = 'synthetic-prompt-canary', argumentCanary = 'synthetic-argument-canary', resultCanary = 'synthetic-result-canary';
const body = () => ({ model: profile.model, stream: true, max_tokens: 128,
  messages: [{ role: 'system', content: promptCanary }, { role: 'user', content: promptCanary },
    { role: 'assistant', content: null, reasoning_content: promptCanary, refusal: promptCanary, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'synthetic_echo', arguments: JSON.stringify({ value: argumentCanary }) } }] },
    { role: 'tool', tool_call_id: 'call_1', name: 'synthetic_echo', content: resultCanary }],
  tools: [{ type: 'function', function: { name: 'synthetic_echo', description: schemaCanary,
    parameters: { type: 'object', properties: { value: { type: 'string', description: schemaCanary } }, required: ['value'] } } }],
  tool_choice: { type: 'function', function: { name: 'synthetic_echo' } }, parallel_tool_calls: false, stream_options: { include_usage: true }, chat_template_kwargs: { enable_thinking: false } });
const requestBytes = Buffer.from('synthetic encrypted request identity');
const signature = (request, response, key = modelKey) => {
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const text = `${profile.model}:${hash(request)}:${hash(response)}`;
  const digest = keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${text.length}`), Buffer.from(text)]));
  const recovered = secp256k1.sign(digest, key.getPrivateKey(), { prehash: false, format: 'recovered' });
  return { signing_algo: 'ecdsa', signature_kind: 'provider_tee', text,
    signature: '0x' + Buffer.concat([Buffer.from(recovered.subarray(1)), Buffer.from([recovered[0] + 27])]).toString('hex') };
};
const sse = (chunks, suffix = 'data: [DONE]\n\n') => Buffer.from(chunks.map(chunk => `data:${JSON.stringify({ id: 'synthetic_chat', model: profile.model, choices: [{ index: 0, ...chunk }] })}\n\n`).join('') + suffix);
const response = () => sse([
  { delta: { reasoning_content: seal('synthetic reasoning'), tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: seal('synthetic_'), arguments: seal('{"value":') } }] } },
  { delta: { tool_calls: [{ index: 0, function: { name: seal('echo'), arguments: seal('"synthetic-result"}') } }] }, finish_reason: 'tool_calls' },
]);
const authenticate = (bytes, sig = signature(requestBytes, bytes), extra = {}) => authenticateNearNativeResponse({ bytes, requestBytes, profile, clientKey, getSignature: async () => sig, ...extra });

test('all sensitive request fields are encrypted and round-trip, including schemas and history', () => {
  const original = body(), encoded = encryptNearNativeRequest(original, modelKey.getPublicKey('hex'));
  const wire = JSON.stringify(encoded);
  for (const canary of [schemaCanary, promptCanary, argumentCanary, resultCanary, 'synthetic_echo']) assert.ok(!wire.includes(canary));
  assert.equal(decrypt(encoded.messages[0].content, modelKey), promptCanary);
  assert.equal(decrypt(encoded.messages[2].tool_calls[0].function.arguments, modelKey), original.messages[2].tool_calls[0].function.arguments);
  assert.equal(decrypt(encoded.messages[2].reasoning_content, modelKey), promptCanary);
  assert.equal(decrypt(encoded.messages[2].refusal, modelKey), promptCanary);
  assert.equal(decrypt(encoded.messages[3].content, modelKey), resultCanary);
  assert.equal(decrypt(encoded.messages[3].name, modelKey), 'synthetic_echo');
  assert.deepEqual(JSON.parse(decrypt(encoded.tools[0].function.parameters, modelKey)), original.tools[0].function.parameters);
  assert.equal(decrypt(encoded.tools[0].function.description, modelKey), schemaCanary);
  assert.equal(decrypt(encoded.tool_choice.function.name, modelKey), 'synthetic_echo');
  assert.equal(encoded.messages[3].tool_call_id, 'call_1');
  assert.equal(original.messages[0].content, promptCanary, 'caller history is not mutated');
});

test('unsupported legacy, multimodal, structured-output and server-side tools refuse before a request', () => {
  for (const changed of [
    { ...body(), functions: [{ name: schemaCanary }] }, { ...body(), response_format: { schema: schemaCanary } },
    { ...body(), logprobs: true }, { ...body(), tools: [{ type: 'web_context_search' }] },
    { ...body(), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: schemaCanary } }] }] },
    { ...body(), messages: [{ role: 'assistant', function_call: { arguments: argumentCanary } }] },
  ]) assert.throws(() => encryptNearNativeRequest(changed, modelKey.getPublicKey('hex')));
});

test('both protocol headers are explicit; version alone is not the all-fields switch', () => {
  const headers = nearNativeHeaders(clientKey.getPublicKey('hex'), modelKey.getPublicKey('hex'));
  assert.equal(headers['X-Encrypt-All-Fields'], 'true'); assert.equal(headers['X-Encryption-Version'], '2');
  assert.equal(headers['X-Client-Pub-Key'].length, 128);
});

test('a genuine attested-model signature releases complete encrypted tool fragments', async () => {
  const result = await authenticate(response());
  assert.equal(result.calls[0].function.name, 'synthetic_echo');
  assert.deepEqual(JSON.parse(result.calls[0].function.arguments), { value: 'synthetic-result' });
  assert.equal(result.reasoning, 'synthetic reasoning');
});

test('a gateway signature, another signer, changed request or edited reply cannot release tools', async () => {
  const bytes = response(), sig = signature(requestBytes, bytes), other = crypto.createECDH('secp256k1'); other.generateKeys();
  for (const [value, proof, extra] of [
    [bytes, { ...sig, signature_kind: 'gateway' }, {}], [bytes, signature(requestBytes, bytes, other), {}],
    [bytes, sig, { requestBytes: Buffer.from('another request') }],
    [Buffer.from(bytes.toString().replace('call_1', 'call_2')), sig, {}],
  ]) await assert.rejects(authenticate(value, proof, extra));
});

test('ciphertext created by anyone for the public client key still needs model authentication', async () => {
  const forged = sse([{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: seal('synthetic_echo'), arguments: seal('{"value":"forged"}') } }] }, finish_reason: 'tool_calls' }]);
  await assert.rejects(authenticate(forged, signature(requestBytes, response())));
});

test('plaintext and corrupt ciphertext are refused even if the model signs them', async () => {
  for (const name of ['synthetic_echo', '00'.repeat(100)]) {
    const bytes = sse([{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: seal('{}') } }] }, finish_reason: 'tool_calls' }]);
    await assert.rejects(authenticate(bytes));
  }
});

test('truncated streams, changed chat IDs, duplicate DONE and post-finish data refuse', async () => {
  const bytes = response();
  for (const bad of [bytes.subarray(0, bytes.length - 2), Buffer.from(bytes.toString().replace('data: [DONE]\n\n', '')), Buffer.from(bytes.toString().replace('data: [DONE]\n\n', 'data: [DONE]\n\ndata: [DONE]\n\n')), Buffer.from(bytes.toString().replace('data: [DONE]', 'data: {"id":"another","choices":[]}\n\ndata: [DONE]'))]) {
    await assert.rejects(authenticate(bad));
  }
});

test('length truncation and invalid argument JSON never release an executable call', async () => {
  for (const reason of ['length', 'tool_calls']) {
    const bytes = sse([{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: seal('synthetic_echo'), arguments: seal('{"unfinished":') } }] }, finish_reason: reason }]);
    await assert.rejects(authenticate(bytes));
  }
});

test('the exact unsigned keepalive frame is excluded without altering signed JSON', async () => {
  const bytes = response(), padded = Buffer.concat([Buffer.from(': keep-alive\n\n'), bytes]);
  const result = await authenticate(padded, signature(requestBytes, bytes));
  assert.equal(result.calls.length, 1);
  const injected = Buffer.concat([Buffer.from(': keep-alive with payload\n\n'), bytes]);
  await assert.rejects(authenticate(injected, signature(requestBytes, bytes)));
});

test('SGLang numeric stop-token metadata is allowed; plaintext stop strings are refused', async () => {
  const valid = sse([{ delta: { content: seal('synthetic answer') }, finish_reason: 'stop', matched_stop: 154829 }]);
  assert.equal((await authenticate(valid)).content, 'synthetic answer');
  const invalid = sse([{ delta: { content: seal('synthetic answer') }, finish_reason: 'stop', matched_stop: 'synthetic-sensitive-stop' }]);
  await assert.rejects(authenticate(invalid));
});

test('actual Pi accepts authenticated native calls and encrypts its tool-result history', async () => {
  const { streamSimple } = await import('../vendor/pi/packages/ai/dist/api/openai-completions.js');
  const model = { id: profile.model, name: 'Synthetic', provider: 'nearai', api: 'openai-completions', baseUrl: 'http://synthetic.invalid/v1',
    reasoning: false, input: ['text'], compat: NEAR_NATIVE_PI_COMPAT, contextWindow: 4096, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const context = { messages: [{ role: 'system', content: 'Synthetic tool qualification.', timestamp: 0, toolsAdded: [{ name: 'synthetic_echo', description: schemaCanary, parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }] },
    { role: 'user', content: promptCanary, timestamp: Date.now() }] };
  const wires = []; let encodeFailure = null;
  const fetch = async (_url, init) => {
    const input = JSON.parse(init.body); let outgoing;
    try { outgoing = encryptNearNativeRequest(input, modelKey.getPublicKey('hex')); }
    catch (error) { encodeFailure = { code: error.code, keys: Object.keys(input), messageKeys: input.messages.map(m => Object.keys(m)), functionKeys: input.tools?.map(t => Object.keys(t.function)) }; throw error; }
    const request = JSON.stringify(outgoing); wires.push(request);
    for (const secret of [promptCanary, schemaCanary, resultCanary, 'synthetic_echo']) assert.ok(!request.includes(secret));
    const bytes = response(), sig = signature(request, bytes);
    const verified = await authenticateNearNativeResponse({ bytes, requestBytes: request, profile, clientKey, getSignature: async () => sig });
    const decoded = authenticatedNearNativeSse(verified);
    return new Response(decoded, { headers: { 'content-type': 'text/event-stream' } });
  };
  const reply = await streamSimple(model, context, { apiKey: 'synthetic', maxTokens: 128, fetch }).result();
  assert.equal(encodeFailure, null, JSON.stringify(encodeFailure));
  assert.equal(reply.stopReason, 'toolUse', reply.errorMessage);
  const call = reply.content.find(part => part.type === 'toolCall');
  assert.equal(call.name, 'synthetic_echo'); assert.deepEqual(call.arguments, { value: 'synthetic-result' });
  context.messages.push(reply, { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: resultCanary }], isError: false, timestamp: Date.now() });
  const second = await streamSimple(model, context, { apiKey: 'synthetic', maxTokens: 128, fetch }).result();
  assert.equal(encodeFailure, null, JSON.stringify(encodeFailure));
  assert.equal(second.stopReason, 'toolUse', second.errorMessage);
  assert.equal(wires.length, 2);
});

test('only immutable authenticated results can be released to the native tool parser', async () => {
  assert.throws(() => authenticatedNearNativeSse({ calls: [] }), /unauthenticated_result/);
  const verified = await authenticate(response());
  assert.throws(() => { verified.calls[0].function.name = 'another_tool'; }, TypeError);
  const altered = structuredClone(profile), bytes = response(), other = crypto.createECDH('secp256k1'); other.generateKeys();
  await assert.rejects(authenticateNearNativeResponse({ bytes, requestBytes, profile: altered, clientKey,
    getSignature: async () => { altered.model_signing_address = address(other); return signature(requestBytes, bytes, other); } }));
});

test('public metadata cannot contain unexpected plaintext payload fields', async () => {
  for (const added of [{ usage: { prompt_tokens: 1, private_text: 'synthetic secret' } }, { created: 'synthetic secret' }, { object: 'synthetic secret' }]) {
    const valid = sse([{ delta: { content: seal('synthetic answer') }, finish_reason: 'stop' }]);
    const event = JSON.parse(valid.toString().split('\n')[0].slice(5)); Object.assign(event, added);
    const bytes = Buffer.from(`data:${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
    await assert.rejects(authenticate(bytes));
  }
});

test('a model signature cannot prove input origin when a trusted gateway supplies the claimed hash', async () => {
  // Expected protocol limitation, not a deployed exploit. The reviewed server
  // lets config.token callers override request_hash with X-Request-Hash.
  // The signature alone cannot distinguish its own wire hash from that claim.
  const differentModelInput = Buffer.from('synthetic gateway-selected model input');
  assert.notDeepEqual(differentModelInput, requestBytes);
  const reply = sse([{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function',
    function: { name: seal('synthetic_echo'), arguments: seal('{"value":"gateway-selected"}') } }] }, finish_reason: 'tool_calls' }]);
  const genuineModelSignature = signature(requestBytes, reply);
  const result = await authenticate(reply, genuineModelSignature);
  assert.equal(JSON.parse(result.calls[0].function.arguments).value, 'gateway-selected');
});
