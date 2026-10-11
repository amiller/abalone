// Research adapter for Playwright extension 0.4.0, relay protocol 2.
// This speaks its internal Chrome-method relay, not Playwright MCP. The existing
// Abalone bridge still owns the grant, CDP actions and Fetch interception.
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

const EXTENSION_ID = 'mmlmfjhmonkocbjadbfplnigmagldckm';
export async function extensionConnection({ opener = process.env.ABALONE_BROWSER_EXTENSION_OPENER ?? 'xdg-open', timeout = 120000, onPairing, signal } = {}) {
  const events = new Set(), pending = new Map();
  let timer;
  let socket, tabId, target, initialized = false, sequence = 0, settled = false;
  let accept, refuse;
  const ready = new Promise((resolve, reject) => { accept = resolve; refuse = reject; });
  ready.catch(() => {}); // Pairing/open failure can precede awaiting the handshake.
  const secretPath = `/extension/${crypto.randomBytes(24).toString('hex')}`;
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const connection = { events, closed: false, product: 'Chromium · Playwright extension protocol 2', close, send };
  function close() {
    if (connection.closed) return;
    connection.closed = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', close);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Browser extension disconnected')); }
    pending.clear();
    socket?.close(1000, 'Abalone disconnected');
    wss.close(); server.close();
    if (!settled) { settled = true; refuse(new Error('Browser extension disconnected before pairing')); }
    for (const listener of events) listener({ method: 'closed' });
  }
  function command(method, params) {
    if (!socket || socket.readyState !== 1 || connection.closed) return Promise.reject(new Error('Browser extension disconnected'));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser extension command timed out: ${method}`)); }, 20000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  const cdp = (method, params = {}) => command('chrome.debugger.sendCommand', [{ tabId }, method, params]);
  function maybeReady() { if (initialized && target && !settled) { settled = true; clearTimeout(timer); accept(connection); } }
  async function message(data) {
    const m = JSON.parse(String(data));
    if (m.id !== undefined) {
      const p = pending.get(m.id); if (!p) return;
      pending.delete(m.id); clearTimeout(p.timer);
      m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      return;
    }
    if (m.method === 'extension.initialized') { initialized = true; maybeReady(); }
    if (m.method === 'chrome.tabs.onCreated') {
      const tab = m.params?.[0];
      if (tabId !== undefined) return; // Never attach a popup or a dragged-in second tab.
      if (!Number.isSafeInteger(tab?.id)) throw new Error('Invalid selected browser tab');
      tabId = tab.id;
      await command('chrome.debugger.attach', [{ tabId }, '1.3']);
      target = (await cdp('Target.getTargetInfo')).targetInfo;
      if (!target?.targetId || target.type !== 'page') throw new Error('Extension did not select a page target');
      maybeReady();
    }
    if (m.method === 'chrome.debugger.onDetach' && m.params?.[0]?.tabId === tabId) close();
    if (m.method === 'chrome.debugger.onEvent' && m.params?.[0]?.tabId === tabId) {
      const [source, method, params] = m.params;
      if (source.sessionId) return; // No child-target authority in this prototype.
      for (const listener of events) listener({ method, params, sessionId: 'abalone-extension' });
    }
  }
  async function send(method, params = {}, sessionId) {
    if (connection.closed) throw new Error('Browser extension disconnected');
    if (method === 'Browser.getVersion') return { product: connection.product };
    if (method === 'Target.getTargets') { target = (await cdp('Target.getTargetInfo')).targetInfo; return { targetInfos: [target] }; }
    if (method === 'Target.attachToTarget') {
      if (params.targetId !== target?.targetId) throw new Error('Only the selected extension tab may be attached');
      return { sessionId: 'abalone-extension' };
    }
    if (method === 'Target.detachFromTarget') {
      if (params.sessionId !== 'abalone-extension') throw new Error('Unknown browser session');
      await cdp('Fetch.disable'); close(); return {};
    }
    if (sessionId !== 'abalone-extension') throw new Error(`Unsupported extension browser command: ${method}`);
    return cdp(method, params);
  }
  server.on('upgrade', (req, stream, head) => {
    if (socket || req.url !== secretPath || req.headers.origin !== `chrome-extension://${EXTENSION_ID}`) { stream.destroy(); return; }
    wss.handleUpgrade(req, stream, head, ws => {
      socket = ws;
      ws.on('message', data => { message(data).catch(() => close()); });
      ws.on('close', close); ws.on('error', close);
    });
  });
  timer = setTimeout(close, timeout);
  signal?.addEventListener('abort', close, { once: true });
  try {
    if (signal?.aborted) { close(); return await ready; }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    if (connection.closed) return await ready;
    const url = new URL(`chrome-extension://${EXTENSION_ID}/connect.html`);
    url.searchParams.set('mcpRelayUrl', `ws://127.0.0.1:${server.address().port}${secretPath}`);
    url.searchParams.set('client', JSON.stringify({ name: 'Abalone research bridge' }));
    url.searchParams.set('protocolVersion', '2');
    if (onPairing) await onPairing(url.href);
    else {
      const child = spawn(opener, [url.href], { stdio: 'ignore' });
      child.once('error', close);
      child.once('exit', code => { if (code) close(); });
    }
    return await ready;
  } catch (error) { close(); throw error; }
}
