// Offline (same-uid) tests for the portable-agent service IPC protocol and
// the backend client. These run everything under ONE uid using the
// in-process constructor flag `testingAllowSameUid` — the same flag pattern
// as the inference broker. Kernel-level uid separation (SO_PEERCRED
// refusal of a real foreign uid, group boundaries, /proc ownership) is NOT
// testable here and is covered by tests/run-uid-tests.sh under real
// separate UIDs; these tests never fake a uid field as a substitute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createAgentService } from '../agent-service.mjs';
import { createBackendClient, BackendUnavailableError } from '../backend-client.mjs';
import { IPC_SERVICE_NAME } from '../ipc.mjs';
import { createWorkspaceServer } from '../../workspace/server.mjs';

const fixtureWorker = path.resolve(import.meta.dirname, '..', '..', 'workspace', 'agent-fixture-worker.mjs');
const uid = process.getuid();
async function ready(read) { for(let i=0;i<200;i++){const s=await read();if(s.agent?.state!=='warming')return s;await new Promise(r=>setTimeout(r,20));}throw Error('readiness did not settle'); }

const tmp = async () => fs.mkdtemp(path.join(os.tmpdir(), 'portable-agent-service-'));
const until = async (pattern, read, label) => {
  let text = '';
  for (let attempt = 0; attempt < 200; attempt++) {
    text += await read();
    if (pattern.test(text)) return text;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail(`expected ${label}: ${text.slice(-800)}`);
};

async function startService(dir, options = {}) {
  const socketPath = path.join(dir, 'run', 'ipc.sock');
  const workspace = path.join(dir, 'ws');
  await fs.mkdir(workspace, { recursive: true });
  const service = createAgentService({
    workspace,
    socketPath,
    allowedUids: [uid],
    workerPath: fixtureWorker,
    testingAllowSameUid: true,
    managerOptions: { runTimeoutMs: 30_000 },
    ...options,
  });
  await service.start();
  return { service, socketPath, workspace };
}

// Raw bounded connection helper for protocol-level checks.
function rawConnect(socketPath, { deadlineMs = 5_000 } = {}) {
  const socket = net.connect(socketPath);
  const state = { data: '', closed: false, error: null };
  socket.setEncoding('utf8');
  socket.on('data', chunk => { state.data += chunk; });
  socket.on('close', () => { state.closed = true; });
  socket.on('error', error => { state.error = error; });
  const write = value => socket.write(value);
  const waitClose = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connection did not close before the deadline')), deadlineMs);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  });
  const waitReply = rid => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no reply before the deadline')), deadlineMs);
    const onData = () => {
      const frames = state.data.split('\n').filter(Boolean);
      for (const frame of frames) {
        try {
          const parsed = JSON.parse(frame);
          if (parsed.rid === rid) { clearTimeout(timer); socket.off('data', onData); resolve(parsed); }
        } catch { /* partial frame */ }
      }
    };
    socket.on('data', onData);
    onData();
  });
  return { socket, state, write, waitClose, waitReply };
}

