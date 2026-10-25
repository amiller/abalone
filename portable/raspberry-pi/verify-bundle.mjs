#!/usr/bin/env node
/**
 * Verify a Pi SDK runtime bundle produced by portable/raspberry-pi/package-sdk.mjs.
 *
 * The same script ships inside the bundle (verify/verify-bundle.mjs) so the
 * receiving machine can repeat the exact checks after transfer:
 *
 *   node verify/verify-bundle.mjs            (from the bundle root)
 *
 * ORDER OF CHECKS (fail closed, manifest first):
 *   1. Environment isolation: the process env is reduced to an allowlist and
 *      HOME/TMPDIR are replaced with disposable directories BEFORE any bundle
 *      code is imported. Discovery canaries are planted in the disposable HOME.
 *   2. Complete manifest check BEFORE any runtime import of bundle code:
 *      every entry is a safe relative path (no absolute/traversal/duplicate/
 *      alias), the bundle contains only regular files and directories (no
 *      symlinks, no special files), nothing is missing, nothing unlisted, and
 *      every hash matches. manifest.txt is the integrity root; it is integrity
 *      relative to the separately trusted transfer digest (.tar.gz.sha256
 *      verified over a trusted channel), NOT authenticity.
 *   3. Only then: SDK import probe, native artifact checks (headers for every
 *      artifact, actual dlopen of host-arch bindings; target-arch bindings are
 *      an explicit open gate when the host differs), quickjs WASM
 *      instantiation, and a scripted agent session driving the real write tool
 *      under the isolated agent-worker recipe with canary assertions.
 *
 * Scope: these checks prove manifest integrity, that the imported SDK entry
 * points load, that quickjs instantiates, and that the write tool executes.
 * They do NOT prove universal SDK completeness, and a successful host run is
 * never proof for the target architecture.
 */
import { createHash } from "node:crypto";
import { openSync, closeSync, fstatSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM"];
const SYSTEM_PROMPT = "You are a bundle verification assistant. Follow the operator's instruction exactly.";

// ---------------------------------------------------------------------------
// Failure handling with cleanup of disposable directories
// ---------------------------------------------------------------------------

const cleanupFns = [];

function cleanup() {
	while (cleanupFns.length > 0) {
		const fn = cleanupFns.pop();
		try {
			fn();
		} catch {
			// best effort
		}
	}
}

function fail(message) {
	cleanup();
	console.error(`verify-bundle: FAIL: ${message}`);
	process.exit(1);
}

function ok(message) {
	console.log(`verify-bundle: ok: ${message}`);
}

function parseArgs(argv) {
	const options = { bundle: "" };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--bundle") options.bundle = resolve(argv[++i]);
		else if (argv[i] === "--check-manifest") {
			// Kept for compatibility: the manifest is ALWAYS checked first.
		} else fail(`unknown argument ${argv[i]}`);
	}
	if (!options.bundle) options.bundle = resolve(SCRIPT_DIR, "..");
	return options;
}

// ---------------------------------------------------------------------------
// 0. Environment isolation (before any bundle code is imported)
// ---------------------------------------------------------------------------

