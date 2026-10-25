// Offline fixture doubles for the portable inference broker tests.
//
// `startLoopbackTee` runs the "endpoint" side of the sealed contract on an
// actual Unix domain socket: it opens request envelopes with its static
// private key, records the decrypted provider requests in memory only, and
// answers with sealed NDJSON response records. Scenario controls exercise the
// failure modes the broker must refuse. `createStubVerifier` provides the
// injected verifier in its admitting and refusing modes. Nothing here is a
// live provider, holds a real credential, or makes any network call beyond
// the loopback Unix sockets the test process creates.
import http from 'node:http';
import crypto from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { generateLoopbackKeyPair, openEnvelope, sealRecord } from './sealed-transport.mjs';

export const sse = objects => objects.map(o => (o === '[DONE]' ? 'data: [DONE]\n' : `data: ${JSON.stringify(o)}\n`)).join('') + '\n';

export const assistantTextDelta = (content, index = 0) => ({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', choices: [{ index, delta: { role: 'assistant', content }, finish_reason: null }] });
export const toolCallDelta = (toolCallId, name, args, index = 0) => ({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', choices: [{ index, delta: { role: 'assistant', tool_calls: [{ index: 0, id: toolCallId, type: 'function', function: { name, arguments: args } }] }, finish_reason: null }] });
export const finishChunk = (finishReason = 'tool_calls', index = 0) => ({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', choices: [{ index, delta: {}, finish_reason: finishReason }] });
export const usageChunk = (promptTokens, completionTokens) => ({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } });

export function createStubVerifier({ mode = 'admitted', release }) {
  const calls = [];
  return {
    calls,
    async verify(context) {
      calls.push(context);
      if (mode === 'hanging') return new Promise(() => {}); // never settles: a stalled verifier gate
      if (mode === 'missing-attestation') return null;
      if (mode === 'throwing') throw new Error('verifier unavailable');
      const measurement = crypto.createHash('sha256').update('fixture-measurement').digest('hex');
      if (mode === 'missing-release') return { admitted: true, measurement };
      if (mode !== 'admitted') throw new Error('unknown verifier mode');
      return { admitted: true, measurement, release: release ?? { keyId: 'loopback-key-v1', publicKeyBase64: 'unset' } };
    },
  };
}

export async function startLoopbackTee({ socketPath, expectedKeyId = 'loopback-key-v1', scenario = 'ok', script, chunkDelayMs = 0, stallAfterConnect = false }) {
  if (!isAbsolute(socketPath)) throw new Error('socketPath must be absolute');
  const pair = generateLoopbackKeyPair();
  const state = { posts: 0, recorded: [], backpressure: { writesReturnedFalse: 0, slowestDrainMs: 0 }, aborted: 0, oversizeBytesSent: 0 };
  const release = { keyId: expectedKeyId, publicKeyBase64: pair.publicKeyBase64 };
  // Every timer this fixture owns is tracked so stop() can cancel it; a
  // held-open scenario must never leave a 60s stall or a delayed-chunk pump
  // alive after the fixture is torn down.
  const timers = new Set();
  const later = (fn, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
    return timer;
  };

  const serve = async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    state.posts += 1;
    req.on('aborted', () => { state.aborted += 1; });
    let opened;
    try {
      opened = openEnvelope(pair.privateKey, Buffer.concat(chunks));
    } catch {
      res.writeHead(400).end();
      return;
    }
    const request = JSON.parse(opened.plaintext.toString('utf8'));
    state.recorded.push({ keyId: opened.keyId, headers: request.headers, body: request.body });

    if (scenario === 'key-mismatch') { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'key-mismatch' } })); return; }
    if (scenario === 'redirect') { res.writeHead(302, { location: 'https://example.invalid/v1/chat/completions' }); res.end(); return; }
    if (scenario === 'drop-after-transmit') { later(() => { try { res.destroy(); res.socket?.destroy(); } catch {} }, 30); return; }
    if (scenario === 'unsealed-response') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end('this line is plaintext, not a sealed record\n');
      return;
    }
    if (scenario === 'oversize') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const filler = Buffer.from('x'.repeat(8192));
      const record = sealRecord(opened.key, filler);
      let sent = 0;
      const pump = () => {
        while (sent < 1 << 20) {
          sent += record.length + 1;
          state.oversizeBytesSent = sent;
          if (res.write(record + '\n')) { if (sent % (8192 * 64) === 0) later(pump, 5); continue; }
          res.once('drain', pump);
          return;
        }
        res.end();
      };
      pump();
      return;
    }

    // scenario 'ok': a script returns the SSE transcript for this round.
    const rounds = state.recorded.filter(r => r).length;
    const transcript = typeof script === 'function' ? script(request.body, rounds, request) : script;
    if (typeof transcript !== 'string' || transcript.length === 0) { res.writeHead(500).end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const lines = transcript.split('\n').filter(line => line.length > 0);
    let index = 0;
    const sendNext = () => {
      if (index >= lines.length) { res.end(); return; }
      const line = lines[index++];
      const began = Date.now();
      const flowing = res.write(sealRecord(opened.key, Buffer.from(line + '\n', 'utf8')) + '\n');
      if (!flowing) {
        state.backpressure.writesReturnedFalse += 1;
        res.once('drain', () => {
          state.backpressure.slowestDrainMs = Math.max(state.backpressure.slowestDrainMs, Date.now() - began);
          if (chunkDelayMs > 0) later(sendNext, chunkDelayMs); else sendNext();
        });
        return;
      }
      if (chunkDelayMs > 0) later(sendNext, chunkDelayMs); else sendNext();
    };
    if (stallAfterConnect && (stallAfterConnect !== 'first' || rounds === 1)) { later(sendNext, 60000); return; }
    sendNext();
  };

  const server = http.createServer(serve);
  const clients = new Set();
  server.on('connection', socket => { clients.add(socket); socket.on('close', () => clients.delete(socket)); });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(socketPath, resolvePromise);
  });
  return {
    socketPath, release, state,
    stop: async () => {
      // Cancel every owned timer first, then destroy the tracked connections
      // BEFORE awaiting server.close(): an active held-open socket would
      // otherwise keep the close callback pending forever.
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const socket of clients) socket.destroy();
      clients.clear();
      await new Promise(resolvePromise => server.close(() => resolvePromise()));
      await unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    },
  };
}
