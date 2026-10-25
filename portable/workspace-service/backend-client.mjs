// Backend client for the trusted portable-ui workspace server.
//
// Connects the HTTP server (server.mjs) to the separate portable-agent
// service over the bounded IPC protocol in ipc.mjs. Every request has a
// hard deadline: on timeout the socket is destroyed BEFORE anything is
// awaited and the request fails — the server then refuses that operation
// (fail closed); it never falls back to spawning anything itself.
//
// Client-side defense: before connecting, the socket path is verified to be
// a socket owned by the expected service uid (when configured). Identity is
// never taken from the protocol — the service proves itself by owning the
// socket in a directory only it can write, and the service authenticates
// the UI by kernel peer uid. No uid or token travels in either direction.
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IPC_LIMITS, encodeFrame } from './ipc.mjs';

export class BackendUnavailableError extends Error {
	constructor(message, code = 'backend-unavailable') { super(message); this.code = code; }
}

export function createBackendClient(options = {}) {
	const {
		socketPath,
		expectedSocketUid = null,
		connectTimeoutMs = 5_000,
		requestTimeoutMs = 30_000,
		maxFrameBytes = IPC_LIMITS.maxFrameBytes,
	} = options;
	if (!socketPath || !path.isAbsolute(socketPath)) throw new Error('An explicit absolute backend socket path is required');
	if (expectedSocketUid !== null && !Number.isSafeInteger(expectedSocketUid)) throw new Error('expectedSocketUid must be numeric when provided');

	let socket = null;
	let connecting = null;
	let buffer = '';
	let nextRid = 1;
	const pending = new Map(); // rid -> { resolve, reject, timer }
	let closed = false;

	const failPending = error => {
		for (const [, entry] of pending) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		pending.clear();
	};

	const teardown = () => {
		// Destroy BEFORE any await: a wedged socket never keeps a request
		// hanging past its own deadline.
		if (socket) { const s = socket; socket = null; s.destroy(); }
		buffer = '';
		failPending(new BackendUnavailableError('backend connection was closed'));
	};

	const handleFrame = line => {
		let reply;
		try { reply = JSON.parse(line); } catch { teardown(); return; }
		if (!reply || typeof reply !== 'object' || !Number.isSafeInteger(reply.rid)) { teardown(); return; }
		const entry = pending.get(reply.rid);
		if (!entry) return; // reply to an already-timed-out request: ignore
		pending.delete(reply.rid);
		clearTimeout(entry.timer);
		if (reply.ok === true) entry.resolve(reply);
		else entry.reject(Object.assign(new Error(reply.error?.message ?? 'backend error'), { code: reply.error?.code ?? 'backend-error', ipcError: reply.error }));
	};

	const ensureSocket = () => {
		if (closed) return Promise.reject(new BackendUnavailableError('backend client is closed'));
		if (socket && !socket.destroyed) return Promise.resolve(socket);
		if (connecting) return connecting;
		connecting = (async () => {
			// Filesystem-layer verification first: the backend socket must be
			// an actual socket and (when configured) owned by the expected
			// service uid. A swapped or foreign socket is refused before any
			// byte is sent.
			const info = await fs.lstat(socketPath).catch(error => { throw new BackendUnavailableError(error.code === 'ENOENT' ? 'agent backend socket is absent' : `agent backend socket is unreachable: ${error.message}`); });
			if (!info.isSocket()) throw new BackendUnavailableError('backend path is not a socket');
			if (expectedSocketUid !== null && info.uid !== expectedSocketUid) {
				throw new BackendUnavailableError(`backend socket owner uid ${info.uid} is not the expected agent uid ${expectedSocketUid}`);
			}
			const s = net.connect(socketPath);
			s.setNoDelay?.(true);
			await new Promise((resolveConnect, rejectConnect) => {
				const timer = setTimeout(() => { s.destroy(); rejectConnect(new BackendUnavailableError('backend connect timed out')); }, connectTimeoutMs);
				s.once('connect', () => { clearTimeout(timer); resolveConnect(); });
				s.once('error', error => { clearTimeout(timer); rejectConnect(new BackendUnavailableError(`backend connect failed: ${error.message}`)); });
			});
			s.setEncoding('utf8');
			s.on('data', chunk => {
				buffer += chunk;
				if (buffer.length > maxFrameBytes) { teardown(); return; }
				for (;;) {
					const index = buffer.indexOf('\n');
					if (index < 0) break;
					const line = buffer.slice(0, index);
					buffer = buffer.slice(index + 1);
					if (line.length > maxFrameBytes) { teardown(); return; }
					handleFrame(line);
				}
			});
			s.on('error', () => teardown());
			s.on('close', () => { if (socket === s) teardown(); else if (!s.destroyed) s.destroy(); });
			socket = s;
			return s;
		})();
		const done = () => { connecting = null; };
		connecting.then(done, done);
		return connecting;
	};

	// Bounded request with rid correlation over one persistent connection.
	const request = (op, params = {}) => new Promise((resolve, reject) => {
		ensureSocket().then(() => {
			if (closed || !socket || socket.destroyed) return reject(new BackendUnavailableError('backend connection is closed'));
			const rid = nextRid++;
			const timer = setTimeout(() => {
				// Deadline: destroy the socket first, then fail the caller.
				pending.delete(rid);
				teardown();
				reject(new BackendUnavailableError(`backend request '${op}' timed out`));
			}, requestTimeoutMs);
			pending.set(rid, { resolve, reject, timer });
			try { socket.write(encodeFrame({ op, rid, ...params })); }
			catch (error) { pending.delete(rid); clearTimeout(timer); teardown(); reject(new BackendUnavailableError(`backend write failed: ${error.message}`)); }
		}, reject);
	});

	const close = async () => {
		closed = true;
		teardown();
	};

	return { request, close, socketPath };
}
