# Portable workspace prototype

A new workspace presentation for portable packaging, independent of the existing
launcher and terminal UI. Terminal sessions are real Linux PTYs running as the
account that starts the server. The agent tab is backed by a real lifecycle
adapter around the vendored Pi SDK, driven by a scripted local model — not by
provider inference. Network and funding states remain fixtures.

Requires Linux, Node 24, Python 3 and Bash. No npm installation or build is
needed for terminals and tests. Use an explicitly disposable directory:

```sh
mkdir -p "$PWD/local-data/portable-demo"
node portable/workspace/server.mjs --workspace "$PWD/local-data/portable-demo"
```

Open `http://127.0.0.1:8765`. The server binds only to IPv4 loopback. When running
remotely, forward this port through SSH and open that same local address. Changing
the forwarding port requires using the same port on both ends because Host checks
are exact. `--port` selects another server port.

The terminal is a plain text PTY view, not a full terminal emulator. Shell state
persists across commands; Ctrl-C can interrupt foreground work. It starts in the
selected directory with a minimal environment and no shell startup files. That
directory is **not a sandbox**: commands have the launching account's filesystem
and network authority. Use a disposable guest for isolation. This prototype does
not enforce Tor and does not perform inference, payment, or balance queries.

Closing a terminal hangs up its shell and foreground job. Programs can deliberately
detach; closing the UI tab does not shut down the server. Stop the server when the
rehearsal ends. Terminal output is bounded in memory, never logged by the server.
Workspace files survive shutdown. No payment credentials should be used here.

## Agent adapter (local development prototype)

The agent tab is served by a bounded lifecycle adapter, not simulated text from
the server. Each run spawns a dedicated worker process
([`agent-worker.mjs`](agent-worker.mjs)) that embeds the vendored Pi SDK when it
is built and reports a clear unavailable state when it is not. The worker selects
explicitly isolated SDK state:

- `SettingsManager.inMemory()` with automatic retries disabled
  (`retry.enabled=false`, `maxRetries=0`, provider `maxRetries=0`) so a future
  real provider integration never retries silently, plus compaction and cache
  warming off.
- `SessionManager.inMemory(cwd)`: no conversation files.
- `ModelRuntime.create` with an in-memory `AuthStorage` credential store and
  `modelsPath: null`, `allowModelNetwork=false` and `refreshOnCreate=false`:
  no `auth.json` or `models.json` is ever read from the workspace or any home
  directory. Per-run SDK state lives in a fresh mode-0700 temporary directory
  outside the workspace, created per run and removed when the worker exits.
- `DefaultResourceLoader` with extensions, skills, prompt templates, themes and
  context files all disabled and an explicit system prompt: nothing ambient is
  admitted.
- Only the `read` and `write` tools are admitted, bound to the workspace cwd.

The worker's model is a **scripted local transport** registered as a native
provider (`abalone-scripted/scripted-agent`): it issues one real SDK tool call
(`write`, or `read` in tests) and then a final text message. Tool execution
inside the SDK is real; the "model responses" are a local script. This is
explicitly **not provider inference**: no network request is made, no
credential is read, and no paid API is contacted. Real inference requires a
future provider broker and is out of scope for this slice.

### Scripted-proof tool outcome policy

Because the scripted transport plans exactly one tool call, the worker treats
the run's honesty as depending on that one call: the planned tool must be one
of the admitted `read`/`write` tools (anything else is rejected before the
run), and the worker captures the SDK's own `tool_execution_end` results. Any
failed tool execution produces an error run — a `tool_failed` event, a nonzero
worker exit and no `done` — and `done.wrote` is only ever set for a captured,
successful `write` execution (reads never claim a write). This strictness is a
property of the one-tool scripted proof transport, **not** a general rule: a
future genuine model agent may observe intermediate tool errors and recover,
and must not be failed permanently by them.

### Lifecycle semantics

- A worker-reported terminal event (`done`, `aborted`, …) is a protocol
  outcome, not process termination. A run occupies capacity until its child
  process is actually reaped; capacity starts being reserved synchronously at
  start (before the per-run directory is created), so concurrent starts cannot
  exceed the limit. Runs whose child has not exited are never pruned and can
  always be stopped.
