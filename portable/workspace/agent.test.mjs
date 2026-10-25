// Agent adapter checks for the portable workspace prototype.
//
// The fixture transport worker (agent-fixture-worker.mjs) speaks the same
// JSONL protocol as the SDK worker without requiring a built Pi SDK. The
// lifecycle tests repeatedly poll the public events()/HTTP surface to prove
// the success contract on two axes at once — the response events and the
// response state: a worker-reported done is converted to worker_reported_done
// evidence with the payload withheld, and neither a done-typed event nor a
// terminal state is observable before the worker process is actually reaped
// and settled. The canonical done (the retained payload) appears exactly
// once, only after a verified clean reap. The final tests are the gated
// actual-SDK checks: they run the real worker against the built vendored SDK
// and are explicitly skipped (never silently passed) when dist/ is absent.
// See README "Qualification status".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { createWorkspaceServer } from './server.mjs';
import { createAgentManager } from './agent-manager.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const fixtureWorker = path.join(here, 'agent-fixture-worker.mjs');
const sdkDist = path.resolve(here, '../../vendor/pi/packages/coding-agent/dist/index.js');

async function readyStatus(app) {
	for (let attempt = 0; attempt < 300; attempt++) {
		const status = await fetch(app.origin + '/api/status').then(response => response.json());
		if (status.agent?.state === 'ready' || status.agent?.state === 'unavailable') return status;
		assert.equal(status.agent?.state, 'warming', 'HTTP readiness uses an explicit state');
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw new Error('readiness did not settle');
}

const workspaceDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'portable-agent-'));

const managerWith = overrides =>
	createAgentManager({ workspace: '/tmp', workerPath: fixtureWorker, runTimeoutMs: 60_000, killGraceMs: 1_500, ...overrides });

