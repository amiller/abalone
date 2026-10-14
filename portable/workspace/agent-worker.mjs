// Dedicated Pi SDK worker process for the portable workspace agent adapter.
//
// Contract: one JSON job line on stdin ({prompt, cwd, agentDir?, script?}),
// JSONL progress events on stdout, console noise rerouted to stderr.
// Exit codes: 0 done/aborted, 1 error, 2 usage, 3 SDK unavailable.
// agentDir is optional: when omitted the worker creates a mode 0700 temporary
// directory outside the workspace for the run and removes it before exiting.
// When provided (manager path), the caller owns creation and cleanup.
//
// The worker embeds the vendored Pi SDK when it is built and drives it with a
// SCRIPTED local model: no provider inference, no network calls, no paid API.
// Tool execution inside the SDK is real (the admitted `read`/`write` tools run
// against the explicit cwd). This is local development tooling: cwd is not a
// sandbox, and nothing here enforces privacy or Tor routing.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const defaultSdkPath = path.join(repoRoot, 'vendor', 'pi', 'packages', 'coding-agent', 'dist', 'index.js');
const sdkPath = process.env.PORTABLE_PI_SDK || defaultSdkPath;

// Keep stdout a pure JSONL channel.
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);

const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const PROBE = process.argv.includes('--probe');

function unavailable(reason) {
	emit({ type: 'unavailable', reason, sdkPath });
	process.exit(3);
}

