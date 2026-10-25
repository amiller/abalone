// Kernel credential helpers for the portable-agent service.
//
// Node exposes no public SO_PEERCRED API, so peer uids are read by a small,
// bounded, known-good Python helper (python3 -I, fixed source, no
// environment, no files) that receives the accepted connection as fd 3.
// This is the same pattern already qualified in portable/inference/broker.mjs.
// Every failure path — helper close, nonzero exit, timeout, protocol
// garbage — REJECTS, and the caller destroys the connection: the check
// fails closed. A caller-supplied uid is never consulted for authentication;
// the only identity source is the kernel.
import { spawn } from 'node:child_process';

const SO_PEERCRED_HELPER = `
import socket, struct, sys
try:
    data = socket.socket(fileno=3).getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
except OSError:
    sys.exit(3)
sys.stdout.write("%d %d %d" % struct.unpack("3i", data))
`;

// Structured credential of one accepted connection. Collects the helper's
// stdout until a complete bounded line arrives AND the helper exits 0
// (clean exit required); any close, nonzero exit, oversized output or
// timeout is a rejection. The helper is always killed after a hard
// deadline and reaped before the promise settles, so it can never hold the
// connection fd open indefinitely.
export function peerCredential(fd, { timeoutMs = 5000, maxOutputBytes = 64, python = 'python3', signal } = {}) {
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawn(python, ['-I', '-c', SO_PEERCRED_HELPER], { stdio: ['ignore', 'pipe', 'ignore', fd], env: { PATH: process.env.PATH || '/usr/bin:/bin' } });
		} catch (error) { return reject(error); }
		let buffer = '';
		let failure = null;
		const cancel = () => { failure = new Error('peer credential check cancelled'); try { child.kill('SIGKILL'); } catch {} };
		signal?.addEventListener('abort', cancel, { once: true });
		if (signal?.aborted) cancel();
		let settled = false;
		const settle = fn => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', cancel);
			fn();
		};
		const timer = setTimeout(() => { failure = new Error('peer credential check timed out'); try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', chunk => {
			buffer += chunk;
			if (buffer.length > maxOutputBytes) {
				failure = new Error('peer credential output exceeded its bound'); try { child.kill('SIGKILL'); } catch {}
			}
		});
		// The credential is trusted only from a helper that exited 0: all
		// stdout is collected until that clean exit (the helper writes one
		// final line without a newline terminator), any close-with-output,
		// nonzero exit or signal is a rejection.
		child.on('close', (code, signal) => {
			settle(() => {
				if (failure) return reject(failure);
				if (code !== 0 || signal !== null || buffer.trim() === '') {
					return reject(new Error('peer credential helper did not exit cleanly'));
				}
				const parts = buffer.trim().split(' ');
				if (parts.length !== 3 || parts.some(part => !/^\d+$/.test(part))) {
					return reject(new Error('peer credential protocol error'));
				}
				resolve({ pid: Number(parts[0]), uid: Number(parts[1]), gid: Number(parts[2]) });
			});
		});
		child.on('error', error => {
			settle(() => reject(error.code === 'ENOENT' ? new Error('python3 is required for peer credential checks') : error));
		});
	});
}

const RESOLVE_HELPER = spec => `
import pwd, grp, sys
kind, name = sys.argv[1], sys.argv[2]
try:
    if kind == "uid":
        sys.stdout.write(str(pwd.getpwnam(name).pw_uid))
    else:
        sys.stdout.write(str(grp.getgrnam(name).gr_gid))
except KeyError:
    sys.exit(3)
`;

// Resolves an account/group NAME to its numeric id with the same bounded
// discipline (clean exit, bounded output, hard timeout kill-after). Used
// only for configuring the service at startup; never for authentication.
export function resolveId(kind, name, { timeoutMs = 5000, python = 'python3' } = {}) {
	return new Promise((resolve, reject) => {
		if (kind !== 'uid' && kind !== 'gid') return reject(new Error('resolveId kind must be uid or gid'));
		let child;
		try {
			child = spawn(python, ['-I', '-c', RESOLVE_HELPER(), kind, name], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: process.env.PATH || '/usr/bin:/bin' } });
		} catch (error) { return reject(error); }
		let buffer = '';
		let settled = false;
		const settle = fn => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
		const timer = setTimeout(() => settle(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } reject(new Error(`id resolution timed out for ${name}`)); }), timeoutMs);
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', chunk => { buffer += chunk; if (buffer.length > 32) settle(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } reject(new Error('id resolution output exceeded its bound')); }); });
		child.on('close', (code, signal) => settle(() => {
			if (code !== 0 || signal !== null || !/^\d{1,10}$/.test(buffer.trim())) return reject(new Error(`unknown ${kind} name: ${name}`));
			resolve(Number(buffer.trim()));
		}));
		child.on('error', error => settle(() => reject(error)));
	});
}

export const resolveUid = (spec, options) => /^\d+$/.test(spec) ? Promise.resolve(Number(spec)) : resolveId('uid', spec, options);
export const resolveGid = (spec, options) => /^\d+$/.test(spec) ? Promise.resolve(Number(spec)) : resolveId('gid', spec, options);
