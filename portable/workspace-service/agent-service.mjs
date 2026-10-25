import { createWorkspaceFiles } from './workspace-files.mjs';
// Portable workspace agent service — the separate portable-agent backend.
//
// This daemon OWNS the real execution authority of the portable workspace:
// Linux PTY terminal sessions and the Pi SDK agent workers. It runs as the
// dedicated nologin `portable-agent` account, which is a member of NO
// operator, credit or vault group — its only shared surface is the explicit
// IPC group (socket reachability). The trusted UI (portable-ui) keeps the
// HTTP server and the loopback origin/CSRF checks;
// it reaches this service exclusively over the bounded Unix socket protocol
// in ipc.mjs, authenticated with the KERNEL's SO_PEERCRED peer uid. The
// service never inherits anything from the UI process: it is a separately
// started process (systemd unit or a test launcher) with its own
// environment, descriptors and uid.
//
// What is deliberately NOT here:
// - No vault lifecycle client, no broker socket access, no credit files.
//   Neither this agent nor the HTTP UI has vault lifecycle or credit authority;
//   the separate credit/operator identity owns those capabilities. Group
//   separation prevents the desktop accounts from reaching that authority.
// - No uid/token field in the protocol: a caller-supplied identity is
//   never authentication; only SO_PEERCRED decides.
// - No duplicated fork/SDK lifecycle: PTY sessions come from
//   portable/workspace/terminal-manager.mjs and agent runs from
//   portable/workspace/agent-manager.mjs — the same managers the
//   direct-launch developer server uses.
//
// Offline protocol tests run the service under the same uid only with the
// explicit constructor flag `testingAllowSameUid` (never settable from the
// environment or the protocol); the production path refuses to start when
// the service uid equals an allowed client uid.
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentManager } from '../workspace/agent-manager.mjs';
import { createTerminalManager } from '../workspace/terminal-manager.mjs';
import { IPC_SERVICE_NAME, IPC_PROTOCOL_VERSION, IPC_LIMITS, parseRequest, replyOk, replyError } from './ipc.mjs';
import { peerCredential, resolveUid, resolveGid } from './syscred.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultWorkerPath = path.resolve(here, '..', 'workspace', 'agent-worker.mjs');
const fixtureWorkerPath = path.resolve(here, '..', 'workspace', 'agent-fixture-worker.mjs');

const agentScriptKeys = ['toolName', 'path', 'content', 'finalText', 'reportEnv', 'slow', 'flood', 'hang', 'proofPath', 'proofContent', 'oversize', 'revive', 'doneThenHang', 'doneThenExit', 'doneThenExit0', 'doneThenAbort', 'exitDelayMs', 'exit0NoDone'];

function usage(code = 2) {
	process.stderr.write([
		'Usage: agent-service.mjs --workspace DIR --socket PATH --allow-uid UID[,UID...]',
		'                        [--group GID_OR_NAME] [--worker sdk|fixture|PATH]',
		'                        [--inference-socket PATH] [--allow-script] [--max-agents N] [--run-timeout-ms MS] [--probe-timeout-ms MS]',
		'',
		'  --workspace    absolute disposable workspace the PTYs and workers act on',
		'  --socket       absolute Unix socket path the trusted UI connects to',
		'  --allow-uid    the only peer uids (kernel SO_PEERCRED) that may connect;',
		'                 numeric ids or account names. Never a protocol field.',
		'  --group        explicit shared IPC group (numeric gid or name) the socket',
		'                 is granted to; the service uid must be a member or own it',
		'  --worker       agent worker: sdk (default), fixture, or an absolute path',
		'  --inference-socket explicit supervisor-owned broker path; never a request field',
		'  --allow-script admit the fixture script knobs on agents.start (tests only)',
		'',
		'The service refuses to start when its own uid is an allowed client uid',
		'(unless the in-process testingAllowSameUid constructor flag is set).',
	].join('\n') + '\n');
	process.exit(code);
}

