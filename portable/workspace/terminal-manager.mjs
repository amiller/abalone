// Terminal session lifecycle for the portable workspace server.
//
// Extracted from server.mjs so the SAME lifecycle code backs both the
// direct-launch developer server and the separate portable-agent service
// (portable/workspace-service/agent-service.mjs): PTY helpers are spawned
// exactly once per session and every consumer keeps the original semantics.
//
// Semantics preserved from the original inline implementation:
// - One real Linux PTY per session via terminal_bridge.py (python3 -I).
// - At most maxSessions concurrent sessions; output is bounded in memory
//   (outputLimit bytes) with a monotonically increasing absolute offset and
//   a `truncated` marker when old bytes were dropped, exactly like the
//   agent event stream.
// - Input is a raw byte stream (terminal control characters included); a
//   session whose input pipe is backed up refuses further input.
// - `list()` exposes surviving sessions so a reloaded UI can reattach
//   instead of leaking sessions until the cap.
// - `stop(id)` now additionally awaits the helper's exit with a hard
//   deadline and kill escalation, so callers (HTTP or IPC) only observe a
//   session as closed once its PTY foreground job was actually hung up and
//   reaped. `close()` stops and reaps every session the same way.
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.join(here, 'terminal_bridge.py');

export function createTerminalManager(options = {}) {
	const {
		workspace,
		maxSessions = 8,
		outputLimit = 256 * 1024,
		maxInputBytes = 8192,
		maxPendingInput = 65536,
		exitTimeoutMs = 5_000,
	} = options;
	if (!workspace || !path.isAbsolute(workspace)) throw new Error('An explicit absolute workspace is required');

	const sessions = new Map();
	let closing = false;

	// Hang up the helper and await its actual exit with escalation. The
	// bridge kills the PTY's foreground process group on stdin EOF, closes
	// the master (kernel SIGHUP to the session) and reaps its child; the
	// deadline covers a wedged helper so no live child is ever abandoned.
	const hangUp = terminal => new Promise(resolve => {
		const child = terminal.child;
		if (child.exitCode !== null || child.signalCode !== null) return resolve();
		let settled = false;
		const finish = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
		const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* already gone */ } }, exitTimeoutMs);
		child.once('close', finish);
		child.once('error', finish);
		try { child.stdin.end(); } catch { /* already closed; close handler owns the record */ }
		// Belt and braces: if stdin.end() did not reach the helper (pipe
		// already broken), terminate directly after the same deadline.
		setTimeout(() => { try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* already gone */ } }, exitTimeoutMs + 2000).unref?.();
	});

	const create = () => {
		if (closing) { const error = new Error('Terminal manager is closing; no new sessions are accepted'); error.code = 'TERMINAL_CLOSING'; throw error; }
		if (sessions.size >= maxSessions) { const error = new Error(`Close a terminal before opening another (at most ${maxSessions})`); error.code = 'TERMINAL_CAPACITY'; throw error; }
		const id = crypto.randomUUID();
		const child = spawn('python3', ['-I', bridgePath, workspace], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}) } });
		const terminal = { child, output: '', base: 0, exited: false, exiting: null };
		child.stdout.setEncoding('utf8');
		const append = data => {
			terminal.output += data;
			if (terminal.output.length > outputLimit) {
				const remove = terminal.output.length - outputLimit;
				terminal.output = terminal.output.slice(remove);
				terminal.base += remove;
			}
		};
		child.stdout.on('data', append);
		child.stderr.on('data', data => append(String(data)));
		child.stdin.on('error', () => {});
		child.on('error', error => { append(`Terminal unavailable: ${error.message}`); terminal.exited = true; });
		child.on('close', () => { terminal.exited = true; });
		sessions.set(id, terminal);
		return { id };
	};

	const input = (id, value) => {
		const terminal = sessions.get(id);
		if (!terminal) return { error: 'not_found' };
		if (typeof value !== 'string' || Buffer.byteLength(value) > maxInputBytes) return { error: 'invalid_input' };
		if (terminal.exited || terminal.exiting || terminal.child.stdin.writableLength > maxPendingInput) return { error: 'busy' };
		terminal.child.stdin.write(JSON.stringify({ input: value }) + '\n');
		return { ok: true };
	};

	const output = (id, after) => {
		const terminal = sessions.get(id);
		if (!terminal) return null;
		if (!Number.isSafeInteger(after) || after < 0) return { error: 'invalid_offset' };
		return {
			output: terminal.output.slice(Math.max(0, after - terminal.base)),
			offset: terminal.base + terminal.output.length,
			exited: terminal.exited,
			truncated: after < terminal.base,
		};
	};

	const list = () => [...sessions.entries()].map(([id, terminal]) => ({ id, exited: terminal.exited }));

	// Cancels a session and resolves only after the helper process was
	// actually reaped (bounded by hangUp's kill escalation).
	const stop = async id => {
		const terminal = sessions.get(id);
		if (!terminal) return false;
		terminal.exiting ??= hangUp(terminal);
		await terminal.exiting;
		sessions.delete(id);
		return true;
	};

	const close = async () => {
		closing = true;
		await Promise.all([...sessions.keys()].map(id => stop(id)));
	};

	return { create, input, output, list, stop, close };
}