test('service refuses to start under an allowed client uid without the explicit testing flag', async () => {
  const dir = await tmp();
  try {
    const workspace = path.join(dir, 'ws');
    await fs.mkdir(workspace, { recursive: true });
    assert.throws(
      () => createAgentService({ workspace, socketPath: path.join(dir, 'ipc.sock'), allowedUids: [uid], workerPath: fixtureWorker }),
      /separate from the trusted UI/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('service preserves and refuses an existing group-writable socket directory', async () => {
  const dir = await tmp();
  try {
    const run = path.join(dir, 'run');
    await fs.mkdir(run);
    await fs.chmod(run, 0o770);
    await assert.rejects(startService(dir), /without group\/world write/);
    assert.equal((await fs.stat(run)).mode & 0o777, 0o770);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('full protocol round trip: terminals and fixture agent runs over the socket', async () => {
  const dir = await tmp();
  const { service, socketPath } = await startService(dir);
  const client = createBackendClient({ socketPath });
  try {
    assert.equal((await fs.stat(path.dirname(socketPath))).mode & 0o777, 0o700);
    const status = await ready(()=>client.request('status'));
    assert.equal(status.service, IPC_SERVICE_NAME);
    assert.equal(status.terminalAvailable, true);
    assert.equal(status.agent.available, true);
    assert.equal(status.agent.kind, 'fixture');

    const { id } = await client.request('terminals.create');
    assert.match(id, /^[a-f0-9-]+$/);
    let offset = 0;
    await until(/workspace \$/, async () => {
      const out = await client.request('terminals.output', { id, after: offset });
      offset = out.offset;
      return out.output;
    }, 'shell prompt');
    await client.request('terminals.input', { id, input: 'printf PROOF_OK\n' });
    await until(/PROOF_OK/, async () => {
      const out = await client.request('terminals.output', { id, after: offset });
      offset = out.offset;
      return out.output;
    }, 'command output');
    const list = await client.request('terminals.list');
    assert.equal(list.sessions.length, 1);
    assert.ok(await client.request('terminals.stop', { id }));
    const missing = await client.request('terminals.output', { id, after: 0 }).then(() => null, error => error);
    assert.equal(missing?.code, 'not_found');

    const run = await client.request('agents.start', { prompt: 'write the proof file' });
    assert.match(run.id, /^[a-f0-9-]+$/);
    let state = null;
    for (let attempt = 0; attempt < 150 && state !== 'done'; attempt++) {
      const events = await client.request('agents.events', { id: run.id, after: 0 });
      state = events.state;
      if (state === 'error' || state === 'timeout') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(state, 'done');
    assert.equal((await client.request('agents.stop', { id: run.id })).ok, true);
  } finally {
    await client.close();
    await service.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('malformed and oversized frames destroy the connection without a reply', async () => {
  const dir = await tmp();
  const { service, socketPath } = await startService(dir, { limits: { maxFrameBytes: 2048 } });
  try {
    const malformed = rawConnect(socketPath);
    malformed.write('this is not json\n');
    await malformed.waitClose();
    assert.equal(malformed.state.data, '');

    const oversized = rawConnect(socketPath);
    oversized.write(`{"op":"status","rid":1,"pad":"${'x'.repeat(4096)}"}\n`);
    await oversized.waitClose();
    assert.equal(oversized.state.data, '');

    // The service must still be healthy afterwards.
    const client = createBackendClient({ socketPath });
    const status = await ready(()=>client.request('status'));
    assert.equal(status.service, IPC_SERVICE_NAME);
    await client.close();
  } finally {
    await service.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('unknown operations and smuggled fields are refused as protocol errors, never executed', async () => {
  const dir = await tmp();
  const { service, socketPath } = await startService(dir);
  const client = createBackendClient({ socketPath });
  try {
    const unknown = await client.request('terminals.spawn', {}).then(() => null, error => error);
    assert.equal(unknown?.code, 'unknown_op');
    // A caller-supplied uid (or cwd, worker, env) is not an accepted field:
    // identity and execution parameters are service-side authority only.
    const smuggled = await client.request('agents.start', { prompt: 'x', uid: 0, cwd: '/etc', workerPath: '/tmp/evil' }).then(() => null, error => error);
    assert.equal(smuggled?.code, 'invalid_request');
    const terminalUid = await client.request('terminals.create', { uid: uid }).then(() => null, error => error);
    assert.equal(terminalUid?.code, 'invalid_request');
    // The fixture script knobs are refused unless the service opts in.
    const script = await client.request('agents.start', { prompt: 'x', script: { toolName: 'write' } }).then(() => null, error => error);
    assert.equal(script?.code, 'invalid_request');
  } finally {
    await client.close();
    await service.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('peer credential failure and foreign peer uid destroy the connection before any protocol byte', async () => {
  const dir = await tmp();
  // Injected credential functions are process-internal test doubles for the
  // KERNEL check (constructor-only; the production default is the real
  // SO_PEERCRED helper). The foreign-uid case is additionally proven with a
  // real kernel uid in tests/run-uid-tests.sh.
  const rejecting = await startService(dir, { peerCred: () => Promise.reject(new Error('helper exploded')) });
  try {
    const refused = rawConnect(rejecting.socketPath);
    refused.write('{"op":"status","rid":1}\n');
    await refused.waitClose();
    assert.equal(refused.state.data, '');
    const foreign = await startService(dir, { socketPath: path.join(dir, 'run', 'ipc2.sock'), peerCred: () => Promise.resolve({ pid: 1, uid: uid + 4242, gid: 1 }) });
    try {
      const spoof = rawConnect(foreign.socketPath);
      spoof.write(`{"op":"status","rid":1,"uid":${uid}}\n`); // claiming the allowed uid must not help
      await spoof.waitClose();
      assert.equal(spoof.state.data, '');
    } finally { await foreign.service.stop(); }
  } finally {
    await rejecting.service.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('backend client fails closed on absent socket, foreign-owned socket and dead deadlines', async () => {
  const dir = await tmp();
  try {
    // Absent socket: typed unavailable error, no connection.
    const absent = createBackendClient({ socketPath: path.join(dir, 'no-such.sock') });
    const error = await absent.request('status').then(() => null, error => error);
    assert.ok(error instanceof BackendUnavailableError);
    await absent.close();

    // A path that exists but is not a socket is refused before connecting.
    const notASocket = path.join(dir, 'regular.file');
    await fs.writeFile(notASocket, 'x');
    const wrongKind = createBackendClient({ socketPath: notASocket });
    assert.match((await wrongKind.request('status').then(() => null, e => e)).message, /not a socket/);
    await wrongKind.close();

    // A live-but-silent endpoint must trip the request deadline: the client
    // destroys the socket first and the promise rejects.
    const silent = net.createServer(conn => { conn.resume(); /* accept, never reply */ });
    const silentPath = path.join(dir, 'silent.sock');
    await new Promise(resolve => silent.listen(silentPath, resolve));
    const slowClient = createBackendClient({ socketPath: silentPath, requestTimeoutMs: 400 });
    const start = Date.now();
    const timeoutError = await slowClient.request('status').then(() => null, e => e);
    assert.ok(timeoutError instanceof BackendUnavailableError);
    assert.ok(Date.now() - start < 5_000);
    // A subsequent request reconnects (still silent) and also fails closed.
    const again = await slowClient.request('status').then(() => null, e => e);
    assert.ok(again instanceof BackendUnavailableError);
    await slowClient.close();
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 2_000); // teardown deadline
      timer.unref?.();
      silent.closeAllConnections?.();
      silent.close(() => { clearTimeout(timer); resolve(); });
      silent.unref?.();
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('socket takeover rules: live service refused, stale socket replaced, verified ownership after start', async () => {
  const dir = await tmp();
  const { service, socketPath } = await startService(dir);
  try {
    const info = await fs.lstat(socketPath);
    assert.ok(info.isSocket());
    assert.equal(info.uid, process.getuid());
    // A second service on the same socket must refuse to start.
    const workspace = path.join(dir, 'ws');
    const rival = createAgentService({ workspace, socketPath, allowedUids: [uid], workerPath: fixtureWorker, testingAllowSameUid: true });
    await assert.rejects(() => rival.start(), /already served by a live service/);
  } finally {
    await service.stop();
    await assert.rejects(() => fs.lstat(socketPath), /ENOENT/);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('HTTP server in service mode proxies to the backend and fails closed when it is absent', async () => {
  const dir = await tmp();
  const { service, socketPath, workspace } = await startService(dir);
  try {
    const client = createBackendClient({ socketPath });
    const app = await createWorkspaceServer({ workspace, backend: client });
    try {
      const status = await ready(()=>fetch(app.origin + '/api/status').then(r=>r.json()));
      assert.equal(status.mode, 'service');
      assert.equal(status.terminalAvailable, true);
      assert.equal(status.agent.kind, 'fixture');
      const headers = {'Content-Type':'application/json','X-Workspace-Token':status.csrfToken};
      const request = (url, method = 'GET', data) => fetch(app.origin + url, {method, headers, ...(data === undefined ? {} : {body:JSON.stringify(data)})});

      // Origin/CSRF protection is unchanged in service mode.
      assert.equal((await fetch(app.origin + '/api/terminals', {method:'POST', headers:{...headers, Origin:'https://evil.example'}, body:'{}'})).status, 403);
      assert.equal((await fetch(app.origin + '/api/terminals', {method:'POST', headers:{'Content-Type':'application/json','X-Workspace-Token':'wrong'}, body:'{}'})).status, 403);

      const created = await (await request('/api/terminals', 'POST', {})).json();
      assert.match(created.id, /^[a-f0-9-]+$/);
      let offset = 0;
      await until(/workspace \$/, async () => {
        const out = await (await request(`/api/terminals/${created.id}/output?after=${offset}`)).json();
        offset = out.offset;
        return out.output;
      }, 'prompt over proxied PTY');
      await request(`/api/terminals/${created.id}`, 'DELETE', {});
      assert.equal((await request(`/api/terminals/${created.id}/output`)).status, 404);
    } finally { await app.close(); }

    // Fail-closed: backend gone -> operations are refused, never spawned
    // locally. The server keeps serving status (locked-state style).
    await service.stop();
    const deadClient = createBackendClient({ socketPath });
    const deadApp = await createWorkspaceServer({ workspace, backend: deadClient });
    try {
      const status = await (await fetch(deadApp.origin + '/api/status')).json();
      assert.equal(status.terminalAvailable, false);
      assert.equal(status.backend.available, false);
      assert.equal(status.agent.available, false);
      const headers = {'Content-Type':'application/json','X-Workspace-Token':status.csrfToken};
      const refused = await fetch(deadApp.origin + '/api/terminals', {method:'POST', headers, body:'{}'});
      assert.equal(refused.status, 503);
      const body = await refused.json();
      assert.match(body.error, /backend unavailable/);
      const agentRefused = await fetch(deadApp.origin + '/api/agents', {method:'POST', headers, body:JSON.stringify({prompt:'hello'})});
      assert.equal(agentRefused.status, 503);
    } finally { await deadApp.close(); }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});


test('pending peer checks count against capacity and stop destroys unauthenticated sockets', async () => {
  const dir = await tmp(); let checks = 0; let release; const peers = [];
  const {service, socketPath} = await startService(dir, {limits:{maxConnections:1}, peerCred:()=>{ checks++; return new Promise(r=>release=r); }});
  try {
    for(let i=0;i<12;i++) { const peer=net.connect(socketPath); peer.on('error',()=>{}); peers.push(peer); await new Promise(r=>setTimeout(r,10)); }
    assert.equal(checks,1);
    await Promise.race([service.stop(),new Promise((_,reject)=>setTimeout(()=>reject(Error('stop waited on authentication')),1000).unref())]);
    release({uid});
  } finally { release?.({uid}); for(const peer of peers)peer.destroy(); await service.stop(); await fs.rm(dir,{recursive:true,force:true}); }
});

test('PTY stop escalates against its HUP/TERM-resistant shell and retains capacity until reap', async () => {
  const {createTerminalManager}=await import('../../workspace/terminal-manager.mjs');
  const dir=await tmp(); const manager=createTerminalManager({workspace:dir,maxSessions:1,exitTimeoutMs:1000}); let pid;
  try {
    const {id}=manager.create();
    manager.input(id,"trap '' HUP TERM; echo $$ > shell.pid; while :; do :; done\n");
    await until(/ready/,async()=>{try {pid=Number(await fs.readFile(path.join(dir,'shell.pid'),'utf8'));return 'ready';}catch{return '';}},'shell pid');
    const stopped=manager.stop(id);
    assert.throws(()=>manager.create(),/Close a terminal/);
    await stopped;
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  } finally { if(pid){try{process.kill(-pid,'SIGKILL');}catch{}} await manager.close(); await fs.rm(dir,{recursive:true,force:true}); }
});