export function createAgentService(options = {}) {
	const {
		workspace,
		socketPath,
		allowedUids,
		ipcGid = null,
		workerPath = defaultWorkerPath,
		allowScript = false,
		inferenceSocket = null,
		managerOptions = {},
		terminalOptions = {},
		peerCred = peerCredential,
		testingAllowSameUid = false,
		limits = {},
	} = options;
	if (!workspace || !path.isAbsolute(workspace)) throw new Error('An explicit absolute workspace is required');
	if (!socketPath || !path.isAbsolute(socketPath)) throw new Error('An explicit absolute socket path is required');
	if (!Array.isArray(allowedUids) || allowedUids.length === 0 || !allowedUids.every(uid => Number.isSafeInteger(uid) && uid >= 0)) {
		throw new Error('allowedUids must be a non-empty array of numeric uids');
	}
	if (ipcGid !== null && !Number.isSafeInteger(ipcGid)) throw new Error('ipcGid must be numeric when provided');
	if (!testingAllowSameUid && allowedUids.includes(process.getuid())) {
		throw new Error('The agent service must run under a uid separate from the trusted UI; refusing to start as an allowed client uid');
	}
	const maxConnections = limits.maxConnections ?? IPC_LIMITS.maxConnections;
	const maxInflight = limits.maxInflightPerConnection ?? IPC_LIMITS.maxInflightPerConnection;
	const idleTimeoutMs = limits.idleTimeoutMs ?? IPC_LIMITS.idleTimeoutMs;
	const maxFrameBytes = limits.maxFrameBytes ?? IPC_LIMITS.maxFrameBytes;

	const terminals = createTerminalManager({ workspace, ...terminalOptions });
	const configuredInferenceSocket = inferenceSocket ?? managerOptions.inferenceSocket ?? null;
	if (configuredInferenceSocket !== null && allowScript) throw new Error('Broker mode cannot admit scripted jobs');
	const agents = createAgentManager({ workspace, workerPath, ...managerOptions, inferenceSocket: configuredInferenceSocket });
	const files = createWorkspaceFiles(workspace);
	const allowed = new Set(allowedUids);
	let server = null;
	let socketInode = null;
	let stopping = false;
	const connections = new Set();

	const attach = conn => {
		connections.add(conn);
		conn.setEncoding('utf8');
		let buffer = '';
		let inflight = 0;
		let idleTimer = null;
		const resetIdle = () => {
			clearTimeout(idleTimer);
			idleTimer = setTimeout(() => conn.destroy(), idleTimeoutMs);
			idleTimer.unref?.();
		};
		resetIdle();
		conn.on('close', () => { clearTimeout(idleTimer); connections.delete(conn); });
		conn.on('error', () => { conn.destroy(); });
		conn.on('data', chunk => {
			resetIdle();
			buffer += chunk;
			if (buffer.length > maxFrameBytes) return conn.destroy();
			for (;;) {
				const index = buffer.indexOf('\n');
				if (index < 0) break;
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (line.length > maxFrameBytes) return conn.destroy();
				const parsed = parseRequest(line);
				if (parsed.error === 'malformed') return conn.destroy();
				if (parsed.error === 'unknown_op' || parsed.error === 'invalid_request') {
					conn.write(replyError(parsed.rid, parsed.error,
						parsed.error === 'unknown_op' ? 'no such operation' : `field not accepted for ${parsed.op}`));
					continue;
				}
				if (inflight >= maxInflight) {
					conn.write(replyError(parsed.request.rid, 'busy', 'too many concurrent requests on this connection'));
					continue;
				}
				inflight += 1;
				handle(parsed.request)
					.then(reply => { if (!conn.destroyed) conn.write(reply); })
					.catch(() => { if (!conn.destroyed) conn.write(replyError(parsed.request.rid, 'internal', 'operation failed')); })
					.finally(() => { inflight -= 1; });
			}
		});
	};

	// One bounded handler per operation. Anything thrown is mapped to an
	// internal error reply; typed errors from the managers keep their codes
	// so the UI maps them to the same HTTP responses as direct mode.
	const handle = async request => {
		const { op, rid } = request;
		switch (op) {
			case 'files.list':
			case 'files.read': {
				try { return replyOk(rid, await files.request(op.slice(6), request.path)); }
				catch (error) { return replyError(rid, error.code ?? 'unavailable', 'Workspace files unavailable: ' + (error.code ?? 'unavailable')); }
			}
			case 'status': {
				const agent = agents.readiness();
				return replyOk(rid, { service: IPC_SERVICE_NAME, version: IPC_PROTOCOL_VERSION, terminalAvailable: true, agent });
			}
			case 'terminals.create': {
				try { return replyOk(rid, terminals.create()); }
				catch (error) { return replyError(rid, error.code === 'TERMINAL_CAPACITY' ? 'capacity' : 'closing', error.message); }
			}
			case 'terminals.list': return replyOk(rid, { sessions: terminals.list() });
			case 'terminals.input': {
				const result = terminals.input(request.id, request.input);
				if (result.error === 'not_found') return replyError(rid, 'not_found', 'Terminal not found');
				if (result.error === 'invalid_input') return replyError(rid, 'invalid_request', 'Invalid input');
				if (result.error === 'busy') return replyError(rid, 'busy', 'Terminal is closed or busy');
				return replyOk(rid);
			}
			case 'terminals.output': {
				const result = terminals.output(request.id, request.after);
				if (result === null) return replyError(rid, 'not_found', 'Terminal not found');
				if (result.error === 'invalid_offset') return replyError(rid, 'invalid_request', 'Invalid offset');
				return replyOk(rid, result);
			}
			case 'terminals.stop':
				return replyOk(rid, { ok: await terminals.stop(request.id) });
			case 'agents.status': {
				const agent = agents.readiness();
				return replyOk(rid, { agent });
			}
			case 'agents.start': {
				if (configuredInferenceSocket !== null && Object.hasOwn(request, 'script')) return replyError(rid, 'invalid_request', 'script knobs are not admitted by broker mode');

				if (typeof request.prompt !== 'string' || !request.prompt.trim() || Buffer.byteLength(request.prompt) > 8192) {
					return replyError(rid, 'invalid_request', 'Prompt must be a non-empty string of at most 8192 bytes');
				}
				let script = null;
				if (request.script !== undefined && request.script !== null) {
					if (!allowScript) return replyError(rid, 'invalid_request', 'script knobs are not admitted by this service');
					if (typeof request.script !== 'object' || Array.isArray(request.script)) return replyError(rid, 'invalid_request', 'Invalid script');
					const keys = Object.keys(request.script);
					if (keys.length > 6 || keys.some(key => !agentScriptKeys.includes(key) || typeof request.script[key] !== 'string' || Buffer.byteLength(request.script[key]) > 2000)) {
						return replyError(rid, 'invalid_request', 'Invalid script fields');
					}
					script = request.script;
				}
				try {
				const readiness = agents.readiness();
				if (!readiness.available) return replyError(rid, 'not-ready', readiness.state === 'warming' ? 'Agent SDK warming' : 'Agent SDK unavailable; readiness retry is bounded');
					const { id } = await agents.start({ prompt: request.prompt, ...(script !== null ? { script } : {}) });
					return replyOk(rid, { id });
				} catch (error) {
					const code = error.code === 'AGENT_CAPACITY' ? 'capacity' : error.code === 'AGENT_CLOSING' ? 'closing' : 'unavailable';
					return replyError(rid, code, error.message);
				}
			}
			case 'agents.list': return replyOk(rid, { agents: agents.list() });
			case 'agents.events': {
				let result;
				try { result = agents.events(request.id, request.after); }
				catch { return replyError(rid, 'invalid_request', 'Invalid offset'); }
				if (result === null) return replyError(rid, 'not_found', 'Agent run not found');
				return replyOk(rid, result);
			}
			case 'agents.stop':
				return replyOk(rid, { ok: await agents.stop(request.id) });
			default:
				return replyError(rid, 'unknown_op', 'no such operation');
		}
	};

	const probeStaleSocket = async () => {
		const info = await fs.lstat(socketPath).then(s => s, e => { if (e.code !== 'ENOENT') throw e; return null; });
		if (!info) return;
		if (!info.isSocket()) throw new Error('socket path exists and is not a socket');
		const live = await new Promise(resolve => {
			const probe = net.connect(socketPath);
			const done = value => { probe.destroy(); resolve(value); };
			probe.on('connect', () => done(true));
			probe.on('error', e => done(e.code === 'ECONNREFUSED' ? false : true));
			const timer = setTimeout(() => done(true), 500);
			timer.unref?.();
			void probe.setTimeout?.(500, () => done(true));
		});
		if (live) throw new Error('socket path is already served by a live service; refusing to take it over');
		await fs.unlink(socketPath);
	};

	const start = async () => {
		if (server) throw new Error('agent service already started');
		if (stopping) throw new Error('agent service is stopping');
		await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
		const dir = await fs.lstat(path.dirname(socketPath));
		const dirReal = await fs.realpath(path.dirname(socketPath));
		if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o022) !== 0 || dirReal !== path.dirname(socketPath)) {
			throw new Error('socket directory must be an owned directory without group/world write and without symlinks');
		}
		await probeStaleSocket();
		await files.start();
		server = net.createServer({ allowHalfOpen: false }, conn => {
			if (connections.size >= maxConnections) return conn.destroy();
			// Authentication happens BEFORE any byte of protocol is read:
			// the kernel peer uid must be an allowed UI uid. The connection
			// stays paused until the check cleanly passes; any failure —
			// helper error, timeout, unknown uid — destroys it (fail closed).
			connections.add(conn);
			conn.once('close', () => connections.delete(conn));
			conn.on('error', () => conn.destroy());
			conn.pause();
			const fd = conn._handle?.fd;
			if (!Number.isInteger(fd)) return conn.destroy();
			const credentialAbort = new AbortController();
			conn.once('close', () => credentialAbort.abort());
			peerCred(fd, { signal: credentialAbort.signal })
				.then(cred => {
					if (!cred || !allowed.has(cred.uid)) { conn.destroy(); return; }
					if (stopping || conn.destroyed) { conn.destroy(); return; }
					attach(conn);
					conn.resume();
				})
				.catch(() => conn.destroy());
		});
		server.on('error', () => { /* surfaced via listen failure paths */ });
		await new Promise((resolveListen, rejectListen) => {
			server.once('error', rejectListen);
			server.listen(socketPath, 8, async () => {
				try {
					await fs.chmod(socketPath, 0o660);
					if (ipcGid !== null) await fs.chown(socketPath, process.getuid(), ipcGid).catch(async error => {
						// chown to a group we do not belong to is not permitted;
						// a service configured with --group must be a member.
						throw new Error(`cannot grant the socket to group ${ipcGid}: ${error.message}`);
					});
					const info = await fs.lstat(socketPath);
					if (!info.isSocket() || info.uid !== process.getuid() || (ipcGid !== null && info.gid !== ipcGid) || (info.mode & 0o777) !== 0o660) {
						throw new Error('socket verification failed after setup (owner/group/mode)');
					}
					socketInode = info.ino;
					resolveListen();
				} catch (error) { rejectListen(error); }
			});
		}).catch(async error => {
			// Fail closed: never leave a bound socket behind on setup failure.
			const closing = server;
			server = null;
			for (const conn of connections) conn.destroy();
			await new Promise(resolveClose => closing.close(() => resolveClose()));
			try { const info = await fs.lstat(socketPath); if (info.isSocket()) await fs.unlink(socketPath); } catch { /* already gone */ }
			await files.close();
			throw error;
		});
		return { socketPath, service: IPC_SERVICE_NAME, version: IPC_PROTOCOL_VERSION };
	};

	let stoppedResolve = null;
	let stopPromise = null;
	const stop = () => {
		if (stopPromise) return stopPromise;
		if (!server) return Promise.resolve();
		stopping = true;
		const closing = server;
		server = null;
		// Publish the shared outcome before any cleanup callback can reenter stop.
		stopPromise = Promise.resolve().then(async () => {
			for (const conn of connections) conn.destroy();
			connections.clear();
			const cleanupSocket = async () => {
				await new Promise(resolveClose => closing.close(() => resolveClose()));
				const info = await fs.lstat(socketPath).then(s => s, e => { if (e.code !== 'ENOENT') throw e; return null; });
				if (info && info.isSocket() && info.ino === socketInode) await fs.unlink(socketPath);
				socketInode = null;
			};
			// A failed reaper must never skip another owner's children or report clean.
			const results = await Promise.allSettled([cleanupSocket, () => files.close(), () => terminals.close(), () => agents.close()].map(cleanup => Promise.resolve().then(cleanup)));
			const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
			if (failures.length) throw new AggregateError(failures, 'Agent service cleanup failed');
			if (stoppedResolve) stoppedResolve();
		});
		return stopPromise;
	};

	return { start, stop, socketPath, workspace };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const parseList = value => value.split(',').map(item => item.trim()).filter(Boolean);

