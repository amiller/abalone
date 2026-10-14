// Fixture transport worker for the portable workspace agent adapter.
//
// Speaks the same JSONL contract as agent-worker.mjs WITHOUT the Pi SDK, so
// lifecycle and security checks run without a built SDK. Every event is
// labeled kind:"fixture". This is not agent execution and not SDK qualification.
//
// Job line on stdin: {prompt, cwd, agentDir, script?}
// Fixture-only script knobs: reportEnv, slow, flood, hang, proofPath,
// proofContent, oversize, revive, doneThenHang, doneThenExit (with optional
// exitDelayMs), doneThenExit0 (done, optional delay, clean exit 0),
// doneThenAbort (done, then a worker-reported aborted, clean exit),
// exit0NoDone.
import fs from 'node:fs';
import path from 'node:path';

console.log = (...args) => console.error(...args);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');

if (process.argv.includes('--probe')) {
	emit({ type: 'ready', kind: 'fixture' });
	process.exit(0);
}

let script = {};
let cwd = null;
let prompt = '';
try {
	let data = '';
	const job = await new Promise((resolve, reject) => {
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', chunk => {
			data += chunk;
			if (Buffer.byteLength(data) > 65536) reject(new Error('Job too large'));
		});
		process.stdin.on('end', () => resolve(JSON.parse(data || '{}')));
		process.stdin.on('error', reject);
	});
	if (typeof job.prompt !== 'string' || !job.prompt.trim() || Buffer.byteLength(job.prompt) > 8192) throw new Error('invalid prompt');
	if (typeof job.cwd !== 'string' || !path.isAbsolute(job.cwd)) throw new Error('invalid cwd');
	cwd = job.cwd;
	prompt = job.prompt;
	script = job.script ?? {};
} catch (error) {
	emit({ type: 'fatal', message: error instanceof Error ? error.message : String(error) });
	process.exit(1);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pace = script.slow ? 120 : 8;
let stopping = false;

process.on('SIGTERM', () => {
	stopping = true;
});
process.on('SIGINT', () => { stopping = true; });

emit({ type: 'ready', kind: 'fixture' });
if (script.reportEnv) {
	emit({ type: 'worker_env', env: Object.keys(process.env).sort() });
}
emit({ type: 'state', state: 'running' });
emit({ type: 'agent_event', event: 'agent_start' });
emit({ type: 'agent_event', event: 'turn_start' });
emit({ type: 'agent_event', event: 'message_start', role: 'assistant' });

if (script.flood) {
	// Large event volume to exercise the bounded event buffer.
	for (let index = 0; index < 400 && !stopping; index++) {
		emit({ type: 'agent_event', event: 'text_delta', delta: 'x'.repeat(120) });
		await delay(0);
	}
} else {
	emit({
		type: 'agent_event', event: 'tool_start', tool: 'write',
		args: `{"path":"${script.proofPath ?? 'fixture-proof.txt'}"}`,
	});
	if (!stopping) {
		// Fixture stand-in for the SDK write tool: one bounded file inside cwd.
		fs.writeFileSync(
			path.join(cwd, script.proofPath ?? 'fixture-proof.txt'),
			script.proofContent ?? `fixture\n${prompt.slice(0, 200)}\n`,
		);
	}
	emit({ type: 'agent_event', event: 'tool_end', tool: 'write', isError: false });
	if (script.oversize) {
		// Malformed protocol mid-stream: one valid-JSON frame far beyond the
		// frame limit; everything after it must be dropped by the manager.
		emit({ type: 'agent_event', event: 'text_delta', delta: 'x'.repeat(300 * 1024) });
	}
	emit({ type: 'agent_event', event: 'message_end', role: 'assistant', stopReason: 'toolUse' });
	emit({ type: 'agent_event', event: 'message_start', role: 'assistant' });
	for (const word of ['fixture ', 'agent ', 'reply']) {
		if (stopping) break;
		await delay(pace);
		emit({ type: 'agent_event', event: 'text_delta', delta: word });
	}
	emit({ type: 'agent_event', event: 'message_end', role: 'assistant', stopReason: 'stop' });
}

if (stopping) {
	emit({ type: 'aborted', reason: 'cancelled' });
	process.exit(0);
}
if (script.hang) {
	// Ignores SIGTERM to exercise the manager's escalation to SIGKILL.
	process.removeAllListeners('SIGTERM');
	setInterval(() => {}, 60_000); // Keep the event loop alive.
	await new Promise(() => {});
}
if (script.doneThenHang) {
	// A worker that reports protocol completion and then never exits: the
	// manager must keep counting the live child, keep the record reachable
	// for stop/close, and only settle the run once the process is reaped.
	emit({ type: 'done', lastText: 'fixture reply' });
	process.removeAllListeners('SIGTERM');
	setInterval(() => {}, 60_000);
	await new Promise(() => {});
}
if (script.doneThenExit) {
	// Reports done, then exits nonzero: reported completion is not success
	// unless the process also exits cleanly. exitDelayMs optionally holds the
	// done-reported-but-not-yet-exited gap open, so checks can observe (by
	// repeated polling) that the public state stays nonterminal during it.
	emit({ type: 'done', lastText: 'fixture reply' });
	if (script.exitDelayMs) await delay(Math.min(Number(script.exitDelayMs) || 0, 5000));
	process.exit(Number(script.doneThenExit) || 7);
}
if (script.doneThenExit0) {
	// Reports done, then exits cleanly after an optional delay: the canonical
	// done must appear exactly once, appended only after the verified reap and
	// carrying the worker's retained payload.
	emit({ type: 'done', lastText: 'fixture reply' });
	if (script.exitDelayMs) await delay(Math.min(Number(script.exitDelayMs) || 0, 5000));
	process.exit(0);
}
if (script.doneThenAbort) {
	// Reports done, then retracts it with a worker-reported aborted outcome,
	// then exits cleanly: aborted outranks the completion claim, so the run
	// settles aborted and no canonical done is ever appended.
	emit({ type: 'done', lastText: 'fixture reply' });
	emit({ type: 'aborted', reason: 'retracted' });
	process.exit(0);
}
if (script.exit0NoDone) {
	// Exits 0 without ever reporting completion: must not become done.
	process.exit(0);
}
emit({ type: 'agent_event', event: 'agent_end' });
emit({ type: 'agent_event', event: 'agent_settled', aborted: false });
emit({ type: 'done', lastText: 'fixture reply' });
if (script.revive) {
	// Late events after the terminal done: a run must not be revived.
	emit({ type: 'state', state: 'running' });
	emit({ type: 'agent_event', event: 'text_delta', delta: 'late' });
}
process.exit(0);
