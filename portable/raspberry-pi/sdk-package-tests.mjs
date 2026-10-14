#!/usr/bin/env node
/**
 * Synthetic-tree tests for portable/raspberry-pi/package-sdk.mjs and
 * verify-bundle.mjs.
 *
 * All trees are disposable and created under a single mkdtemp sandbox; no user
 * data is touched. Two groups:
 *
 *   A. Packager output safety + closure policy (synthetic monorepo trees):
 *      sentinel/sibling survival (no pruning, ever), nonempty/inside/ancestor/
 *      symlink/symlinked-ancestor/preexisting-target refusal, missing relative
 *      runtime edge, nonliteral dynamic import audit (audited passes,
 *      unaudited fails), classified optional import (classified passes,
 *      unclassified fails), wrong-arch-only native refusal (target-only
 *      passes).
 *
 *   B. verify-bundle manifest rejection BEFORE any side-effect import: the
 *      fake SDK entry writes a marker file at import time; every rejection
 *      case must exit nonzero WITHOUT the marker (import never ran), and a
 *      clean manifest must produce the marker (import did run, order proven).
 *
 * Usage: node sdk-package-tests.mjs
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGER = join(SCRIPT_DIR, "package-sdk.mjs");
const VERIFIER = join(SCRIPT_DIR, "verify-bundle.mjs");

const results = [];
function record(name, passed, detail = "") {
	results.push({ name, passed, detail });
	console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function runTool(tool, args, extraEnv = {}) {
	const result = spawnSync(process.execPath, [tool, ...args], {
		encoding: "utf8",
		timeout: 120000,
		env: { ...process.env, ...extraEnv },
	});
	return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function expectFail(name, result, needle, sandbox) {
	const out = `${result.stdout}${result.stderr}`;
	const passed = result.status !== 0 && out.includes(needle);
	record(name, passed, passed ? `refused: "${needle.split("\n")[0].slice(0, 90)}"` : `status=${result.status}, output did not contain ${JSON.stringify(needle.slice(0, 60))}: ${out.slice(0, 200).replace(/\n/g, " | ")}`);
	if (sandbox) rmSync(sandbox, { recursive: true, force: true });
}

function expectPass(name, result, sandbox) {
	const passed = result.status === 0;
	record(name, passed, passed ? "" : `status=${result.status}: ${(result.stderr || result.stdout).slice(0, 300).replace(/\n/g, " | ")}`);
	if (sandbox) rmSync(sandbox, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Synthetic source tree helpers
// ---------------------------------------------------------------------------

function writeJson(file, value) {
	writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
}

function makeSyntheticSource(root, { distIndex = 'export const VERSION = "1.1.0-test";\n' } = {}) {
	const src = join(root, "src");
	mkdirSync(join(src, "packages", "coding-agent", "dist"), { recursive: true });
	writeJson(join(src, "package.json"), { name: "pi-monorepo", version: "0.0.0" });
	writeJson(join(src, "packages", "coding-agent", "package.json"), {
		name: "@earendil-works/pi-coding-agent",
		version: "1.1.0",
		license: "MIT",
	});
	writeFileSync(join(src, "packages", "coding-agent", "dist", "index.js"), distIndex);
	writeFileSync(join(src, "packages", "coding-agent", "dist", "cli.js"), "export {};\n");
	writeFileSync(join(src, "packages", "coding-agent", "dist", "rpc-entry.js"), "export {};\n");
	writeFileSync(join(src, "LICENSE"), "MIT test license\n");
	return src;
}

function addThirdParty(src, name, mainJs, extraFiles = {}) {
	const pkgDir = join(src, "node_modules", ...name.split("/"));
	mkdirSync(pkgDir, { recursive: true });
	writeJson(join(pkgDir, "package.json"), { name, version: "1.0.0", license: "MIT", main: "index.js" });
	writeFileSync(join(pkgDir, "index.js"), mainJs);
	for (const [rel, content] of Object.entries(extraFiles)) {
		const file = join(pkgDir, rel);
		mkdirSync(dirname(file), { recursive: true });
		content.buffer ? writeFileSync(file, content.buffer) : writeFileSync(file, content);
	}
	return pkgDir;
}

/** Minimal ELF header (20 bytes) with the given machine architecture. */
function elfHeader(machine) {
	const buf = Buffer.alloc(20);
	buf[0] = 0x7f;
	buf.write("ELF", 1, "ascii");
	buf[4] = 2; // 64-bit
	buf.writeUInt16LE(machine, 18);
	return buf;
}
const EM_X64 = 62;
const EM_ARM64 = 183;

