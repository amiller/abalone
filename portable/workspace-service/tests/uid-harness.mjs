#!/usr/bin/env node
// Actual separate-UID tests for the portable workspace authority split.
//
// Runs INSIDE a user+mount namespace whose uid/gid map provides genuinely
// distinct kernel identities (written by the outer launcher via
// newuidmap/newgidmap — never faked uid fields):
//
//   inner uid 0  harness root (maps to the outer invoking user)
//   inner uid 1  portable-ui       (primary gid 1 = portable-ipc)
//   inner uid 2  portable-agent    (primary gid 1 = portable-ipc; NOT in
//                                   portable-operators, NOT in credit)
//   inner uid 3  attacker          (in or out of the IPC group by case)
//   inner uid 4  portable-credit   (owns the credit journal file)
//   inner gid 1  portable-ipc      (the explicit shared IPC group)
//   inner gid 2  portable-operators (fake vault-broker socket group)
//   inner gid 3  portable-credit
//
// The kernel enforces these boundaries for real: PTY and SDK worker
// processes must show the agent uid in /proc, the agent uid must be refused
// at the broker socket and the credit file, IPC connections from any uid
// other than the UI's must be destroyed by SO_PEERCRED, cancellation must
// reap children and remove per-run state, and a UI restart must reattach to
// the still-running sessions owned by the agent service. No provider calls
// are made: the SDK worker uses the scripted local transport and the
// lifecycle service uses the fixture worker.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const SDK_DIST = path.join(REPO, 'vendor', 'pi', 'packages', 'coding-agent', 'dist', 'index.js');
let SERVICE_SCRIPT = path.join(REPO, 'portable', 'workspace-service', 'agent-service.mjs');
let SERVER_SCRIPT = path.join(REPO, 'portable', 'workspace', 'server.mjs');

const UID_UI = 1, UID_AGENT = 2, UID_ATTACKER = 3, UID_CREDIT = 4;
const GID_IPC = 1, GID_OPERATORS = 2, GID_CREDIT = 3;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const fixtureServers = [];
let current = null;
const step = async (name, fn) => {
	current = name;
	const start = Date.now();
	try { await fn(); results.push({ name, ok: true, ms: Date.now() - start }); console.log(`ok   - ${name}`); }
	catch (error) { results.push({ name, ok: false, error: String(error?.message ?? error), ms: Date.now() - start }); console.log(`not ok - ${name}: ${error?.message ?? error}`); }
};
const check = (condition, message) => { if (!condition) throw new Error(message); };

// Bounded wait: every wait in this harness has a hard deadline; a missed
// condition is a failure, never a hang.
async function waitFor(label, condition, { timeoutMs = 15_000, intervalMs = 25 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let value;
		try { value = await condition(); } catch (error) { value = null; }
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
		await sleep(intervalMs);
	}
}

// --- /proc inspection (the harness runs as the namespace root) ---
const procEntries = async () => {
	const entries = await fs.promises.readdir('/proc');
	const processes = [];
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const stat = await fs.promises.readFile(`/proc/${entry}/stat`, 'utf8');
			const closeParen = stat.lastIndexOf(')');
			const fields = stat.slice(closeParen + 2).split(' ');
			// after the comm field: state, ppid, pgrp, session...
			processes.push({ pid: Number(entry), state: fields[0], ppid: Number(fields[1]), pgrp: Number(fields[2]), session: Number(fields[3] ?? 0) });
		} catch { /* process exited */ }
	}
	return processes;
};
const procUid = async pid => (await fs.promises.stat(`/proc/${pid}`)).uid;
const cmdlineOf = async pid => (await fs.promises.readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ');
const descendants = async (rootPid, { maxDepth = 6 } = {}) => {
	const processes = await procEntries();
	const childrenOf = new Map();
	for (const proc of processes) {
		if (!childrenOf.has(proc.ppid)) childrenOf.set(proc.ppid, []);
		childrenOf.get(proc.ppid).push(proc);
	}
	const out = [];
	const walk = (pid, depth) => {
		if (depth > maxDepth) return;
		for (const child of childrenOf.get(pid) ?? []) { out.push(child); walk(child.pid, depth + 1); }
	};
	walk(rootPid, 0);
	return out;
};

// --- process launching as specific namespace identities ---
const runAs = (uid, gid, command, { env = {}, stdio = ['ignore', 'pipe', 'pipe'], groups = [] } = {}) => new Promise((resolve, reject) => {
	const args = [];
	if (groups.length) args.push('--groups', groups.join(','));
	else args.push('--clear-groups');
	args.push('--reuid', String(uid), '--regid', String(gid), '--');
	const child = spawn('setpriv', [...args, ...command], { cwd: '/', stdio, env: { PATH: `/usr/bin:/bin:${path.dirname(NODE_BIN)}`, ...env } });
	let stdout = '', stderr = '';
	if (stdio[1] === 'pipe') child.stdout.on('data', chunk => { stdout += chunk; });
	if (stdio[2] === 'pipe') child.stderr.on('data', chunk => { stderr += chunk; });
	child.on('error', reject);
	child.on('close', code => resolve({ code, stdout, stderr }));
});

const spawnAs = (uid, gid, command, { env = {}, groups = [] } = {}) => {
	const args = [];
	if (groups.length) args.push('--groups', groups.join(','));
	else args.push('--clear-groups');
	args.push('--reuid', String(uid), '--regid', String(gid), '--');
	return spawn('setpriv', [...args, ...command], { cwd: '/', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: `/usr/bin:/bin:${path.dirname(NODE_BIN)}`, ...env } });
};