const waitFor = async (manager, id, predicate, label) => {
	for (let attempt = 0; attempt < 400; attempt++) {
		const record = manager.get(id);
		if (record && predicate(record)) return record;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	assert.fail(`Timeout waiting for ${label}; state=${manager.get(id)?.state}`);
};

// Per-run agent directories the manager creates under the system temp root.
const tempAgentDirs = async () => (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('pi-agent-')).sort();

// True when no fixture worker process is left running on this host.
const noFixtureWorkers = () => new Promise(resolve => {
	execFile('pgrep', ['-f', fixtureWorker], error => resolve(Boolean(error)));
});

const eventTypes = result => result.events.filter(event => event.type === 'agent_event').map(event => event.event);

// The public terminal states, mirroring the UI's polling contract: a
// consumer that observes one of these stops polling, so none of them may be
// observable before the worker process is actually reaped and settled.
const TERMINAL_RUN_STATES = new Set(['done', 'aborted', 'error', 'timeout', 'killed', 'unavailable']);

test('agent lifecycle: ordered events, real worker process, bounded reattach', async () => {
	const workspace = await workspaceDir();
	const manager = managerWith({ workspace });
	try {
		const { id } = await manager.start({ prompt: 'write the proof file', script: { proofPath: 'proof.txt', proofContent: 'proof-content\n' } });
		const record = await waitFor(manager, id, r => r.state === 'done' && r.child.exitCode === 0, 'run completion');
		assert.equal(record.child.exitCode, 0, 'fixture worker exits cleanly');
		assert.equal(await fs.readFile(path.join(workspace, 'proof.txt'), 'utf8'), 'proof-content\n');
		const first = manager.events(id, 0);
		const types = eventTypes(first);
		assert.equal(types[0], 'agent_start');
		assert.ok(types.indexOf('tool_start') < types.indexOf('tool_end'), 'tool events ordered');
		assert.ok(types.indexOf('tool_end') < types.indexOf('agent_settled'), 'settlement after tool work');
		assert.equal(types[types.length - 1], 'agent_settled');
		// Canonical done contract: exactly one done-typed event, appended only
		// at the verified clean reap (so it is the final line), carrying the
		// worker's retained payload, and preceded by the evidence marker that
		// replaced the worker's immediate claim.
		const doneEvents = first.events.filter(event => event.type === 'done');
		assert.equal(doneEvents.length, 1, 'exactly one canonical done event');
		assert.equal(first.events[first.events.length - 1].type, 'done', 'the canonical done is appended at the reap, after all worker output');
		assert.equal(doneEvents[0].lastText, 'fixture reply', 'the canonical done carries the retained worker payload');
		const reportedIndex = first.events.findIndex(event => event.type === 'worker_reported_done');
		assert.ok(reportedIndex >= 0 && reportedIndex < first.events.length - 1, 'the worker_reported_done evidence precedes the canonical done');
		assert.deepEqual(Object.keys(first.events[reportedIndex]), ['type'], 'the evidence marker carries no payload; the payload stays private until the reap');
		// Reattach from a mid-stream offset receives only later events.
		const firstResult = manager.events(id, 0);
		let running = 0;
		let offsetAfterToolEnd = 0;
		for (const event of firstResult.events) {
			running += Buffer.byteLength(JSON.stringify(event)) + 1;
			if (event.type === 'agent_event' && event.event === 'tool_end') offsetAfterToolEnd = running;
		}
		assert.ok(offsetAfterToolEnd > 0);
		const tail = manager.events(id, offsetAfterToolEnd);
		assert.ok(tail.events.length < firstResult.events.length, 'tail poll is a subset');
		assert.equal(tail.events.some(event => event.type === 'agent_event' && event.event === 'tool_start'), false, 'already-seen events are not repeated');
		assert.equal(manager.list().length, 1);
		assert.equal(manager.list()[0].alive, false);
	} finally { await manager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

test('cancellation: stop aborts a running worker and reaps the process', async () => {
	const workspace = await workspaceDir();
	const manager = managerWith({ workspace });
	try {
		const { id } = await manager.start({ prompt: 'slow run', script: { slow: '1' } });
		await waitFor(manager, id, r => r.state === 'running', 'run start');
		assert.ok(manager.get(id).child.exitCode === null, 'worker alive before stop');
		assert.equal(await manager.stop(id), true);
		assert.equal(manager.get(id), null, 'record removed after stop');
		assert.equal((await manager.start({ prompt: 'after stop' })).id.length > 0, true, 'capacity released');
		await waitFor(manager, (await manager.list())[0].id, r => r.state === 'done', 'second run');
	} finally { await manager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

test('unresponsive worker: timeout escalation marks the run and kills the process', async () => {
	const workspace = await workspaceDir();
	const manager = managerWith({ workspace, runTimeoutMs: 400, killGraceMs: 400 });
	const child = { pid: null };
	try {
		const { id } = await manager.start({ prompt: 'hang', script: { hang: '1' } });
		child.pid = manager.get(id).child.pid;
		const record = await waitFor(manager, id, r => r.state === 'timeout' && (r.child.exitCode !== null || r.child.signalCode !== null), 'timeout kill');
		assert.equal(record.state, 'timeout');
		assert.ok(record.child.signalCode !== null || record.child.exitCode !== 0, 'hanging worker is killed, not completed');
	} finally { await manager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

test('unavailable SDK: probe reports missing build and start is refused', async () => {
	const workspace = await workspaceDir();
	const manager = createAgentManager({ workspace, workerPath: path.join(workspace, 'no-such-worker.mjs') });
	try {
		const status = await manager.status();
		assert.equal(status.available, false);
		assert.equal(status.kind, 'missing');
		assert.match(status.detail, /probe|Pi SDK|spawn/i);
		await assert.rejects(manager.start({ prompt: 'x' }), error => error.code === 'AGENT_UNAVAILABLE');
	} finally { await manager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

test('no ambient configuration: worker env is allowlisted, secrets are not inherited', async () => {
	const workspace = await workspaceDir();
	const canary = 'ZAI_TEST_AMBIENT_SECRET';
	process.env[canary] = 'do-not-inherit';
	const manager = managerWith({ workspace });
	try {
		const { id } = await manager.start({ prompt: 'env report', script: { reportEnv: '1' } });
		await waitFor(manager, id, r => r.state === 'done', 'env report');
		const report = manager.events(id, 0).events.find(event => event.type === 'worker_env');
		assert.ok(report, 'worker reported its environment keys');
		const keys = report.env;
		for (const key of keys) {
			assert.ok(['PATH', 'LANG', 'PI_OFFLINE'].includes(key), `unexpected env key ${key}`);
		}
		assert.equal(keys.includes(canary), false, 'ambient secret not inherited');
		assert.equal(keys.includes('HOME'), false, 'HOME not forwarded; agentDir is explicit');
	} finally {
		delete process.env[canary];
		await manager.close();
		await fs.rm(workspace, {recursive:true,force:true});
	}
});

test('event buffer is bounded and offsets report truncation', async () => {
	const workspace = await workspaceDir();
	const manager = managerWith({ workspace, eventLimit: 4 * 1024 });
	try {
		const { id } = await manager.start({ prompt: 'flood', script: { flood: '1' } });
		await waitFor(manager, id, r => r.state === 'done', 'flood completion');
		const result = manager.events(id, 0);
		assert.ok(result.truncated, 'early events were dropped');
		assert.ok(result.offset > 0);
		const later = manager.events(id, result.offset);
		assert.equal(later.events.length, 0);
		assert.equal(later.truncated, false);
	} finally { await manager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

test('HTTP surface: security checks, capacity, validation, and status honesty', async () => {
	const workspace = await workspaceDir();
	const agentManager = managerWith({ workspace, maxAgents: 1 });
	const app = await createWorkspaceServer({ workspace, agentManager });
	try {
		const status = await readyStatus(app);
		assert.equal(status.agent.kind, 'fixture');
		assert.equal(status.agent.available, true);
		const headers = { 'Content-Type': 'application/json', 'X-Workspace-Token': status.csrfToken };
		const request = (url, method = 'GET', data, extra = {}) =>
			fetch(app.origin + url, { method, headers: { ...headers, ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
		assert.equal((await request('/api/agents', 'POST', { prompt: 'x' }, { Origin: 'https://evil.example' })).status, 403);
		assert.equal((await request('/api/agents', 'POST', { prompt: 'x' }, { 'X-Workspace-Token': 'wrong' })).status, 403);
		const rebound = await new Promise(resolve => http.get(app.origin + '/api/agents', { headers: { Host: 'evil.example', ...headers } }, res => { res.resume(); resolve(res.statusCode); }));
		assert.equal(rebound, 403);
		assert.equal((await request('/api/agents', 'POST', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
		assert.equal((await request('/api/agents', 'POST', { prompt: 'x'.repeat(9000) })).status, 400);
		assert.equal((await request('/api/agents', 'POST', { prompt: 'ok', script: { surprise: '1' } })).status, 400);
		const started = await request('/api/agents', 'POST', { prompt: 'slow', script: { slow: '1' } });
		assert.equal(started.status, 201);
		const { id } = await started.json();
		assert.equal((await request('/api/agents', 'POST', { prompt: 'second' })).status, 409);
		assert.equal((await request(`/api/agents/${id}/events?after=notanumber`)).status, 400);
		let events = null;
		for (let attempt = 0; attempt < 100 && !events; attempt++) {
			const result = await (await request(`/api/agents/${id}/events?after=0`)).json();
			if (result.events.some(event => event.type === 'agent_event' && event.event === 'agent_start')) events = result;
			else await new Promise(resolve => setTimeout(resolve, 25));
		}
		assert.ok(events, 'events stream over HTTP');
		const listing = await (await request('/api/agents')).json();
		assert.deepEqual(listing.agents.map(entry => entry.id), [id]);
		assert.equal((await request(`/api/agents/${id}`, 'DELETE', {})).status, 200);
		assert.equal((await request(`/api/agents/${id}/events`)).status, 404);
	} finally { await app.close(); await agentManager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

test('HTTP surface: unavailable SDK yields an honest 503, not fixture text', async () => {
	const workspace = await workspaceDir();
	const app = await createWorkspaceServer({ workspace }); // default worker: real SDK path
	try {
		const status = await readyStatus(app);
		const exists = await fs.stat(sdkDist).then(() => true, () => false);
		assert.equal(status.agent.available, exists, 'status matches the actual built SDK presence');
		const headers = { 'Content-Type': 'application/json', 'X-Workspace-Token': status.csrfToken };
		const response = await fetch(app.origin + '/api/agents', { method: 'POST', headers, body: JSON.stringify({ prompt: 'hello' }) });
		if (!exists) {
			assert.equal(response.status, 503);
			const data = await response.json();
			assert.equal(status.agent.state, 'unavailable', 'missing SDK probe has settled');
			assert.equal(data.code, 'not-ready');
			assert.equal(data.error, 'Agent not ready');
			assert.ok(data.detail, 'refusal explains why');
		} else {
			assert.equal(response.status, 201);
		}
	} finally { await app.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

test('probe waits for a complete newline-terminated status line', async () => {
	const dir = await workspaceDir();
	const probePath = path.join(dir, 'split-probe.mjs');
	await fs.writeFile(probePath, [
		'const line = JSON.stringify({ type: "ready", kind: "fixture" });',
		'process.stdout.write(line.slice(0, 24));',
		'setTimeout(() => process.stdout.write(line.slice(24) + "\\n"), 200);',
		'setInterval(() => {}, 60000);',
	].join('\n'));
	const manager = managerWith({ workspace: dir, workerPath: probePath });
	try {
		const status = await manager.status();
		assert.equal(status.available, true, 'split JSON line is parsed only once the newline arrives');
		assert.equal(status.kind, 'fixture');
	} finally { await manager.close(); await fs.rm(dir, {recursive:true,force:true}); }
});

test('probe refuses unbounded non-newline noise instead of buffering it', async () => {
	const dir = await workspaceDir();
	const probePath = path.join(dir, 'noise-probe.mjs');
	await fs.writeFile(probePath, [
		'process.stdout.write("x".repeat(1024 * 1024));',
		'setInterval(() => {}, 60000);',
	].join('\n'));
	const manager = managerWith({ workspace: dir, workerPath: probePath, probeTimeoutMs: 30_000 });
	try {
		const startedAt = Date.now();
		const status = await manager.status();
		assert.equal(status.available, false);
		assert.match(status.detail, /exceeded \d+ bytes/);
		assert.ok(Date.now() - startedAt < 10_000, 'refused promptly rather than buffering megabytes');
	} finally { await manager.close(); await fs.rm(dir, {recursive:true,force:true}); }
});

test('oversized event frames are refused before retention and the worker is terminated', async () => {
	const workspace = await workspaceDir();
	const manager = managerWith({ workspace, maxFrameBytes: 8 * 1024, eventLimit: 64 * 1024 });
	try {
		const { id } = await manager.start({ prompt: 'oversize', script: { oversize: '1' } });
		const record = await waitFor(manager, id, r => r.state === 'error' && (r.child.exitCode !== null || r.child.signalCode !== null), 'malformed worker exit');
		assert.equal(record.state, 'error', 'a frame-limit violation is terminal');
		const result = manager.events(id, 0);
		const note = result.events.find(event => event.type === 'frame_too_large');
		assert.ok(note, 'refusal is visible as a bounded event');
		assert.ok(note.bytes > 8 * 1024 && note.limit === 8 * 1024);
		assert.equal(result.events.some(event => event.type === 'agent_event' && event.event === 'text_delta' && (event.delta ?? '').length > 1024), false, 'oversized frame is not retained');
		assert.ok(record.bytes <= 64 * 1024 + 2 * 1024, `retained bytes bounded (got ${record.bytes})`);
		for (const event of result.events) {
			assert.ok(Buffer.byteLength(JSON.stringify(event)) + 1 <= 8 * 1024 + 512, 'each retained frame is within the limit');
		}
	} finally { await manager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

test('late running events cannot revive a terminal run', async () => {
	const workspace = await workspaceDir();
	const manager = managerWith({ workspace });
	try {
		const { id } = await manager.start({ prompt: 'revive attempt', script: { revive: '1' } });
		const record = await waitFor(manager, id, r => r.state === 'done' && r.child.exitCode === 0, 'completion');
		const events = manager.events(id, 0).events;
		// The late events land between the evidence marker and the canonical
		// done, which is appended at the reap — after everything the worker
		// emitted — and remains the only done-typed line in the stream.
		const evidenceIndex = events.findIndex(event => event.type === 'worker_reported_done');
		assert.ok(evidenceIndex >= 0, 'the worker done report is retained as evidence');
		assert.ok(events.some((event, index) => event.type === 'state' && event.state === 'running' && index > evidenceIndex), 'fixture emitted a late running event after its done report');
		const doneEvents = events.filter(event => event.type === 'done');
		assert.equal(doneEvents.length, 1, 'exactly one canonical done');
		assert.equal(events[events.length - 1].type, 'done', 'the canonical done is appended at the reap, after the late events');
		assert.equal(doneEvents[0].lastText, 'fixture reply', 'the canonical done carries the retained payload');
		assert.equal(record.state, 'done', 'final state stays monotonic');
		assert.equal(manager.list()[0].alive, false);
	} finally { await manager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

test('concurrent starts: capacity is reserved synchronously; at most maxAgents accepted', async () => {
	const workspace = await workspaceDir();
	const manager = managerWith({ workspace, maxAgents: 2 });
	const dirsBefore = await tempAgentDirs();
	try {
		// Five parallel starts against a capacity of two: the reservation
		// happens before any await (including agentDir creation), so exactly
		// two are accepted no matter how the interleaving lands.
		const attempts = await Promise.allSettled(Array.from({ length: 5 }, () =>
			manager.start({ prompt: 'race', script: { slow: '1' } })));
		const accepted = attempts.filter(result => result.status === 'fulfilled');
		const rejected = attempts.filter(result => result.status === 'rejected');
		assert.equal(accepted.length, 2, 'exactly the capacity is accepted');
		assert.equal(rejected.length, 3);
		for (const result of rejected) assert.equal(result.reason.code, 'AGENT_CAPACITY');
		// No child:null records are ever exposed, and both live children hold capacity.
		const listing = manager.list();
		assert.equal(listing.length, 2);
		for (const entry of listing) {
			assert.equal(entry.alive, true);
			assert.ok(manager.get(entry.id).child, 'published records always carry their child');
		}
		await assert.rejects(manager.start({ prompt: 'third' }), error => error.code === 'AGENT_CAPACITY');
		// Capacity recovers only once the children are actually reaped.
		for (const result of accepted) await waitFor(manager, result.value.id, r => r.state === 'done' && r.reaped, 'race run completion');
		const { id } = await manager.start({ prompt: 'recovered' });
		await waitFor(manager, id, r => r.state === 'done' && r.reaped, 'capacity recovery');
	} finally { await manager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
	assert.deepEqual(await tempAgentDirs(), dirsBefore, 'no stray per-run temp directories');
});

test('reported done is not terminal success: repeated polls during the gap never observe a done event or terminal state (doneThenHang)', async () => {
	const workspace = await workspaceDir();
	const manager = managerWith({ workspace, maxAgents: 1, runTimeoutMs: 1_000, killGraceMs: 300 });
	try {
		const { id } = await manager.start({ prompt: 'done then hang', script: { doneThenHang: '1' } });
		// Poll the public events() surface repeatedly across the gap between the
		// worker's done report and its reap: the report is visible only as a
		// worker_reported_done evidence marker (payload withheld), and BOTH the
		// event stream and the authoritative state must stay free of any
		// done-typed/terminal claim while the worker process is still live.
		let sawReported = false;
		let gapPolls = 0;
		let offset = 0;
		for (let attempt = 0; attempt < 600; attempt++) {
			const record = manager.get(id);
			if (!record) break;
			const reapedNow = record.reaped;
			const result = manager.events(id, offset);
			offset = result.offset;
			if (!reapedNow) {
				if (result.events.some(event => event.type === 'worker_reported_done')) sawReported = true;
				if (sawReported) {
					gapPolls += 1;
					// The only state change that may appear before the reap is the
					// manager-initiated 'timeout' (the kill it initiates): the
					// worker's own done report must never produce any terminal
					// state, least of all 'done'.
					assert.ok(result.state === 'running' || result.state === 'timeout', `authoritative state stays nonterminal on the worker's own claim (got ${result.state})`);
					assert.notEqual(result.state, 'done', 'the done report never yields the terminal success state before reap');
					assert.equal(result.events.some(event => event.type === 'done'), false, 'no canonical done event is observable before the reap');
				}
				if (sawReported && gapPolls === 1) {
					// First observation of the gap: the previous lifecycle protections
				// still hold while the done-reporting worker remains live.
					assert.ok(!record.reaped && record.child.exitCode === null, 'the worker process is still live after reporting done');
					assert.equal(manager.list()[0].alive, true, 'listing reports process truth, not the protocol claim');
					await assert.rejects(manager.start({ prompt: 'second' }), error => error.code === 'AGENT_CAPACITY', 'a live done-reporting child still occupies capacity');
				}
			}
			if (reapedNow) break;
			await new Promise(resolve => setTimeout(resolve, 15));
		}
		assert.ok(sawReported, 'the worker reported done; the claim is visible as evidence');
		assert.ok(gapPolls >= 5, `the provisional-done gap was observed by repeated polls, not only the final outcome (got ${gapPolls})`);
		// The run timeout still governs the process: the hung worker is killed.
		const finished = await waitFor(manager, id, r => r.state === 'timeout' && r.reaped, 'timeout kill of a done-reporting worker');
		assert.ok(finished.child.signalCode !== null || finished.child.exitCode !== 0, 'the worker was actually killed, not completed');
		// Timeout precedence over the done claim, on the event axis too: the
		// final stream has the evidence marker but no canonical done ever.
		const final = manager.events(id, 0);
		assert.equal(final.state, 'timeout');
		assert.equal(final.events.filter(event => event.type === 'done').length, 0, 'timeout precedence: no canonical done is ever appended');
		assert.equal(final.events.filter(event => event.type === 'worker_reported_done').length, 1, 'the provisional claim is retained as exactly one evidence marker');
		// After the reap the slot is free again.
		const { id: next } = await manager.start({ prompt: 'recovered' });
		await waitFor(manager, next, r => r.state === 'done' && r.reaped, 'capacity recovery');
	} finally { await manager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

test('delayed nonzero exit: done stays provisional until the reap settles it as error', async () => {
	const workspace = await workspaceDir();
	const manager = managerWith({ workspace });
	try {
		const { id } = await manager.start({ prompt: 'done then delayed nonzero exit', script: { doneThenExit: '7', exitDelayMs: '800' } });
		// Repeatedly poll across the 800 ms gap between the done report and the
		// nonzero exit: every poll must show no done-typed event and a
		// nonterminal state; success is settled only after the exit is reaped.
		let sawReported = false;
		let gapPolls = 0;
		let offset = 0;
		for (let attempt = 0; attempt < 400; attempt++) {
			const record = manager.get(id);
			if (!record) break;
			const reapedNow = record.reaped;
			const result = manager.events(id, offset);
			offset = result.offset;
			if (!reapedNow) {
				if (result.events.some(event => event.type === 'worker_reported_done')) sawReported = true;
				if (sawReported) {
					gapPolls += 1;
					assert.equal(result.state, 'running', 'authoritative state stays nonterminal between the done report and the nonzero exit');
					assert.equal(result.events.some(event => event.type === 'done'), false, 'no canonical done event is observable before the nonzero exit is reaped');
				}
			}
			if (reapedNow) break;
			await new Promise(resolve => setTimeout(resolve, 15));
		}
		assert.ok(sawReported, 'the worker reported done');
		assert.ok(gapPolls >= 5, `the gap was observed by repeated polls, not only the final outcome (got ${gapPolls})`);
		const settled = await waitFor(manager, id, r => r.state === 'error' && r.reaped, 'delayed nonzero settlement');
		assert.equal(settled.child.exitCode, 7);
		const final = manager.events(id, 0);
		assert.equal(final.state, 'error', 'the response state is authoritative');
		assert.equal(final.events.filter(event => event.type === 'done').length, 0, 'no canonical done exists for a nonzero exit');
		assert.ok(final.events.some(event => event.type === 'worker_reported_done'), 'the protocol done is retained as provisional evidence');
		const exit = final.events.find(event => event.type === 'worker_exit');
		assert.ok(exit, 'the unclean exit is recorded');
		assert.equal(exit.code, 7);
		assert.match(exit.detail, /uncleanly/);
	} finally { await manager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

test('delayed clean exit: the canonical done appears exactly once, only at the verified reap', async () => {
	const workspace = await workspaceDir();
	const manager = managerWith({ workspace });
	try {
		const { id } = await manager.start({ prompt: 'done then delayed clean exit', script: { doneThenExit0: '1', exitDelayMs: '800' } });
		// Repeated polls across the delayed-exit window must observe the
		// worker_reported_done evidence but never a done-typed event and never
		// a terminal state; the canonical done is appended exactly once, at the
		// clean reap, with the retained payload.
		let sawReported = false;
		let gapPolls = 0;
		let offset = 0;
		for (let attempt = 0; attempt < 400; attempt++) {
			const record = manager.get(id);
			if (!record) break;
			const reapedNow = record.reaped;
			const result = manager.events(id, offset);
			offset = result.offset;
			if (!reapedNow) {
				if (result.events.some(event => event.type === 'worker_reported_done')) sawReported = true;
				if (sawReported) {
					gapPolls += 1;
					assert.equal(result.state, 'running', 'state stays nonterminal across the done-report-to-exit gap');
					assert.equal(result.events.some(event => event.type === 'done'), false, 'no canonical done event is observable before the clean exit is reaped');
				}
			}
			if (reapedNow) break;
			await new Promise(resolve => setTimeout(resolve, 15));
		}
		assert.ok(sawReported, 'the worker reported done; the evidence marker was observed');
		assert.ok(gapPolls >= 5, `the delayed-exit window was observed by repeated polls (got ${gapPolls})`);
		await waitFor(manager, id, r => r.state === 'done' && r.reaped, 'clean settlement');
		const final = manager.events(id, 0);
		assert.equal(final.state, 'done');
		const doneEvents = final.events.filter(event => event.type === 'done');
		assert.equal(doneEvents.length, 1, 'exactly one canonical done after the clean reap');
		assert.equal(final.events[final.events.length - 1].type, 'done', 'the canonical done is the final event, appended at the reap');
		assert.equal(doneEvents[0].lastText, 'fixture reply', 'the canonical done carries the privately retained payload');
		assert.equal(manager.list()[0].alive, false, 'the worker is reaped');
	} finally { await manager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

test('worker-reported aborted after done outranks the completion claim: no canonical done', async () => {
	const workspace = await workspaceDir();
	const manager = managerWith({ workspace });
	try {
		const { id } = await manager.start({ prompt: 'done then aborted', script: { doneThenAbort: '1' } });
		const record = await waitFor(manager, id, r => r.state === 'aborted' && r.reaped, 'aborted settlement');
		assert.equal(record.child.exitCode, 0, 'the worker exited cleanly, but aborted outranks the done claim');
		const final = manager.events(id, 0);
		assert.equal(final.state, 'aborted');
		assert.equal(final.events.filter(event => event.type === 'done').length, 0, 'no canonical done is appended when the worker retracted its completion');
		assert.equal(final.events.filter(event => event.type === 'worker_reported_done').length, 1, 'the provisional claim is retained as evidence');
		assert.equal(final.events[final.events.length - 1].type, 'aborted', 'the worker-reported aborted outcome is the terminal event');
	} finally { await manager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

test('HTTP events surface: a provisional done never reads as terminal success before reap', async () => {
	const workspace = await workspaceDir();
	const agentManager = managerWith({ workspace });
	const app = await createWorkspaceServer({ workspace, agentManager });
	try {
		const status = await readyStatus(app);
		const headers = { 'Content-Type': 'application/json', 'X-Workspace-Token': status.csrfToken };
		const request = (url, method = 'GET', data) =>
			fetch(app.origin + url, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
		const started = await request('/api/agents', 'POST', { prompt: 'delayed nonzero over HTTP', script: { doneThenExit: '3', exitDelayMs: '800' } });
		assert.equal(started.status, 201);
		const { id } = await started.json();
		// Poll the exact wire surface the UI polls: while the worker_reported_done
		// evidence marker is already in the stream, neither a done-typed event
		// nor a terminal state may be observable until the reap settles the run
		// — for this worker, as an error.
		let sawReported = false;
		let gapPolls = 0;
		let offset = 0;
		let finalState = null;
		for (let attempt = 0; attempt < 200; attempt++) {
			const result = await (await request(`/api/agents/${id}/events?after=${offset}`)).json();
			offset = result.offset;
			if (result.events.some(event => event.type === 'worker_reported_done')) sawReported = true;
			if (TERMINAL_RUN_STATES.has(result.state)) { finalState = result.state; break; }
			if (sawReported) {
				gapPolls += 1;
				assert.equal(result.state, 'running', 'no terminal state is observable over HTTP before the worker process is reaped');
				assert.equal(result.events.some(event => event.type === 'done'), false, 'no canonical done event is observable over HTTP before the reap');
			}
			await new Promise(resolve => setTimeout(resolve, 15));
		}
		assert.equal(finalState, 'error', 'the run settles as error, the only legitimate terminal outcome for this worker');
		assert.ok(sawReported, 'the provisional done report was visible as evidence');
		assert.ok(gapPolls >= 5, `the provisional-done gap was observed over HTTP by repeated polls (got ${gapPolls})`);
		const all = await (await request(`/api/agents/${id}/events?after=0`)).json();
		assert.equal(all.state, 'error', 'response.state is authoritative');
		assert.equal(all.events.filter(event => event.type === 'done').length, 0, 'no canonical done event exists in the final stream');
		assert.ok(all.events.some(event => event.type === 'worker_reported_done'), 'the worker_reported_done evidence marker remains in the stream');
		const exit = all.events.find(event => event.type === 'worker_exit');
		assert.ok(exit, 'the unclean exit is recorded');
		assert.equal(exit.code, 3);
		assert.match(exit.detail, /uncleanly/);
		const listing = await (await request('/api/agents')).json();
		assert.equal(listing.agents[0].alive, false, 'the worker is reaped, not merely claimed done');
	} finally { await app.close(); await agentManager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

test('done followed by a nonzero exit is an error, not success', async () => {
	const workspace = await workspaceDir();
	const manager = managerWith({ workspace });
	try {
		const { id } = await manager.start({ prompt: 'done then bad exit', script: { doneThenExit: '7' } });
		const record = await waitFor(manager, id, r => r.state === 'error' && r.reaped, 'done-then-nonzero settlement');
		assert.equal(record.child.exitCode, 7);
		const events = manager.events(id, 0).events;
		assert.equal(events.filter(event => event.type === 'done').length, 0, 'no canonical done is ever appended for an unclean exit');
		assert.ok(events.some(event => event.type === 'worker_reported_done'), 'the protocol done is retained as evidence');
		const exit = events.find(event => event.type === 'worker_exit');
		assert.ok(exit, 'the unclean exit is recorded');
		assert.equal(exit.code, 7);
		assert.match(exit.detail, /uncleanly/);
	} finally { await manager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

test('exit 0 without reporting completion is an error, not done', async () => {
	const workspace = await workspaceDir();
	const manager = managerWith({ workspace });
	try {
		const { id } = await manager.start({ prompt: 'silent exit', script: { exit0NoDone: '1' } });
		await waitFor(manager, id, r => r.state === 'error' && r.reaped, 'silent-exit settlement');
		const events = manager.events(id, 0).events;
		assert.equal(events.some(event => event.type === 'done'), false, 'no completion was ever reported');
		assert.equal(events.some(event => event.type === 'worker_reported_done'), false, 'no done report evidence exists either');
		const exit = events.find(event => event.type === 'worker_exit');
		assert.ok(exit, 'the exit is recorded');
		assert.equal(exit.code, 0);
		assert.match(exit.detail, /without reporting completion/);
	} finally { await manager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

test('racing start and close: in-flight starts settle, no stray children or temp dirs', async () => {
	const dir = await workspaceDir();
	const dirsBefore = await tempAgentDirs();
	// A: deterministic race — a slow probe keeps the start in flight while
	// close() begins; the start must roll back and reject, not spawn.
	const probePath = path.join(dir, 'slow-probe.mjs');
	await fs.writeFile(probePath, [
		'setTimeout(() => { process.stdout.write(JSON.stringify({ type: "ready", kind: "fixture" }) + "\\n"); }, 400);',
		'setInterval(() => {}, 60000);',
	].join('\n'));
	const racing = managerWith({ workspace: dir, workerPath: probePath, probeTimeoutMs: 30_000 });
	const attempt = racing.start({ prompt: 'race close' });
	await new Promise(resolve => setTimeout(resolve, 100)); // inside the probe await
	await racing.close();
	await assert.rejects(attempt, error => error.code === 'AGENT_CLOSING', 'in-flight start is rejected once closing begins');
	await assert.rejects(racing.start({ prompt: 'after close' }), error => error.code === 'AGENT_CLOSING', 'starts after close are rejected');
	assert.deepEqual(racing.list(), []);
	// B: close() stops and reaps a running agent and awaits its cleanup.
	const manager = managerWith({ workspace: dir });
	try {
		const { id } = await manager.start({ prompt: 'slow', script: { slow: '1' } });
		await waitFor(manager, id, r => r.state === 'running', 'run start');
		await manager.close();
		assert.deepEqual(manager.list(), [], 'close removes every record');
		assert.equal(await noFixtureWorkers(), true, 'no stray worker processes survive close');
	} finally { await manager.close(); }
	await fs.rm(dir, {recursive:true,force:true});
	assert.deepEqual(await tempAgentDirs(), dirsBefore, 'no stray per-run temp directories');
});

test('terminal reattach: listing exposes surviving sessions after a page reload', async () => {
	const workspace = await workspaceDir();
	const app = await createWorkspaceServer({ workspace });
	try {
		const status = await readyStatus(app);
		const headers = { 'Content-Type': 'application/json', 'X-Workspace-Token': status.csrfToken };
		const first = await (await fetch(app.origin + '/api/terminals', { method: 'POST', headers, body: '{}' })).json();
		const second = await (await fetch(app.origin + '/api/terminals', { method: 'POST', headers, body: '{}' })).json();
		const listing = await (await fetch(app.origin + '/api/terminals')).json();
		assert.deepEqual(listing.sessions.map(session => session.id).sort(), [first.id, second.id].sort());
		await fetch(app.origin + `/api/terminals/${first.id}`, { method: 'DELETE', headers, body: '{}' });
		const after = await (await fetch(app.origin + '/api/terminals')).json();
		assert.deepEqual(after.sessions.map(session => session.id), [second.id]);
		assert.equal((await fetch(app.origin + `/api/terminals/${second.id}/output?after=0`)).status, 200);
	} finally { await app.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

// Gated actual-SDK smoke check. This test runs agent-worker.mjs (the real
// vendored Pi SDK, scripted local model) through the manager. When the SDK is
// not built it is explicitly SKIPPED — it never reports an actual-SDK pass on
// the strength of the fixture transport.
test('actual SDK: workspace auth/models canaries ignored, per-run temp agentDir, real tool file and event order', async t => {
	const built = await fs.stat(sdkDist).then(() => true, () => false);
	if (!built) return t.skip(`Pi SDK dist not built at ${sdkDist}; actual-SDK smoke check skipped (not passed)`);

	const workspace = await workspaceDir();
	const canaryKey = 'ZAI-CANARY-KEY-DO-NOT-USE';
	const canaryAuth = JSON.stringify({ 'canary-provider': { type: 'api_key', key: canaryKey } }, null, 2);
	const canaryModels = JSON.stringify({
		providers: { 'canary-provider': { name: 'Canary', baseUrl: 'https://canary.example.invalid', api: 'openai-compliant', models: [{ id: 'canary-model', name: 'Canary model' }] } },
	}, null, 2);
	await fs.mkdir(path.join(workspace, '.pi-agent'), { recursive: true });
	// A symlinked auth.json plus a plain models.json with canary values, both
	// inside the workspace: if the SDK consulted them the run would pick up the
	// canary provider/model and credential.
	await fs.writeFile(path.join(workspace, 'canary-auth-target.json'), canaryAuth);
	await fs.symlink('canary-auth-target.json', path.join(workspace, '.pi-agent', 'auth.json'));
	await fs.writeFile(path.join(workspace, '.pi-agent', 'models.json'), canaryModels);

	const manager = createAgentManager({ workspace, runTimeoutMs: 120_000, killGraceMs: 2_000 });
	try {
		const { id } = await manager.start({ prompt: 'write the proof file', script: { path: 'sdk-proof.txt', content: 'actual-sdk\nproof\n' } });
		const record = await waitFor(manager, id, r => r.state === 'done' && r.child.exitCode === 0, 'actual SDK run completion');
		assert.equal(await fs.readFile(path.join(workspace, 'sdk-proof.txt'), 'utf8'), 'actual-sdk\nproof\n', 'the real SDK write tool produced the file');

		const result = manager.events(id, 0);
		const types = eventTypes(result);
		assert.equal(types[0], 'agent_start');
		assert.ok(types.indexOf('tool_start') < types.indexOf('tool_end'), 'tool events ordered');
		assert.ok(types.indexOf('tool_end') < types.indexOf('agent_settled'), 'settlement after tool work');
		const toolStart = result.events.find(event => event.type === 'agent_event' && event.event === 'tool_start');
		assert.equal(toolStart.tool, 'write');
		// Canonical done contract against the actual SDK worker: exactly one
		// done-typed line, appended at the verified reap (it is the final
		// event), preceded by the payload-less evidence marker.
		const doneEvents = result.events.filter(event => event.type === 'done');
		assert.equal(doneEvents.length, 1, 'exactly one canonical done event');
		assert.equal(result.events[result.events.length - 1].type, 'done', 'the canonical done is appended at the reap');
		assert.equal(doneEvents[0].wrote, 'sdk-proof.txt', 'the canonical done carries the worker payload');
		assert.ok(result.events.some(event => event.type === 'worker_reported_done'), 'the provisional report is retained as evidence');

		// Isolation evidence from the SDK runtime itself (not mocked call options).
		const diag = result.events.find(event => event.type === 'sdk_diag');
		assert.ok(diag, 'worker reports post-run SDK diagnostics');
		assert.deepEqual(diag.credentialProviders, ['abalone-scripted'], 'in-memory AuthStorage is the live credential store');
		assert.ok(diag.models.every(entry => !entry.includes('canary')), 'canary provider/model from a read models.json is absent');
		assert.equal(JSON.stringify(result.events).includes('canary'), false, 'no canary material anywhere in the event stream');
		assert.equal(JSON.stringify(result.events).includes(canaryKey), false, 'canary key never surfaces');

		// The poisoned files were never read or rewritten.
		assert.equal(await fs.readFile(path.join(workspace, '.pi-agent', 'models.json'), 'utf8'), canaryModels, 'models.json untouched');
		assert.equal(await fs.readFile(path.join(workspace, 'canary-auth-target.json'), 'utf8'), canaryAuth, 'symlinked auth target untouched');

		// Per-run agentDir: fresh 0700 temp dir outside the workspace, cleaned after exit.
		const agentDir = record.agentDir;
		assert.ok(agentDir.startsWith(path.join(os.tmpdir(), 'pi-agent-')), 'agentDir is a fresh temp directory');
		assert.ok(!agentDir.startsWith(workspace), 'agentDir is outside the workspace');
		let removed = false;
		for (let attempt = 0; attempt < 160 && !removed; attempt++) {
			removed = !(await fs.stat(agentDir).then(() => true, () => false));
			if (!removed) await new Promise(resolve => setTimeout(resolve, 25));
		}
		assert.ok(removed, 'the created agentDir is removed after the worker exits');
		const entries = (await fs.readdir(workspace)).sort();
		assert.deepEqual(entries, ['.pi-agent', 'canary-auth-target.json', 'sdk-proof.txt'], 'no stray agent state written into the workspace');
	} finally { await manager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

// Gated actual-SDK negatives: the scripted proof transport must never report
// success when the real SDK tool execution failed, was an unknown tool, or
// was only a read. See README "Scripted-proof tool outcome policy".
test('actual SDK: failed tool executions produce errors, never claimed writes', async t => {
	const built = await fs.stat(sdkDist).then(() => true, () => false);
	if (!built) return t.skip(`Pi SDK dist not built at ${sdkDist}; actual-SDK negative checks skipped (not passed)`);

	const workspace = await workspaceDir();
	const manager = createAgentManager({ workspace, runTimeoutMs: 120_000, killGraceMs: 2_000 });
	try {
		// Negative: the real SDK write tool cannot write to a directory path.
		const { id: writeId } = await manager.start({ prompt: 'failed write', script: { toolName: 'write', path: '.', content: 'no\n' } });
		const writeRecord = await waitFor(manager, writeId, r => r.state === 'error' && r.reaped, 'write-directory refusal');
		assert.equal(writeRecord.child.exitCode, 1, 'worker exits nonzero on a failed planned tool');
		const writeEvents = manager.events(writeId, 0).events;
		const writeToolEnd = writeEvents.find(event => event.type === 'agent_event' && event.event === 'tool_end');
		assert.equal(writeToolEnd.isError, true, 'the real SDK write tool failed');
		const writeFailed = writeEvents.find(event => event.type === 'tool_failed');
		assert.ok(writeFailed, 'the captured tool failure is reported');
		assert.equal(writeFailed.tool, 'write');
		assert.equal(writeEvents.some(event => event.type === 'done'), false, 'no success is claimed');

		// Negative: reading a file that does not exist fails the run.
		const { id: readId } = await manager.start({ prompt: 'missing read', script: { toolName: 'read', path: 'no-such-file.txt' } });
		await waitFor(manager, readId, r => r.state === 'error' && r.reaped, 'missing-read refusal');
		const readEvents = manager.events(readId, 0).events;
		const readToolEnd = readEvents.find(event => event.type === 'agent_event' && event.event === 'tool_end');
		assert.equal(readToolEnd.tool, 'read');
		assert.equal(readToolEnd.isError, true, 'the real SDK read tool failed');
		assert.ok(readEvents.some(event => event.type === 'tool_failed'));
		assert.equal(readEvents.some(event => event.type === 'done'), false, 'no success is claimed');

		// Negative: an unknown planned tool is refused outright.
		const { id: badId } = await manager.start({ prompt: 'invalid tool', script: { toolName: 'bogus' } });
		await waitFor(manager, badId, r => r.state === 'error' && r.reaped, 'invalid-tool refusal');
		const badEvents = manager.events(badId, 0).events;
		const fatal = badEvents.find(event => event.type === 'fatal');
		assert.ok(fatal, 'the invalid planned tool is rejected with an explicit error');
		assert.match(fatal.message, /read.*write|write.*read/);
		assert.equal(badEvents.some(event => event.type === 'done'), false, 'no success is claimed');

		assert.deepEqual((await fs.readdir(workspace)).sort(), [], 'no tool file was created by any negative run');
	} finally { await manager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});

test('actual SDK: a successful read reports no wrote claim', async t => {
	const built = await fs.stat(sdkDist).then(() => true, () => false);
	if (!built) return t.skip(`Pi SDK dist not built at ${sdkDist}; actual-SDK read check skipped (not passed)`);

	const workspace = await workspaceDir();
	await fs.writeFile(path.join(workspace, 'note.txt'), 'actual-sdk note\n');
	const manager = createAgentManager({ workspace, runTimeoutMs: 120_000, killGraceMs: 2_000 });
	try {
		const { id } = await manager.start({ prompt: 'read the note', script: { toolName: 'read', path: 'note.txt', finalText: 'read it' } });
		await waitFor(manager, id, r => r.state === 'done' && r.reaped && r.child.exitCode === 0, 'read-only run completion');
		const events = manager.events(id, 0).events;
		const toolEnd = events.find(event => event.type === 'agent_event' && event.event === 'tool_end');
		assert.equal(toolEnd.tool, 'read');
		assert.equal(toolEnd.isError, false);
		const done = events.find(event => event.type === 'done');
		assert.ok(done, 'a successful read still completes the run');
		assert.equal(done.wrote, null, 'a read never claims a wrote path');
		assert.equal(events.filter(event => event.type === 'done').length, 1, 'exactly one canonical done, appended at the reap');
		const evidenceIndex = events.findIndex(event => event.type === 'worker_reported_done');
		assert.ok(evidenceIndex >= 0, 'the provisional report is retained as evidence');
		assert.ok(events.indexOf(done) > evidenceIndex, 'the evidence marker precedes the canonical done');
		assert.equal(await fs.readFile(path.join(workspace, 'note.txt'), 'utf8'), 'actual-sdk note\n', 'the file is untouched');
		assert.deepEqual((await fs.readdir(workspace)).sort(), ['note.txt'], 'nothing was written');
	} finally { await manager.close(); await fs.rm(workspace, {recursive:true,force:true}); }
});
