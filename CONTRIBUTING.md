# Contributing to Abalone

Keep Abalone a focused client: useful private work, deliberate disclosure,
understandable retention and graceful entry/exit. Preserve a small explainable
Pi patch; propose provider or skill additions against explicit privacy criteria.
dsmack node operations are a separate product responsibility.

Start with the [roadmap](docs/roadmap.md) and [GitHub issues](https://github.com/amiller/abalone/issues).
The optional incognito journey is the first introduction, not a mandatory global
mode. Follow the [development workflow](docs/development.md) for scope and review.

## Local development

Use a topic branch or `tools/dev-worktree.sh <name>`. The helper creates a separate
checkout; `--copy-builds` optionally copies existing build outputs without shared
writable file inodes. It never copies credentials. Set ABALONE_DIR to disposable
state inside the worktree's ignored local-data/. Do not use a live private folder
or your normal state to rehearse a contribution.

The existing build recipe requires Linux, Node 24/npm, bubblewrap and the tools
used by the selected suite (including tmux, Chromium and strace for parts of the
full offline suite), plus XDG_RUNTIME_DIR for sockets. Build from locked packages:

```sh
npm ci --no-audit --no-fund
(cd pi && npm ci --no-audit --no-fund && bash -c "$(node -p 'require("./package.json").scripts["build:offline"].replace("cd ../coding-agent && npm run build", "cd ../coding-agent && npm run build:unbundled")')")
(cd aci && npm ci --no-audit --no-fund && npm run build)
aci/node_modules/.bin/tsc -p aci/verifier-ts/tsconfig.test.json
make verify-offline
```

The dependency installation and Pi/ACI build steps above passed on 10 October
2026 at source revision d51227b from a fresh source-only worktree with Node 24.15.0
and npm 11.12.1; no copied
build outputs were needed. Build Pi before ACI, whose adapters use Pi's generated
types. This is development-build evidence, not a full offline-suite pass or
installed-release qualification. Offline tests use synthetic/recorded
inputs; installing dependencies may require network access. See tests/verify.sh
for suite prerequisites. `make verify` also contacts real hosts without spending;
credential/hardware/paid suites are explicit separate work. The historical
traceability runner is outside this candidate's supported workflow.

## Changes and review

Describe the user-visible outcome, changed trust/retention boundary, relevant
checks and limits. Runtime changes require the offline integration gate; docs
need links and `git diff --check`. Seek independent review. Worktree helpers are
optional; no particular assistant model or private directory is required.

Preserve curated/manifest.json. The staged-file import and manifest tools are
available under tools/. Maintainers can enable the hook with
`git config core.hooksPath tools/hooks`; it checks imports and updates the manifest.

Recorded fixtures require publication review before upload. Never attach real
session logs by default. First-party code is [MIT licensed](LICENSE); preserve
[component notices](THIRD_PARTY_NOTICES.md) and use [security reporting](SECURITY.md)
for private concerns. Public issues and PRs belong in amiller/abalone. CI, the Pi
update procedure and release qualification remain tracked work. Existing scripts are implementation
material, not a promise that a fresh release has passed those gates.