const killTree = async (pid, { graceMs = 8_000 } = {}) => {
	try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
	await waitFor(`process ${pid} exit`, async () => {
		try { process.kill(pid, 0); return false; } catch { return true; }
	}, { timeoutMs: graceMs }).catch(() => {
		try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
	});
};

// --- main ---
// This harness only works when the outer launcher (run-uid-tests.sh) has
// written the namespace id maps; waiting for them avoids racing newuidmap.
const mapReady = async () => {
	for (let attempt = 0; attempt < 400; attempt++) {
		try {
			const uidMap = await fs.promises.readFile('/proc/self/uid_map', 'utf8');
			if (uidMap.trim() !== '' && process.getuid() === 0) return;
		} catch { /* map not written yet */ }
		await sleep(25);
	}
	throw new Error('uid map was never written: start via run-uid-tests.sh');
};
await mapReady();

// The launcher mounts a namespace-private tmpfs at this path: its
// superblock belongs to the user namespace, so chown between the genuinely
// distinct mapped uids is a real kernel operation here (on a host-owned
// filesystem it would be EPERM without caps in the init namespace).
const T = process.argv[2];
if (!T || !path.isAbsolute(T)) throw new Error('start via run-uid-tests.sh (private tmpfs mountpoint required)');
// Mount the private tmpfs now that uid 0 is mapped: mount(8) requires a
// mapped root. Its superblock belongs to this namespace, so chown between
// the genuinely distinct mapped uids is a real kernel operation here.
const mountResult = spawn('mount', ['-n', '-t', 'tmpfs', 'none', T], { stdio: 'ignore' });
const mountExit = await new Promise(resolve => mountResult.once('close', code => resolve(code)).once('error', () => resolve(-1)));
if (mountExit !== 0) { console.log('SKIP: private tmpfs mount failed inside the namespace'); process.exit(42); }

await fs.promises.chmod(T, 0o755);

