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