async function importSdk() {
	try {
		return { sdk: await import(pathToFileURL(sdkPath).href) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

if (PROBE) {
	const { sdk, error } = await importSdk();
	if (error) unavailable(`Pi SDK import failed at ${sdkPath}: ${error}`);
	emit({ type: 'ready', kind: 'sdk', sdkVersion: sdk.VERSION, sdkPath });
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Scripted model transport (no pi-ai imports needed; same event contract).
// ---------------------------------------------------------------------------

const SCRIPTED_PROVIDER = 'abalone-scripted';
const SCRIPTED_MODEL_ID = 'scripted-agent';
const SCRIPTED_API = 'abalone-scripted';

const zeroUsage = () => ({
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const scriptedModel = {
	id: SCRIPTED_MODEL_ID,
	name: 'Portable workspace scripted local agent (no inference)',
	api: SCRIPTED_API,
	provider: SCRIPTED_PROVIDER,
	baseUrl: 'urn:abalone:scripted', // Never fetched; the scripted transport performs no I/O.
	input: ['text'],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	contextWindow: 128000,
	maxTokens: 4096,
};

class SimpleEventStream {
	constructor() {
		this.queue = [];
		this.waiters = [];
		this.finished = false;
		this.resultPromise = new Promise(resolve => { this.resolveResult = resolve; });
	}
	push(event) {
		if (this.finished) return;
		if (event.type === 'done') { this.finished = true; this.resolveResult(event.message); }
		if (event.type === 'error') { this.finished = true; this.resolveResult(event.error); }
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.queue.push(event);
	}
	async *[Symbol.asyncIterator]() {
		for (;;) {
			const event = this.queue.shift();
			if (event) { yield event; continue; }
			if (this.finished) return;
			const result = await new Promise(resolve => this.waiters.push(resolve));
			if (result.done) return;
			yield result.value;
		}
	}
	result() { return this.resultPromise; }
}

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Scripted assistant turn: a tool call first, plain text once results return. */
function scriptedStream(model, context, options) {
	const messages = context.messages ?? [];
	const hasToolResult = messages.some(m => m.role === 'toolResult');
	const stream = new SimpleEventStream();
	const signal = options?.signal;
	(async () => {
		const base = {
			role: 'assistant', content: [], api: model.api, provider: model.provider,
			model: model.id, usage: zeroUsage(), stopReason: 'pending', timestamp: Date.now(),
		};
		const snap = () => ({ ...base, content: base.content.map(block => ({ ...block })) });
		const finishWith = (final, reason) => {
			final.stopReason = reason;
			stream.push({ type: 'done', reason, message: final });
		};
		const abort = () => {
			const aborted = { ...snap(), stopReason: 'aborted' };
			stream.push({ type: 'error', reason: 'aborted', error: aborted });
		};
		try {
			stream.push({ type: 'start', partial: snap() });
			if (signal?.aborted) return abort();
			if (!hasToolResult) {
				const toolCall = {
					type: 'toolCall', id: `scripted-${Date.now()}`, name: script.toolName,
					arguments: { path: script.path, content: script.content },
				};
				base.content.push(toolCall);
				stream.push({ type: 'toolcall_start', contentIndex: 0, partial: snap() });
				await tick(5);
				if (signal?.aborted) return abort();
				stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: { ...toolCall }, partial: snap() });
				return finishWith(snap(), 'toolUse');
			}
			const finalText = script.finalText;
			base.content.push({ type: 'text', text: '' });
			stream.push({ type: 'text_start', contentIndex: 0, partial: snap() });
			for (const piece of finalText.match(/[\s\S]{1,32}/g) ?? []) {
				await tick(5);
				if (signal?.aborted) return abort();
				base.content[0].text += piece;
				stream.push({ type: 'text_delta', contentIndex: 0, delta: piece, partial: snap() });
			}
			stream.push({ type: 'text_end', contentIndex: 0, content: finalText, partial: snap() });
			finishWith(snap(), 'stop');
		} catch (error) {
			console.error('scripted stream failed:', error);
			abort();
		}
	})();
	return stream;
}

const scriptedProvider = {
	id: SCRIPTED_PROVIDER,
	name: 'Portable workspace scripted transport (no network)',
	auth: {
		apiKey: {
			name: 'Scripted local auth (never requests anything)',
			resolve: async () => ({ auth: {}, source: 'scripted-local' }),
		},
	},
	getModels: () => [scriptedModel],
	getAllModels: () => [scriptedModel],
	stream: (model, context, options) => scriptedStream(model, context, options),
	streamSimple: (model, context, options) => scriptedStream(model, context, options),
};

// ---------------------------------------------------------------------------
// Job handling
// ---------------------------------------------------------------------------

let script = null;
// Set when this worker created its own per-run agent directory; only that
// directory is ever removed by this process.
let ownedAgentDir = null;
const cleanupAgentDir = () => {
	if (!ownedAgentDir) return;
	try { fs.rmSync(ownedAgentDir, { recursive: true, force: true }); } catch { /* best effort */ }
};

function readJob() {
	return new Promise((resolve, reject) => {
		let data = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', chunk => {
			data += chunk;
			if (Buffer.byteLength(data) > 65536) reject(new Error('Job too large'));
		});
		process.stdin.on('end', () => resolve(JSON.parse(data || '{}')));
		process.stdin.on('error', reject);
	});
}

function validateJob(job) {
	if (typeof job.prompt !== 'string' || !job.prompt.trim() || Buffer.byteLength(job.prompt) > 8192) {
		throw new Error('prompt must be a non-empty string of at most 8192 bytes');
	}
	if (typeof job.cwd !== 'string' || !path.isAbsolute(job.cwd)) throw new Error('cwd must be absolute');
	if (job.agentDir !== undefined && (typeof job.agentDir !== 'string' || !path.isAbsolute(job.agentDir))) {
		throw new Error('agentDir must be absolute when provided');
	}
	script = {
		toolName: 'write',
		path: 'agent-run.txt',
		content: `scripted-agent\n${job.prompt.slice(0, 200)}\n`,
		finalText: 'Scripted agent finished: it exercised the real SDK write tool locally. This was not model inference.',
	};
	const raw = job.script ?? {};
	for (const key of Object.keys(raw)) {
		if (!['toolName', 'path', 'content', 'finalText'].includes(key)) throw new Error(`Unknown script field: ${key}`);
		if (typeof raw[key] !== 'string' || Buffer.byteLength(raw[key]) > 2000) {
			throw new Error(`script.${key} must be a string of at most 2000 bytes`);
		}
		script[key] = raw[key];
	}
	// The scripted proof transport plans exactly one tool call, and it must be
	// one of the two admitted tools: an unknown planned tool is rejected here
	// instead of ever being reported as a successful run. (Defense in depth:
	// the SDK itself also errors unknown tool calls, and the captured-outcome
	// check after the run refuses success on any failed tool execution.)
	if (!['read', 'write'].includes(script.toolName)) {
		throw new Error(`script.toolName must be "read" or "write" for the scripted proof transport (got ${JSON.stringify(script.toolName)})`);
	}
}

const SYSTEM_PROMPT = [
	'You are the scripted agent of the portable workspace prototype.',
	'Responses are produced by a local script, not a model. Use only the admitted tools.',
].join('\n');

let session = null;
let settled = { done: false, aborted: false };
// Actual tool executions the SDK performed this run, as the SDK reported
// them: the planned scripted call is only believed when a real non-error
// execution of that tool was observed.
const toolOutcomes = [];

const forward = event => {
	switch (event.type) {
		case 'agent_start': return emit({ type: 'agent_event', event: 'agent_start' });
		case 'turn_start': return emit({ type: 'agent_event', event: 'turn_start' });
		case 'turn_end': return emit({ type: 'agent_event', event: 'turn_end' });
		case 'agent_end': return emit({ type: 'agent_event', event: 'agent_end' });
		case 'agent_settled': settled = { done: true, aborted: event.aborted }; return emit({ type: 'agent_event', event: 'agent_settled', aborted: event.aborted });
		case 'message_start': return emit({ type: 'agent_event', event: 'message_start', role: event.message?.role });
		case 'message_update':
			if (event.assistantMessageEvent?.type === 'text_delta') {
				return emit({ type: 'agent_event', event: 'text_delta', delta: String(event.assistantMessageEvent.delta).slice(0, 500) });
			}
			return;
		case 'message_end': {
			const message = event.message ?? {};
			return emit({ type: 'agent_event', event: 'message_end', role: message.role, stopReason: message.stopReason });
		}
		case 'tool_execution_start':
			return emit({
				type: 'agent_event', event: 'tool_start', tool: event.toolName,
				args: String(JSON.stringify(event.args ?? null)).slice(0, 400),
			});
		case 'tool_execution_end':
			toolOutcomes.push({ tool: event.toolName, isError: event.isError === true });
			return emit({ type: 'agent_event', event: 'tool_end', tool: event.toolName, isError: event.isError === true });
		case 'auto_retry_start':
		case 'auto_retry_end':
			return emit({ type: 'agent_event', event: event.type, ...(event.type === 'auto_retry_start' ? { attempt: event.attempt } : {}) });
		default: return;
	}
};

let stopping = false;
async function stop(reason) {
	if (stopping) return;
	stopping = true;
	try { if (session) await session.abort(); } catch (error) { console.error('abort failed:', error); }
	emit({ type: 'aborted', reason });
	cleanupAgentDir();
	process.exit(0);
}
process.on('SIGTERM', () => void stop('cancelled'));
process.on('SIGINT', () => void stop('interrupted'));

async function importAuthStorage() {
	const url = pathToFileURL(path.join(path.dirname(sdkPath), 'core', 'auth-storage.js')).href;
	try {
		return { AuthStorage: (await import(url)).AuthStorage };
	} catch (error) {
		return { error: `AuthStorage import failed next to ${sdkPath}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

try {
	const job = await readJob();
	validateJob(job);
	const { sdk, error } = await importSdk();
	if (error) unavailable(`Pi SDK import failed at ${sdkPath}: ${error}`);
	const { AuthStorage, error: authError } = await importAuthStorage();
	if (authError) throw new Error(authError);

	let agentDir = job.agentDir ?? null;
	if (agentDir) fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	else agentDir = ownedAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-'));
	emit({ type: 'ready', kind: 'sdk', sdkVersion: sdk.VERSION, sdkPath, model: `${SCRIPTED_PROVIDER}/${SCRIPTED_MODEL_ID}` });

	// Explicit in-memory and isolated state; nothing discovers HOME configuration.
	const settingsManager = sdk.SettingsManager.inMemory({
		// Automatic retries stay off for any future real provider integration.
		retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
		compaction: { enabled: false },
		cacheWarming: 'off',
	});
	const sessionManager = sdk.SessionManager.inMemory(job.cwd);
	// Credentials come from a real in-memory AuthStorage (imported from the SDK
	// dist core because it is not a public index export); no auth.json or
	// models.json path is configured anywhere, so nothing under the workspace
	// or a home directory is consulted for auth or model configuration.
	const modelRuntime = await sdk.ModelRuntime.create({
		credentials: AuthStorage.inMemory({ [SCRIPTED_PROVIDER]: { type: 'api_key', key: 'portable-scripted-local' } }),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(scriptedProvider);
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd: job.cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: SYSTEM_PROMPT,
	});
	await resourceLoader.reload();
	const model = modelRuntime.getModel(SCRIPTED_PROVIDER, SCRIPTED_MODEL_ID) ?? scriptedModel;
	const created = await sdk.createAgentSession({
		cwd: job.cwd,
		agentDir,
		model,
		thinkingLevel: 'off',
		modelRuntime,
		resourceLoader,
		sessionManager,
		settingsManager,
		tools: ['read', 'write'],
	});
	session = created.session;
	session.subscribe(forward);
	emit({ type: 'state', state: 'running' });
	await session.prompt(job.prompt);
	if (!stopping) {
		if (settled.aborted) {
			emit({ type: 'aborted', reason: 'run' });
		} else {
			// Actual-SDK evidence for isolation checks: what the runtime's own
			// credential store and model catalog report after the run.
			try {
				const credentialProviders = (await modelRuntime.listCredentials()).map(info => info.providerId);
				const models = modelRuntime.getAllModels().map(model => `${model.provider}/${model.id}`).slice(0, 300);
				emit({ type: 'sdk_diag', credentialProviders, models });
			} catch (diagError) {
				emit({ type: 'sdk_diag', error: String(diagError instanceof Error ? diagError.message : diagError).slice(0, 300) });
			}
			// Scripted-proof outcome policy: the script plans exactly ONE tool
			// call, so any failed (or, if tool admission ever diverges, unknown)
			// tool execution means the planned proof did not happen — report an
			// error run (no done, nonzero exit) instead of success. This
			// strictness is a property of the one-tool scripted transport, NOT a
			// general rule: a future genuine model agent may observe tool errors
			// mid-run and recover, and must not be failed permanently by them.
			const failed = toolOutcomes.find(outcome => outcome.isError);
			if (failed) {
				emit({ type: 'tool_failed', tool: failed.tool, plannedTool: script.toolName });
				session.dispose();
				cleanupAgentDir();
				process.exit(1);
			}
			// Only a captured, successful `write` execution justifies a wrote
			// claim; reads never claim a write.
			const writeSucceeded = toolOutcomes.some(outcome => outcome.tool === 'write' && !outcome.isError);
			emit({ type: 'done', lastText: session.getLastAssistantText() ?? '', wrote: script.toolName === 'write' && writeSucceeded ? script.path : null });
		}
		session.dispose();
		cleanupAgentDir();
		process.exit(0);
	}
} catch (error) {
	emit({ type: 'fatal', message: error instanceof Error ? error.message : String(error) });
	cleanupAgentDir();
	process.exit(1);
}
