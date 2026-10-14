import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAgentManager } from './agent-manager.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const limit = 256 * 1024;
const agentScriptKeys = ['toolName', 'path', 'content', 'finalText', 'reportEnv', 'slow', 'flood', 'hang', 'proofPath', 'proofContent', 'oversize', 'revive', 'doneThenHang', 'doneThenExit', 'doneThenExit0', 'doneThenAbort', 'exitDelayMs', 'exit0NoDone'];
export async function createWorkspaceServer({ workspace, port = 0, agentManager }) {
  if (!workspace || !path.isAbsolute(workspace)) throw new Error('An explicit absolute disposable workspace is required');
  const root = await fs.realpath(workspace);
  if (!(await fs.stat(root)).isDirectory() || root === '/') throw new Error('Workspace must be a directory other than /');
  const token = crypto.randomBytes(32).toString('hex');
  const terminals = new Map();
  const agents = agentManager ?? createAgentManager({ workspace: root });
  let origin;
  const send = (res, code, data) => { res.writeHead(code, {'content-type':'application/json'}); res.end(JSON.stringify(data)); };
  const body = async req => {
    let value = '';
    for await (const chunk of req) { value += chunk; if (Buffer.byteLength(value) > 16384) throw new Error('Request too large'); }
    return JSON.parse(value || '{}');
  };
  const stop = terminal => { terminal.child.stdin.end(); };
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
        const agent = await agents.status().catch(error => ({ available: false, kind: 'missing', detail: error.message }));
        return send(res, 200, { terminalAvailable:true, csrfToken:token, workspace:root, qualification:'local-development', agent });
      }
      if (req.method === 'GET' && url.pathname === '/api/terminals') {
        return send(res, 200, { sessions: [...terminals.entries()].map(([id, terminal]) => ({ id, exited: terminal.exited })) });
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
        try {
          const { id } = await agents.start({ prompt, script });
          return send(res, 201, { id });
        } catch (error) {
          if (error.code === 'AGENT_CAPACITY') return send(res, 409, { error: error.message });
          if (error.code === 'AGENT_CLOSING') return send(res, 503, { error: 'Agent manager is closing', detail: error.message });
          return send(res, 503, { error: 'Agent SDK unavailable', detail: error.message });
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/agents') return send(res, 200, { agents: agents.list() });
      const agentMatch = /^\/api\/agents\/([a-f0-9-]+)(\/events)?$/.exec(url.pathname);
      if (agentMatch) {
        if (req.method === 'GET' && agentMatch[2] === '/events') {
          const result = agents.events(agentMatch[1], Number(url.searchParams.get('after') || 0));
          if (!result) return send(res, 404, {error:'Agent run not found'});
          return send(res, 200, result);
        }
        if (req.method === 'DELETE' && agentMatch[2] === undefined) {
          const removed = await agents.stop(agentMatch[1]);
          return send(res, removed ? 200 : 404, removed ? {ok:true} : {error:'Agent run not found'});
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/terminals') {
        await body(req);
        if (terminals.size >= 8) return send(res, 409, {error:'Close a terminal before opening another'});
        const id = crypto.randomUUID();
        const child = spawn('python3', ['-I', path.join(here, 'terminal_bridge.py'), root], {stdio:['pipe','pipe','pipe'], env:{PATH:process.env.PATH}});
        const terminal = {child, output:'', base:0, exited:false};
        child.stdout.setEncoding('utf8');
        const append = data => { terminal.output += data; if (terminal.output.length > limit) { const remove = terminal.output.length - limit; terminal.output = terminal.output.slice(remove); terminal.base += remove; } };
        child.stdout.on('data', append);
        child.stderr.on('data', data => append(String(data)));
        child.stdin.on('error', () => {});
        child.on('error', error => { append(`Terminal unavailable: ${error.message}`); terminal.exited = true; });
        child.on('close', () => { terminal.exited = true; });
        terminals.set(id, terminal);
        return send(res, 201, {id});
      }
      const match = /^\/api\/terminals\/([a-f0-9-]+)(?:\/(input|output))?$/.exec(url.pathname);
      if (match) {
        const terminal = terminals.get(match[1]);
        if (!terminal) return send(res, 404, {error:'Terminal not found'});
        if (req.method === 'GET' && match[2] === 'output') {
          const after = Number(url.searchParams.get('after') || 0);
          if (!Number.isSafeInteger(after) || after < 0) return send(res, 400, {error:'Invalid offset'});
          return send(res, 200, {output:terminal.output.slice(Math.max(0, after - terminal.base)), offset:terminal.base + terminal.output.length, exited:terminal.exited, truncated:after < terminal.base});
        }
        if (req.method === 'POST' && match[2] === 'input') {
          const {input} = await body(req);
          if (typeof input !== 'string' || Buffer.byteLength(input) > 8192) return send(res, 400, {error:'Invalid input'});
          if (terminal.exited || terminal.child.stdin.writableLength > 65536) return send(res, 409, {error:'Terminal is closed or busy'});
          terminal.child.stdin.write(JSON.stringify({input}) + '\n');
          return send(res, 200, {ok:true});
        }
        if (req.method === 'DELETE' && !match[2]) { stop(terminal); terminals.delete(match[1]); return send(res, 200, {ok:true}); }
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
  return {origin, async close() { for (const terminal of terminals.values()) stop(terminal); await agents.close(); await new Promise(resolve => server.close(resolve)); }};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const workspace = args[args.indexOf('--workspace') + 1];
  if (!args.includes('--workspace')) throw new Error('Usage: node server.mjs --workspace /absolute/disposable/folder [--port 8765]');
  const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 8765;
  const app = await createWorkspaceServer({workspace, port});
  console.log(`Local prototype: ${app.origin}\nReal terminals run as your account. The agent adapter uses a local scripted model (no provider inference) when the Pi SDK is built; otherwise it reports unavailable. Funding stays a fixture. No sandbox or Tor enforcement.`);
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
