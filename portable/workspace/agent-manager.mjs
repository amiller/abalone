// Agent lifecycle manager for the portable workspace server.
//
// Spawns one dedicated worker process per agent run (agent-worker.mjs, or an
// explicitly injected fixture worker for tests), with an allowlisted child
// environment: no inherited credentials, no ambient auth/resource discovery.
// Worker stdout is a JSONL event channel; buffers are bounded like terminal
// output. This is a local development prototype: the workspace directory is
// not a sandbox and no privacy or Tor enforcement is claimed.
//
// Lifecycle rules:
// - Capacity counts reserved starts (pendingStarts) plus records whose child
//   process has not exited yet. Capacity is reserved synchronously — no await
//   (including agentDir creation) may interleave between the check and the
//   reservation — and a failed start rolls its reservation back.
// - A worker-reported terminal event (done/aborted/...) is a protocol
//   outcome, not process termination. The record stays counted and is never
//   pruned until the child is actually reaped; stop()/close() can still kill
//   a worker that reported done and then hung.
// - A worker-reported "done" is provisional evidence, never a public
//   terminal state and never a public "done" event. It is converted on
//   arrival to a worker_reported_done evidence marker in the bounded stream,
//   while the worker's payload is retained privately on the record. The
//   state reported by events()/list() stays nonterminal (running/starting)
//   and no done-typed event is observable until the process is actually
//   reaped, so neither a state-polling nor an event-rendering consumer (the
//   UI prints its completion message from a done event) can mistake a
//   done-then-hang or done-then-nonzero worker for success.
// - Terminal "done" requires the protocol completion AND a clean process
//   exit (code 0, no signal), settled at reap: only then is the canonical
//   done event — the privately retained worker payload — appended to the
//   stream. done followed by a nonzero/unclean exit becomes error with no
//   canonical done; exit 0 with no reported completion becomes error.
//   Manager-initiated outcomes (timeout, aborted, error) take precedence over
//   a worker-reported done but never over each other; a late worker event can
//   never revive or replace a terminal state.
// - close() rejects new starts, waits for in-flight starts to settle, stops
//   every record and awaits both child reaping and removal of the per-run
//   agentDirs this manager created before resolving.
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultWorkerPath = path.join(here, 'agent-worker.mjs');

const TERMINAL_STATES = new Set(['done', 'aborted', 'error', 'timeout', 'killed', 'unavailable']);
// Manager-initiated outcomes outrank a worker-reported done (protocol
// completion is not termination) and never demote each other. 'done' itself
// is never set from a worker event: it is settled only at reap, when the
// protocol completion is confirmed by a clean exit.
const STATE_RANK = { starting: 0, running: 1, done: 2, unavailable: 3, aborted: 4, timeout: 5, killed: 6, error: 7 };