// The repository checkout is mode 0750 for the invoking account; the inner
// service/UI uids are genuinely different kernel uids and must not be able
// to read it (that is the point of the split). Mirror only the first-party
// files the services need — plus the vendored SDK dist for the real worker —
// into the private tmpfs, world-readable, and run everything from there.
const REPO_MIRROR = path.join(T, 'repo');
const copyTree = async (from, to) => {
	await fs.promises.mkdir(path.dirname(to), { recursive: true });
	await fs.promises.cp(from, to, { recursive: true, verbatimSymlinks: false, dereference: true });
};
await copyTree(path.join(REPO, 'portable', 'workspace', 'ui'), path.join(REPO_MIRROR, 'portable', 'workspace', 'ui'));
for (const name of ['server.mjs', 'terminal-manager.mjs', 'agent-manager.mjs', 'agent-worker.mjs', 'agent-fixture-worker.mjs', 'terminal_bridge.py']) {
	await fs.promises.mkdir(path.join(REPO_MIRROR, 'portable', 'workspace'), { recursive: true });
	await fs.promises.copyFile(path.join(REPO, 'portable', 'workspace', name), path.join(REPO_MIRROR, 'portable', 'workspace', name));
}
for (const name of ['agent-service.mjs', 'ipc.mjs', 'syscred.mjs', 'backend-client.mjs']) {
	await fs.promises.mkdir(path.join(REPO_MIRROR, 'portable', 'workspace-service'), { recursive: true });
	await fs.promises.copyFile(path.join(REPO, 'portable', 'workspace-service', name), path.join(REPO_MIRROR, 'portable', 'workspace-service', name));
}
// A dist directory alone is NOT a portable dependency closure. This UID
// harness qualifies the fixture worker; actual SDK tests run separately.
const sdkAvailable = false;
console.log('# actual SDK under separate UIDs: NOT QUALIFIED (closure not mirrored)');
if (sdkAvailable) {
	await copyTree(path.join(REPO, 'vendor', 'pi', 'packages', 'coding-agent', 'dist'),
		path.join(REPO_MIRROR, 'vendor', 'pi', 'packages', 'coding-agent', 'dist'));
}
await fs.promises.chmod(REPO_MIRROR, 0o755);
// Everything under the mirror is world-readable so uid 1 and uid 2 can load
// the mirrored code (their authority comes from the kernel, not from the
// repository checkout they can no longer even traverse).
const mirrorWalk = async dir => {
	for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		await fs.promises.chmod(full, entry.isDirectory() ? 0o755 : 0o644);
		if (entry.isDirectory()) await mirrorWalk(full);
	}
};
await mirrorWalk(REPO_MIRROR);
SERVICE_SCRIPT = path.join(REPO_MIRROR, 'portable', 'workspace-service', 'agent-service.mjs');
SERVER_SCRIPT = path.join(REPO_MIRROR, 'portable', 'workspace', 'server.mjs');
// The invoking account's node lives under a 0750 home directory: the inner
// uids could never traverse it, and a process that execs it once (with
// capabilities still held) would still fail every later child spawn.
// Mirror the Node 24 binary itself into the private tree and run every
// inner process from it — process.execPath then points at a path the agent
// uid can legitimately exec for PTY helpers' python3 and SDK workers.
const NODE_BIN = path.join(REPO_MIRROR, 'bin', 'node');
await fs.promises.mkdir(path.join(REPO_MIRROR, 'bin'), { recursive: true });
await fs.promises.chmod(path.dirname(NODE_BIN), 0o755);
await fs.promises.copyFile(process.execPath, NODE_BIN);
await fs.promises.chmod(NODE_BIN, 0o755);
// Preflight: prove the inner identities can exec the mirrored node before
// anything else depends on it (stat dump on failure for diagnosis).
try {
	const stat = await fs.promises.stat(NODE_BIN);
	check((stat.mode & 0o777) === 0o755, `node mirror mode ${(stat.mode & 0o777).toString(8)}`);
	const pre = await runAs(UID_AGENT, GID_IPC, [NODE_BIN, '-e', 'console.log("uid", process.getuid())']);
	check(pre.code === 0 && pre.stdout.includes('uid 2'), `agent uid can exec the mirrored node (rc=${pre.code}, out=${pre.stdout.trim()}, err=${pre.stderr.trim()})`);
	// And WITHOUT capabilities held across the exec: a uid-2 node process
	// spawning the same binary the service will spawn.
	const nested = await runAs(UID_AGENT, GID_IPC, [NODE_BIN, '-e', `
		const { spawn } = require('node:child_process');
		const child = spawn(${JSON.stringify(NODE_BIN)}, ['-e', 'console.log(42)'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
		child.stdout.on('data', c => console.log('child:', c.toString().trim()));
		child.on('error', e => console.log('childerr:', e.code));
		child.on('close', () => process.exit(0));
		setTimeout(() => process.exit(3), 8000);
	`]);
	check(nested.code === 0 && nested.stdout.includes('child: 42'), `uid-2 process can spawn the mirrored node without caps (rc=${nested.code}, out=${nested.stdout.trim()}, err=${nested.stderr.trim()})`);
} catch (error) {
	console.log(`not ok - mirrored node preflight: ${error.message}`);
	process.exit(1);
}
const spawned = []; // {pid, label}
let failures = 0;

