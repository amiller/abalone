#!/usr/bin/env node
/**
 * Build a small, transferable runtime bundle of the vendored Pi SDK
 * (@earendil-works/pi-coding-agent 1.1.x) for deployment on another machine,
 * by default a Raspberry Pi class ARM64 (aarch64) Linux guest.
 *
 * Safety contract (fail closed; this tool never deletes anything):
 *   - The output directory must NOT exist, or must be an empty real directory.
 *     A nonempty output, a symlinked output (or symlinked ancestor), or a
 *     preexisting archive/checksum/summary target is refused.
 *   - The output must be disjoint from the source tree: it may not lie inside
 *     the source, and the source may not lie inside it (paths canonicalized).
 *   - Older bundles and sibling archives are NEVER pruned. Retire outputs by
 *     hand.
 *
 * Bundle format (simple and portable):
 *   - Regular files and directories only. NO symlinks anywhere: any symlink
 *     found while copying is a hard error.
 *   - manifest.txt holds the sha256 of EVERY file in the bundle except
 *     manifest.txt itself (it cannot hash itself). manifest.json (metadata),
 *     THIRD_PARTY_NOTICES.md and the marker are covered like any other file.
 *   - manifest.txt is the integrity root of the bundle. It is integrity
 *     relative to the separately trusted transfer digest (the .tar.gz.sha256
 *     sidecar verified over the trusted transfer channel); it is NOT
 *     authenticity of the source tree.
 *
 * Closure policy (static scan, classified, fail closed on the unexplained):
 *   - Literal import/require/require.resolve/import() specifiers are traced.
 *   - Missing RELATIVE imports are errors for first-party code and must be
 *     classified for third-party code (OPTIONAL_IMPORTS).
 *   - Unresolved third-party bare imports are failures unless classified in
 *     OPTIONAL_IMPORTS with a concrete audited reason.
 *   - Nonliteral (computed) require()/import() sites must belong to a package
 *     listed in DYNAMIC_IMPORT_AUDIT with an audited reason.
 *   This is a heuristic static scan, not a complete static closure; runtime
 *   verification covers only the exercised paths (SDK import, quickjs,
 *   write tool). No universal SDK completeness is claimed.
 *
 * Native policy:
 *   - Every .node ELF must be target-arch, or host-arch WITH a target-arch
 *     sibling in the same package. Wrong-arch-only packages are hard failures.
 *   - WASM is recorded as portable. Host verification loads native bindings
 *     only for the host architecture; target-arch bindings are an explicit
 *     open gate for on-target verification (never claimed from the host).
 *
 * Provenance: the checkout may not be a git repo; the manifest records source
 * and lockfile digests, exact package versions, license declarations and the
 * generator script digests. Declared licenses are not notice provenance; the
 * shipped license/notice files are preserved inside the packages.
 *
 * Usage:
 *   node package-sdk.mjs [--source <dir>] [--out <dir>] [--target-arch arm64|x64]
 *                        [--target-platform linux] [--skip-verify] [--no-tar] [--help]
 *
 * Defaults are derived from this script's location:
 *   source: <repo>/vendor/pi        (repo = the abalone checkout)
 *   out:    $PI_SDK_BUNDLE_OUT or <repo>/../tmp/pi-sdk-<platform>-<arch>
 *
 * The tool performs no network access, no installs and no guest interaction.
 * It only reads the existing built tree and writes to --out (plus the archive,
 * checksum sidecar and build summary next to it).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { isBuiltin } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const BUNDLE_MARKER = ".pi-sdk-bundle";

class PackError extends Error {}

function fail(message) {
	throw new PackError(message);
}

function log(step, message) {
	console.error(`[package-sdk ${step}] ${message}`);
}

function sha256File(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const options = {
		source: resolve(REPO_ROOT, "vendor", "pi"),
		out: process.env.PI_SDK_BUNDLE_OUT || "",
		targetArch: "arm64",
		targetPlatform: "linux",
		skipVerify: false,
		noTar: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			if (i + 1 >= argv.length) fail(`missing value for ${arg}`);
			return argv[++i];
		};
		switch (arg) {
			case "--source":
				options.source = resolve(next());
				break;
			case "--out":
				options.out = resolve(next());
				break;
			case "--target-arch":
				options.targetArch = next();
				break;
			case "--target-platform":
				options.targetPlatform = next();
				break;
			case "--skip-verify":
				options.skipVerify = true;
				break;
			case "--no-tar":
				options.noTar = true;
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			default:
				fail(`unknown argument: ${arg}`);
		}
	}
	if (!["arm64", "x64"].includes(options.targetArch)) {
		fail(`unsupported --target-arch: ${options.targetArch} (supported: arm64, x64)`);
	}
	if (options.targetPlatform !== "linux") {
		fail(`unsupported --target-platform: ${options.targetPlatform} (only linux is wired up)`);
	}
	if (!options.out) {
		options.out = resolve(REPO_ROOT, "..", "tmp", `pi-sdk-${options.targetPlatform}-${options.targetArch}`);
	}
	return options;
}

// ---------------------------------------------------------------------------
// Output safety (nothing is ever deleted by this tool)
// ---------------------------------------------------------------------------

/**
 * Validate the output location before any write. Refuses:
 *   - an existing nonempty output directory
 *   - an existing output that is a file or symlink
 *   - symlinked ancestors (path redirection)
 *   - output inside the source tree, or the source inside the output
 *   - preexisting archive/checksum/summary targets next to the output
 */
function assertSafeOutput(source, outDir) {
	if (!isAbsolute(outDir)) fail(`output path is not absolute after resolution: ${outDir}`);
	// Preexisting archive/checksum/summary targets (any file type, incl. symlinks).
	for (const suffix of [".tar.gz", ".tar.gz.sha256", ".build-summary.json"]) {
		const target = `${outDir}${suffix}`;
		let targetStat = null;
		try {
			targetStat = lstatSync(target);
		} catch {
			// absent
		}
		if (targetStat) {
			fail(`refusing to touch preexisting output target: ${target} (remove it by hand if you are sure)`);
		}
	}
	// The output itself.
	const outStat = existsSync(outDir) ? lstatSync(outDir) : null;
	if (outStat) {
		if (outStat.isSymbolicLink()) fail(`output path is a symlink: ${outDir}`);
		if (!outStat.isDirectory()) fail(`output path exists and is not a directory: ${outDir}`);
		const entries = readdirSync(outDir);
		if (entries.length > 0) {
			fail(
				`output directory is not empty (${entries.length} entries, first: ${entries[0]}): ${outDir}. ` +
					"This tool never deletes existing output; choose a fresh directory or empty it by hand.",
			);
		}
	}
	// No symlinked ancestors: every existing component must be a real directory.
	let cursor = dirname(outDir);
	const ancestors = [];
	for (;;) {
		ancestors.push(cursor);
		if (cursor === dirname(cursor)) break;
		cursor = dirname(cursor);
	}
	for (const ancestor of ancestors.reverse()) {
		let st;
		try {
			st = lstatSync(ancestor);
		} catch {
			continue; // not created yet; parents are created with recursive mkdir below it
		}
		if (st.isSymbolicLink()) fail(`ancestor of the output is a symlink (path redirection): ${ancestor}`);
		if (!st.isDirectory()) fail(`ancestor of the output is not a directory: ${ancestor}`);
	}
	// Disjointness, canonicalized against the deepest existing ancestor of out.
	let probe = outDir;
	while (!existsSync(probe)) {
		const parent = dirname(probe);
		if (parent === probe) break;
		probe = parent;
	}
	const realAnchor = realpathSync(probe);
	const canonicalOut = outDir === probe ? realAnchor : join(realAnchor, relative(probe, outDir));
	const realSource = realpathSync(source);
	if (canonicalOut === realSource || canonicalOut.startsWith(realSource + sep)) {
		fail(`output lies inside the source tree: ${outDir} (canonical ${canonicalOut}, source ${realSource})`);
	}
	if (realSource === canonicalOut || realSource.startsWith(canonicalOut + sep)) {
		fail(`output is an ancestor of the source tree: ${outDir} (canonical ${canonicalOut}, source ${realSource})`);
	}
}

