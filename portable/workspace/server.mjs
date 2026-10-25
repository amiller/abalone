import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAgentManager } from './agent-manager.mjs';
import { createTerminalManager } from './terminal-manager.mjs';
import { createCreditClient, validateCredit, unknownCredit } from './credit-client.mjs';
import { readDesktopStatus } from './desktop-status.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentScriptKeys = ['toolName', 'path', 'content', 'finalText', 'reportEnv', 'slow', 'flood', 'hang', 'proofPath', 'proofContent', 'oversize', 'revive', 'doneThenHang', 'doneThenExit', 'doneThenExit0', 'doneThenAbort', 'exitDelayMs', 'exit0NoDone'];

// Creates the workspace HTTP server.
//
// Two explicit execution authorities — there is no implicit fallback
// between them:
//
// - Direct mode (development): pass `agentManager`/`terminalManager` (or
//   neither to get the default local managers). The server process itself
//   spawns the PTYs and SDK workers with its own account authority. The CLI
//   requires --direct for this and prints a loud warning; it is the
//   disposable developer path, never the production one.
//
// - Service mode (production): pass `backend` (a backend client for the
//   separate portable-agent service, portable/workspace-service/). The
//   server owns no PTY and no worker process at all; if the backend is
//   absent or refuses, every terminal/agent operation fails closed with
//   503 and the status endpoint reports it — the server NEVER falls back
//   to spawning anything itself.
//
// Both modes keep the identical loopback origin/Host checks, Fetch
// Metadata and token+JSON mutation gates, bounded request bodies and the
// static-file allowlist.
export async function createWorkspaceServer({ workspace, port = 0, agentManager, terminalManager, backend, creditSocket = null, creditProjection = null, readDesktopProjection = readDesktopStatus }) {
  if (!workspace || !path.isAbsolute(workspace)) throw new Error('An explicit absolute disposable workspace is required');
  // The backend owns workspace storage. Its absence must not prevent the
  // unprivileged status page from appearing during startup or recovery.
  const root = backend ? path.resolve(workspace) : await fs.realpath(workspace);
  if (root === '/' || (!backend && !(await fs.stat(root)).isDirectory())) throw new Error('Workspace must be a directory other than /');
  const token = crypto.randomBytes(32).toString('hex');
  const terminals = terminalManager ?? (!backend ? createTerminalManager({ workspace: root }) : null);
  const agents = agentManager ?? (!backend ? createAgentManager({ workspace: root }) : null);
  if (backend && (agentManager || terminalManager)) throw new Error('Pass either a backend (service mode) or local managers (direct mode), not both');
  if ((creditSocket !== null || creditProjection !== null) && !backend) throw new Error('Credit projection requires service mode');
  if (creditProjection && (creditSocket !== null || typeof creditProjection.status !== 'function' || typeof creditProjection.close !== 'function')) throw new Error('Invalid credit projection');
  // Trusted constructor seam only; never selected by an HTTP request or CLI flag.
  if (typeof readDesktopProjection !== 'function') throw new Error('Invalid desktop projection');
  const creditClient = creditProjection || createCreditClient({socketPath:creditSocket});
  async function readCredit() {
    let timer;
    try {
      const value = await Promise.race([Promise.resolve().then(()=>creditClient.status()),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Credit deadline')),1500);})]);
      // creditClient.status() already returns the lease remaining AFTER its own
      // read latency; timestamp that resolution so the caller deducts only the
      // wait that happens afterwards, never the credit read a second time.
      return {credit: creditProjection ? validateCredit(value) : value, observedAt: performance.now()};
    } catch { return {credit: unknownCredit('unavailable'), observedAt: performance.now()}; } finally { clearTimeout(timer); }
  }
  let origin;
  const send = (res, code, data) => { res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(data)); };
  const body = async req => {
    let value = '';
    for await (const chunk of req) { value += chunk; if (Buffer.byteLength(value) > 16384) throw new Error('Request too large'); }
    return JSON.parse(value || '{}');
  };

  // ---- Service-mode adapters: backend errors map to the same HTTP
  // responses direct mode produces; a backend that is absent, down or
  // refusing makes every mutation fail closed. Never a local spawn.
  const backendError = (res, error) => {
    if (error && error.ipcError) {
      const code = error.code;
      if (code === 'not_found') return send(res, 404, {error: error.message.includes('Agent') ? 'Agent run not found' : 'Terminal not found'});
      if (code === 'capacity') return send(res, 409, {error: error.message});
      if (code === 'busy') return send(res, 409, {error: 'Terminal is closed or busy'});
      if (code === 'closing') return send(res, 503, {error: 'Agent manager is closing', detail: error.message});
      if (code === 'invalid_request') return send(res, 400, {error: error.message});
      if (code === 'not-ready') return send(res, 503, {error:'Agent not ready',code:'not-ready',detail:error.message});
      if (code === 'unavailable') return send(res, 503, {error: 'Agent SDK unavailable', detail: error.message});
      return send(res, 503, {error: 'Agent backend error', detail: error.message});
    }
    return send(res, 503, {error: 'Agent backend unavailable', detail: error instanceof Error ? error.message : String(error)});
  };
  const requestBackend = async (res, op, params) => {
    try { return await backend.request(op, params); }
    catch (error) { backendError(res, error); return null; }
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      // Host checks prevent DNS rebinding; Origin/Fetch Metadata and token reject cross-site commands.
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, {error:'Origin refused'});
      const url = new URL(req.url, origin);
      if (!['GET', 'HEAD'].includes(req.method)) {
        if (req.headers['x-workspace-token'] !== token || req.headers['content-type'] !== 'application/json') return send(res, 403, {error:'Workspace token and JSON required'});
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        if (backend) {
          // The credit observation is timestamped when readCredit resolves; only
          // the subsequent backend/desktop wait before this HTTP response is
          // deducted from it (the projection's own read latency was already spent).
          const [status, observed] = await Promise.all([backend.request('status').catch(error => ({ unavailable: true, detail: error instanceof Error ? error.message : String(error) })), readCredit()]);
          const desktop = await readDesktopProjection();
          const elapsed = performance.now()-observed.observedAt;
          const remaining = Math.floor(observed.credit.validForMs-elapsed);
          const credit = Number.isFinite(observed.observedAt) && Number.isFinite(elapsed) && elapsed>=0 && Number.isFinite(remaining) && remaining>0 ? {...observed.credit,validForMs:remaining} : unknownCredit(observed.credit.state === 'unconfigured' ? 'unconfigured' : 'unavailable');
          if (status.unavailable) {
            return send(res, 200, { terminalAvailable:false, csrfToken:token, workspace:root, qualification:'service-mode', mode:'service', desktop, credit,
              backend: { available:false, socketPath: backend.socketPath, detail: status.detail },
              agent: { available:false, kind:'missing', detail:'agent backend unavailable' } });
          }
          return send(res, 200, { terminalAvailable: status.terminalAvailable === true, csrfToken:token, workspace:root, qualification:'service-mode', mode:'service', desktop, credit,
            backend: { available:true, socketPath: backend.socketPath, service: status.service, version: status.version },
            agent: status.agent ?? { available:false, kind:'missing', detail:'agent status unknown' } });
        }
        const agent = agents.readiness ? agents.readiness() : await agents.status().catch(error => ({ available: false, kind: 'missing', detail: error.message }));
        return send(res, 200, { terminalAvailable:true, csrfToken:token, workspace:root, qualification:'local-development', mode:'direct', agent });
      }
      if (req.method === 'GET' && ['/api/files','/api/file'].includes(url.pathname)) {
        if (!backend) return send(res, 503, {error:'File browsing requires the separate agent service'});
        if ([...url.searchParams.keys()].some(key=>key!=='path') || url.searchParams.getAll('path').length > 1) return send(res,400,{error:'Invalid file query'});
        const relative = url.searchParams.get('path') ?? '';
        try {
          const reply = await backend.request(url.pathname==='/api/files'?'files.list':'files.read',{path:relative});
          const {rid,ok,...result}=reply;
          return send(res,200,result);
        } catch(error) {
          const code=error.code ?? 'unavailable';
          return send(res,code==='invalid_request'?400:['unsupported','binary','too_large'].includes(code)?422:code==='changed'?409:503,{error:'Workspace files unavailable',code});
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/terminals') {
        if (backend) {
          const reply = await requestBackend(res, 'terminals.list');
          return reply ? send(res, 200, { sessions: reply.sessions }) : undefined;
        }
        return send(res, 200, { sessions: terminals.list() });
      }
      if (req.method === 'POST' && url.pathname === '/api/agents') {
        const { prompt, script } = await body(req);
        if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 8192) return send(res, 400, {error:'Prompt must be a non-empty string of at most 8192 bytes'});
        if (script !== undefined && (typeof script !== 'object' || script === null || Array.isArray(script))) return send(res, 400, {error:'Invalid script'});
        if (script) {
          const keys = Object.keys(script);
          if (keys.length > 6 || keys.some(key => !agentScriptKeys.includes(key) || typeof script[key] !== 'string' || Buffer.byteLength(script[key]) > 2000)) {
            return send(res, 400, {error:'Invalid script fields'});
          }
        }
        if (backend) {
          const status = await requestBackend(res, 'status');
          if (!status) return;
          if (status.agent?.mode === 'broker') {
            const desktop = await readDesktopProjection();
            if (desktop?.tor?.state !== 'bootstrapped' || desktop.tor.progress !== 100 || !Number.isFinite(desktop.validForMs) || desktop.validForMs <= 0) {
              return send(res,503,{error:'Connecting to Tor. Terminals and files remain available.',code:'tor-not-ready'});
            }
          }
          const reply = await requestBackend(res, 'agents.start', { prompt, ...(script ? { script } : {}) });
          return reply ? send(res, 201, { id: reply.id }) : undefined;
        }
        try {
          const readiness = agents.readiness?.();
          if (readiness && !readiness.available) return send(res,503,{error:'Agent not ready',code:'not-ready',detail:readiness.detail});
          const { id } = await agents.start({ prompt, script });
          return send(res, 201, { id });
        } catch (error) {
          if (error.code === 'AGENT_CAPACITY') return send(res, 409, { error: error.message });
          if (error.code === 'AGENT_CLOSING') return send(res, 503, { error: 'Agent manager is closing', detail: error.message });
          return send(res, 503, { error: 'Agent SDK unavailable', detail: error.message });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/agents') {
        if (backend) {
          const reply = await requestBackend(res, 'agents.list');
          return reply ? send(res, 200, { agents: reply.agents }) : undefined;
        }
        return send(res, 200, { agents: agents.list() });
      }
      const agentMatch = /^\/api\/agents\/([a-f0-9-]+)(\/events)?$/.exec(url.pathname);
      if (agentMatch) {
        if (req.method === 'GET' && agentMatch[2] === '/events') {
          if (backend) {
            const after = Number(url.searchParams.get('after') || 0);
            const reply = await requestBackend(res, 'agents.events', { id: agentMatch[1], after });
            return reply ? send(res, 200, reply) : undefined;
          }
          const result = agents.events(agentMatch[1], Number(url.searchParams.get('after') || 0));
          if (!result) return send(res, 404, {error:'Agent run not found'});
          return send(res, 200, result);
        }
        if (req.method === 'DELETE' && agentMatch[2] === undefined) {
          if (backend) {
            const reply = await requestBackend(res, 'agents.stop', { id: agentMatch[1] });
            return reply ? send(res, reply.ok ? 200 : 404, reply.ok ? {ok:true} : {error:'Agent run not found'}) : undefined;
          }
          const removed = await agents.stop(agentMatch[1]);
          return send(res, removed ? 200 : 404, removed ? {ok:true} : {error:'Agent run not found'});
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/terminals') {
        await body(req);
        if (backend) {
          const reply = await requestBackend(res, 'terminals.create');
          return reply ? send(res, 201, {id: reply.id}) : undefined;
        }
        try { const { id } = terminals.create(); return send(res, 201, {id}); }
        catch (error) {
          if (error.code === 'TERMINAL_CAPACITY') return send(res, 409, {error: error.message});
          return send(res, 503, {error: 'Terminal manager is closing', detail: error.message});
        }
      }
      const match = /^\/api\/terminals\/([a-f0-9-]+)(?:\/(input|output))?$/.exec(url.pathname);
      if (match) {
        if (req.method === 'GET' && match[2] === 'output') {
          const after = Number(url.searchParams.get('after') || 0);
          if (!Number.isSafeInteger(after) || after < 0) return send(res, 400, {error:'Invalid offset'});
          if (backend) {
            const reply = await requestBackend(res, 'terminals.output', { id: match[1], after });
            return reply ? send(res, 200, reply) : undefined;
          }
          const terminal = terminals.output(match[1], after);
          if (!terminal) return send(res, 404, {error:'Terminal not found'});
          return send(res, 200, terminal);
        }
        if (req.method === 'POST' && match[2] === 'input') {
          const {input} = await body(req);
          if (typeof input !== 'string' || Buffer.byteLength(input) > 8192) return send(res, 400, {error:'Invalid input'});
          if (backend) {
            const reply = await requestBackend(res, 'terminals.input', { id: match[1], input });
            return reply ? send(res, 200, {ok:true}) : undefined;
          }
          const result = terminals.input(match[1], input);
          if (result.error === 'not_found') return send(res, 404, {error:'Terminal not found'});
          if (result.error === 'invalid_input') return send(res, 400, {error:'Invalid input'});
          if (result.error === 'busy') return send(res, 409, {error:'Terminal is closed or busy'});
          return send(res, 200, {ok:true});
        }
        if (req.method === 'DELETE' && !match[2]) {
          if (backend) {
            const reply = await requestBackend(res, 'terminals.stop', { id: match[1] });
            return reply ? send(res, reply.ok ? 200 : 404, reply.ok ? {ok:true} : {error:'Terminal not found'}) : undefined;
          }
          const removed = await terminals.stop(match[1]);
          return send(res, removed ? 200 : 404, removed ? {ok:true} : {error:'Terminal not found'});
        }
      }
      if (req.method !== 'GET' || url.pathname.startsWith('/api/')) return send(res, 404, {error:'Not found'});
      const names = {'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css','/styles.css':'styles.css'};
      const name = names[url.pathname];
      if (!name) return send(res, 404, {error:'Not found'});
      const data = await fs.readFile(path.join(here, 'ui', name));
      res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
      res.end(data);
    } catch (error) { send(res, error.code === 'ENOENT' ? 404 : 400, {error:error.code === 'ENOENT' ? 'Not found' : 'Request refused'}); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  let closePromise;
  return {origin, close() {
    if (!closePromise) closePromise = Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        ...[creditClient,terminals,agents,backend].filter(Boolean).map(owner=>Promise.resolve().then(()=>owner.close())),
        new Promise(resolve=>{server.closeIdleConnections?.();server.close(resolve);}),
      ]);
      if (results.some(r=>r.status==='rejected')) throw new Error('Workspace cleanup failed');
    });
    return closePromise;
  }};
}