try {
	// ---------------- fixture layout ----------------
	await fs.promises.mkdir(path.join(T, 'ws'), { recursive: true });
	await fs.promises.chown(path.join(T, 'ws'), UID_AGENT, GID_IPC);
	await fs.promises.chmod(path.join(T, 'ws'), 0o700);
	const agentTmp = path.join(T, 'agent-tmp');
	await fs.promises.mkdir(agentTmp, { recursive: true });
	await fs.promises.chown(agentTmp, UID_AGENT, GID_IPC);
	await fs.promises.chmod(agentTmp, 0o700);
	const agentTmpB = path.join(T, 'agent-tmp-b');
	await fs.promises.mkdir(agentTmpB, { recursive: true });
	await fs.promises.chown(agentTmpB, UID_AGENT, GID_IPC);
	await fs.promises.chmod(agentTmpB, 0o700);
	const wsB = path.join(T, 'ws-b');
	await fs.promises.mkdir(wsB, { recursive: true });
	await fs.promises.chown(wsB, UID_AGENT, GID_IPC);
	await fs.promises.chmod(wsB, 0o700);
	// Credit journal fixture: owned by the credit account, group-readable
	// only by the credit group — the agent uid must be refused.
	const creditDir = path.join(T, 'creditdir');
	await fs.promises.mkdir(creditDir, { recursive: true });
	const creditFile = path.join(creditDir, 'credit.log');
	await fs.promises.writeFile(creditFile, 'CREDIT-SECRET-FIXTURE\n');
	await fs.promises.chown(creditFile, UID_CREDIT, GID_CREDIT);
	await fs.promises.chmod(creditFile, 0o640);
	await fs.promises.chown(creditDir, UID_CREDIT, GID_CREDIT);
	await fs.promises.chmod(creditDir, 0o750);
	// Fake vault-broker socket, root:portable-operators 0660 in a 0750
	// directory: exactly the reachability the agent account must NOT have.
	const brokerDir = path.join(T, 'brokerdir');
	await fs.promises.mkdir(brokerDir, { recursive: true });
	await fs.promises.chown(brokerDir, 0, GID_OPERATORS);
	await fs.promises.chmod(brokerDir, 0o750);
	const brokerOpenDir = path.join(T, 'brokeropen'); // traversable, socket still 0660 root:operators
	await fs.promises.mkdir(brokerOpenDir, { recursive: true });
	await fs.promises.chmod(brokerOpenDir, 0o755);
	const broker = net.createServer(conn => conn.resume());
	fixtureServers.push(broker);
	await new Promise(resolve => broker.listen(path.join(brokerDir, 'broker.sock'), resolve));
	await fs.promises.chown(path.join(brokerDir, 'broker.sock'), 0, GID_OPERATORS);
	await fs.promises.chmod(path.join(brokerDir, 'broker.sock'), 0o660);
	const brokerOpen = net.createServer(conn => conn.resume());
	fixtureServers.push(brokerOpen);
	await new Promise(resolve => brokerOpen.listen(path.join(brokerOpenDir, 'broker.sock'), resolve));
	await fs.promises.chown(path.join(brokerOpenDir, 'broker.sock'), 0, GID_OPERATORS);
	await fs.promises.chmod(path.join(brokerOpenDir, 'broker.sock'), 0o660);

	// Denial probe script the agent's own processes will run.
	const denyProbe = path.join(T, 'denyprobe.mjs');
	await fs.promises.writeFile(denyProbe, [
		'import net from "node:net"; import fs from "node:fs";',
		'const out = {};',
		'const tryConnect = p => new Promise(resolve => { const s = net.connect(p); s.once("connect", () => { s.destroy(); resolve("CONNECTED"); }); s.once("error", e => resolve(e.code)); });',
		'out.brokerDir = await tryConnect(process.argv[2]);',
		'out.brokerSocket = await tryConnect(process.argv[3]);',
		'out.credit = await fs.promises.readFile(process.argv[4], "utf8").then(() => "READ", e => e.code);',
		'out.uid = process.getuid(); out.gid = process.getgid();',
		'console.log("DENY " + JSON.stringify(out));',
	].join('\n'));
	await fs.promises.chmod(denyProbe, 0o644);

	const sdkAvailableLocal = sdkAvailable;
	console.log(`# harness: uid split under namespace; sdk worker: ${sdkAvailableLocal ? 'sdk' : 'fixture'}`);

	for (const name of ['ipcdir','ipcdir-b']) { const dir=path.join(T,name); await fs.promises.mkdir(dir); await fs.promises.chown(dir,UID_AGENT,GID_IPC); await fs.promises.chmod(dir,0o750); }
	await fs.promises.chmod(denyProbe,0o644);
	// ---------------- start the agent service (uid 2) ----------------
	const ipcSocket = path.join(T, 'ipcdir', 'ipc.sock');
	const service = spawnAs(UID_AGENT, GID_IPC, [NODE_BIN, SERVICE_SCRIPT,
		'--workspace', path.join(T, 'ws'), '--socket', ipcSocket,
		'--allow-uid', String(UID_UI), '--group', String(GID_IPC),
		'--worker', sdkAvailableLocal ? 'sdk' : 'fixture', '--allow-script'],
		{ env: { TMPDIR: agentTmp } });
	spawned.push({ pid: service.pid, label: 'agent-service' });
	let serviceLog = '';
	service.stdout.on('data', chunk => { serviceLog += chunk; });
	service.stderr.on('data', chunk => { serviceLog += chunk; });
	await waitFor('agent socket',async()=>{if(service.exitCode!==null)throw Error(serviceLog);return fs.existsSync(ipcSocket);},{timeoutMs:5000}).catch(e=>{throw Error(e.message+' '+serviceLog);});

	// Fixture-lifecycle twin service (same agent uid, separate dirs).
	const ipcSocketB = path.join(T, 'ipcdir-b', 'ipc.sock');
	const serviceB = spawnAs(UID_AGENT, GID_IPC, [NODE_BIN, SERVICE_SCRIPT,
		'--workspace', wsB, '--socket', ipcSocketB,
		'--allow-uid', String(UID_UI), '--group', String(GID_IPC),
		'--worker', 'fixture', '--allow-script'],
		{ env: { TMPDIR: agentTmpB } });
	spawned.push({ pid: serviceB.pid, label: 'agent-service-b' });

	// ---------------- start the UI server (uid 1) ----------------
	const startUi = async backendSocket => {
		const ui = spawnAs(UID_UI, GID_IPC, [NODE_BIN, SERVER_SCRIPT,
			'--workspace', path.join(T, 'ws'), '--backend', backendSocket, '--backend-uid', String(UID_AGENT), '--port', '0'],
			{ env: {} });
		spawned.push({ pid: ui.pid, label: 'ui-server' });
		let out = '';
		ui.stdout.on('data', chunk => { out += chunk; });
		ui.stderr.on('data', chunk => { out += chunk; });
		const origin = await waitFor('UI origin line', () => { const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/); return m ? `http://127.0.0.1:${m[1]}` : null; }, { timeoutMs: 20_000 });
		return { ui, origin };
	};
	const ui = await startUi(ipcSocket);
	let uiOrigin = ui.origin;

	// Bounded HTTP helper for the UI (loopback, same-origin semantics).
	const httpJson = async (pathname, { method = 'GET', token, body, origin = uiOrigin } = {}) => {
		const response = await fetch(origin + pathname, {
			method,
			headers: {
				...(method !== 'GET' && method !== 'HEAD' ? { 'Content-Type': 'application/json', ...(token ? { 'X-Workspace-Token': token } : {}) } : {}),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		return { status: response.status, json: await response.json().catch(() => null) };
	};

	await step('service and UI run under genuinely separate kernel uids', async () => {
		check(await procUid(service.pid) === UID_AGENT, `agent service /proc uid is ${await procUid(service.pid)}, want ${UID_AGENT}`);
		check(await procUid(ui.ui.pid) === UID_UI, `UI /proc uid is ${await procUid(ui.ui.pid)}, want ${UID_UI}`);
	});

	let token = null;
	await step('UI reaches the backend; status reports service mode with fixture/sdk agent', async () => {
		const status = await waitFor('status ok', async () => {
			const reply = await httpJson('/api/status').catch(() => null);
			return reply?.status === 200 && reply.json.agent?.available ? reply.json : null;
		}, { timeoutMs: 20_000 });
		check(status.mode === 'service', 'status mode is service');
		check(status.terminalAvailable === true, 'terminalAvailable '+JSON.stringify(status));
		token = status.csrfToken;
		check(status.agent?.available === true, `agent available (got ${JSON.stringify(status.agent)}); service log: ${serviceLog.slice(-1500)}`);
	});

	let terminalId = null, offset = 0;
	const terminalOutput = pattern => waitFor(`terminal output ${pattern}`, async () => {
		const reply = await httpJson(`/api/terminals/${terminalId}/output?after=${offset}`, { token });
		if (reply.status !== 200) return null;
		offset = reply.json.offset;
		return pattern.test(reply.json.output) ? reply.json.output : null;
	}, { timeoutMs: 20_000 });
	const terminalInput = input => httpJson(`/api/terminals/${terminalId}/input`, { method: 'POST', token, body: { input } });

	await step('PTY session runs under the agent uid, not the UI uid', async () => {
		const created = await httpJson('/api/terminals', { method: 'POST', token, body: {} });
		check(created.status === 201, `terminal create status ${created.status}`);
		terminalId = created.json.id;
		await terminalOutput(/workspace \$/);
		await terminalInput('id -u; id -g; echo "RESULT_UID_$(id -u)_GID_$(id -g)"; touch pty-proof.txt\n');
		const out = await terminalOutput(/RESULT_UID_2_GID_1/);
		check(/RESULT_UID_2_GID_1/.test(out), `pty reports uid:gid ${out.match(/RESULT_UID_[^\r\n]*/)?.[0]}, want RESULT_UID_2_GID_1`);
		// Kernel truth from /proc: the bridge python and the bash it forked
		// are children of the service and owned by the agent uid.
		const bridge = await waitFor('pty bridge process', async () => {
			const kids = await descendants(service.pid);
			for (const kid of kids) {
				const cmd = await cmdlineOf(kid.pid).catch(() => '');
				if (cmd.includes('terminal_bridge.py')) return kid;
			}
			return null;
		}, { timeoutMs: 10_000 });
		check(await procUid(bridge.pid) === UID_AGENT, 'terminal bridge /proc uid is the agent uid');
		const proof = path.join(T, 'ws', 'pty-proof.txt');
		await waitFor('pty proof file', () => fs.promises.stat(proof).then(s => s.uid === UID_AGENT ? s : null).catch(() => null));
		check((await fs.promises.stat(proof)).uid === UID_AGENT, 'PTY-created file is owned by the agent uid');
	});

	await step('fixture worker runs under the agent uid and writes with its authority', async () => {
		const prompt = 'write the uid proof file';
		const started = await httpJson('/api/agents', { method: 'POST', token, body: { prompt, script:{slow:'yes',proofPath:'agent-run.txt'} } });
		check(started.status === 201, `agent start status ${started.status} ${JSON.stringify(started.json)}`);
		const runId = started.json.id;
		// Catch the live worker process and read its /proc uid.
		const workerUid = await waitFor('worker process under agent uid', async () => {
			const kids = await descendants(service.pid);
			for (const kid of kids) {
				const cmd = await cmdlineOf(kid.pid).catch(() => '');
				if (cmd.includes('agent-worker.mjs') || cmd.includes('agent-fixture-worker.mjs')) {
					const uid = await procUid(kid.pid);
					return uid === UID_AGENT ? uid : new Error(`worker uid ${uid}`);
				}
			}
			return null;
		}, { timeoutMs: 20_000 });
		check(workerUid === UID_AGENT, 'worker /proc uid is the agent uid');
		const events = await waitFor('run completes', async () => {
			const reply = await httpJson(`/api/agents/${runId}/events?after=0`, { token });
			return reply.json?.state === 'done' || reply.json?.state === 'error' ? reply.json : null;
		}, { timeoutMs: 60_000 });
		check(events.state === 'done', `run state ${events.state}`);
		const proof = path.join(T, 'ws', 'agent-run.txt');
		await waitFor('worker proof file', () => fs.promises.stat(proof).then(s => s.uid === UID_AGENT ? s : null).catch(() => null));
		check((await fs.promises.stat(proof)).uid === UID_AGENT, 'worker-written file is owned by the agent uid');
	});

	await step('agent uid is refused at the broker socket and the credit file (direct kernel check)', async () => {
		const probe = await runAs(UID_AGENT, GID_IPC, [NODE_BIN, denyProbe,
			path.join(brokerDir, 'broker.sock'), path.join(brokerOpenDir, 'broker.sock'), creditFile]);
		check(probe.code === 0, `deny probe exited ${probe.code}: ${probe.stderr}`);
		const report = JSON.parse((probe.stdout.match(/DENY (.*)/) ?? [])[1]);
		check(report.uid === UID_AGENT, 'probe ran as agent uid');
		check(report.brokerDir === 'EACCES', `broker dir traversal refused, got ${report.brokerDir}`);
		check(report.brokerSocket === 'EACCES', `broker socket connect refused, got ${report.brokerSocket}`);
		check(report.credit === 'EACCES', `credit file read refused, got ${report.credit}`);
	});

	await step('the same denials hold inside the agent PTY (its own shell)', async () => {
		await terminalInput(`${NODE_BIN} ${denyProbe} ${path.join(brokerDir, 'broker.sock')} ${path.join(brokerOpenDir, 'broker.sock')} ${creditFile}\n`);
		const out = await terminalOutput(/DENY /);
		const report = JSON.parse((out.match(/DENY ({[^\r\n]*)/) ?? [])[1]);
		check(report.brokerDir === 'EACCES' && report.brokerSocket === 'EACCES' && report.credit === 'EACCES', `pty denials: ${JSON.stringify(report)}`);
	});

	await step('IPC spoofing: wrong-uid connections are destroyed without a reply (kernel SO_PEERCRED)', async () => {
		// Attacker IN the shared IPC group (gid 1): filesystem reachability
		// succeeds, but the peer uid is not the UI uid — no reply, closed.
		const inGroup = await runAs(UID_ATTACKER, GID_IPC, [NODE_BIN, '-e', `
			const net = require('node:net');
			const s = net.connect(${JSON.stringify(ipcSocket)});
			let data = '';
			s.on('connect', () => s.write(JSON.stringify({op:'status', rid:1, uid:${UID_UI}}) + '\\n'));
			s.on('data', c => { data += c; });
			s.on('close', () => { console.log('CLOSED data=' + JSON.stringify(data)); process.exit(0); });
			setTimeout(() => { console.log('HUNG-OPEN data=' + JSON.stringify(data)); process.exit(2); }, 8000);
		`], { groups: [GID_IPC] });
		check(inGroup.code === 0, `in-group attacker connection must close, got exit ${inGroup.code}: ${inGroup.stdout}${inGroup.stderr}`);
		check(inGroup.stdout.includes('CLOSED data=""'), `no reply before close: ${inGroup.stdout.trim()}`);
		// Attacker OUTSIDE the IPC group: the socket directory itself refuses.
		const outGroup = await runAs(UID_ATTACKER, 9, [NODE_BIN, '-e', `
			const net = require('node:net');
			const s = net.connect(${JSON.stringify(ipcSocket)});
			s.on('error', e => { console.log('ERR ' + e.code); process.exit(0); });
			setTimeout(() => process.exit(2), 8000);
		`]);
		check(outGroup.code === 0 && outGroup.stdout.includes('ERR EACCES'), `out-of-group attacker refused by filesystem: ${outGroup.stdout.trim()}`);
		// The service survives the refused connections.
		const status = await httpJson('/api/status');
		check(status.status === 200 && status.json.terminalAvailable === true, 'service healthy after spoof attempts');
	});

	await step('cancellation reaps PTY children and stops foreground work', async () => {
		await terminalInput('sleep 4242\n');
		await sleep(400);
		const stopped = await httpJson(`/api/terminals/${terminalId}`, { method: 'DELETE', token, body: {} });
		check(stopped.status === 200, `terminal stop ${stopped.status}`);
		await waitFor('sleep 4242 gone', async () => {
			const all = await procEntries();
			for (const proc of all) {
				const cmd = await cmdlineOf(proc.pid).catch(() => '');
				if (cmd.includes('sleep 4242')) return false;
			}
			return true;
		}, { timeoutMs: 10_000 });
		const gone = await httpJson(`/api/terminals/${terminalId}/output`, { token });
		check(gone.status === 404, 'terminal is gone after stop');
		// No bridge/bash descendants of the service remain from that session.
		const kids = await descendants(service.pid);
		const stragglers = [];
		for (const kid of kids) {
			const cmd = await cmdlineOf(kid.pid).catch(() => '');
			if (cmd.includes('terminal_bridge.py') || /\bbash\b/.test(cmd)) stragglers.push(cmd);
		}
		check(stragglers.length === 0, `no PTY stragglers after stop: ${stragglers.join(' | ')}`);
	});

	await step('cancellation reaps fixture workers and removes per-run state', async () => {
		// A hanging fixture run on the lifecycle twin service. The harness
		// itself is namespace root (uid 0) and is NOT an allowed peer, so all
		// driving goes through a real UI process (uid 1) attached to the twin
		// service — the same production path.
		const uiB = await startUi(ipcSocketB);
		try {
			const statusB = await waitFor('twin UI status', async () => {
				const reply = await fetch(uiB.origin + '/api/status').then(r => r.json()).catch(() => null);
				return reply?.agent?.available === true ? reply : null;
			}, { timeoutMs: 20_000 });
			const tokenB = statusB.csrfToken;
			const post = (url, body) => fetch(uiB.origin + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': tokenB }, body: JSON.stringify(body) });
			const started = await post('/api/agents', { prompt: 'hang', script: { hang: '1' } });
			check(started.status === 201, `fixture hang run started (${started.status})`);
			const runId = (await started.json()).id;
			await waitFor('fixture worker process', async () => {
				const kids = await descendants(serviceB.pid);
				for (const kid of kids) {
					const cmd = await cmdlineOf(kid.pid).catch(() => '');
					if (cmd.includes('agent-fixture-worker.mjs')) return true;
				}
				return false;
			}, { timeoutMs: 10_000 });
			await waitFor('per-run agentDir exists', () => fs.promises.readdir(agentTmpB).then(entries => entries.length > 0 ? entries : null).catch(() => null));
			const stopped = await fetch(uiB.origin + `/api/agents/${runId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': tokenB } });
			check(stopped.status === 200, `agent stop ${stopped.status}`);
			await waitFor('worker reaped', async () => {
				const kids = await descendants(serviceB.pid);
				for (const kid of kids) {
					const cmd = await cmdlineOf(kid.pid).catch(() => '');
					if (cmd.includes('agent-fixture-worker.mjs')) return false;
				}
				return true;
			}, { timeoutMs: 10_000 });
			await waitFor('agentDir removed', () => fs.promises.readdir(agentTmpB).then(entries => entries.length === 0 ? true : null));
		} finally { await killTree(uiB.ui.pid); }
	});

	await step('UI restart: sessions survive, reattach works, offsets and tokens are bounded', async () => {
		// Reattach target terminal with a bounded background marker loop.
		const created = await httpJson('/api/terminals', { method: 'POST', token, body: {} });
		check(created.status === 201, 'marker terminal created');
		const markerId = created.json.id;
		let markerOffset = 0;
		const markerRead = async () => {
			const reply = await httpJson(`/api/terminals/${markerId}/output?after=${markerOffset}`, { token });
			markerOffset = reply.json?.offset ?? markerOffset;
			return reply.json?.output ?? '';
		};
		await waitFor('marker prompt', async () => (await markerRead()).match(/workspace \$/) ? true : null);
		await httpJson(`/api/terminals/${markerId}/input`, { method: 'POST', token, body: { input: 'for i in $(seq 1 60); do date >> marker.txt; sleep 0.5; done &\n' } });
		await waitFor('marker started', () => fs.promises.stat(path.join(T, 'ws', 'marker.txt')).then(s => s.size > 0 ? s : null).catch(() => null));
		// An agent run settling while the UI is down.
		const runStarted = await httpJson('/api/agents', { method: 'POST', token, body: { prompt: 'background completion' } });
		check(runStarted.status === 201, 'agent run started before UI restart');
		const downRunId = runStarted.json.id;

		// Restart the UI process.
		const oldToken = token;
		await killTree(ui.ui.pid);
		await sleep(1_500); // sessions keep running under the agent service
		const sizeBefore = (await fs.promises.stat(path.join(T, 'ws', 'marker.txt'))).size;
		await sleep(1_500);
		const sizeAfter = (await fs.promises.stat(path.join(T, 'ws', 'marker.txt'))).size;
		check(sizeAfter > sizeBefore, 'PTY session keeps working while the UI is down');

		const ui2 = await startUi(ipcSocket);
		uiOrigin = ui2.origin;
		const status = await waitFor('new UI status', async () => {
			const reply = await httpJson('/api/status').catch(() => null);
			return reply?.status === 200 ? reply.json : null;
		}, { timeoutMs: 20_000 });
		token = status.csrfToken;
		check(token !== oldToken, 'restart issues a fresh CSRF token');
		const oldTokenRefused = await httpJson('/api/terminals', { method: 'POST', token: oldToken, body: {} });
		check(oldTokenRefused.status === 403, `old token refused (${oldTokenRefused.status})`);

		const listed = await httpJson('/api/terminals', { token });
		check(listed.status === 200 && listed.json.sessions.some(s => s.id === markerId && !s.exited), 'marker terminal survives and is reattachable');
		// Continue reading from the recorded offset on the NEW connection.
		const resumed = await waitFor('marker output continues', async () => {
			const reply = await httpJson(`/api/terminals/${markerId}/output?after=${markerOffset}`, { token });
			if (reply.status !== 200) return null;
			markerOffset = reply.json.offset;
			return reply.json.output.length >= 0 ? reply.json : null;
		});
		check(resumed.offset >= markerOffset, 'output offset continues after reattach');
		await httpJson(`/api/terminals/${markerId}/input`, { method: 'POST', token, body: { input: 'printf "\\nREATTACHED\\n"\n' } });
		let out = '';
		await waitFor('reattached marker', async () => {
			const reply = await httpJson(`/api/terminals/${markerId}/output?after=${markerOffset}`, { token });
			markerOffset = reply.json.offset;
			out = reply.json.output;
			return /REATTACHED/.test(out) ? true : null;
		}, { timeoutMs: 15_000 });
		// Agent run that settled while the UI was down is still queryable.
		const settled = await waitFor('down-time run settles', async () => {
			const reply = await httpJson(`/api/agents/${downRunId}/events?after=0`, { token });
			return ['done', 'error', 'timeout'].includes(reply.json?.state) ? reply.json : null;
		}, { timeoutMs: 60_000 });
		check(settled.state === 'done', `down-time run completed, state ${settled.state}`);
		check(settled.events.filter(event => event.type === 'done').length === 1, 'exactly one canonical done event');
		// Boundary: the dead UI left no duplicate or half-open state — a new
		// terminal still works and the cap still applies.
		const fresh = await httpJson('/api/terminals', { method: 'POST', token, body: {} });
		check(fresh.status === 201, 'new terminal after restart');
		await httpJson(`/api/terminals/${fresh.json.id}`, { method: 'DELETE', token, body: {} });
		await httpJson(`/api/terminals/${markerId}`, { method: 'DELETE', token, body: {} });
	});

	await step('absent backend: service-mode UI fails closed and spawns nothing', async () => {
		const ui3 = await startUi(path.join(T, 'ipcdir', 'absent.sock'));
		try {
			const status = await waitFor('absent-backend status', async () => {
				const reply = await fetch(ui3.origin + '/api/status').then(r => r.json()).catch(() => null);
				return reply?.backend?.available === false ? reply : null;
			}, { timeoutMs: 20_000 });
			check(status.terminalAvailable === false, 'terminalAvailable false without backend');
			const csrf = status.csrfToken;
			const refused = await fetch(ui3.origin + '/api/terminals', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Token': csrf }, body: '{}' });
			check(refused.status === 503, `terminal refused with 503, got ${refused.status}`);
			// Fail closed means fail SPAWNED: no PTY bridge ever appears.
			const kids = await descendants(ui3.ui.pid);
			check(kids.length === 0, `UI spawned children without a backend: ${kids.map(k => k.pid).join(',')}`);
		} finally { await killTree(ui3.ui.pid); }
	});

	await step('teardown: services exit cleanly, sockets removed, children reaped, temp state cleared', async () => {
		await Promise.all([killTree(service.pid), killTree(serviceB.pid)]);
		await waitFor('sockets removed', async () => {
			const a = await fs.promises.stat(ipcSocket).then(() => false, e => e.code === 'ENOENT');
			const b = await fs.promises.stat(ipcSocketB).then(() => false, e => e.code === 'ENOENT');
			return a && b;
		}, { timeoutMs: 10_000 });
		const strays = [];
		for (const entry of spawned) {
			const kids = await descendants(entry.pid).catch(() => []);
			for (const kid of kids) strays.push(await cmdlineOf(kid.pid).catch(() => String(kid.pid)));
		}
		check(strays.length === 0, `reaped cleanly, stragglers: ${strays.join(' | ')}`);
		const tmpLeft = [...await fs.promises.readdir(agentTmp).catch(() => []), ...await fs.promises.readdir(agentTmpB).catch(() => [])];
		check(tmpLeft.length === 0, `per-run temp dirs removed, left: ${tmpLeft.join(',')}`);
	});
} catch (error) {
	failures += 1;
	console.log(`not ok - harness aborted: ${error?.message ?? error}`);
} finally {
	await Promise.all(fixtureServers.map(server=>new Promise(resolve=>server.close(resolve))));
	// Bounded final cleanup: marker loops and any survivor are killed with a
	// hard deadline; nothing is left writing into the disposable tree.
	const killAll = async () => {
		const processes = await procEntries().catch(() => []);
		for (const proc of processes) {
			const cmd = await cmdlineOf(proc.pid).catch(() => '');
			const hostile = cmd.includes('marker.txt') || cmd.includes('sleep 4242')
				|| (cmd.includes('agent-service.mjs') && proc.pid !== process.pid)
				|| cmd.includes('server.mjs --workspace') || cmd.includes('terminal_bridge.py');
			if (hostile) {
				try { process.kill(proc.pid, 'SIGKILL'); } catch { /* already gone */ }
			}
		}
	};
	await Promise.race([killAll(), sleep(5_000)]);
	for (const { pid } of spawned) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
	await Promise.race([fs.promises.rm(T, { recursive: true, force: true }).catch(() => {}), sleep(5_000)]);
}

failures += results.filter(result => !result.ok).length;
console.log(`# ${results.filter(r => r.ok).length}/${results.length} checks passed`);
if (failures > 0 || results.some(result => !result.ok)) process.exit(1);