function isolateEnvironment() {
	const isolated = mkdtempSync(join(tmpdir(), "pi-verify-env-"));
	const home = join(isolated, "home");
	const tmp = join(isolated, "tmp");
	const markerDir = join(isolated, "markers");
	mkdirSync(home, { recursive: true });
	mkdirSync(tmp, { recursive: true });
	mkdirSync(markerDir, { recursive: true });
	cleanupFns.push(() => rmSync(isolated, { recursive: true, force: true }));

	// Plant discovery canaries in the disposable HOME. If any discovery path
	// executed despite the isolation flags, markers would appear and the
	// canary assertions below would fail.
	const agentDir = join(home, ".pi", "agent");
	for (const dir of ["extensions", "skills/canary-skill", "prompts", "themes"]) {
		mkdirSync(join(agentDir, dir), { recursive: true });
	}
	writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify({ "canary-provider": { type: "api_key", key: "canary-key" } }, null, 2)}\n`);
	writeFileSync(
		join(agentDir, "models.json"),
		`${JSON.stringify(
			{ providers: { "canary-provider": { baseUrl: "http://127.0.0.1:9", api: "anthropic-messages", models: [{ id: "canary-model", name: "Canary Model" }] } } },
			null,
			2,
		)}\n`,
	);
	writeFileSync(join(agentDir, "SYSTEM.md"), "CANARY-GLOBAL-SYSTEM-PROMPT must never appear in the session system prompt.\n");
	writeFileSync(
		join(agentDir, "extensions", "canary-ext.mjs"),
		[
			'import { writeFileSync } from "node:fs";',
			'// If discovery imports this file, the marker proves it.',
			'writeFileSync(process.env.PI_VERIFY_CANARY_DIR + "/extension-executed", "yes");',
			"export default {};",
			"",
		].join("\n"),
	);
	writeFileSync(join(agentDir, "skills", "canary-skill", "SKILL.md"), "---\nname: canary-skill\ndescription: canary\n---\nCANARY SKILL\n");
	writeFileSync(join(agentDir, "prompts", "canary-prompt.md"), "CANARY PROMPT TEMPLATE\n");
	writeFileSync(join(agentDir, "themes", "canary-theme.json"), '{"name":"canary-theme","CANARY":true}\n');

	const clean = {};
	for (const key of ENV_ALLOWLIST) {
		if (process.env[key] !== undefined) clean[key] = process.env[key];
	}
	clean.HOME = home;
	clean.TMPDIR = tmp;
	clean.PI_OFFLINE = "1"; // model network disabled at the runtime level too
	clean.PI_VERIFY_CANARY_DIR = markerDir;
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, clean);

	return { home, tmp, markerDir };
}

// ---------------------------------------------------------------------------
// 1. Manifest check (complete, strict, BEFORE any runtime import)
// ---------------------------------------------------------------------------

const ELF_MACHINE_TO_ARCH = { 3: "ia32", 40: "arm", 62: "x64", 183: "arm64", 243: "riscv64" };

function inspectBinary(file) {
	const data = readFileSync(file);
	if (data.length >= 20 && data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46) {
		return { format: "elf", bits: data[4] === 2 ? 64 : 32, arch: ELF_MACHINE_TO_ARCH[data.readUInt16LE(18)] || "unknown" };
	}
	if (data.length >= 4 && data[0] === 0x00 && data[1] === 0x61 && data[2] === 0x73 && data[3] === 0x6d) {
		return { format: "wasm", arch: "wasm32 (portable)" };
	}
	return { format: "unknown", arch: "?" };
}

function checkManifest(bundleDir) {
	// The bundle root itself must not be a symlink/path alias.
	const realBundle = realpathSync(bundleDir);
	if (realBundle !== resolve(bundleDir)) {
		fail(`bundle path is an alias (symlink?): ${bundleDir} -> ${realBundle}; pass the real path`);
	}
	const manifestPath = join(bundleDir, "manifest.txt");
	if (!existsSync(manifestPath)) fail("manifest.txt missing");
	// Open without following links or blocking on FIFOs, then validate the
	// descriptor before reading. The manifest root needs the same type gate.
	const manifestFd = openSync(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	let manifestText;
	try {
		const info = fstatSync(manifestFd);
		if (!info.isFile() || info.size > 16 * 1024 * 1024) fail("manifest.txt must be a bounded regular file");
		manifestText = readFileSync(manifestFd, "utf8");
	} finally { closeSync(manifestFd); }
	const entries = new Map();
	for (const line of manifestText.split("\n")) {
		if (line.startsWith("#") || line.trim() === "") continue;
		const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
		if (!match) fail(`malformed manifest line: ${JSON.stringify(line)}`);
		const [, sha, rawPath] = match;
		if (rawPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rawPath)) fail(`manifest entry is absolute: ${rawPath}`);
		if (rawPath.includes("\\")) fail(`manifest entry contains a backslash (non-portable): ${rawPath}`);
		const segments = rawPath.split("/");
		if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
			fail(`manifest entry is empty/traversal: ${rawPath}`);
		}
		if (rawPath === "manifest.txt") fail("manifest.txt must not list itself (it is the integrity root)");
		if (entries.has(rawPath)) fail(`duplicate manifest entry: ${rawPath}`);
		const file = resolve(bundleDir, rawPath);
		if (!(file === bundleDir || file.startsWith(bundleDir + sep))) fail(`manifest entry escapes the bundle: ${rawPath}`);
		entries.set(rawPath, sha);
	}
	if (entries.size === 0) fail("manifest.txt lists no files");

	// Walk the bundle: regular files and directories only.
	const diskFiles = new Set(["manifest.txt"]);
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			const rel = relative(bundleDir, path);
			if (entry.isSymbolicLink()) fail(`bundle contains a symlink (format forbids symlinks): ${rel}`);
			if (entry.isDirectory()) {
				walk(path);
				continue;
			}
			if (!entry.isFile()) fail(`bundle contains a non-regular file: ${rel}`);
			diskFiles.add(rel);
		}
	};
	walk(bundleDir);

	for (const [rel, expected] of entries) {
		const file = join(bundleDir, rel);
		if (!existsSync(file)) fail(`manifest lists missing file: ${rel}`);
		let stat;
		try {
			stat = lstatSync(file);
		} catch {
			fail(`cannot stat manifest entry: ${rel}`);
		}
		if (!stat.isFile()) fail(`manifest entry is not a regular file: ${rel}`);
		if (realpathSync(file) !== file) fail(`manifest entry is a path alias (realpath differs): ${rel}`);
		const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
		if (sha256 !== expected) fail(`checksum mismatch: ${rel}`);
	}
	for (const rel of diskFiles) {
		if (rel === "manifest.txt") continue; // the integrity root cannot hash itself
		if (!entries.has(rel)) fail(`bundle contains a file not listed in manifest.txt: ${rel}`);
	}

	// manifest.json must exist and parse (it is hashed content, checked above).
	const manifestJsonPath = join(bundleDir, "manifest.json");
	if (!entries.has("manifest.json")) fail("manifest.txt does not cover manifest.json");
	try {
		const meta = JSON.parse(readFileSync(manifestJsonPath, "utf8"));
		if (typeof meta.generator !== "string" || !meta.target?.arch) {
			fail("manifest.json is missing generator/target metadata");
		}
	} catch (error) {
		fail(`manifest.json is unreadable: ${error.message}`);
	}
	ok(`manifest verified FIRST: ${entries.size} files hashed and matched, no symlinks, no missing/unlisted/absolute/traversal/duplicate entries`);
}

// ---------------------------------------------------------------------------
// 2. SDK probe (only after the manifest check passed)
// ---------------------------------------------------------------------------

async function importFromBundle(bundleDir, relativePath) {
	const file = join(bundleDir, "node_modules", "@earendil-works", relativePath);
	if (!existsSync(file)) fail(`bundle is missing ${relative(bundleDir, file)}`);
	return import(pathToFileURL(file).href);
}

async function probeSdk(bundleDir) {
	const sdk = await importFromBundle(bundleDir, "pi-coding-agent/dist/index.js");
	for (const name of ["VERSION", "AgentSession", "SessionManager", "SettingsManager", "DefaultResourceLoader", "createCodingTools", "createWriteTool", "ModelRuntime", "runPrintMode"]) {
		if (!(name in sdk)) fail(`SDK entry does not export ${name}`);
	}
	ok(`SDK loads from bundle: @earendil-works/pi-coding-agent@${sdk.VERSION}`);

	const ai = await importFromBundle(bundleDir, "pi-ai/dist/index.js");
	if (typeof ai.createAssistantMessageEventStream !== "function") fail("pi-ai does not export createAssistantMessageEventStream");
	const agentCore = await importFromBundle(bundleDir, "pi-agent-core/dist/index.js");
	if (typeof agentCore.Agent !== "function") fail("pi-agent-core does not export Agent");
	ok("pi-ai and pi-agent-core load from bundle");
	return { sdk, ai, agentCore };
}

// ---------------------------------------------------------------------------
// 3. Native and WASM artifacts
// ---------------------------------------------------------------------------

/** Package root (bundle-relative) of a file inside node_modules. */
function packageRootOfRelative(relPath) {
	const segments = relPath.split("/");
	const idx = segments.lastIndexOf("node_modules");
	if (idx === -1 || idx === segments.length - 1) return relPath;
	const rest = segments.slice(idx + 1);
	const root = rest[0].startsWith("@") && rest.length > 1 ? [rest[0], rest[1]] : [rest[0]];
	return [...segments.slice(0, idx + 1), ...root].join("/");
}

async function checkArtifacts(bundleDir) {
	const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8"));
	const targetArch = manifest.target?.arch ?? fail("manifest.json has no target.arch");
	const hostArch = process.arch;
	const artifacts = manifest.nativeArtifacts ?? [];
	const elfArchesByPackage = new Map();
	for (const artifact of artifacts) {
		const info = inspectBinary(join(bundleDir, artifact.path));
		if (info.format !== artifact.format || info.arch !== artifact.arch) {
			fail(`native artifact ${artifact.path} does not match the manifest claim (${JSON.stringify(info)} vs ${JSON.stringify(artifact)})`);
		}
		if (info.format === "elf") {
			const root = packageRootOfRelative(artifact.path);
			if (!elfArchesByPackage.has(root)) elfArchesByPackage.set(root, new Set());
			elfArchesByPackage.get(root).add(info.arch);
		}
	}
	// Target-coverage rule: every non-target ELF package must also ship a
	// target-arch ELF (this revalidates the packager's rule on the target).
	for (const artifact of artifacts) {
		if (artifact.format !== "elf") continue;
		if (artifact.arch === targetArch) continue;
		const root = packageRootOfRelative(artifact.path);
		if (!elfArchesByPackage.get(root)?.has(targetArch)) {
			fail(`native artifact ${artifact.path} is ${artifact.arch} and package ${root} ships no ${targetArch} variant (wrong-arch-only dependency)`);
		}
	}
	// pi-tui prebuilds: header check for each bundled arch, plus an ACTUAL
	// binding load for prebuilds matching this host. Non-host prebuilds are an
	// explicit open gate, never claimed from here.
	const prebuildBase = join("node_modules", "@earendil-works", "pi-tui", "native", "linux", "prebuilds");
	for (const artifact of artifacts) {
		if (!artifact.path.startsWith(prebuildBase) || !artifact.path.endsWith(".node")) continue;
		const arch = artifact.arch;
		ok(`pi-tui prebuild ${relative(prebuildBase, dirname(artifact.path))}: ELF header validated (${arch})`);
		if (arch === hostArch) {
			try {
				const { createRequire } = await import("node:module");
				const req = createRequire(import.meta.url);
				const binding = req(join(bundleDir, artifact.path));
				ok(`pi-tui ${arch} native binding ACTUALLY LOADED on this host (exports: ${Object.keys(binding).join(", ") || "none"})`);
			} catch (error) {
				fail(`pi-tui ${arch} native binding failed to load on this ${hostArch} host: ${error.message}`);
			}
		} else {
			console.log(`verify-bundle: gate: pi-tui ${arch} binding NOT loadable on host ${hostArch}; open gate for on-target verification`);
		}
	}
	// WASM payloads are validated by header here and instantiated below.
	const wasmTargets = [
		["@silvia-odwyer/photon-node/photon_rs_bg.wasm", "photon image conversion"],
		["quickjs-wasi/quickjs.wasm", "codemode quickjs runtime"],
	];
	for (const [path, label] of wasmTargets) {
		const file = join(bundleDir, "node_modules", path);
		if (!existsSync(file)) fail(`missing ${label} payload: ${path}`);
		const info = inspectBinary(file);
		if (info.format !== "wasm") fail(`${label} payload is not WebAssembly: ${path}`);
		ok(`${label}: WebAssembly payload present (portable across CPU architectures)`);
	}
}

async function checkQuickjs(bundleDir) {
	const quickjsUrl = pathToFileURL(join(bundleDir, "node_modules", "quickjs-wasi", "dist", "index.js")).href;
	const mod = await import(quickjsUrl);
	if (typeof mod.QuickJS?.create !== "function") fail("quickjs-wasi does not export QuickJS.create");
	const wasmPath = join(bundleDir, "node_modules", "quickjs-wasi", "quickjs.wasm");
	// Mirror the real consumer (pi-codemode): resolve quickjs-wasi/quickjs.wasm
	// through node resolution and pass the bytes to QuickJS.create.
	const wasmBytes = readFileSync(wasmPath);
	let vm;
	try {
		vm = await mod.QuickJS.create({ wasm: wasmBytes });
		if (!vm?.exports?.memory) fail("quickjs-wasm module failed to instantiate (no exported memory)");
		const versions = vm.versions;
		if (!versions?.quickjs) fail("instantiated quickjs reports no engine version");
		ok(`quickjs-wasi WebAssembly instantiates from the bundle (quickjs ${versions.quickjs})`);
	} finally {
		vm?.dispose?.();
	}
}

// ---------------------------------------------------------------------------
// 4. Scripted session driving the real write tool (isolated agent-worker recipe)
// ---------------------------------------------------------------------------

const PROOF_TEXT = `pi-sdk bundle verification ${new Date().toISOString()}\n`;

async function scriptedToolSession(bundleDir, modules, canary) {
	const { sdk, ai, agentCore } = modules;
	const tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-verify-"));
	cleanupFns.push(() => rmSync(tempDir, { recursive: true, force: true }));
	const agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	// Project-scope discovery canaries (cwd), in addition to the HOME ones.
	const projectAgentDir = join(tempDir, ".pi", "agent", "extensions");
	mkdirSync(projectAgentDir, { recursive: true });
	writeFileSync(
		join(projectAgentDir, "canary-project-ext.mjs"),
		[
			'import { writeFileSync } from "node:fs";',
			'writeFileSync(process.env.PI_VERIFY_CANARY_DIR + "/project-extension-executed", "yes");',
			"export default {};",
			"",
		].join("\n"),
	);
	writeFileSync(join(tempDir, "AGENTS.md"), "CANARY-CONTEXT-FILE must never be loaded.\n");

	// Isolation recipe (mirrors portable/workspace/agent-worker.mjs): explicit
	// in-memory everything, discovery disabled, no network, explicit prompt.
	const settingsManager = sdk.SettingsManager.inMemory({
		retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
		compaction: { enabled: false },
		cacheWarming: "off",
	});
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd: tempDir,
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

	const authStorage = (await importFromBundle(bundleDir, "pi-coding-agent/dist/core/auth-storage.js")).AuthStorage.inMemory({
		faux: { type: "api_key", key: "faux-key" },
	});
	const { InMemoryCodingAgentModelsStore } = await importFromBundle(bundleDir, "pi-coding-agent/dist/core/models-store.js");
	const modelRuntime = await sdk.ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	const fauxModel = {
		id: "faux-1",
		name: "Faux Model",
		api: "anthropic-messages",
		provider: "faux",
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
	modelRuntime.registerProvider("faux", {
		baseUrl: fauxModel.baseUrl,
		api: fauxModel.api,
		models: [{ ...fauxModel }],
	});

	const helloPath = join(tempDir, "hello.txt");
	const responses = [
		{ toolCalls: [{ name: "write", args: { path: helloPath, content: PROOF_TEXT } }] },
		{ text: "wrote the file" },
	];
	let callCount = 0;
	const streamFn = () => {
		const response = responses[callCount++ % responses.length];
		const message = {
			role: "assistant",
			content: response.toolCalls
				? [
						{
							type: "toolCall",
							id: `verify_${callCount}`,
							name: response.toolCalls[0].name,
							arguments: response.toolCalls[0].args,
						},
					]
				: [{ type: "text", text: response.text }],
			api: fauxModel.api,
			provider: fauxModel.provider,
			model: fauxModel.id,
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: response.toolCalls ? "toolUse" : "stop",
			timestamp: Date.now(),
		};
		const stream = ai.createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
			message.content.forEach((block, index) => {
				if (block.type === "text") {
					stream.push({ type: "text_start", contentIndex: index, partial: message });
					stream.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: message });
					stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: message });
				} else {
					stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: message });
				}
			});
			stream.push({ type: "done", reason: message.stopReason, message });
		});
		return stream;
	};

	const tools = sdk.createCodingTools(tempDir);
	const toolRecord = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
	if (!toolRecord.write) fail("createCodingTools did not provide a write tool");

	const agent = new agentCore.Agent({
		getApiKey: async () => "faux-key",
		initialState: { model: fauxModel, systemPrompt: SYSTEM_PROMPT, tools: [] },
		streamFn,
	});

	const events = [];
	const session = new sdk.AgentSession({
		agent,
		sessionManager: sdk.SessionManager.inMemory(tempDir),
		settingsManager,
		cwd: tempDir,
		modelRuntime,
		resourceLoader,
		baseToolsOverride: toolRecord,
	});
	session.subscribe((event) => events.push(event));

	try {
		const timeout = new Promise((_, reject) => {
			const timer = setTimeout(() => reject(new Error("session timed out after 90s")), 90000);
			timer.unref();
		});
		timeout.catch(() => {}); // the race winner may finish first; keep the rejection handled
		await Promise.race([session.prompt("Write hello.txt exactly as instructed."), timeout]);
	} finally {
		session.dispose();
	}

	if (!existsSync(helloPath)) fail("scripted session finished but the write tool did not create hello.txt");
	const written = readFileSync(helloPath, "utf8");
	if (written !== PROOF_TEXT) fail(`write tool produced wrong content: ${JSON.stringify(written)}`);
	const toolExecutions = events.filter((event) => event.type.startsWith("tool_"));
	if (toolExecutions.length === 0) fail("session emitted no tool events; the scripted tool call was not executed");
	const writeExecuted = events.some((event) => event.type.startsWith("tool_") && JSON.stringify(event).includes('"write"'));
	if (!writeExecuted) fail("no tool event references the write tool");
	ok(`scripted session executed the real write tool (${toolExecutions.length} tool events, hello.txt verified)`);

	// --- Canary assertions: discovery must not have executed anything --------
	const markerDir = canary.markerDir;
	const markerNames = ["extension-executed", "project-extension-executed"];
	for (const marker of markerNames) {
		if (existsSync(join(markerDir, marker))) fail(`discovery canary executed: ${marker} was created; isolation is broken`);
	}
	const extensions = resourceLoader.getExtensions();
	if (extensions?.extensions?.length > 0) fail(`discovery canary: extensions were loaded (${extensions.extensions.length}) despite noExtensions`);
	const skills = resourceLoader.getSkills();
	if (skills?.skills?.length > 0) fail(`discovery canary: skills were loaded (${skills.skills.length}) despite noSkills`);
	const prompts = resourceLoader.getPrompts();
	if (prompts?.prompts?.length > 0) fail(`discovery canary: prompt templates were loaded (${prompts.prompts.length}) despite noPromptTemplates`);
	const themes = resourceLoader.getThemes();
	if (themes?.themes?.length > 0) fail(`discovery canary: themes were loaded (${themes.themes.length}) despite noThemes`);
	const agentsFiles = resourceLoader.getAgentsFiles();
	if (agentsFiles?.agentsFiles?.length > 0) fail(`discovery canary: context files were loaded (${agentsFiles.agentsFiles.length}) despite noContextFiles`);
	const systemPrompt = resourceLoader.getSystemPrompt() ?? "";
	if (systemPrompt.includes("CANARY")) fail("discovery canary: CANARY text leaked into the system prompt");
	if (!systemPrompt.includes("bundle verification assistant")) fail("explicit system prompt was not used");
	const credentialProviders = (await modelRuntime.listCredentials()).map((info) => info.providerId);
	if (credentialProviders.includes("canary-provider")) fail("discovery canary: HOME auth.json was consulted by the model runtime");
	const modelIds = modelRuntime.getAllModels().map((model) => `${model.provider}/${model.id}`);
	if (modelIds.some((id) => id.includes("canary"))) fail("discovery canary: HOME models.json was consulted by the model runtime");
	ok(
		`isolation canaries clean: no extension/skill/prompt/theme/context-file execution, HOME auth.json+models.json untouched, explicit system prompt in effect (env reduced to allowlist + disposable HOME)`,
	);
}

// ---------------------------------------------------------------------------

async function checkOpenAICompatibility(bundleDir) {
 const {openAICompletionsApi} = await importFromBundle(bundleDir, 'pi-ai/dist/compat.js');
 const api = openAICompletionsApi();
 let calls = 0;
 const model = {id:'synthetic-only',provider:'synthetic-only',api:'openai-completions',baseUrl:'https://synthetic.invalid/v1',reasoning:false,input:['text'],contextWindow:4096,maxTokens:32,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsStore:false,maxTokensField:'max_tokens'}};
 const deny = globalThis.fetch;
 globalThis.fetch = async () => { throw new Error('Unexpected external fetch during compatibility verification'); };
 try {
  const stream = api.streamSimple(model,{messages:[{role:'user',content:[{type:'text',text:'synthetic offline probe'}],timestamp:0}]},{apiKey:'synthetic-only',maxRetries:0,signal:AbortSignal.timeout(60000),fetch:async(url,init)=>{
   if(String(url)!=='https://synthetic.invalid/v1/chat/completions') fail('unexpected compatibility endpoint');
   if(JSON.parse(init.body).model!=='synthetic-only') fail('unexpected compatibility model');
   calls++;
   return new Response('data: '+JSON.stringify({id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'offline compatibility proof'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'synthetic',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  const result=await stream.result();
  if(calls!==1 || result.stopReason!=='stop' || !result.content.some(v=>v.type==='text'&&v.text==='offline compatibility proof')) fail('OpenAI compatibility synthetic request failed');
  ok('actual OpenAI compatibility lazy import and streamSimple synthetic fetch completed; one request, no provider');
 } finally { globalThis.fetch=deny; }
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const bundleDir = options.bundle;
	if (!existsSync(join(bundleDir, "node_modules", "@earendil-works", "pi-coding-agent"))) {
		fail(`${bundleDir} does not contain node_modules/@earendil-works/pi-coding-agent`);
	}
	console.log(`verify-bundle: bundle: ${bundleDir}`);
	console.log(`verify-bundle: host: ${process.platform}/${process.arch}, node ${process.version}`);

	// 0. Isolate the environment BEFORE importing any bundle code.
	const canary = isolateEnvironment();
	console.log(`verify-bundle: env: reduced to allowlist [${ENV_ALLOWLIST.join(", ")}, HOME, TMPDIR, PI_OFFLINE] with disposable HOME`);

	// 1. Complete manifest check BEFORE any runtime import.
	checkManifest(bundleDir);

	// 2..4 only run once integrity is established.
	const modules = await probeSdk(bundleDir);
	await checkArtifacts(bundleDir);
	await checkQuickjs(bundleDir);
	await checkOpenAICompatibility(bundleDir);
	await scriptedToolSession(bundleDir, modules, canary);
	ok("all bundle checks passed (scope: manifest integrity, SDK import, native/WASM presence + host-arch load, quickjs, OpenAI compatibility synthetic fetch, write tool; NOT universal SDK completeness, NOT target-arch proof)");
	cleanup();
}

main().catch((error) => {
	fail(error?.stack || String(error));
});