// ---------------------------------------------------------------------------
// Copy filters (third-party packages)
// ---------------------------------------------------------------------------

// Directories that are always junk, at any depth.
const THIRD_PARTY_JUNK_DIRS = new Set([
	"__tests__",
	"coverage",
	".nyc_output",
	".github",
	".git",
	".hg",
	".svn",
	".idea",
	".vscode",
	".husky",
	".circleci",
	".bin",
	"test",
	"tests",
	"browser-test",
	"system-test",
	"bench",
	"benchmarks",
	".history", // editor local-history snapshots (e.g. node-domexception ships stale test copies)
]);

// Directories excluded only at the package root. Nested directories with these
// names can be runtime code (the yaml package ships dist/doc/, and some
// packages load examples or docs at runtime).
const THIRD_PARTY_ROOT_EXCLUDE_DIRS = new Set(["example", "examples", "docs", "doc"]);

const THIRD_PARTY_DEV_FILE =
	/^(\.|eslint|prettier|babel|webpack|rollup|vite\.config|vitest|jest|mocha|karma|nyc|tsconfig|ts-node|husky|lint-staged)/i;

const THIRD_PARTY_TEST_FILE = /(\.(test|spec|bench)\.[cm]?js$)|(^test\.[cm]?js$)/i;

const THIRD_PARTY_KEEP_BASENAME = /^(license|licence|copying|notice|readme|authors|contributors|changelog)/i;