export async function main(argv) {
	const args = argv.slice(2);
	const value = name => {
		const index = args.indexOf(name);
		if (index < 0 || index + 1 >= args.length) return null;
		return args[index + 1];
	};
	if (args.includes('--help')) usage(0);
	const workspace = value('--workspace');
	const socketPath = value('--socket');
	const allowUidSpec = value('--allow-uid');
	if (!workspace || !socketPath || !allowUidSpec) usage(2);
	const workerChoice = value('--worker') ?? 'sdk';
	const workerPath = workerChoice === 'sdk' ? defaultWorkerPath : workerChoice === 'fixture' ? fixtureWorkerPath : workerChoice;
	if (!path.isAbsolute(workerPath)) usage(2);
	const allowedUids = [];
	for (const spec of parseList(allowUidSpec)) allowedUids.push(await resolveUid(spec));
	const groupSpec = value('--group');
	const ipcGid = groupSpec === null ? null : await resolveGid(groupSpec);
	const runTimeout = value('--run-timeout-ms');
	const maxAgents = value('--max-agents');
	const probeTimeout = value('--probe-timeout-ms');
	const inferenceSocket = value('--inference-socket');
	if (args.includes('--inference-socket') && inferenceSocket === null) throw new Error('Missing inference-socket');
	if (args.includes('--probe-timeout-ms') && probeTimeout === null) throw new Error('Missing probe-timeout-ms');
	if (probeTimeout !== null && (!/^\d+$/.test(probeTimeout) || Number(probeTimeout)<1000 || Number(probeTimeout)>120000)) throw new Error('probe-timeout-ms must be 1000..120000');
	const service = createAgentService({
		workspace,
		socketPath,
		allowedUids,
		ipcGid,
		workerPath,
		allowScript: args.includes('--allow-script'),
		inferenceSocket,
		managerOptions: {
			...(runTimeout ? { runTimeoutMs: Number(runTimeout) } : {}),
			...(maxAgents ? { maxAgents: Number(maxAgents) } : {}),
			...(probeTimeout ? { probeTimeoutMs: Number(probeTimeout) } : {}),
		},
	});
	await service.start();
	process.stderr.write(`${IPC_SERVICE_NAME} service listening on ${socketPath} (allowed peer uids: ${allowedUids.join(',')}${ipcGid !== null ? `, ipc gid: ${ipcGid}` : ''})\n`);
	let stoppingMain = false;
	const shutdown = signal => {
		if (stoppingMain) return;
		stoppingMain = true;
		service.stop().then(() => process.exit(0)).catch(() => process.exit(1));
		// Hard kill-after deadline: teardown is destroy-first and bounded,
		// but the process itself may never hang past this either.
		setTimeout(() => process.exit(1), 35_000).unref?.();
		void signal;
	};
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
	return service;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv).catch(error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
}