// ---------------------------------------------------------------------------
// Group A: packager safety + closure policy
// ---------------------------------------------------------------------------

function testPackagerSafety() {
	// A1: sentinel + sibling archive survival; no pruning.
	{
		const sandbox = mkdtempSync(join(tmpdir(), "pi-pkg-a1-"));
		try {
			const src = makeSyntheticSource(sandbox);
			const outParent = join(sandbox, "out");
			mkdirSync(join(outParent, "sentinel-dir"), { recursive: true });
			writeFileSync(join(outParent, "sentinel-dir", "keep.txt"), "keep me\n");
			writeFileSync(join(outParent, "pi-sdk-old.tar.gz"), "old archive bytes\n");
			mkdirSync(join(outParent, "pi-sdk-old"), { recursive: true });
			writeFileSync(join(outParent, "pi-sdk-old", ".pi-sdk-bundle"), "{}\n"); // marker-bearing old bundle
			writeFileSync(join(outParent, "pi-sdk-old", "payload.txt"), "old payload\n");
			const result = runTool(PACKAGER, ["--source", src, "--out", join(outParent, "new-bundle"), "--skip-verify", "--no-tar"]);
			const kept =
				existsSync(join(outParent, "sentinel-dir", "keep.txt")) &&
				existsSync(join(outParent, "pi-sdk-old.tar.gz")) &&
				existsSync(join(outParent, "pi-sdk-old", "payload.txt"));
			const built = existsSync(join(outParent, "new-bundle", "manifest.txt"));
			record("A1 sentinel/sibling survival (no pruning)", result.status === 0 && kept && built, result.status === 0 && kept && built ? "" : `status=${result.status} kept=${kept} built=${built}: ${result.stderr.slice(0, 200)}`);
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	}

	// A2: refuse nonempty output.
	{
		const sandbox = mkdtempSync(join(tmpdir(), "pi-pkg-a2-"));
		const src = makeSyntheticSource(sandbox);
		const out = join(sandbox, "nonempty");
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, "precious.txt"), "user data\n");
		const result = runTool(PACKAGER, ["--source", src, "--out", out, "--skip-verify", "--no-tar"]);
		const preserved = existsSync(join(out, "precious.txt"));
		expectFail("A2 refuse nonempty output (content preserved)", { ...result, status: preserved ? result.status : 99 }, "not empty", sandbox);
	}

	// A3: refuse output inside the source tree.
	{
		const sandbox = mkdtempSync(join(tmpdir(), "pi-pkg-a3-"));
		const src = makeSyntheticSource(sandbox);
		const result = runTool(PACKAGER, ["--source", src, "--out", join(src, "inside"), "--skip-verify", "--no-tar"]);
		expectFail("A3 refuse output inside source", result, "lies inside the source tree", sandbox);
	}

	// A4: output nested under a COMMON ancestor of the source is allowed (guard
	// against an over-broad disjointness rule); output nested under the source
	// itself through not-yet-existing directories is refused.
	{
		const sandbox = mkdtempSync(join(tmpdir(), "pi-pkg-a4-"));
		try {
			const base = join(sandbox, "x");
			const src = makeSyntheticSourceIn(sandbox, base); // x/src
		const okOut = join(base, "out"); // sibling of src under x — allowed
		const ok = runTool(PACKAGER, ["--source", src, "--out", okOut, "--skip-verify", "--no-tar"]);
		const nested = runTool(PACKAGER, ["--source", src, "--out", join(src, "sub", "deep", "out"), "--skip-verify", "--no-tar"]);
		const passed = ok.status === 0 && nested.status !== 0 && `${nested.stderr}`.includes("lies inside the source tree");
		record("A4 common-ancestor output allowed; nested-in-source refused", passed, passed ? "" : `ok=${ok.status} nested=${nested.status}: ${nested.stderr.slice(0, 160)}`);
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	}

	// A5: refuse symlinked output directory.
	{
		const sandbox = mkdtempSync(join(tmpdir(), "pi-pkg-a5-"));
		const src = makeSyntheticSource(sandbox);
		const realOut = join(sandbox, "real-out");
		mkdirSync(realOut, { recursive: true });
		symlinkSync(realOut, join(sandbox, "link-out"));
		const result = runTool(PACKAGER, ["--source", src, "--out", join(sandbox, "link-out"), "--skip-verify", "--no-tar"]);
		expectFail("A5 refuse symlinked output", result, "symlink", sandbox);
	}

	// A6: refuse symlinked ancestor (path redirection).
	{
		const sandbox = mkdtempSync(join(tmpdir(), "pi-pkg-a6-"));
		const src = makeSyntheticSource(sandbox);
		const realDir = join(sandbox, "real-parent");
		mkdirSync(realDir, { recursive: true });
		symlinkSync(realDir, join(sandbox, "link-parent"));
		const result = runTool(PACKAGER, ["--source", src, "--out", join(sandbox, "link-parent", "out"), "--skip-verify", "--no-tar"]);
		expectFail("A6 refuse symlinked ancestor", result, "symlink", sandbox);
	}

	// A7: refuse preexisting archive/checksum/summary targets.
	for (const suffix of [".tar.gz", ".tar.gz.sha256", ".build-summary.json"]) {
		const sandbox = mkdtempSync(join(tmpdir(), `pi-pkg-a7-`));
		const src = makeSyntheticSource(sandbox);
		writeFileSync(join(sandbox, `out${suffix}`), "stale target\n");
		const result = runTool(PACKAGER, ["--source", src, "--out", join(sandbox, "out"), "--skip-verify"]);
		expectFail(`A7 refuse preexisting ${suffix} target`, result, "preexisting output target", sandbox);
	}
}