- A worker-reported `done` is **provisional evidence, never a public terminal
  state and never a public `done` event**. On arrival the manager converts it
  to a `worker_reported_done` evidence marker in the bounded stream and retains
  the worker's payload privately; the `state` returned by the events endpoint
  (and by the manager's `events()`/`list()`) stays nonterminal
  (`running`/`starting`) and **no done-typed event is observable** until the
  worker process is actually reaped. A consumer that stops polling on terminal
  states — or one that renders events, like the UI, which prints its
  completion message from a `done` event — can never mistake a done-then-hang
  or done-then-nonzero worker for success. `state` is authoritative; the
  `worker_reported_done` line is the worker's claim, kept as evidence with the
  payload withheld.
- Terminal `done` requires the protocol completion **and** a clean process
  exit (exit code 0, no kill signal), settled at reap: only then is the
  **canonical `done` event — the privately retained worker payload — appended
  to the stream, exactly once, as the final line**. A `done` followed by a
  nonzero/unclean exit becomes `error` (a `worker_exit` event records why)
  with no canonical `done`, and an exit 0 without any reported completion also
  becomes `error`. Manager-initiated outcomes (`timeout`, `aborted`, `error`)
  and a worker-reported `aborted` outrank a reported `done`; a late worker
  event can never revive or replace a terminal state.
- Server shutdown and per-run stop await actual child reaping and the removal
  of the per-run temporary directories this manager created; there is no
  give-up timer that could abandon a live child. Once shutdown has begun, new
  runs are refused (503 with `Agent manager is closing`).

The worker environment is a fixed allowlist (`PATH`, `LANG`, `PI_OFFLINE=1`).
`HOME` is not forwarded and no ambient credentials or API keys are inherited, so
the SDK cannot discover ambient auth. `agentDir` is explicit, so nothing under
the operator's home directory is consulted. The workspace cwd is still not a
sandbox: the `write` tool writes with the launching account's authority.

### Agent API

Same security checks as the terminal API (exact Host, same-origin Origin and
Fetch Metadata, `X-Workspace-Token` + JSON content type for mutations, bounded
request bodies).

- `GET /api/status` now includes `agent: { available, kind, sdkPath, detail }`,
  where `kind` is `sdk` (built SDK), `fixture` (test transport) or `missing`.
- `POST /api/agents {prompt}` starts a run (`{id}`); prompt is 1..8192 bytes.
  At most two runs are active (a live worker process counts, even one that
  already reported `done`); beyond that the response is 409. If the SDK is not
  built the response is 503 with the reason — never fake agent output.
- `GET /api/agents` lists runs (`{agents: [{id, state, alive}]}`) for reattach
  after a page reload; `alive` reports process truth (whether the worker
  process is still live), not the protocol claim.
- `GET /api/agents/:id/events?after=N` returns `{events, offset, truncated,
  state}`. Events are the worker's JSONL records (ready, state, agent_event,
  `worker_reported_done` evidence, the canonical done/aborted/error outcomes,
  and `worker_exit`/`tool_failed` failure evidence). Poll with the previous
  offset; the buffer is bounded to 256 KiB per run and reports truncation like
  terminal output. **Neither a terminal `state` nor a done-typed event is
  observable before the worker process is reaped**: a `worker_reported_done`
  line is the worker's provisional claim with its payload withheld — keep
  polling until `state` is terminal. The canonical `done` (carrying the
  worker's payload, e.g. `lastText`/`wrote`) is appended exactly once, only
  after the verified clean exit; every non-success settlement (`error`)
  carries `worker_exit` evidence instead.
- `DELETE /api/agents/:id` cancels the run: the worker aborts the SDK session,
  and an unresponsive worker is killed after a grace period. The response is
  sent once the worker process is actually reaped and its per-run temp
  directory is removed. A run also times out after 120 s (the timeout governs
  the process even after a reported `done`).

To run the adapter standalone against a built SDK (qualification; also covered
automatically by the gated smoke test below). The availability probe runs once
per server process, so building the SDK requires a server restart to be
detected. `agentDir` may be omitted: the worker then creates and removes its own
mode-0700 temporary directory outside the workspace:

```sh
(cd vendor/pi && npm ci --no-audit --no-fund && bash -c "$(node -p 'require("./package.json").scripts["build:offline"].replace("cd ../coding-agent && npm run build", "cd ../coding-agent && npm run build:unbundled")')")
node portable/workspace/agent-worker.mjs --probe   # expect {"type":"ready","kind":"sdk",...}
echo '{"prompt":"write the proof file","cwd":"'"$PWD/local-data/portable-demo"'"}' | node portable/workspace/agent-worker.mjs
```

`PORTABLE_PI_SDK=/abs/path/dist/index.js` overrides the SDK location.

## API and adapter seam

`GET /api/status` returns `csrfToken`, `workspace`, `terminalAvailable`,
`qualification` and `agent`. All mutations require `Content-Type: application/json`
and `X-Workspace-Token` with that token. Foreign Origins, cross-site Fetch
Metadata and unexpected Host Headers are refused; static serving is an explicit
file allowlist.

- `POST /api/terminals {}` returns `{id}` (eight sessions maximum).
- `POST /api/terminals/:id/input {input}` queues raw terminal input.
- `GET /api/terminals/:id/output?after=0` returns `{output,offset,exited,truncated}`.
  Poll with the previous offset; output includes terminal control characters.
- `DELETE /api/terminals/:id` closes the session.
- `GET /api/terminals` returns `{sessions: [{id, exited}]}` so a reloaded page
  can reattach to surviving PTYs (via the output endpoint above) instead of
  leaking new sessions until the eight-session cap is exhausted. The current UI
  does not use it yet; the endpoint is the coordination point for that fix.

A live provider adapter must keep the SDK's in-memory session manager, isolated
configuration and admitted tools, keep retries disabled, and route credentials
through a separate broker rather than the worker environment. Connection and
funding adapters must distinguish unknown balance, stale balance, payment
detection, confirmation, conversion and spendable credit. Do not upgrade fixture
labels to live claims without end-to-end evidence through the shipped network
boundary.

## Checks

```sh
node --test portable/workspace/server.test.mjs
node --test portable/workspace/agent.test.mjs
```

The first checks cross-origin/Host/token rejection, request limits, actual shell
state, workspace writes, foreground interruption, session closure and
static-file exposure. The second checks the agent lifecycle: event ordering,
mid-stream reattach offsets, cancellation and process reaping, timeout
escalation to kill, the unavailable-SDK refusal path (no fake output), the
allowlisted worker environment (an ambient secret canary is not inherited),
bounded event buffers, probe newline/buffer hardening (split status line,
unbounded noise), oversized-frame refusal with worker termination, monotonic
final states (no late-event revival), synchronous capacity reservation under
five concurrent starts against a limit of two, reported-done-is-not-termination
(a done-reporting live worker keeps capacity until reaped and is still killed
by its run timeout), repeated-poll proofs over the delayed-exit window that
assert the response **events** as well as the response **state** — no
done-typed event and no terminal state before the reap, on the manager
`events()` surface and over HTTP, for a done-then-hang worker (settled by its
run timeout), a delayed nonzero exit (settled as `error` with `worker_exit`
evidence) and a delayed clean exit (the canonical `done` appears exactly
once, appended at the verified reap and carrying the retained payload) —
plus a worker-reported `aborted` after `done` outranking the completion
claim, done-then-nonzero-exit and exit-0-without-done both settling as errors
with no canonical `done`, a racing start/close leaving no stray worker
processes or temp directories, agent-endpoint security checks,
and the terminal session listing for reload reattach. Its final tests are the gated actual-SDK checks:
the smoke check runs the real worker against the built vendored SDK and asserts
the real tool file contents and event order, that a poisoned workspace
`.pi-agent` (symlinked `auth.json`, canary `models.json`) is ignored in favor of
the in-memory credential store (verified via the runtime's own
`listCredentials`/model catalog, not mocked call options), and that the per-run
agentDir is a fresh 0700 temp directory outside the workspace that is removed
after the worker exits; the negative checks assert that a failed real SDK write
(to a directory path), a missing-file read and an invalid planned tool each
produce an error run with no `done` and no `wrote` claim, and that a successful
read completes without claiming a write. When `dist/` is absent those tests
report an explicit skip with the reason — they never masquerade as an
actual-SDK pass.

### Qualification status and honest limits

- The fixture transport ([`agent-fixture-worker.mjs`](agent-fixture-worker.mjs))
  covers the server/manager seam without needing a built SDK.
- Actual Pi SDK execution is qualified only by the gated smoke test (and the
  standalone commands above), and only on machines where the vendored SDK is
  built; the recorded run for this slice used SDK 1.1.0 built from
  `vendor/pi` and passed. A checkout without `dist/` shows that test as
  skipped, which is the honest result.
- The scripted model is not a model: responses are canned script turns. Only
  the SDK tool execution path is real.
- No Tor, no sandbox, no privacy claim: this is local development tooling. The
  worker writes with the launching account's authority inside the workspace.
- The repository offline integration gate and independent review remain required
  before integration; these checks do not qualify ARM images, Tor or payment
  behavior.