function usage(code = 2) {
  process.stderr.write([
    'Usage: node server.mjs --workspace DIR (--direct | --backend SOCK [--backend-uid UID]) [--port 8765]',
    '',
    '  --direct       disposable DEVELOPER mode: this process itself spawns the',
    '                 terminal PTYs and agent workers with YOUR account authority.',
    '                 The workspace is not a sandbox; use a disposable directory.',
    '  --backend      production/service mode: proxy terminals and agent runs to the',
    '                 separate portable-agent service (see portable/workspace-service).',
    '  --credit-socket optional trusted read-only UID972 credit projection socket.',
    '  --backend-uid  numeric uid that must own the backend socket (fail closed).',
    '',
    'Exactly one execution mode is required: the server never falls back from a',
    'missing backend to direct spawning, and direct mode is always explicit.',
  ].join('\n') + '\n');
  process.exit(code);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) usage(0);
  const workspace = args[args.indexOf('--workspace') + 1];
  if (!args.includes('--workspace')) throw new Error('Usage: node server.mjs --workspace /absolute/disposable/folder (--direct | --backend SOCK) [--port 8765]');
  const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 8765;
  const direct = args.includes('--direct');
  const backendIndex = args.indexOf('--backend');
  const backendPath = backendIndex >= 0 ? args[backendIndex + 1] : null;
  if ((!direct && !backendPath) || (direct && backendPath)) usage(2);
  let backend = null;
  if (backendPath) {
    const { createBackendClient } = await import('../workspace-service/backend-client.mjs');
    const uidIndex = args.indexOf('--backend-uid');
    const userIndex = args.indexOf('--backend-user');
    if ((uidIndex >= 0) === (userIndex >= 0)) throw new Error('Service mode requires exactly one --backend-uid or --backend-user');
    const { resolveUid } = await import('../workspace-service/syscred.mjs');
    const identity = args[(uidIndex >= 0 ? uidIndex : userIndex) + 1];
    if (!identity || identity.startsWith('--')) throw new Error('Missing backend identity');
    if (uidIndex >= 0 && !/^\d+$/.test(identity)) throw new Error('Invalid backend uid');
    const backendUid = await resolveUid(identity);
    if (!Number.isSafeInteger(backendUid) || backendUid < 0) throw new Error('Invalid backend uid');
    backend = createBackendClient({ socketPath: backendPath, expectedSocketUid: backendUid });
  }
  const creditIndex = args.indexOf('--credit-socket');
  const creditSocket = creditIndex < 0 ? null : args[creditIndex+1];
  if (creditIndex >= 0 && (!creditSocket || creditSocket.startsWith('--'))) throw new Error('Missing credit socket');
  const app = await createWorkspaceServer({workspace, port, creditSocket, ...(backend ? {backend} : {})});
  if (direct) {
    console.log(`Local prototype (DIRECT DEVELOPER MODE): ${app.origin}\nReal terminals run as your account. The agent adapter uses a local scripted model (no provider inference) when the Pi SDK is built; otherwise it reports unavailable. Funding stays a fixture. No sandbox or Tor enforcement.`);
  } else {
    console.log(`Portable workspace UI (service mode): ${app.origin}\nTerminals and agent runs are proxied to the separate portable-agent service at ${backendPath}. If that backend is absent, terminal and agent operations fail closed (503); this server never spawns them itself.`);
  }
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