function thirdPartyKeep(entryName, isDir, depth = 0) {
	if (isDir) {
		if (THIRD_PARTY_JUNK_DIRS.has(entryName)) return false;
		if (depth === 0 && THIRD_PARTY_ROOT_EXCLUDE_DIRS.has(entryName)) return false;
		return true;
	}
	const ext = entryName.slice(entryName.lastIndexOf("."));
	if (entryName === "package.json" || entryName === "package-lock.json") return true;
	if (ext === ".map" || ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") return false;
	if (THIRD_PARTY_TEST_FILE.test(entryName) || THIRD_PARTY_DEV_FILE.test(entryName)) return false;
	if (ext === ".md") return THIRD_PARTY_KEEP_BASENAME.test(entryName);
	if (ext === ".node" || ext === ".wasm" || ext === ".so") return true;
	if (entryName.startsWith(".")) return false;
	// Everything else (code, json, data files, images, html) is kept: dropping
	// runtime assets the scanner cannot see risks a broken bundle.
	return true;
}

// ---------------------------------------------------------------------------
// Closure classification tables (audited on the real vendored tree, 2026-10-14)
// ---------------------------------------------------------------------------

/**
 * Unresolved third-party imports that are ACCEPTED, each with a concrete
 * audited classification. Anything not listed here is a hard failure.
 * Key: bare specifier root package name (or importer-qualified entries under
 * "byImporter" for false positives inside generated-code templates).
 */
const OPTIONAL_IMPORTS = {
	"@aws-sdk/signature-v4-crt": {
		classification: "optional-native-dependency",
		reason: "AWS CRT signer acceleration; only used when installed, runtime-guarded fallback exists in @aws-sdk/signature-v4-multi-region.",
	},
	"@aws-sdk/signature-v4a": {
		classification: "optional-dependency",
		reason: "Asymmetric signature support package; optional peer of signature-v4-multi-region, guarded at runtime.",
	},
	"supports-color": {
		classification: "optional-dependency",
		reason: "Color support probe of the debug package; optional by design.",
	},
	kerberos: {
		classification: "optional-native-dependency",
		reason: "Native negotiate auth for proxy-agent-negotiate; only used when installed, plain negotiation otherwise.",
	},
	bufferutil: {
		classification: "optional-native-dependency",
		reason: "Optional ws (WebSocket) permessage-deflate accelerator.",
	},
	"utf-8-validate": {
		classification: "optional-native-dependency",
		reason: "Optional ws (WebSocket) UTF-8 validation accelerator.",
	},
	byImporter: {
		// String literals inside jiti's babel-compat generated-code templates,
		// not real runtime imports of the SDK closure.
		jiti: {
			b: {
				classification: "generator-template-false-positive",
				reason: "String literal in jiti's babel compatibility templates; never executed as a real require by this bundle's paths.",
			},
			"some-module": {
				classification: "generator-template-false-positive",
				reason: "Example string literal in jiti's generated-code templates; not a real dependency.",
			},
			"./module": {
				classification: "generator-template-false-positive",
				reason: "Placeholder relative specifier inside jiti's bundled babel code-generation templates (dist/babel.cjs); not a real filesystem import.",
			},
			"...": {
				classification: "generator-template-false-positive",
				reason: "Ellipsis placeholder string literal inside jiti's bundled babel templates (dist/babel.cjs); not a real specifier.",
			},
		},
	},
};

/**
 * Packages that contain nonliteral (computed) require()/import() sites, with
 * the audited reason the closure scanner accepts them. A nonliteral site in a
 * package NOT listed here is a hard failure ("unaudited dynamic root").
 */
const DYNAMIC_IMPORT_AUDIT = {
	"@earendil-works/pi-ai": {
		classification: "audited-computed-builtin-import",
		reason: "Dynamic imports of node builtins via constant string concatenation (browser-bundler workaround: auth/context.js, env-api-keys.js, bedrock-converse-stream.lazy.js); no third-party runtime edges.",
	},
	"@earendil-works/pi-coding-agent": {
		classification: "audited-dynamic-root",
		reason: "dist/core/extensions/loader.js imports user-specified extension paths at runtime. Extensions are disabled under verifier isolation (noExtensions) and extension loading is outside bundle acceptance.",
	},
	"@silvia-odwyer/photon-node": {
		classification: "audited-computed-builtin-import",
		reason: "Template-literal import of the node builtin 'util'; constant specifier.",
	},
	jiti: {
		classification: "audited-runtime-transpiler",
		reason: "jiti is a runtime transpiler and requires arbitrary user-specified modules by design; only its fixed entry paths are used by this bundle's closure.",
	},
	marked: {
		classification: "audited-cli-only",
		reason: "bin/main.js loads a user config file path at runtime; CLI-only, not on the SDK runtime path.",
	},
	protobufjs: {
		classification: "audited-internal-lazy-load",
		reason: "dist/light build lazily requires its own internal parser/tokenizer modules by computed name.",
	},
	yaml: {
		classification: "audited-cli-only",
		reason: "dist/cli.mjs loads visitor plugins by path; CLI-only, not on the SDK runtime path.",
	},
};

// ---------------------------------------------------------------------------
// Import scanning
// ---------------------------------------------------------------------------

const SPECIFIER_INVALID_CHARS = /[{}$()=,:;%<>[\]!&|+*?^'"\\\s]/;

function plausibleSpecifier(spec) {
	return spec.length > 0 && spec !== "." && spec !== ".." && !SPECIFIER_INVALID_CHARS.test(spec);
}

const IMPORT_RE =
	/(?:\bfrom\s*|\bimport\s*|\brequire\s*(?:\.resolve)?\s*\(\s*|\bimport\s*\(\s*)(["'])((?:[^"'\n\\]|\\.)*)\1/g;

// require(...) / import(...) whose first argument is NOT a string literal.
const DYNAMIC_CALL_RE = /\b(?:require(?:\s*\.\s*resolve)?|import)\s*\(\s*([^)\n;]{0,80})/g;

/**
 * Remove // and /* *\/ comments while preserving string literals, so that
 * prose like "the first grapheme from 'after'" in a comment cannot be mistaken
 * for an import specifier. Regex literals (including ones containing quotes,
 * e.g. .replace(/"/g, ...)) are copied verbatim so they cannot desync the
 * string tracking; a bail-out on newline keeps malformed input from running
 * away. Conservative: anything misparsed can only leave a string temporarily
 * unbalanced, never add imports.
 */
const REGEX_PRECEDING_CHARS = "([{=,:;!&|?+-*%~^<>";
const REGEX_PRECEDING_KEYWORDS = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
]);

function lastSignificantToken(out) {
	let end = out.length;
	while (end > 0 && /\s/.test(out[end - 1])) end--;
	let start = end;
	while (start > 0 && /[A-Za-z0-9_$]/.test(out[start - 1])) start--;
	if (start !== end) {
		return { word: out.slice(start, end), char: null };
	}
	return { word: null, char: end > 0 ? out[end - 1] : null };
}

function regexCanStartHere(out) {
	const { word, char } = lastSignificantToken(out);
	if (word !== null) return REGEX_PRECEDING_KEYWORDS.has(word);
	if (char === null) return true; // start of file
	return REGEX_PRECEDING_CHARS.includes(char);
}

function stripComments(source) {
	let out = "";
	let mode = "code";
	for (let i = 0; i < source.length; ) {
		const char = source[i];
		const next = source[i + 1];
		if (mode === "code") {
			if (char === "/" && next === "/") {
				mode = "line";
				out += "  ";
				i += 2;
			} else if (char === "/" && next === "*") {
				mode = "block";
				out += "  ";
				i += 2;
			} else if (char === "/" && regexCanStartHere(out)) {
				mode = "regex";
				out += char;
				i += 1;
			} else {
				if (char === '"') mode = "dquote";
				else if (char === "'") mode = "squote";
				else if (char === "`") mode = "template";
				out += char;
				i += 1;
			}
		} else if (mode === "line") {
			if (char === "\n") {
				mode = "code";
				out += char;
			}
			i += 1;
		} else if (mode === "block") {
			if (char === "*" && next === "/") {
				mode = "code";
				i += 2;
			} else {
				i += 1;
			}
		} else if (mode === "regex") {
			// Copy regex literals verbatim; quotes inside them must not open strings.
			if (char === "\n") {
				// Malformed (unterminated) regex literal: bail out conservatively.
				mode = "code";
				continue;
			}
			if (char === "\\") {
				out += char + (next ?? "");
				i += 2;
				continue;
			}
			if (char === "[") mode = "regexClass";
			else if (char === "/") mode = "code";
			out += char;
			i += 1;
		} else if (mode === "regexClass") {
			if (char === "\\") {
				out += char + (next ?? "");
				i += 2;
				continue;
			}
			if (char === "]") mode = "regex";
			out += char;
			i += 1;
		} else {
			// Inside a string literal: copy verbatim, honor escapes.
			if (char === "\\") {
				out += char + (next ?? "");
				i += 2;
				continue;
			}
			if ((mode === "dquote" && char === '"') || (mode === "squote" && char === "'") || (mode === "template" && char === "`")) {
				mode = "code";
			}
			out += char;
			i += 1;
		}
	}
	return out;
}

function scanFile(file) {
	const specifiers = new Set();
	const dynamicSites = [];
	let source;
	try {
		source = readFileSync(file, "utf8");
	} catch {
		return { specifiers, dynamicSites };
	}
	source = stripComments(source);
	IMPORT_RE.lastIndex = 0;
	let match;
	while ((match = IMPORT_RE.exec(source)) !== null) {
		const spec = match[2];
		if (!plausibleSpecifier(spec) || spec.startsWith("http:") || spec.startsWith("https:") || spec.startsWith("data:")) continue;
		specifiers.add(spec);
	}
	DYNAMIC_CALL_RE.lastIndex = 0;
	while ((match = DYNAMIC_CALL_RE.exec(source)) !== null) {
		const arg = match[1].trim();
		if (!arg) continue;
		// A quoted prefix is not necessarily a literal argument: concatenation
		// must remain subject to the dynamic-import audit.
		if (/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*$/.test(arg)) continue;
		if (arg.startsWith("`")) {
			const end = arg.indexOf("`", 1);
			const template = end > 0 ? arg.slice(1, end) : arg.slice(1);
			if (end > 0 && arg.slice(end + 1).trim() === "" && !template.includes("${")) {
				// Constant template literal: treat as a literal specifier.
				if (plausibleSpecifier(template)) specifiers.add(template);
				continue;
			}
		}
		dynamicSites.push(arg.slice(0, 60));
	}
	return { specifiers, dynamicSites };
}

function isBuiltinSpecifier(spec) {
	if (spec.startsWith("node:") || spec.startsWith("bun:")) return true;
	if (spec === "electron") return true;
	try {
		return isBuiltin(spec);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Package resolution
// ---------------------------------------------------------------------------

function readJson(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

function findPackageDir(fromDir, name) {
	let dir = fromDir;
	for (;;) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(candidate)) {
			try {
				return realpathSync(candidate);
			} catch {
				return candidate;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function probeFile(path) {
	const candidates = [
		path,
		`${path}.js`,
		`${path}.mjs`,
		`${path}.cjs`,
		`${path}.json`,
		`${path}.node`,
		join(path, "index.js"),
		join(path, "index.mjs"),
		join(path, "index.cjs"),
		join(path, "index.json"),
		join(path, "index.node"),
	];
	for (const candidate of candidates) {
		try {
			const st = statSync(candidate);
			if (st.isFile()) return candidate;
		} catch {
			// try next
		}
	}
	return null;
}

const EXPORT_CONDITIONS = new Set(["node", "import", "default", "require", "types"]);
const CONDITION_ORDER = ["node", "import", "require", "default"];

function resolveExports(exportsValue, subpath) {
	if (typeof exportsValue === "string") {
		return subpath === "." || subpath.startsWith("#") ? exportsValue : null;
	}
	if (Array.isArray(exportsValue)) {
		for (const entry of exportsValue) {
			const resolved = resolveExports(entry, subpath);
			if (resolved) return resolved;
		}
		return null;
	}
	if (exportsValue === null || typeof exportsValue !== "object") return null;
	// Path map vs condition object: keys starting with "." (or "#" for a
	// package "imports" map) form a path map.
	const keys = Object.keys(exportsValue);
	const isPathMap = keys.some((key) => key === "." || key.startsWith("./") || key.startsWith("#"));
	if (isPathMap) {
		if (subpath in exportsValue) {
			return resolveExports(exportsValue[subpath], ".");
		}
		for (const key of keys) {
			const wildcard = key.indexOf("*");
			if (wildcard === -1 || !key.startsWith(".")) continue;
			const prefix = key.slice(0, wildcard);
			const suffix = key.slice(wildcard + 1);
			if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
				const replacement = subpath.slice(prefix.length, subpath.length - suffix.length);
				const target = resolveExports(exportsValue[key], ".");
				if (typeof target === "string") return target.replace("*", replacement);
			}
		}
		return null;
	}
	for (const condition of CONDITION_ORDER) {
		if (condition in exportsValue && EXPORT_CONDITIONS.has(condition)) {
			const resolved = resolveExports(exportsValue[condition], subpath);
			if (resolved) return resolved;
		}
	}
	return null;
}

/**
 * Resolve the entry file for `subpath` inside the package at pkgDir.
 * Returns { file } on success or { error } with a concrete reason.
 * If the package has an `exports` map that does not expose the subpath, that
 * is an error (matching node runtime behavior), not a silent fs fallback.
 */
function resolvePackageEntry(pkgDir, subpath) {
	const pkgJsonPath = join(pkgDir, "package.json");
	if (!existsSync(pkgJsonPath)) return { error: `no package.json in ${pkgDir}` };
	let pkgJson;
	try {
		pkgJson = readJson(pkgJsonPath);
	} catch (error) {
		return { error: `unreadable package.json in ${pkgDir}: ${error.message}` };
	}
	let target = null;
	if (pkgJson.exports) {
		target = resolveExports(pkgJson.exports, subpath);
		if (!target && subpath !== ".") {
			return { error: `exports map of ${pkgJson.name || pkgDir} does not expose subpath ${subpath}` };
		}
	}
	if (!target) {
		if (subpath !== ".") {
			target = `./${subpath.slice(2)}`;
		} else {
			target = pkgJson.main || pkgJson.module || "./index.js";
		}
	}
	if (typeof target !== "string") return { error: `unresolvable export target in ${pkgDir}` };
	const file = probeFile(resolve(pkgDir, target));
	if (!file) return { error: `entry ${target} of ${pkgJson.name || pkgDir} not found on disk` };
	return { file };
}

// ---------------------------------------------------------------------------
// Native artifact inspection
// ---------------------------------------------------------------------------

const ELF_MACHINE_TO_ARCH = { 3: "ia32", 40: "arm", 62: "x64", 183: "arm64", 243: "riscv64" };

function inspectNativeBinary(file) {
	let handle;
	try {
		handle = readFileSync(file);
	} catch {
		return { format: "unreadable" };
	}
	if (handle.length >= 20 && handle[0] === 0x7f && handle[1] === 0x45 && handle[2] === 0x4c && handle[3] === 0x46) {
		return {
			format: "elf",
			bits: handle[4] === 2 ? 64 : 32,
			arch: ELF_MACHINE_TO_ARCH[handle.readUInt16LE(18)] || `unknown(${handle.readUInt16LE(18)})`,
		};
	}
	if (handle.length >= 4 && handle[0] === 0x00 && handle[1] === 0x61 && handle[2] === 0x73 && handle[3] === 0x6d) {
		return { format: "wasm", arch: "wasm32 (portable)" };
	}
	return { format: "unknown" };
}

/** Package root (bundle-relative, posix) of a file inside node_modules. */
function packageRootOfRelative(relPath) {
	const segments = relPath.split("/");
	const idx = segments.lastIndexOf("node_modules");
	if (idx === -1 || idx === segments.length - 1) return relPath;
	const rest = segments.slice(idx + 1);
	const root = rest[0].startsWith("@") && rest.length > 1 ? [rest[0], rest[1]] : [rest[0]];
	return [...segments.slice(0, idx + 1), ...root].join("/");
}

// ---------------------------------------------------------------------------
// Main packager
// ---------------------------------------------------------------------------

function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		console.log(
			[
				"Usage: node package-sdk.mjs [options]",
				"  --source <dir>          vendored pi monorepo (default: <repo>/vendor/pi)",
				"  --out <dir>             bundle directory; must not exist or be empty (default: $PI_SDK_BUNDLE_OUT or <repo>/../tmp/pi-sdk-<platform>-<arch>)",
				"  --target-arch <arch>    arm64 (default) | x64",
				"  --target-platform <os>  linux (default; only supported value)",
				"  --skip-verify           skip the post-build runtime verification",
				"  --no-tar                do not create the .tar.gz transfer archive",
				"  --help                  show this help",
				"",
				"Nothing is ever deleted: preexisting outputs, archives, checksums and",
				"sibling files are refused, and no pruning of older bundles happens.",
			].join("\n"),
		);
		return;
	}

	const hostArch = process.arch;
	const source = realpathSync(options.source);
	const outDir = options.out;
	const startedAt = Date.now();

	log("1/7", `source: ${source}`);
	log("1/7", `out: ${outDir} (target ${options.targetPlatform}/${options.targetArch}, host ${process.platform}/${hostArch})`);
	assertSafeOutput(source, outDir);
	log("1/7", "output safety checks passed (empty/disjoint output, no symlink redirection, no preexisting targets)");

	// --- Step 2: validate the built source tree --------------------------------

	const monorepoJson = join(source, "package.json");
	if (!existsSync(monorepoJson) || readJson(monorepoJson).name !== "pi-monorepo") {
		fail(`${source} is not the vendored pi monorepo root (expected package.json name "pi-monorepo")`);
	}
	const codingAgentDir = join(source, "packages", "coding-agent");
	for (const required of ["package.json", "dist", "dist/cli.js", "dist/index.js", "dist/rpc-entry.js"]) {
		if (!existsSync(join(codingAgentDir, required))) {
			fail(
				`missing ${join(codingAgentDir, required)}: the vendored Pi SDK is not built. ` +
					"Build it first (see CONTRIBUTING.md: vendor/pi npm ci + build:unbundled); this tool never builds or installs.",
			);
		}
	}

	// Workspace package index: realpath(packages/<dir>) -> package info.
	const workspaceByDir = new Map();
	const workspaceByName = new Map();
	for (const entry of readdirSync(join(source, "packages"), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const pkgDir = join(source, "packages", entry.name);
		const pkgJsonPath = join(pkgDir, "package.json");
		if (!existsSync(pkgJsonPath)) continue;
		let pkgJson;
		try {
			pkgJson = readJson(pkgJsonPath);
		} catch {
			continue;
		}
		if (!pkgJson.name) continue;
		const info = { name: pkgJson.name, dir: realpathSync(pkgDir), pkgJson };
		workspaceByDir.set(info.dir, info);
		workspaceByName.set(info.name, info);
	}

	// --- Step 3: compute the runtime import closure -----------------------------

	const includedWorkspaces = new Map(); // name -> info
	const includedThirdParty = new Map(); // pkgRoot -> {name, version, license, sourceDir, bundleDir, reasons:[]}
	const edges = [];
	const unresolved = [];
	const warnings = []; // classified warnings {from, spec, classification, reason}
	const dynamicSiteRecords = []; // audited nonliteral sites {package, classification}
	const scanQueue = [];
	const scanned = new Set();

	function bundleDirForThirdParty(pkgRoot) {
		const underRoot = `${source}${sep}node_modules${sep}`;
		if (pkgRoot.startsWith(underRoot)) {
			return join(outDir, "node_modules", pkgRoot.slice(underRoot.length));
		}
		for (const [, info] of workspaceByDir) {
			const nested = `${info.dir}${sep}node_modules${sep}`;
			if (pkgRoot.startsWith(nested)) {
				return join(outDir, "node_modules", info.name, "node_modules", pkgRoot.slice(nested.length));
			}
		}
		return null;
	}

	function enqueueWorkspaceDist(info) {
		const distDir = join(info.dir, "dist");
		if (!existsSync(distDir)) {
			fail(`workspace package ${info.name} is imported at runtime but has no dist/ build: ${info.dir}`);
		}
		const walk = (dir) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					// dist/bun only serves bun-compiled binaries; it is neither scanned nor shipped.
					if (entry.name !== "bun") walk(path);
				} else if (entry.name.endsWith(".js") && !entry.name.endsWith(".d.js")) scanQueue.push(path);
			}
		};
		walk(distDir);
	}

	function includeWorkspace(info, reason) {
		if (includedWorkspaces.has(info.name)) return;
		includedWorkspaces.set(info.name, info);
		log("3/7", `first-party: ${info.name} (${reason})`);
		enqueueWorkspaceDist(info);
	}

	function includeThirdParty(pkgRoot, importerLabel, spec) {
		if (includedThirdParty.has(pkgRoot)) {
			includedThirdParty.get(pkgRoot).reasons.push(`${importerLabel} -> ${spec}`);
			return;
		}
		const pkgJsonPath = join(pkgRoot, "package.json");
		if (!existsSync(pkgRoot) || !existsSync(pkgJsonPath)) {
			fail(`resolved ${spec} (from ${importerLabel}) to ${pkgRoot} which has no package.json`);
		}
		const bundleDir = bundleDirForThirdParty(pkgRoot);
		if (!bundleDir) {
			fail(
				`resolved ${spec} (from ${importerLabel}) to ${pkgRoot}, which is neither under the monorepo node_modules ` +
					"nor under a workspace package's nested node_modules; refusing to bundle unknown layouts",
			);
		}
		const pkgJson = readJson(pkgJsonPath);
		includedThirdParty.set(pkgRoot, {
			name: pkgJson.name || basename(pkgRoot),
			version: pkgJson.version || "0.0.0",
			license: pkgJson.license || "UNKNOWN",
			sourceDir: pkgRoot,
			bundleDir,
			reasons: [`${importerLabel} -> ${spec}`],
		});
		log("3/7", `third-party: ${pkgJson.name || basename(pkgRoot)}@${pkgJson.version || "?"} (${importerLabel} -> ${spec})`);
		// Scan every shipped code file of the package so the closure covers
		// lazily required internals, not just the entry chain.
		const walk = (dir, depth) => {
			let entries;
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (thirdPartyKeep(entry.name, true, depth)) walk(path, depth + 1);
				} else if (entry.isFile() && thirdPartyKeep(entry.name, false, depth)) {
					if (/\.(js|mjs|cjs)$/.test(entry.name)) scanQueue.push(path);
				}
			}
		};
		walk(pkgRoot, 0);
	}

	function owningPackageInfo(file) {
		// Stop at the nearest package boundary, before crossing a nested
		// node_modules into its enclosing workspace package.
		let dir = dirname(realpathSync(file));
		for (;;) {
			if (workspaceByDir.has(dir)) {
				const info = workspaceByDir.get(dir);
				return { name: info.name, root: info.dir, pkgJson: info.pkgJson, firstParty: true, info };
			}
			const parent = dirname(dir);
			if (basename(parent) === "node_modules" || (basename(parent).startsWith("@") && basename(dirname(parent)) === "node_modules")) {
				const pkgJsonPath = join(dir, "package.json");
				const pkgJson = existsSync(pkgJsonPath) ? readJson(pkgJsonPath) : null;
				return { name: pkgJson?.name || basename(dir), root: dir, pkgJson, firstParty: false };
			}
			if (parent === dir) return null;
			dir = parent;
		}
	}

	function classifyResolvedFile(file, importerLabel, spec) {
		const owner = owningPackageInfo(file);
		if (!owner) {
			unresolved.push(`${importerLabel}: cannot classify import ${spec} -> ${realpathSync(file)} (file outside every included package)`);
			return;
		}
		edges.push({ from: importerLabel, to: owner.name, spec });
		if (owner.firstParty) includeWorkspace(owner.info, `${importerLabel} -> ${spec}`);
		else includeThirdParty(owner.root, importerLabel, spec);
	}

	function classifyUnresolvedImport(file, importerLabel, spec, detail) {
		const owner = owningPackageInfo(file);
		const specRoot = spec.startsWith(".") || spec.startsWith("#") ? spec : spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
		let entry = OPTIONAL_IMPORTS[specRoot];
		const ownerFile = owner ? relative(owner.root, file) : '';
		if (owner?.name === 'openai' && owner.pkgJson?.version === '7.19.0') {
			if (spec === 'apiKey' && ['client.js', 'client.mjs'].includes(ownerFile)) entry = {
				classification: 'diagnostic-template-false-positive',
				reason: "OpenAI 7.19 client diagnostic template says Failed to get token from 'apiKey' function; not an import.",
			};
			if (spec === '@smithy/hash-node' && ['providers/bedrock/aws.js', 'providers/bedrock/aws.mjs'].includes(ownerFile) && owner.pkgJson.peerDependenciesMeta?.[spec]?.optional === true) entry = {
				classification: 'optional-provider-peer',
				reason: 'OpenAI Bedrock adapter optional peer; this bundle qualifies only OpenAI-compatible completions, never Bedrock.',
			};
		}
		if (!entry && owner && !owner.firstParty) {
			entry = OPTIONAL_IMPORTS.byImporter[owner.name]?.[spec];
		}
		if (entry) {
			warnings.push({ from: importerLabel, spec, classification: entry.classification, reason: entry.reason });
			return;
		}
		unresolved.push(
			`${importerLabel}: ${detail}` +
				(owner ? ` (owning package: ${owner.name}${owner.firstParty ? " [first-party]" : ""})` : "") +
				`; unclassified: add an audited classification or fix the import`,
		);
	}

	const codingAgentInfo = workspaceByName.get("@earendil-works/pi-coding-agent");
	if (!codingAgentInfo) fail("packages/coding-agent not found in the vendored source");
	includeWorkspace(codingAgentInfo, "bundle root (SDK + CLI)");

	while (scanQueue.length > 0) {
		const file = scanQueue.pop();
		if (scanned.has(file)) continue;
		scanned.add(file);
		const importerLabel = relative(source, file) || file;
		const { specifiers, dynamicSites } = scanFile(file);
		for (const spec of specifiers) {
			if (isBuiltinSpecifier(spec)) continue;
			if (spec.startsWith(".")) {
				const resolved = probeFile(resolve(dirname(file), spec));
				if (!resolved) {
					// A missing relative import is never silently ignored.
					const detail = `relative import ${spec} does not resolve to a file`;
					const owner = owningPackageInfo(file);
					if (owner && !owner.firstParty) classifyUnresolvedImport(file, importerLabel, spec, detail);
					else unresolved.push(`${importerLabel}: ${detail} (first-party; the bundle would be broken)`);
					continue;
				}
				scanQueue.push(resolved);
				continue;
			}
			if (spec.startsWith("#")) {
				// Package-internal "imports" map (e.g. chalk's #ansi-styles).
				const owner = owningPackageInfo(file);
				const target = owner?.pkgJson?.imports ? resolveExports(owner.pkgJson.imports, spec) : null;
				const resolvedFile = owner && target ? probeFile(resolve(owner.root, target)) : null;
				if (!resolvedFile) {
					const detail = `cannot resolve imports-map entry ${spec} of ${owner?.root ?? "unknown package"}`;
					if (owner && !owner.firstParty) classifyUnresolvedImport(file, importerLabel, spec, detail);
					else unresolved.push(`${importerLabel}: ${detail} (first-party)`);
				continue;
				}
				classifyResolvedFile(resolvedFile, importerLabel, spec);
				continue;
			}
			// Bare specifier: package name + optional subpath.
			const parts = spec.split("/");
			const pkgName = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
			const subpath = "." + spec.slice(pkgName.length);
			const pkgDir = findPackageDir(dirname(file), pkgName);
			if (!pkgDir) {
				classifyUnresolvedImport(file, importerLabel, spec, `package not found in any node_modules: ${spec}`);
				continue;
			}
			const entryResult = resolvePackageEntry(pkgDir, subpath);
			if (!entryResult.file) {
				classifyUnresolvedImport(file, importerLabel, spec, `${entryResult.error} (specifier ${spec})`);
				continue;
			}
			classifyResolvedFile(entryResult.file, importerLabel, spec);
		}
		// Nonliteral dynamic import/require sites must be audited per package.
		if (dynamicSites.length > 0) {
			const owner = owningPackageInfo(file);
			const audit = owner ? DYNAMIC_IMPORT_AUDIT[owner.name] : null;
			if (!audit) {
				unresolved.push(
					`${importerLabel}: unaudited nonliteral dynamic import site(s): ${dynamicSites.map((s) => `require/import(${s})`).join(", ")}` +
						(owner ? ` (owning package: ${owner.name})` : "") +
						"; computed import roots must be audited in DYNAMIC_IMPORT_AUDIT",
				);
			} else {
				dynamicSiteRecords.push({
					from: importerLabel,
					package: owner.name,
					sites: dynamicSites.length,
					classification: audit.classification,
					reason: audit.reason,
				});
			}
		}
	}

	if (unresolved.length > 0) {
		console.error("package-sdk: unexplained missing runtime edges (build stopped):");
		for (const line of unresolved) console.error(`  ${line}`);
		fail(`${unresolved.length} unexplained import edge(s); bundle would be incomplete`);
	}
	if (warnings.length > 0) {
		log("3/7", `${warnings.length} classified optional/unresolvable import(s) recorded in the manifest`);
	}
	log(
		"3/7",
		`closure: ${includedWorkspaces.size} first-party, ${includedThirdParty.size} third-party packages, ${scanned.size} files scanned, ${dynamicSiteRecords.length} audited dynamic-site file(s)`,
	);

	// --- Step 4: copy into the bundle -------------------------------------------

	// assertSafeOutput proved outDir absent or empty; create it (parents included).
	mkdirSync(outDir, { recursive: true });
	writeFileSync(
		join(outDir, BUNDLE_MARKER),
		`${JSON.stringify({ generator: "portable/raspberry-pi/package-sdk.mjs", targetPlatform: options.targetPlatform, targetArch: options.targetArch }, null, "\t")}\n`,
	);

	function copyFileSyncChecked(from, to) {
		mkdirSync(dirname(to), { recursive: true });
		const fromStat = lstatSync(from);
		if (fromStat.isSymbolicLink()) {
			fail(`symlink in copied source tree (bundle format forbids symlinks): ${from} -> ${readlinkSync(from)}`);
		}
		if (!fromStat.isFile()) {
			fail(`non-regular file in copied source tree: ${from}`);
		}
		copyFileSync(from, to);
		chmodSync(to, fromStat.mode & 0o777);
	}

	function copyTree(fromDir, toDir, keep, depth = 0) {
		for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
			const from = join(fromDir, entry.name);
			const to = join(toDir, entry.name);
			if (entry.isSymbolicLink()) {
				// Simplest portable format: no symlinks at all.
				fail(`symlink in copied source tree (bundle format forbids symlinks): ${from} -> ${readlinkSync(from)}`);
			}
			if (entry.isDirectory()) {
				if (keep(entry.name, true, depth)) copyTree(from, to, keep, depth + 1);
				continue;
			}
			if (entry.isFile()) {
				if (keep(entry.name, false, depth)) copyFileSyncChecked(from, to);
				continue;
			}
			fail(`non-regular file in copied source tree: ${from}`);
		}
	}

	const workspaceKeep = (name, isDir) => {
		if (!isDir) return !name.endsWith(".map");
		return name !== "bun"; // dist/bun only serves bun-compiled binaries
	};

	function copyWorkspacePackage(info) {
		const dest = join(outDir, "node_modules", info.name);
		for (const metaFile of ["package.json", "README.md", "CHANGELOG.md"]) {
			const from = join(info.dir, metaFile);
			if (existsSync(from)) copyFileSyncChecked(from, join(dest, metaFile));
		}
		copyTree(join(info.dir, "dist"), join(dest, "dist"), workspaceKeep);
		// Runtime native prebuilds (pi-tui clipboard helper). The target-arch
		// prebuild is REQUIRED; the host-arch prebuild (when different) is
		// included so host verification can actually load a binding.
		if (info.name === "@earendil-works/pi-tui") {
			const hostPrebuildLimitations = [];
			for (const arch of [options.targetArch, ...(hostArch !== options.targetArch ? [hostArch] : [])]) {
				const prebuildDir = join(info.dir, "native", options.targetPlatform, "prebuilds", `${options.targetPlatform}-${arch}`);
				if (!existsSync(prebuildDir)) {
					if (arch === options.targetArch) {
						fail(
							`pi-tui prebuild for ${options.targetPlatform}-${arch} is missing at ${prebuildDir}; ` +
								"no target-arch native clipboard helper can be bundled (concrete blocker)",
						);
					}
					hostPrebuildLimitations.push(
						`host-arch prebuild ${options.targetPlatform}-${hostArch} absent; host-side native load check will be skipped`,
					);
					continue;
				}
				copyTree(prebuildDir, join(dest, "native", options.targetPlatform, "prebuilds", `${options.targetPlatform}-${arch}`), () => true);
			}
			for (const limitation of hostPrebuildLimitations) warnings.push({ from: "package-sdk", spec: "pi-tui prebuilds", classification: "host-prebuild-absent", reason: limitation });
		}
		// Third-party notices shipped by first-party packages.
		if (info.name === "@earendil-works/pi-mcp") {
			const licensesDir = join(info.dir, "LICENSES");
			if (existsSync(licensesDir)) copyTree(licensesDir, join(dest, "LICENSES"), () => true);
		}
		// Runtime-referenced asset directories of the coding agent (docs and
		// examples commands read these; images are documentation-only).
		if (info.name === "@earendil-works/pi-coding-agent") {
			if (existsSync(join(info.dir, "docs"))) {
				copyTree(join(info.dir, "docs"), join(dest, "docs"), (name, isDir) => !(isDir && name === "images"));
			}
			if (existsSync(join(info.dir, "examples"))) {
				copyTree(join(info.dir, "examples"), join(dest, "examples"), (name, isDir) =>
					isDir ? name !== "node_modules" : !name.endsWith(".map"),
				);
			}
		}
	}

	for (const [, info] of includedWorkspaces) copyWorkspacePackage(info);
	for (const [, info] of includedThirdParty) {
		copyTree(info.sourceDir, info.bundleDir, thirdPartyKeep);
	}

	// First-party license + verification tool.
	copyFileSyncChecked(join(source, "LICENSE"), join(outDir, "LICENSE"));
	copyFileSyncChecked(resolve(SCRIPT_DIR, "verify-bundle.mjs"), join(outDir, "verify", "verify-bundle.mjs"));

	// --- Step 5: read-back verification, native inventory, manifest -------------

	log("5/7", "inventorying bundle files");
	const problems = [];

	function inventoryBundle() {
		const fileEntries = [];
		const nativeArtifacts = [];
		const walk = (dir) => {
			for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
				const path = join(dir, entry.name);
				const rel = relative(outDir, path);
				if (entry.isDirectory()) {
					walk(path);
					continue;
				}
				if (entry.isSymbolicLink()) {
					problems.push(`symlink in bundle (format forbids symlinks): ${rel} -> ${readlinkSync(path)}`);
					continue;
				}
				if (!entry.isFile()) {
					problems.push(`unexpected file type in bundle: ${rel}`);
					continue;
				}
				const data = readFileSync(path);
				const sha256 = createHash("sha256").update(data).digest("hex");
				fileEntries.push({ path: rel, size: data.length, sha256 });
				if (rel.endsWith(".node") || rel.endsWith(".wasm") || rel.endsWith(".so")) {
					const info = inspectNativeBinary(path);
					nativeArtifacts.push({ path: rel, ...info });
				}
			}
		};
		walk(outDir);
		return { fileEntries, nativeArtifacts };
	}

	const { fileEntries, nativeArtifacts } = inventoryBundle();

	// Native coverage policy: every ELF must be target-arch, or host-arch with
	// a target-arch sibling in the same package. Wrong-arch-only is a blocker.
	const elfByPackage = new Map();
	for (const artifact of nativeArtifacts) {
		if (artifact.format !== "elf") continue;
		const root = packageRootOfRelative(artifact.path);
		if (!elfByPackage.has(root)) elfByPackage.set(root, new Set());
		elfByPackage.get(root).add(artifact.arch);
	}
	for (const artifact of nativeArtifacts) {
		if (artifact.format === "wasm") continue;
		if (artifact.format !== "elf") {
			problems.push(`native artifact ${artifact.path} has unrecognized format ${artifact.format}`);
			continue;
		}
		if (artifact.arch === options.targetArch) {
			artifact.coverage = "target";
			continue;
		}
		if (artifact.arch === hostArch) {
			const root = packageRootOfRelative(artifact.path);
			const archs = elfByPackage.get(root);
			if (archs.has(options.targetArch)) {
				artifact.coverage = `host (${options.targetArch} sibling present in same package)`;
				continue;
			}
			problems.push(
				`native artifact ${artifact.path} is ${artifact.arch}-only: package ${root} ships no ${options.targetArch} ` +
					`variant. This bundle could not run on the ${options.targetArch} target. Concrete blocker: obtain a ` +
					`${options.targetArch} build of this dependency and rebuild the bundle.`,
			);
			continue;
		}
		problems.push(`native artifact ${artifact.path} is ${artifact.arch}; neither target (${options.targetArch}) nor host (${hostArch})`);
	}

	if (problems.length > 0) {
		console.error("package-sdk: bundle inventory problems:");
		for (const problem of problems) console.error(`  ${problem}`);
		fail(`${problems.length} bundle problem(s)`);
	}

	const totals = fileEntries.reduce((acc, entry) => ({ files: acc.files + 1, bytes: acc.bytes + entry.size }), {
		files: 0,
		bytes: 0,
	});

	// Provenance: the checkout may not be a git repo; digests are the record.
	const gitRev = (() => {
		const result = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" });
		return result.status === 0 ? result.stdout.trim() : null;
	})();
	const provenance = {
		sourceRoot: source,
		repositoryRevision: gitRev,
		repositoryRevisionNote: gitRev ? "git rev-parse of the vendored source" : "not a git checkout; the digests below are the source provenance",
		sourceDigests: {
			"package.json": sha256File(join(source, "package.json")),
			"package-lock.json": existsSync(join(source, "package-lock.json")) ? sha256File(join(source, "package-lock.json")) : null,
			"packages/coding-agent/package.json": sha256File(join(codingAgentDir, "package.json")),
		},
		firstPartyVersions: Object.fromEntries(
			[...includedWorkspaces.values()].sort((a, b) => a.name.localeCompare(b.name)).map((info) => [info.name, info.pkgJson.version || "?"]),
		),
		generator: {
			script: "portable/raspberry-pi/package-sdk.mjs",
			sha256: sha256File(fileURLToPath(import.meta.url)),
			verifierSha256: sha256File(resolve(SCRIPT_DIR, "verify-bundle.mjs")),
		},
		buildHost: { platform: process.platform, arch: process.arch, nodeVersion: process.version },
		generatedAt: new Date().toISOString(),
	};

	const manifest = {
		generator: "portable/raspberry-pi/package-sdk.mjs",
		created: new Date().toISOString(),
		status: "content-complete (integrity root is manifest.txt; rerun verify/verify-bundle.mjs on the target)",
		scope: "Static import closure of @earendil-works/pi-coding-agent plus runtime verification of the SDK import, quickjs instantiation and the write tool. NOT a claim of universal SDK completeness; unexercised paths may still miss runtime edges.",
		integrityNote:
			"manifest.txt is the integrity root of the bundle contents. It is integrity relative to the separately trusted transfer digest (the .tar.gz.sha256 sidecar verified over a trusted channel); it is not authenticity.",
		target: {
			platform: options.targetPlatform,
			arch: options.targetArch,
			nodeEngine: ">=22.19.0 (per @earendil-works/pi-coding-agent engines)",
			nativePolicy: `every ELF is ${options.targetArch}, or ${hostArch} with a ${options.targetArch} sibling in the same package; host verification loads only ${hostArch} bindings, ${options.targetArch} binding load is an open on-target gate`,
		},
		provenance,
		packages: {
			firstParty: [...includedWorkspaces.keys()].sort().map((name) => {
				const info = includedWorkspaces.get(name);
				return { name, version: info.pkgJson.version, license: info.pkgJson.license || "MIT", reason: "runtime import closure from @earendil-works/pi-coding-agent" };
			}),
			thirdParty: [...includedThirdParty.values()]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((info) => ({
					name: info.name,
					version: info.version,
					license: info.license,
					bundleDir: relative(outDir, info.bundleDir),
					reasons: [...new Set(info.reasons)].slice(0, 4),
				})),
		},
		nativeArtifacts,
		importEdges: [...new Set(edges.map((edge) => `${edge.from} -> ${edge.to} via ${edge.spec}`))].sort(),
		warnings,
		auditedDynamicImports: dynamicSiteRecords,
		totals,
	};
	writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);

	// Third-party notices. License fields are package.json declarations, not
	// verified notice text; shipped license files are preserved in place.
	const notices = [
		"# Third-party notices",
		"",
		"This bundle redistributes the third-party npm packages listed below as part of",
		"the Pi SDK runtime closure. The License column is the package.json declaration",
		"(metadata, not notice provenance); license/notice files shipped inside the",
		"packages are preserved in place within node_modules/.",
		"",
		"| Package | Version | License (declared) | Bundle path |",
		"| --- | --- | --- | --- |",
		...[...includedThirdParty.values()]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((info) => `| ${info.name} | ${info.version} | ${info.license} | ${relative(outDir, info.bundleDir)} |`),
		"",
		"First-party code (@earendil-works/*, LICENSE in the bundle root) is MIT licensed.",
		"",
	];
	writeFileSync(join(outDir, "THIRD_PARTY_NOTICES.md"), notices.join("\n"));

	// manifest.txt: the integrity root. Hash EVERY file except manifest.txt
	// itself (written last, after all content exists).
	const { fileEntries: finalEntries } = inventoryBundle();
	const manifestTxt = [
		`# Pi SDK runtime bundle manifest (${options.targetPlatform}/${options.targetArch})`,
		"# sha256 of every file in this bundle except this file itself.",
		"# Verify with: sha256sum -c manifest.txt   (from the bundle root)",
		"# Integrity relative to the trusted .tar.gz.sha256 transfer digest; not authenticity.",
		...finalEntries.filter((entry) => entry.path !== "manifest.txt").map((entry) => `${entry.sha256}  ${entry.path}`),
		"",
	].join("\n");
	writeFileSync(join(outDir, "manifest.txt"), manifestTxt);

	log("5/7", `bundle: ${totals.files} files, ${(totals.bytes / 1024 / 1024).toFixed(1)} MiB, ${nativeArtifacts.length} native/wasm artifacts`);

	// --- Step 6: runtime verification on this host -------------------------------

	let verification = { skipped: true, note: "host verification only; never proof for the target architecture" };
	if (!options.skipVerify) {
		log("6/7", `running bundle verification on this host (${hostArch}; target ${options.targetArch} stays an open gate)`);
		const verifyScript = join(outDir, "verify", "verify-bundle.mjs");
		const result = spawnSync(process.execPath, [verifyScript, "--bundle", outDir, "--check-manifest"], {
			encoding: "utf8",
			timeout: 180000,
			// The verifier re-sanitizes its own environment; start it clean anyway.
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				TMPDIR: process.env.TMPDIR,
				LANG: process.env.LANG,
				TZ: process.env.TZ,
			},
		});
		process.stdout.write(result.stdout || "");
		if (result.status !== 0) {
			process.stderr.write(result.stderr || "");
			fail(`bundle verification failed with exit code ${result.status}; see output above (bundle left in place for inspection)`);
		}
		verification = { skipped: false, exitCode: result.status, host: `${process.platform}/${hostArch}`, target: `${options.targetPlatform}/${options.targetArch}` };
	} else {
		log("6/7", "verification skipped (--skip-verify)");
	}

	// --- Step 7: transfer archive + external summary (no pruning, ever) ----------

	let archive = null;
	if (!options.noTar) {
		const tarPath = `${outDir}.tar.gz`;
		log("7/7", `creating ${tarPath}`);
		const tarBase = basename(outDir);
		// Deterministic flags only; NO silent fallback that would change the
		// layout. If this tar does not support them, fail explicitly.
		const tarResult = spawnSync(
			"tar",
			[
				"--sort=name",
				"--owner=0",
				"--group=0",
				"--numeric-owner",
				"--mtime=1970-01-01T00:00:00Z",
				"-czf",
				tarPath,
				"-C",
				dirname(outDir),
				tarBase,
			],
			{ encoding: "utf8" },
		);
		if (tarResult.status !== 0) {
			process.stderr.write(tarResult.stderr || "");
			fail("tar failed (deterministic flags not supported?); no fallback archive is created. Bundle left in place.");
		}
		const sha = createHash("sha256").update(readFileSync(tarPath)).digest("hex");
		writeFileSync(`${tarPath}.sha256`, `${sha}  ${basename(tarPath)}\n`);
		archive = { path: tarPath, bytes: statSync(tarPath).size, sha256: sha };
		log("7/7", `archive sha256 (transfer digest): ${sha}`);
		// The build summary lives NEXT TO the archive, never inside the bundle:
		// the archive must contain exactly the hashed content.
		const summary = {
			bundleDir: outDir,
			archive,
			totals,
			firstPartyPackages: [...includedWorkspaces.keys()].sort(),
			thirdPartyPackages: [...includedThirdParty.values()].map((info) => `${info.name}@${info.version}`).sort(),
			nativeArtifacts,
			verification,
			openGates: [
				`target ${options.targetArch} native bindings are not loadable on this ${hostArch} host; run verify/verify-bundle.mjs on the target`,
			],
			elapsedMs: Date.now() - startedAt,
		};
		writeFileSync(`${outDir}.build-summary.json`, `${JSON.stringify(summary, null, "\t")}\n`);
	} else {
		log("7/7", "archive skipped (--no-tar)");
	}

	log("done", `${outDir} (${(totals.bytes / 1024 / 1024).toFixed(1)} MiB, ${((Date.now() - startedAt) / 1000).toFixed(1)}s); nothing was pruned`);
}

try {
	main();
} catch (error) {
	if (error instanceof PackError) {
		console.error(`package-sdk: error: ${error.message}`);
		process.exit(1);
	}
	throw error;
}