export function createAgentManager(options = {}) {
	const {
		workspace,
		workerPath = defaultWorkerPath,
		inferenceSocket = null,
		maxAgents = 2,
		maxRecords = 16,
		eventLimit = 256 * 1024,
		runTimeoutMs = 120_000,
		killGraceMs = 3_000,
		probeTimeoutMs = 60_000,
		probeRetryBaseMs = 1_000,
		probeMaxAttempts = 3,
		probeClock = () => performance.now(),
		probeRunner = null, // Trusted in-process test seam; never CLI/request data.
		probeLineLimit = 64 * 1024,
		maxFrameBytes = 1024 * 1024,
	} = options;
	if (!workspace || !path.isAbsolute(workspace)) throw new Error('An explicit absolute workspace is required');
	if (inferenceSocket !== null && (typeof inferenceSocket !== 'string' || !path.isAbsolute(inferenceSocket) || inferenceSocket.includes('\0') || Buffer.byteLength(inferenceSocket) > 107)) throw new Error('Inference socket must be an absolute Unix socket path');
	const workerArgs = inferenceSocket === null ? [] : ['--inference-socket', inferenceSocket];

	if (!Number.isSafeInteger(probeTimeoutMs) || probeTimeoutMs < 1 || probeTimeoutMs > 120_000) throw new Error('Probe timeout must be 1..120000ms');
	if (!Number.isSafeInteger(probeRetryBaseMs) || probeRetryBaseMs < 1 || probeRetryBaseMs > 30_000 || !Number.isSafeInteger(probeMaxAttempts) || probeMaxAttempts < 1 || probeMaxAttempts > 5) throw new Error('Invalid bounded probe retry policy');
	const records = new Map();
	let probe = null, probeChild = null, retryTimer = null, attempts = 0, retryAt = 0;
	let probeSnapshot = {available:false,kind:'warming',state:'warming',detail:'Agent SDK warming'};
	let closing = false;
	// The broker is deliberately absent until the operator unlocks the vault.
	// A bounded failed SDK probe must not require restarting this service later.
	// Requalify only when the supervisor-owned socket changes identity; polling
	// an unchanged broken socket never resets the existing probe attempt limit.
	let brokerIdentity = null, brokerGeneration = 0, brokerCheck = null;
	let brokerWatcher = null, brokerEpoch = 0;
	const watchBrokerDirectory = () => {
		if (brokerWatcher || closing) return;
		try {
			// Linux can reuse a removed socket's inode AND coarse timestamps.
			// Observe its fixed directory entry as well, so a quick lock/unlock
			// cannot remain stuck behind the previous socket's exhausted probes.
			brokerWatcher = watch(path.dirname(inferenceSocket), { persistent: false }, (_event, name) => {
				if (!closing && (name === null || name === path.basename(inferenceSocket))) brokerEpoch++;
			});
			brokerWatcher.on('error', () => {
				brokerWatcher?.close(); brokerWatcher = null;
				if (!closing) brokerEpoch++;
			});
		} catch { /* Parent may not exist before target tmpfiles setup. */ }
	};
	const checkBrokerSocket = () => {
		if (inferenceSocket === null || closing) return Promise.resolve();
		if (brokerCheck) return brokerCheck;
		watchBrokerDirectory();
		brokerCheck = fs.lstat(inferenceSocket, { bigint: true }).then(
			info => info.isSocket() ? `${info.dev}:${info.ino}:${info.ctimeNs}:${brokerEpoch}` : null,
			() => null,
		).then(identity => {
			if (closing) return;
			if (identity !== brokerIdentity) {
				brokerIdentity = identity;
				brokerGeneration++;
				attempts = 0;
				retryAt = 0;
				clearTimeout(retryTimer); retryTimer = null;
				probeSnapshot = { available: false, kind: 'warming', mode: 'broker', state: 'warming', detail: 'Agent SDK warming' };
			}
			if (identity === null) probeSnapshot = { available: false, kind: 'missing', mode: 'broker', state: 'unavailable', detail: 'Unlock storage to connect the inference provider' };
		}).finally(() => { brokerCheck = null; });
		return brokerCheck;
	};
	const refreshBrokerSocket = async () => {
		// An observation already in flight may predate a lock/unlock. Wait for
		// it, then take a fresh sample for an awaited status/start or probe result.
		if (brokerCheck) await brokerCheck;
		await checkBrokerSocket();
	};
	// Capacity reservations for starts that have not spawned their child yet;
	// guards the await window (probe, agentDir creation) between the capacity
	// check and the record becoming visible with a live child.
	let pendingStarts = 0;
	// Every start() attempt not yet settled, so close() can wait for starts
	// that were already in flight when shutdown began.
	const inFlightStarts = new Set();
	// Outstanding removals of per-run agentDirs created by this manager.
	const dirCleanups = new Set();

	const agentClosingError = () => {
		const error = new Error('Agent manager is closing; no new runs are accepted');
		error.code = 'AGENT_CLOSING';
		return error;
	};

	// Removes only the exact per-run directory this manager created with
	// mkdtemp, and tracks the removal so shutdown can await it.
	const removeAgentDir = dir => {
		const done = fs.rm(dir, { recursive: true, force: true }).catch(() => {});
		dirCleanups.add(done);
		done.then(() => dirCleanups.delete(done), () => dirCleanups.delete(done));
		return done;
	};

	// Fixed allowlist: PATH for tool helpers, a locale, and PI_OFFLINE to keep
	// the SDK from any model-catalog network refresh. HOME and every ambient
	// credential variable stay out of the worker.
	const childEnv = () => ({
		...(process.env.PATH ? { PATH: process.env.PATH } : {}),
		LANG: 'C.UTF-8',
		PI_OFFLINE: '1',
	});

	// Waits for a complete newline-terminated line: a JSON document split
	// across writes is not resolved early, and non-newline noise past
	// probeLineLimit kills the probe instead of buffering without bound.
	const firstJsonLine = child => new Promise((resolve, reject) => {
		let buffer = '';
		const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('probe timed out')); }, probeTimeoutMs);
		const fail = error => { clearTimeout(timer); reject(error); };
		child.once('error', fail);
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', chunk => {
			buffer += chunk;
			const newline = buffer.indexOf('\n');
			if (newline < 0) {
				if (buffer.length > probeLineLimit) {
					child.kill('SIGKILL');
					fail(new Error(`probe status line exceeded ${probeLineLimit} bytes`));
				}
				return;
			}
			clearTimeout(timer);
			try { resolve(JSON.parse(buffer.slice(0, newline))); } catch { fail(new Error('probe produced no JSON status line')); }
		});
		child.once('close', () => { clearTimeout(timer); reject(new Error('probe exited before reporting')); });
	});

	const performProbe = async () => {
        if (closing) throw agentClosingError();
        if (probeRunner) return probeRunner();
        const child = spawn(process.execPath, [workerPath, '--probe', ...workerArgs], {stdio:['ignore','pipe','ignore'],env:childEnv()});
        probeChild = child;
        const reaped = new Promise(resolve => child.once('close', resolve));
        try {
            const status = await firstJsonLine(child);
            if (status.type === 'ready' && inferenceSocket !== null && status.mode !== 'broker') return {available:false,kind:'missing',detail:'Configured broker mode was not confirmed'};
            if (status.type === 'ready') return {available:true,kind:status.kind ?? 'unknown',...(status.mode ? {mode:status.mode} : {}),sdkPath:status.sdkPath ?? workerPath,detail:status.kind === 'sdk' ? `Pi SDK ${status.sdkVersion ?? 'unknown version'}` : 'fixture transport'};
            return {available:false,kind:'missing',sdkPath:workerPath,detail:status.reason ?? 'Agent SDK unavailable'};
        } finally {
            child.kill('SIGKILL');
            await reaped;
            if (probeChild === child) probeChild = null;
        }
    };
    const beginProbe = () => {
        if (closing || probe || probeSnapshot.available || attempts >= probeMaxAttempts) return probe ?? Promise.resolve(probeSnapshot);
        if (inferenceSocket !== null && brokerIdentity === null) return Promise.resolve(probeSnapshot);
        clearTimeout(retryTimer); retryTimer = null;
        const generation = brokerGeneration;
        attempts++;
        probeSnapshot = {available:false,kind:'warming',state:'warming',attempt:attempts,detail:'Agent SDK warming'};
        probe = Promise.resolve().then(performProbe).catch(error => ({available:false,kind:'missing',detail:error.message})).then(async result => {
            await refreshBrokerSocket();
            if (closing) return {available:false,kind:'missing',state:'closed',detail:'Agent manager closed'};
            if (generation !== brokerGeneration) return {...probeSnapshot};
            probeSnapshot = {...result,state:result.available?'ready':'unavailable',attempt:attempts};
            if (!result.available && attempts < probeMaxAttempts) {
                const delay = Math.min(30_000, probeRetryBaseMs * 2 ** (attempts - 1));
                retryAt = probeClock() + delay;
                retryTimer = setTimeout(() => { retryTimer=null; void probeWorker(); }, delay);
                retryTimer.unref?.();
            }
            return probeSnapshot;
        }).finally(() => { probe = null; });
        return probe;
    };
    const readiness = () => {
        if (closing) return {available:false,kind:'missing',state:'closed',detail:'Agent manager closed'};
        if (inferenceSocket !== null) {
            void checkBrokerSocket().then(() => {
                if (!closing && !probeSnapshot.available && !probe && attempts < probeMaxAttempts && (attempts === 0 || probeClock() >= retryAt)) void beginProbe();
            });
            return {...probeSnapshot};
        }
        if (!probeSnapshot.available && !probe && attempts < probeMaxAttempts && (attempts === 0 || probeClock() >= retryAt)) void beginProbe();
        return {...probeSnapshot,...(probeSnapshot.state==='unavailable' && attempts<probeMaxAttempts ? {retryAfterMs:Math.max(0,retryAt-probeClock())} : {})};
    };
    // Explicit internal wait API; HTTP/IPC must use readiness(), never await SDK imports.
    const probeWorker = async () => {
        if (inferenceSocket === null) { readiness(); return probe ?? {...probeSnapshot}; }
        await refreshBrokerSocket();
        if (closing) return {available:false,kind:'missing',state:'closed',detail:'Agent manager closed'};
        if (!probe && !probeSnapshot.available && attempts < probeMaxAttempts && (attempts === 0 || probeClock() >= retryAt)) void beginProbe();
        return probe ?? {...probeSnapshot};
    };

	// Live occupancy: reserved starts plus records whose child process has not
	// exited. A worker that reported done but still holds its process keeps
	// occupying a slot until it is actually reaped.
	const liveCount = () => pendingStarts + [...records.values()].filter(record => !record.reaped).length;

	// Prunes only records that are both protocol-terminal and reaped: a
	// done-reporting but still-live worker must stay reachable so stop() and
	// close() can kill it.
	const prune = () => {
		const finished = [...records.entries()].filter(([, record]) => TERMINAL_STATES.has(record.state) && record.reaped);
		while (records.size > maxRecords && finished.length) {
			const [id] = finished.shift();
			records.delete(id);
		}
	};

	const append = (record, event) => {
		const line = JSON.stringify(event);
		const bytes = Buffer.byteLength(line) + 1;
		record.lines.push({ event, bytes });
		record.bytes += bytes;
		while (record.bytes > eventLimit && record.lines.length > 1) {
			const dropped = record.lines.shift();
			record.bytes -= dropped.bytes;
			record.base += dropped.bytes;
			record.truncated = true;
		}
	};

	const reap = record => {
		if (record.timer) clearTimeout(record.timer);
		if (record.killTimer) clearTimeout(record.killTimer);
	};

	const terminate = (record, state) => {
		if (record.child.exitCode !== null || record.child.signalCode !== null) return;
		record.enforce(state);
		try { record.child.kill('SIGTERM'); } catch { /* already gone */ }
		if (record.killTimer) clearTimeout(record.killTimer);
		record.killTimer = setTimeout(() => { try { record.child.kill('SIGKILL'); } catch { /* already gone */ } }, killGraceMs);
	};

	const startRun = async (job = {}) => {
		const { prompt, script } = job;
		if (inferenceSocket !== null && Object.hasOwn(job, 'script')) throw new Error('Scripted jobs cannot select a broker run');
		if (closing) throw agentClosingError();
		const status = await probeWorker();
		if (closing) throw agentClosingError();
		if (!status.available) {
			const error = new Error(status.detail || 'Agent SDK unavailable');
			error.code = 'AGENT_UNAVAILABLE';
			throw error;
		}
		if (closing) throw agentClosingError();
		if (liveCount() >= maxAgents) {
			const error = new Error('Agent capacity reached; stop a running agent first');
			error.code = 'AGENT_CAPACITY';
			throw error;
		}
		// Reserve capacity synchronously: no await may run between the check
		// above and this increment. Holds through agentDir creation and spawn.
		pendingStarts += 1;
		let agentDir = null;
		try {
			// Per-run agent directory: fresh, mode 0700 (mkdtemp), outside the
			// workspace. The worker never sees a path inside the workspace for
			// SDK state, and only this exact created directory is removed.
			agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-agent-'));
			if (closing) throw agentClosingError();
			const id = crypto.randomUUID();
			const record = {
				id, state: 'starting', child: null, reaped: false, lines: [], bytes: 0, base: 0, truncated: false,
				timer: null, killTimer: null, startedAt: Date.now(), agentDir, malformed: false, cleaned: false,
				closed: null, cleanupDone: null, completion: false, completionPayload: null,
			};
			// Worker-protocol transitions are strictly monotonic: once
			// terminal, no late worker event (a stray "running" after done, a
			// done after timeout) can revive or replace the terminal state. A
			// worker "done" does not transition at all: it only records the
			// provisional completion; the public state stays nonterminal until
			// the close handler settles it at reap.
			record.transition = state => {
				if (!TERMINAL_STATES.has(record.state)) record.state = state;
			};
			// Manager-initiated outcomes (timeout/aborted/error) may supersede
			// a worker-reported done, never each other, never downward.
			record.enforce = state => {
				if ((STATE_RANK[state] ?? 0) > (STATE_RANK[record.state] ?? 0)) record.state = state;
			};
			let settleClosed;
			record.closed = new Promise(resolve => { settleClosed = resolve; });
			const cleanup = () => {
				if (record.cleaned) return record.cleanupDone;
				record.cleaned = true;
				record.cleanupDone = removeAgentDir(agentDir);
				return record.cleanupDone;
			};

			// Spawn before the record becomes visible: no consumer of
			// records/list() ever observes a child:null record.
			const child = spawn(process.execPath, [workerPath, ...workerArgs], { stdio: ['pipe', 'pipe', 'ignore'], env: childEnv() });
			record.child = child;
			let buffer = '';
			const handleLine = line => {
				if (!line.trim() || record.malformed) return;
				let event;
				try { event = JSON.parse(line); } catch {
					append(record, { type: 'worker_log', line: line.slice(0, 500) });
					return;
				}
				// A worker "done" is converted, never published as-is: the public
				// stream gains only a worker_reported_done evidence marker, and
				// the payload is retained privately on the record. The canonical
				// done (this payload) is appended only once the reap verifies a
				// clean exit, so no done-typed event is observable before that —
				// a consumer that renders events, like the UI, cannot print its
				// completion message from a provisional claim.
				if (event.type === 'done') {
					record.completion = true;
					record.completionPayload = event;
					append(record, { type: 'worker_reported_done' });
					return;
				}
				append(record, event);
				switch (event.type) {
					case 'state':
						if (event.state === 'running') record.transition('running');
						break;
					case 'aborted': record.transition('aborted'); break;
					case 'unavailable': record.transition('unavailable'); break;
					default: break;
				}
			};
			// A single frame larger than maxFrameBytes is refused before parsing or
			// retention: nothing oversized is buffered into the event record, and a
			// worker emitting one is terminated as malformed.
			const refuseFrame = bytes => {
				if (record.malformed) return;
				record.malformed = true;
				append(record, { type: 'frame_too_large', bytes, limit: maxFrameBytes });
				record.enforce('error');
				terminate(record, 'error');
			};
			child.stdout.setEncoding('utf8');
			child.stdout.on('data', chunk => {
				if (record.malformed) return;
				buffer += chunk;
				let index;
				while ((index = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, index);
					buffer = buffer.slice(index + 1);
					if (line.length > maxFrameBytes) return refuseFrame(line.length);
					handleLine(line);
				}
				if (buffer.length > maxFrameBytes) refuseFrame(buffer.length);
			});
			child.stdin.on('error', () => {});
			child.on('error', error => {
				record.enforce('error');
				append(record, { type: 'error', message: error.message });
				// Spawn errors never produce a close event: the record is
				// reaped here so capacity, prune and stop() see the truth.
				record.reaped = true;
				cleanup();
				settleClosed();
			});
			child.on('close', (code, signal) => {
				reap(record);
				record.reaped = true;
				if (!record.malformed && buffer.trim()) handleLine(buffer);
				// Settlement happens only at reap. If a terminal state is already
				// set (manager-initiated timeout/abort/error, or a worker-reported
				// aborted/unavailable) it keeps precedence and is left untouched;
				// otherwise the run settles by combining the provisional protocol
				// completion with process exit truth.
				if (!TERMINAL_STATES.has(record.state)) {
					if (record.completion && code === 0 && signal === null) {
						// Protocol completion confirmed by a clean exit: this, and
						// only this, is the terminal success, and only now is the
						// canonical done — the privately retained worker payload —
						// appended to the public stream.
						record.state = 'done';
						append(record, record.completionPayload);
					} else if (record.completion) {
						// Reported completion but the process did not exit cleanly
						// (nonzero code or kill signal): not a success.
						record.state = 'error';
						append(record, { type: 'worker_exit', code, signal: signal ?? null, detail: 'worker reported done but exited uncleanly' });
					} else {
						// No protocol completion was ever reported.
						record.state = 'error';
						append(record, { type: 'worker_exit', code, signal: signal ?? null, detail: 'worker exited without reporting completion' });
					}
				}
				prune();
				cleanup();
				settleClosed();
			});
			records.set(id, record);
			prune();
			pendingStarts -= 1;
			record.timer = setTimeout(() => terminate(record, 'timeout'), runTimeoutMs);
			try {
				child.stdin.write(JSON.stringify({ prompt, cwd: workspace, agentDir, ...(inferenceSocket === null ? { script: script ?? null } : {}) }) + '\n');
				child.stdin.end();
			} catch { /* child vanished instantly; its close handler owns the record */ }
			return { id };
		} catch (error) {
			pendingStarts -= 1;
			// The record was never published (spawn happens before
			// records.set), so only the reservation and directory roll back.
			if (agentDir) await removeAgentDir(agentDir);
			throw error;
		}
	};

	const start = options => {
		if (closing) return Promise.reject(agentClosingError());
		const attempt = startRun(options);
		inFlightStarts.add(attempt);
		return attempt.finally(() => inFlightStarts.delete(attempt));
	};

	const get = id => records.get(id) ?? null;

	const events = (id, after = 0) => {
		const record = records.get(id);
		if (!record) return null;
		if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid offset');
		const out = [];
		let offset = record.base;
		for (const line of record.lines) {
			const start = offset;
			offset += line.bytes;
			if (start >= after) out.push(line.event);
		}
		return { events: out, offset, truncated: after < record.base, state: record.state };
	};

	// Cancels a run and resolves only after the child is actually reaped and
	// this run's agentDir removal has settled. There is no give-up timeout
	// that could abandon a live child: terminate() escalates SIGTERM->SIGKILL.
	const stop = id => {
		const record = records.get(id);
		if (!record) return Promise.resolve(false);
		return (async () => {
			terminate(record, 'aborted');
			// record.closed resolves only after the child's close/error handler
			// has run, and that handler always starts the agentDir cleanup first.
			await record.closed;
			await record.cleanupDone;
			records.delete(id);
			return true;
		})();
	};

	const list = () => [...records.values()].map(record => ({
		id: record.id,
		state: record.state,
		// Process truth, not protocol outcome: a worker that reported done but
		// still holds its process is listed alive (and still occupies capacity).
		alive: !record.reaped,
	}));

	const close = async () => {
		closing = true;
		brokerWatcher?.close(); brokerWatcher = null;
		clearTimeout(retryTimer);
		if (brokerCheck) await brokerCheck;
		if (probeChild) { probeChild.kill('SIGKILL'); await probe; }
		// Starts already in flight when shutdown began must settle (they
		// re-check closing after each await and roll back); no new start can
		// pass the entry check.
		while (inFlightStarts.size > 0) await Promise.allSettled([...inFlightStarts]);
		await Promise.all([...records.keys()].map(id => stop(id)));
		// Shutdown is done only once every created per-run agentDir removal
		// (including those of already-pruned records) has settled.
		while (dirCleanups.size > 0) await Promise.allSettled([...dirCleanups]);
	};

	return { status: probeWorker, readiness, start, get, events, stop, list, close };
}
