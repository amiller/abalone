# Raspberry Pi (ARM64) SDK runtime bundle

Tools to build and verify a small, transferable runtime bundle of the vendored
Pi SDK (`@earendil-works/pi-coding-agent` 1.1.x) for deployment on an ARM64
(aarch64) Linux guest.

- `package-sdk.mjs` — build the bundle from the built vendored source tree.
- `verify-bundle.mjs` — verify a bundle (ships inside it as
  `verify/verify-bundle.mjs`); the receiving machine reruns the exact checks.
- `sdk-package-tests.mjs` — synthetic-tree tests (no user data): output
  safety, closure policy, and manifest-rejection-before-import ordering.

## Build

```sh
node package-sdk.mjs --source <repo>/vendor/pi --out <fresh-dir> --target-arch arm64
```

No network access, no installs, no guest interaction, and **nothing is ever
deleted**: the packager refuses a nonempty output, symlinked outputs or
ancestors, output/source overlap (either direction), and preexisting
`<out>.tar.gz` / `.sha256` / `.build-summary.json` targets. There is no
pruning of older bundles — retire outputs by hand. Failed runs leave partial
output in place; reruns refuse it (choose a fresh directory).

Outputs (all next to each other):

- `<out>/` — the bundle directory (regular files and directories only).
- `<out>.tar.gz` + `<out>.tar.gz.sha256` — the transfer archive and its
  **transfer digest**.
- `<out>.build-summary.json` — external build record (verification result,
  archive digest, open gates). Never inside the bundle, so the archive
  contains exactly the hashed content.

## Bundle format

- **No symlinks at all** (simplest portable format). Any symlink found while
  copying or verifying is a hard error.
- `manifest.txt` is the integrity root: the sha256 of **every** file in the
  bundle except itself (including `manifest.json` and
  `THIRD_PARTY_NOTICES.md`). Files must be relative POSIX paths without
  absolute/traversal/duplicate/alias components; the bundle must contain
  nothing unlisted and nothing missing.
- A manifest checksum is **integrity relative to the separately trusted
  transfer digest** (the `.tar.gz.sha256` verified over a trusted channel);
  it is not authenticity of the source tree.
- `manifest.json` carries metadata only: target, provenance (source +
  lockfile digests, exact package versions, generator digests — the checkout
  may not be a git repo), package inventory with declared licenses (metadata,
  not notice provenance; shipped license files are preserved in place),
  classified closure warnings, audited dynamic-import sites, and the native
  artifact inventory.

## Closure policy

The static scan traces literal `import`/`require`/`require.resolve`/`import()`
specifiers (comment stripping is regex-literal aware) and:

- fails on **missing relative imports** (first-party) — never silently ignored;
- fails on unresolved third-party imports **unless classified** in
  `OPTIONAL_IMPORTS` with a concrete audited reason (optional native deps such
  as `kerberos`, `bufferutil`, `utf-8-validate`, AWS CRT signer deps;
  generator-template false positives inside `jiti`);
- fails on **nonliteral (computed) `require()`/`import()` sites** unless the
  owning package is audited in `DYNAMIC_IMPORT_AUDIT`;
- respects package `exports` maps (a subpath not exposed by `exports` is an
  error, matching Node runtime behavior).

This is a heuristic static closure, not complete static analysis. Runtime
verification covers only the exercised paths (SDK import, quickjs
instantiation, the write tool). **No universal SDK completeness is claimed.**

## Native policy

- Every `.node` ELF must be target-arch, or host-arch **with a target-arch
  sibling in the same package**. Wrong-arch-only dependencies are hard
  failures with a concrete blocker message.
- WASM payloads are architecture independent (photon, quickjs and extensions).
- Host verification actually `dlopen`s native bindings whose architecture
  matches the host. Target-arch bindings (e.g. the arm64 `pi-tui` prebuild on
  an x64 host) are an **explicit open gate** and are never claimed from the
  host. The `pi-tui` binding is a clipboard helper (X11); if a target lacks
  the display stack, report that gate separately.

## Verification

```sh
node verify/verify-bundle.mjs            # from the bundle root
```

Order (fail closed):

1. **Environment isolation** before any bundle code import: the process env is
   reduced to an allowlist (`PATH`, `LANG`, `LC_*`, `TZ`, `TERM`, plus
   disposable `HOME`/`TMPDIR` and `PI_OFFLINE=1`); `NODE_OPTIONS`, `PI_*`
   and everything else are dropped. Discovery canaries (extensions, skills,
   prompts, themes, context files, `auth.json`, `models.json`) are planted in
   the disposable HOME and asserted **not executed**.
2. **Complete manifest check before any runtime import** (see format above).
3. SDK import probe, native header + host-arch load checks, quickjs WASM
   instantiation, and a scripted agent session that executes the real write
   tool under the isolated agent-worker recipe
   (`SettingsManager.inMemory` with retry/compaction/cacheWarming off,
   `DefaultResourceLoader` with `noExtensions/noSkills/noPromptTemplates/
   noThemes/noContextFiles`, explicit system prompt, in-memory
   auth/models/session, `refreshOnCreate: false`, `allowModelNetwork: false`).

## ARM handoff (parent-coordinated; these tools never touch the guest)

1. Verify the trusted transfer digest on the sending side:
   `sha256sum -c sdk-reviewed-bundle.tar.gz.sha256`.
2. Inspect archive member paths and link types (regular files only):
   `tar -tvzf sdk-reviewed-bundle.tar.gz`.
3. Transfer only the reviewed archive to a **new guest temp directory**; never
   overwrite an existing SDK/deployment.
4. On the guest (expect `uname -m` = `aarch64`, `process.arch` = `arm64`,
   Node 24 ARM runtime): extract, then run
   `node verify/verify-bundle.mjs` from the bundle root. Record
   `uname -m`, `process.platform/arch/version`, archive/source hashes, and
   the verifier output. The arm64 `pi-tui` binding load is the open gate this
   closes.
5. Limitations to record: host checks are x86 evidence only; the scripted
   write-tool session proves that path, not universal SDK completeness; no
   live inference, wallet-credential, or Tor qualification follows from these
   checks; a vendored-relative deployment path (e.g. the workspace
   `agent-worker`) is not automatically integrated by standalone bundle
   proof.

## Tests

```sh
node sdk-package-tests.mjs
```

26 synthetic-tree tests: sentinel/sibling survival, nonempty/inside-source/
symlink/preexisting-target refusal, missing runtime edges, audited vs
unaudited nonliteral dependencies, classified vs unclassified optional
imports, wrong-arch-only native refusal, and manifest rejection **before**
side-effect import (traversal/absolute/duplicate/symlink/unlisted/hash
mismatch/missing/nonregular/alias), plus order proof that a clean manifest
reaches the SDK import.
