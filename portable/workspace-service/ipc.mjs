// Bounded IPC wire protocol shared by the portable-agent service
// (agent-service.mjs) and the trusted UI's backend client
// (backend-client.mjs).
//
// Transport: one Unix domain socket provided by the portable-agent service.
// Authentication is KERNEL-ONLY: the service checks the connecting peer's
// real uid via SO_PEERCRED (see peer-cred.mjs) before any frame is read.
// There is deliberately NO uid, token or credential field anywhere in this
// protocol: a caller-supplied identity is never accepted as authentication.
//
// Wire format: newline-terminated JSON frames in both directions, each
// frame bounded by maxFrameBytes. Requests carry a caller-chosen integer
// `rid`; replies echo it. A connection that sends a non-JSON frame, an
// oversized frame, or a reply-less protocol violation is destroyed —
// the protocol fails closed.
export const IPC_SERVICE_NAME = 'portable-agent';
export const IPC_PROTOCOL_VERSION = 1;

export const IPC_LIMITS = {
	// Large enough for the biggest legitimate reply (a full bounded event or
	// output window plus JSON envelope), small enough to bound memory.
	maxFrameBytes: 1024 * 1024,
	// Concurrent in-flight requests per connection; a client may multiplex
	// terminal/agent polls, not unbounded parallelism.
	maxInflightPerConnection: 16,
	// Total simultaneous authenticated connections.
	maxConnections: 16,
	// A connection that sends nothing for this long is destroyed.
	idleTimeoutMs: 10 * 60 * 1000,
};

export const IPC_OPS = new Set([
	'status',
	'files.list',
	'files.read',
	'terminals.create',
	'terminals.list',
	'terminals.input',
	'terminals.output',
	'terminals.stop',
	'agents.status',
	'agents.start',
	'agents.list',
	'agents.events',
	'agents.stop',
]);

// Request field allowlists per operation: a caller may not smuggle
// parameters outside the operation's schema (notably no cwd, no worker
// path, no environment — the workspace is service-side authority).
export const IPC_REQUEST_FIELDS = {
	'status': [],
	'files.list': ['path'],
	'files.read': ['path'],
	'terminals.create': [],
	'terminals.list': [],
	'terminals.input': ['id', 'input'],
	'terminals.output': ['id', 'after'],
	'terminals.stop': ['id'],
	'agents.status': [],
	'agents.start': ['prompt', 'script'],
	'agents.list': [],
	'agents.events': ['id', 'after'],
	'agents.stop': ['id'],
};

export const encodeFrame = value => JSON.stringify(value) + '\n';

// Parses one newline-terminated frame from a running buffer. Returns
// { frames: [...], remainder } — frames longer than maxFrameBytes are
// reported as { violation: 'oversize' } and the caller must destroy the
// connection.
export function takeFrames(buffer, maxFrameBytes = IPC_LIMITS.maxFrameBytes) {
	const frames = [];
	let rest = buffer;
	for (;;) {
		const index = rest.indexOf('\n');
		if (index < 0) break;
		const line = rest.slice(0, index);
		rest = rest.slice(index + 1);
		if (line.length > maxFrameBytes) return { frames, remainder: rest, violation: 'oversize' };
		frames.push(line);
	}
	if (rest.length > maxFrameBytes) return { frames, remainder: rest, violation: 'oversize' };
	return { frames, remainder: rest, violation: null };
}

export function parseRequest(line) {
	let request;
	try { request = JSON.parse(line); } catch { return { error: 'malformed' }; }
	if (!request || typeof request !== 'object' || Array.isArray(request)) return { error: 'malformed' };
	if (!Number.isSafeInteger(request.rid) || request.rid < 0) return { error: 'malformed' };
	if (typeof request.op !== 'string' || !IPC_OPS.has(request.op)) return { error: 'unknown_op', rid: request.rid, op: request.op };
	const allowed = IPC_REQUEST_FIELDS[request.op];
	for (const key of Object.keys(request)) {
		if (key !== 'op' && key !== 'rid' && !allowed.includes(key)) return { error: 'invalid_request', rid: request.rid, op: request.op };
	}
	return { request };
}

export const replyOk = (rid, result = {}) => JSON.stringify({ rid, ok: true, ...result }) + '\n';
export const replyError = (rid, code, message) => JSON.stringify({ rid, ok: false, error: { code, message: message ?? code } }) + '\n';
