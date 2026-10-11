import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { extensionConnection } from '../lib/browser-extension.mjs';

let socket, commands = [];
const connection = await extensionConnection({ timeout: 3000, onPairing: async link => {
  const url = new URL(link), endpoint = url.searchParams.get('mcpRelayUrl');
  assert.equal(url.searchParams.get('protocolVersion'), '2');
  assert.equal(url.searchParams.has('token'), false);
  // An unpaired web page cannot claim the relay, even with the URL.
  const denied = new WebSocket(endpoint, { origin: 'https://example.com' });
  await new Promise(resolve => denied.on('error', resolve));
  socket = new WebSocket(endpoint, { origin: `${url.protocol}//${url.host}` });
  socket.on('error', error => { throw error; });
  socket.on('message', bytes => {
    const m = JSON.parse(bytes); commands.push(m);
    const result = m.method === 'chrome.debugger.sendCommand' && m.params[1] === 'Target.getTargetInfo'
      ? { targetInfo: { targetId: 'selected-target', type: 'page', title: 'Fixture', url: 'http://localhost/mail' } } : {};
    socket.send(JSON.stringify({ id: m.id, result }));
  });
  await new Promise(resolve => socket.on('open', resolve));
  socket.send(JSON.stringify({ method: 'chrome.tabs.onCreated', params: [{ id: 7 }] }));
  socket.send(JSON.stringify({ method: 'extension.initialized', params: [] }));
} });
assert.equal((await connection.send('Target.getTargets')).targetInfos.length, 1);
assert.deepEqual(await connection.send('Target.attachToTarget', { targetId: 'selected-target' }), { sessionId: 'abalone-extension' });
await assert.rejects(connection.send('Target.attachToTarget', { targetId: 'other-target' }), /selected/);
await assert.rejects(connection.send('Target.createTarget', { url: 'http://example.com' }), /Unsupported/);
socket.send(JSON.stringify({ method: 'chrome.tabs.onCreated', params: [{ id: 8 }] }));
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(commands.filter(m => m.method === 'chrome.debugger.attach').length, 1);
const event = new Promise(resolve => connection.events.add(resolve));
socket.send(JSON.stringify({ method: 'chrome.debugger.onEvent', params: [{ tabId: 8 }, 'Page.frameNavigated', {}] }));
socket.send(JSON.stringify({ method: 'chrome.debugger.onEvent', params: [{ tabId: 7 }, 'Page.frameNavigated', { frame: { id: 'selected-target' } }] }));
assert.equal((await event).params.frame.id, 'selected-target');
await connection.send('Fetch.enable', { patterns: [] }, 'abalone-extension');
assert.equal(commands.at(-1).params[0].tabId, 7);
await connection.send('Target.detachFromTarget', { sessionId: 'abalone-extension' });
await assert.rejects(connection.send('Page.enable', {}, 'abalone-extension'), /disconnected/);
console.log('browser-extension: PASS origin refusal, manual pairing, one-tab authority, CDP event filtering, detach refusal');

// Cancelling before approval releases the loopback listener, without another page.
let endpoint;
const abort = new AbortController();
const cancelled = extensionConnection({ timeout: 3000, signal: abort.signal, onPairing: link => {
  endpoint = new URL(link).searchParams.get('mcpRelayUrl'); abort.abort();
} });
await assert.rejects(cancelled, /disconnected before pairing/);
const gone = new WebSocket(endpoint, { origin: 'chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm' });
await new Promise(resolve => gone.on('error', resolve));

// Concurrent browser requests share one approval, and launcher shutdown cancels it.
const fs = await import('node:fs');
const os = await import('node:os');
const dir = fs.mkdtempSync(`${os.tmpdir()}/abalone-pairing-test-`);
const { browserBridge, call } = await import('../lib/browser.mjs');
let opens = 0, finish;
const fake = { events: new Set(), closed: false, close() { this.closed = true; }, async send() { return { targetInfos: [] }; } };
const cleanup = browserBridge(dir, { extensionConnector: () => { opens++; return new Promise(resolve => { finish = resolve; }); } });
try {
  const requests = [call(dir, 'tabs', { identity: { mode: 'extension' } }), call(dir, 'tabs', { identity: { mode: 'extension' } })];
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(opens, 1);
  finish(fake); await Promise.all(requests);
} finally { cleanup(); fs.rmSync(dir, { recursive: true }); }
const dir2 = fs.mkdtempSync(`${os.tmpdir()}/abalone-pairing-test-`);
let cancelledPairing = false;
const cleanup2 = browserBridge(dir2, { extensionConnector: ({ signal }) => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => { cancelledPairing = true; reject(new Error('pairing cancelled')); }, { once: true });
}) });
try {
  const request = call(dir2, 'tabs', { identity: { mode: 'extension' } });
  const rejection = assert.rejects(request, /pairing cancelled/);
  await new Promise(resolve => setTimeout(resolve, 40));
  cleanup2(); await rejection; assert.equal(cancelledPairing, true);
} finally { cleanup2(); fs.rmSync(dir2, { recursive: true }); }
console.log('browser-extension: PASS pairing cancellation, concurrent single approval, shutdown cancellation');