function makeSyntheticSourceIn(sandbox, base) {
	// Build a synthetic source at base/src (helper for the ancestor test).
	const src = join(base, "src");
	mkdirSync(join(src, "packages", "coding-agent", "dist"), { recursive: true });
	writeJson(join(src, "package.json"), { name: "pi-monorepo", version: "0.0.0" });
	writeJson(join(src, "packages", "coding-agent", "package.json"), { name: "@earendil-works/pi-coding-agent", version: "1.1.0", license: "MIT" });
	writeFileSync(join(src, "packages", "coding-agent", "dist", "index.js"), 'export const VERSION = "1.1.0-test";\n');
	writeFileSync(join(src, "packages", "coding-agent", "dist", "cli.js"), "export {};\n");
	writeFileSync(join(src, "packages", "coding-agent", "dist", "rpc-entry.js"), "export {};\n");
	writeFileSync(join(src, "LICENSE"), "MIT test license\n");
	return src;
}

function testClosurePolicy() {
	for (const prefix of ['"./"', "`./`"]) {
		const sandbox = mkdtempSync(join(tmpdir(), "pi-pkg-prefix-"));
		const src = makeSyntheticSource(sandbox, { distIndex: 'import "computed-prefix";\n' });
		addThirdParty(src, "computed-prefix", `export function load(name) { return import(${prefix} + name); }\n`);
		const result = runTool(PACKAGER, ["--source", src, "--out", join(sandbox, "out"), "--skip-verify", "--no-tar"]);
		expectFail(`${prefix} computed import requires dynamic audit`, result, "unaudited nonliteral dynamic", sandbox);
	}
	// B1: missing relative import (first-party) is a hard failure.
	{
		const sandbox = mkdtempSync(join(tmpdir(), "pi-pkg-b1-"));
		const src = makeSyntheticSource(sandbox, { distIndex: 'import "./missing.js";\nexport const VERSION = "1.1.0-test";\n' });
		const result = runTool(PACKAGER, ["--source", src, "--out", join(sandbox, "out"), "--skip-verify", "--no-tar"]);
		expectFail("B1 missing relative runtime edge refused", result, "does not resolve to a file", sandbox);
	}

	// B2: nonliteral dynamic import in an AUDITED package passes and is recorded.
	{
		const sandbox = mkdtempSync(join(tmpdir(), "pi-pkg-b2-"));
		const src = makeSyntheticSource(sandbox, { distIndex: 'import "jiti";\nexport const VERSION = "1.1.0-test";\n' });
		addThirdParty(src, "jiti", "export function jit(id) { return require(id); }\n");
		const out = join(sandbox, "out");
		const result = runTool(PACKAGER, ["--source", src, "--out", out, "--skip-verify", "--no-tar"]);
		let audited = false;
		if (result.status === 0) {
			const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
			audited = (manifest.auditedDynamicImports ?? []).some((recorded) => recorded.package === "jiti");
		}
		record("B2 audited nonliteral dependency passes + recorded", result.status === 0 && audited, result.status === 0 && audited ? "" : `status=${result.status} audited=${audited}: ${result.stderr.slice(0, 200)}`);
		rmSync(sandbox, { recursive: true, force: true });
	}

	// B3: nonliteral dynamic import in an UNAUDITED package fails.
	{
		const sandbox = mkdtempSync(join(tmpdir(), "pi-pkg-b3-"));
		const src = makeSyntheticSource(sandbox, { distIndex: 'import "mystery-pkg";\nexport const VERSION = "1.1.0-test";\n' });
		addThirdParty(src, "mystery-pkg", "export function load(id) { return require(id); }\n");
		const result = runTool(PACKAGER, ["--source", src, "--out", join(sandbox, "out"), "--skip-verify", "--no-tar"]);
		expectFail("B3 unaudited nonliteral dependency refused", result, "unaudited nonliteral dynamic import site", sandbox);
	}

	// B4: classified optional import (third-party) passes with a recorded classification.
	{
		const sandbox = mkdtempSync(join(tmpdir(), "pi-pkg-b4-"));
		const src = makeSyntheticSource(sandbox, { distIndex: 'import "debug";\nexport const VERSION = "1.1.0-test";\n' });
		addThirdParty(src, "debug", 'import "supports-color";\nexport default {};\n');
		const out = join(sandbox, "out");
		const result = runTool(PACKAGER, ["--source", src, "--out", out, "--skip-verify", "--no-tar"]);
		let classified = false;
		if (result.status === 0) {
			const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
			classified = (manifest.warnings ?? []).some((warning) => warning.spec === "supports-color" && warning.classification === "optional-dependency");
		}
		record("B4 classified optional import passes + recorded", result.status === 0 && classified, result.status === 0 && classified ? "" : `status=${result.status} classified=${classified}: ${result.stderr.slice(0, 200)}`);
		rmSync(sandbox, { recursive: true, force: true });
	}

	// B5: unclassified unresolved third-party import fails.
	{
		const sandbox = mkdtempSync(join(tmpdir(), "pi-pkg-b5-"));
		const src = makeSyntheticSource(sandbox, { distIndex: 'import "weird-pkg";\nexport const VERSION = "1.1.0-test";\n' });
		addThirdParty(src, "weird-pkg", 'import "not-installed-anywhere";\nexport default {};\n');
		const result = runTool(PACKAGER, ["--source", src, "--out", join(sandbox, "out"), "--skip-verify", "--no-tar"]);
		expectFail("B5 unclassified unresolved import refused", result, "unclassified", sandbox);
	}

	// B6: wrong-arch-only native dependency is refused (x64-only when targeting arm64).
	{
		const sandbox = mkdtempSync(join(tmpdir(), "pi-pkg-b6-"));
		const src = makeSyntheticSource(sandbox, { distIndex: 'import "native-only-x64";\nexport const VERSION = "1.1.0-test";\n' });
		addThirdParty(src, "native-only-x64", "export const native = true;\n", { "prebuilds/x64.node": { buffer: elfHeader(EM_X64) } });
		const result = runTool(PACKAGER, ["--source", src, "--out", join(sandbox, "out"), "--skip-verify", "--no-tar"]);
		expectFail("B6 wrong-arch-only native refused (x64-only, target arm64)", result, "ships no arm64", sandbox);
	}

	// B7: target-arch native with host sibling passes and is inventoried.
	{
		const sandbox = mkdtempSync(join(tmpdir(), "pi-pkg-b7-"));
		const src = makeSyntheticSource(sandbox, { distIndex: 'import "native-dual";\nexport const VERSION = "1.1.0-test";\n' });
		addThirdParty(src, "native-dual", "export const native = true;\n", {
			"prebuilds/arm64.node": { buffer: elfHeader(EM_ARM64) },
			"prebuilds/x64.node": { buffer: elfHeader(EM_X64) },
		});
		const out = join(sandbox, "out");
		const result = runTool(PACKAGER, ["--source", src, "--out", out, "--skip-verify", "--no-tar"]);
		let inventoried = false;
		if (result.status === 0) {
			const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
			inventoried =
				manifest.nativeArtifacts.some((artifact) => artifact.path.endsWith("arm64.node") && artifact.coverage === "target") &&
				manifest.nativeArtifacts.some((artifact) => artifact.path.endsWith("x64.node") && String(artifact.coverage).includes("sibling"));
		}
		record("B7 target+host native inventory passes with coverage labels", result.status === 0 && inventoried, result.status === 0 && inventoried ? "" : `status=${result.status} inventoried=${inventoried}: ${result.stderr.slice(0, 200)}`);
		rmSync(sandbox, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Group C: verify-bundle manifest rejection BEFORE side-effect import
// ---------------------------------------------------------------------------

function makeFakeBundle(root, { tamper } = {}) {
	// Minimal bundle whose SDK entry has an import side effect (marker file).
	const bundle = join(root, "bundle");
	const sdkDir = join(bundle, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
	mkdirSync(sdkDir, { recursive: true });
	writeFileSync(
		join(sdkDir, "index.js"),
		[
			'import { writeFileSync, mkdirSync } from "node:fs";',
			'import { dirname, join } from "node:path";',
			'import { fileURLToPath } from "node:url";',
			'// Side effect proving this module was imported.',
			'const bundleRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");',
			'writeFileSync(join(bundleRoot, "SDK-IMPORT-EXECUTED"), "yes");',
			'export const VERSION = "1.1.0-test";',
			"",
		].join("\n"),
	);
	writeJson(join(bundle, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), {
		name: "@earendil-works/pi-coding-agent",
		version: "1.1.0",
	});
	writeJson(join(bundle, "manifest.json"), { generator: "test", target: { arch: "arm64" } });

	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else files.push(relative(bundle, path));
		}
	};
	walk(bundle);
	const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
	const baseLines = ["# test manifest", ...files.map((f) => `${sha(join(bundle, f))}  ${f}`)];
	const extraLines = tamper ? tamper(bundle, sha, baseLines) || [] : [];
	writeFileSync(join(bundle, "manifest.txt"), [...baseLines, ...extraLines, ""].join("\n"));
	return bundle;
}

function testVerifierRejection() {
	{
		const sandbox = mkdtempSync(join(tmpdir(), "pi-verify-root-fifo-"));
		try {
			const bundle = makeFakeBundle(sandbox, {});
			const manifest = join(bundle, "manifest.txt");
			rmSync(manifest);
			const mk = spawnSync("mkfifo", [manifest]);
			if (mk.status !== 0) throw new Error("mkfifo required for manifest root regression");
			const result = spawnSync(process.execPath, [VERIFIER, "--bundle", bundle], { encoding: "utf8", timeout: 3000 });
			record("manifest root FIFO rejects promptly before SDK import", result.status === 1 && !result.error
				&& result.stderr.includes("bounded regular file") && !existsSync(join(bundle, "SDK-IMPORT-EXECUTED")), result.stderr || String(result.error));
		} finally { rmSync(sandbox, { recursive: true, force: true }); }
	}
	const cases = [
		{
			name: "C1 traversal entry refused before import",
			tamper: (bundle, sha) => {
				writeFileSync(join(bundle, "..", "outside.txt"), "outside\n");
				return [`${sha(join(bundle, "..", "outside.txt"))}  ../outside.txt`];
			},
		},
		{
			name: "C2 absolute entry refused before import",
			tamper: (bundle, sha) => [`${sha("/etc/passwd")}  /etc/passwd`],
		},
		{
			name: "C3 duplicate entry refused before import",
			tamper: (bundle, sha) => [`${sha(join(bundle, "manifest.json"))}  manifest.json`],
		},
		{
			name: "C4 symlink in bundle refused before import",
			tamper: (bundle) => symlinkSync(join(bundle, "manifest.json"), join(bundle, "node_modules", "alias.json")),
		},
		{
			name: "C5 unlisted file refused before import",
			tamper: () => {},
			afterManifest: (bundle) => writeFileSync(join(bundle, "node_modules", "sneaky.js"), "export {};\n"),
		},
		{
			name: "C6 hash mismatch refused before import",
			tamper: () => {},
			afterManifest: (bundle) => {
				// Corrupt a file AFTER the manifest was written.
				const path = join(bundle, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
				writeFileSync(path, `${readFileSync(path, "utf8")}\n// tampered\n`);
			},
		},
		{
			name: "C7 missing listed file refused before import",
			tamper: () => {},
			afterManifest: (bundle) => rmSync(join(bundle, "manifest.json")),
		},
	];
	for (const testCase of cases) {
		const sandbox = mkdtempSync(join(tmpdir(), "pi-verify-c-"));
		try {
			const bundle = makeFakeBundle(sandbox, { tamper: testCase.tamper });
			if (testCase.afterManifest) testCase.afterManifest(bundle);
			const marker = join(bundle, "SDK-IMPORT-EXECUTED");
			const result = runTool(VERIFIER, ["--bundle", bundle]);
			const rejected = result.status !== 0;
			const noImport = !existsSync(marker);
			record(testCase.name, rejected && noImport, rejected && noImport ? `${(result.stderr || result.stdout).split("\n")[0].slice(0, 90)}` : `status=${result.status} marker=${existsSync(marker)}`);
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	}

	// C8: nonregular file (FIFO) refused before import.
	{
		const sandbox = mkdtempSync(join(tmpdir(), "pi-verify-c8-"));
		try {
			const bundle = makeFakeBundle(sandbox, {});
			const fifo = join(bundle, "node_modules", "pipe");
			const mk = spawnSync("mkfifo", [fifo]);
			let passed;
			let detail = "";
			if (mk.status !== 0) {
				passed = true;
				detail = "mkfifo unavailable on this host; skipped (symlink case covers non-regular rejection)";
			} else {
				const marker = join(bundle, "SDK-IMPORT-EXECUTED");
				const result = runTool(VERIFIER, ["--bundle", bundle]);
				passed = result.status !== 0 && !existsSync(marker);
				detail = passed ? "" : `status=${result.status} marker=${existsSync(marker)}`;
			}
			record("C8 nonregular file (fifo) refused before import", passed, detail);
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	}

	// C9: aliased (symlinked) bundle path refused.
	{
		const sandbox = mkdtempSync(join(tmpdir(), "pi-verify-c9-"));
		try {
			const bundle = makeFakeBundle(sandbox, {});
			symlinkSync(bundle, join(sandbox, "alias-bundle"));
			const result = runTool(VERIFIER, ["--bundle", join(sandbox, "alias-bundle")]);
			const marker = join(bundle, "SDK-IMPORT-EXECUTED");
			record("C9 aliased bundle path refused before import", result.status !== 0 && !existsSync(marker), (result.stderr || "").split("\n")[0].slice(0, 90));
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	}

	// C10: clean manifest → the SDK IS imported (order proven: manifest first, import second).
	{
		const sandbox = mkdtempSync(join(tmpdir(), "pi-verify-c10-"));
		try {
			const bundle = makeFakeBundle(sandbox, {});
			const marker = join(bundle, "SDK-IMPORT-EXECUTED");
			const result = runTool(VERIFIER, ["--bundle", bundle]);
			const imported = existsSync(marker);
			const manifestFirst = (result.stdout + result.stderr).includes("manifest verified FIRST");
			record("C10 clean manifest reaches SDK import (marker written after manifest ok)", imported && manifestFirst, `imported=${imported} manifestFirst=${manifestFirst} status=${result.status}`);
		} finally {
			rmSync(sandbox, { recursive: true, force: true });
		}
	}
}

// ---------------------------------------------------------------------------

function main() {
	console.log(`sdk-package-tests: node ${process.version}, host ${process.platform}/${process.arch}`);
	testPackagerSafety();
	testClosurePolicy();
	testVerifierRejection();
	const failed = results.filter((entry) => !entry.passed);
	console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
	if (failed.length > 0) {
		for (const entry of failed) console.error(`FAILED: ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
		process.exit(1);
	}
}

main();
