import { digest, utf8, unhex, replyKey, verifySignature } from './crypto.mjs';
import { encryptRequest, decryptChunk } from './codec.mjs';

const MAX_BUFFER = 8 * 1024 * 1024;
const bounded = (value, fallback) => {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_BUFFER) throw new Error('invalid buffer bound');
  return value;
};
function hash(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('unknown code measurement'); return value; }
export function checkAdmission(admission, policy, model, now = Date.now()) {
  // This module does not authenticate hardware evidence. Only pass an assessment
  // produced by a separately reviewed DCAP/NRAS verifier, never raw provider JSON.
  if (!admission || !policy || typeof policy.id !== 'string' || !policy.id || !Number.isFinite(now)) throw new Error('explicit code admission policy required');
  for (const field of ['composeHashes', 'osImageHashes']) if (!Array.isArray(policy[field]) || !policy[field].length || !policy[field].every((item) => /^[a-f0-9]{64}$/.test(item))) throw new Error('explicit code hash allowlist required');
  if (admission.model !== model) throw new Error('admitted model mismatch');
  unhex(admission.signingKey, 32);
  if (!policy.composeHashes.includes(hash(admission.composeHash)) || !policy.osImageHashes.includes(hash(admission.osImageHash))) throw new Error('code measurement not admitted');
  if (!Number.isSafeInteger(policy.maxAgeMs) || policy.maxAgeMs <= 0 || !Number.isFinite(admission.verifiedAt) || !Number.isFinite(admission.expiresAt) || admission.verifiedAt > now || now >= admission.expiresAt || now - admission.verifiedAt >= policy.maxAgeMs) throw new Error('admission expired or freshness unknown');
  return Object.freeze({ model, signingKey: admission.signingKey.toLowerCase(), composeHash: admission.composeHash, osImageHash: admission.osImageHash, verifiedAt: admission.verifiedAt, expiresAt: admission.expiresAt, policy: policy.id });
}
export function prepareExchange(request, admission, policy, options = {}) {
  const model = request?.model;
  const assessed = checkAdmission(admission, policy, model, options.now ?? Date.now());
  // Freeze an independent policy snapshot so external mutation cannot relax it.
  const fixedPolicy = Object.freeze({ id: policy.id, maxAgeMs: policy.maxAgeMs, composeHashes: Object.freeze([...policy.composeHashes]), osImageHashes: Object.freeze([...policy.osImageHashes]) });
  const requestLimit = bounded(options.maxRequestBytes, 2 * 1024 * 1024);
  if (utf8(JSON.stringify(request)).length > requestLimit) throw new Error('request buffer exceeded');
  const toolNames = new Set((request.tools ?? []).map((tool) => tool.function?.name));
  if (request.tool_choice === 'none') toolNames.clear();
  else if (request.tool_choice && typeof request.tool_choice === 'object') {
    const selected = request.tool_choice.function?.name;
    if (!toolNames.has(selected)) throw new Error('selected tool not declared');
    toolNames.clear(); toolNames.add(selected);
  }
  const keys = replyKey(); let body;
  try {
    body = utf8(JSON.stringify(encryptRequest(request, assessed.signingKey)));
    if (body.length > requestLimit) throw new Error('request buffer exceeded');
  } catch (error) { keys.secret.fill(0); throw error; }
  const headers = Object.freeze({ 'x-signing-algo': 'ed25519', 'x-client-pub-key': keys.publicKey, 'x-model-pub-key': assessed.signingKey, 'x-encryption-version': '2', 'x-encrypt-all-fields': 'true' });
  let consumed = false;
  return Object.freeze({ get body() { return Uint8Array.from(body); }, headers, admission: assessed,
    close() { consumed = true; keys.secret.fill(0); },
    async complete(stream, proof, completion = {}) {
      if (consumed) throw new Error('exchange already consumed');
      consumed = true;
      try {
        checkAdmission(assessed, fixedPolicy, model, completion.now ?? Date.now());
        const raw = await collect(stream, bounded(completion.maxResponseBytes, 2 * 1024 * 1024), completion.signal);
        // A proof resolver receives only the two digests, not any plaintext or keys.
        const expected = `${assessed.model}:${digest(body)}:${digest(raw)}`;
        const signed = typeof proof === 'function' ? await abortable(proof(Object.freeze({ model, requestSha256: digest(body), responseSha256: digest(raw) })), completion.signal) : proof;
        completion.signal?.throwIfAborted();
        checkAdmission(assessed, fixedPolicy, model, completion.now ?? Date.now());
        if (!signed || signed.signature_kind !== 'provider_tee' || signed.signing_algo !== 'ed25519' || signed.text !== expected || typeof signed.signing_address !== 'string' || signed.signing_address.replace(/^0x/, '').toLowerCase() !== assessed.signingKey) throw new Error('exact exchange proof required');
        if (!verifySignature(signed.signature?.replace(/^0x/, ''), expected, assessed.signingKey)) throw new Error('invalid exchange signature');
        const chunks = parseStream(raw, keys.secret, model, toolNames);
        // No plaintext stream (including tools) is exposed until every check passes.
        return Object.freeze({ sse: utf8(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'), requestSha256: digest(body), responseSha256: digest(raw), policy: assessed.policy });
      } finally { keys.secret.fill(0); }
    },
  });
}
async function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function collect(stream, limit, signal) {
  if (!stream || typeof stream.getReader !== 'function') throw new Error('response stream required');
  const reader = stream.getReader(), chunks = []; let size = 0, finished = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    for (;;) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) { finished = true; return Buffer.concat(chunks); }
      if (!(value instanceof Uint8Array)) throw new Error('byte stream required');
      size += value.length;
      if (size > limit) throw new Error('response buffer exceeded');
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function parseStream(raw, secret, expectedModel, toolNames) {
  let source = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  // Require fully framed SSE; do not silently accept an unframed EOF fragment.
  if (!source.endsWith('\n\n') && !source.endsWith('\r\n\r\n')) throw new Error('incomplete SSE framing');
  source = source.replace(/\r\n/g, '\n');
  const chunks = [], calls = new Map(); let done = false, finish = null, model = null;
  for (const event of source.split('\n\n')) {
    if (!event) continue;
    const lines = event.split('\n');
    if (lines.every((line) => line.startsWith(':'))) continue;
    if (lines.length !== 1 || !lines[0].startsWith('data:')) throw new Error('unsupported SSE event');
    if (done) throw new Error('data after DONE');
    const data = lines[0].slice(5).trim();
    if (data === '[DONE]') { done = true; continue; }
    const chunk = decryptChunk(JSON.parse(data), secret);
    if (chunk.model) { if (chunk.model !== expectedModel) throw new Error('response model mismatch'); if (model && chunk.model !== model) throw new Error('response model changed'); model = chunk.model; }
    for (const choice of chunk.choices) {
      if (finish !== null) throw new Error('choice after finish');
      const delta = choice.delta ?? {};
      for (const item of delta.tool_calls ?? []) {
        if (!Number.isSafeInteger(item.index)) throw new Error('tool delta index required');
        const old = calls.get(item.index) ?? { name: '', arguments: '', id: null };
        if (item.id) { if (old.id && old.id !== item.id) throw new Error('tool id changed'); old.id = item.id; }
        old.name += item.function?.name ?? ''; old.arguments += item.function?.arguments ?? '';
        calls.set(item.index, old);
      }
      if (choice.finish_reason != null) finish = choice.finish_reason;
    }
    chunks.push(chunk);
  }
  if (!done || !['stop', 'tool_calls'].includes(finish)) throw new Error('incomplete or refused model response');
  if (calls.size && finish !== 'tool_calls') throw new Error('incomplete tool turn');
  if (finish === 'tool_calls' && !calls.size) throw new Error('tool finish without calls');
  const ids = new Set();
  for (const call of calls.values()) {
    if (!call.id || ids.has(call.id) || !call.name || !call.arguments) throw new Error('incomplete tool call');
    if (!toolNames.has(call.name)) throw new Error('undeclared tool request');
    ids.add(call.id);
    const args = JSON.parse(call.arguments);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('tool arguments must be an object');
  }
  return chunks;
}
