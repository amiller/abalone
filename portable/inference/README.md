# Dsmack portable inference brokers

Two source prototypes share the workspace SDK's local Unix connection: the
sealed PPQ broker below and a direct Zai development broker. The worker uses a
dummy local token; the broker holds the provider credential. Neither path has
live-provider qualification in the portable image yet.

## Direct Zai development path

`direct-zai-entry.mjs` connects the inherited vault lease to
`direct-zai-broker.mjs` and `zai-curl-transport.mjs`. The read-only credential
record is exactly `{version:1, provider:'zai', model:'glm-5.3', apiKey:'...'}`.
It is separate from the PPQ credit-display record schema. The broker runs as
UID972; only kernel-authenticated UID970 reaches its HTTP parser. Root provisions
`/run/portable-inference` as UID972:GID974, mode02750, so the fixed `zai.sock`
endpoint inherits GID974 with mode0660 without adding supplementary groups.

The trusted supervisor selects `/run/portable-inference/zai.sock` to use GLM-5.3
with low reasoning and at most1,024 output tokens. Jobs cannot select provider
credentials, endpoints or models. A broker session consumes at most three
logical request IDs, including failed attempts; duplicate IDs are refused.
This is a session resource limit, not a dollar cap or a durable restart budget.
Zai is a development provider here; this route makes no confidential-inference,
account-balance or funding claim.

Curl uses the fixed HTTPS Coding endpoint through SOCKS remote DNS at
`127.0.0.1:9050`, verifies TLS, and never follows redirects or retries. The key
arrives through config stdin; a fixed Python exec shim supplies the bounded JSON
body through an anonymous memfd. Cancellation waits for credential acquisition
and the owned process to drain before the lease is released. No credential is
passed in argv or environment variables.

Offline evidence covers actual SDK read/write tools through the broker, real
curl, and local TLS/SOCKS fixtures. Actual UID/socket isolation is separately
qualified; the joined SDK fixture projects identities and paths. These checks do
not establish public Tor routing, ARM installation or a live provider request.
Run the component checks with:

```sh
node --test portable/inference/direct-zai-broker.test.mjs portable/inference/zai-curl-transport.test.mjs portable/inference/direct-zai-entry.test.mjs
```

The following sections describe the sealed PPQ prototype and its separate
accounting and attestation contract.

## Shape

- `broker.mjs` — the broker process component. Listens on a Unix socket and
  serves exactly `POST /v1/chat/completions`. The caller presents only a fixed
  dummy authorization token and a logical request id; it cannot override the
  endpoint, model, key or headers, and there is no account or management API
  on the socket. The fixed external model `private/gpt-oss-120b` is mapped to
  `gpt-oss-120b` inside the sealed body, with the private id preserved on the
  `x-private-model` header. Native OpenAI tool definitions and tool results
  pass through in their original shape; an empty `tools` array is normalized
  away. Requests are bounded (body size, header count, JSON depth, response
  size, idle and total deadlines) and the SSE relay applies explicit
  backpressure through the whole chain.
- `client.mjs` — `inferenceSocketFetch(socketPath, { requestId, signal })`
  returns the fetch-compatible seam a future Pi SDK provider registration will
  use (the pattern of `agents/pi/coupon-provider.ts` +
  `lib/coupon-socket.mjs`, with no coupon-admission dependency): dummy
  authorization only, request id, cancel via `AbortSignal`, incremental
  streamed body, pull-based backpressure.
- `sealed-transport.mjs` — the injected-transport contract and an offline
  loopback implementation (ephemeral X25519 → HKDF-SHA256 → AES-256-GCM
  envelopes over an actual Unix socket to the fixture endpoint in
  `testing.mjs`). Exactly one raw encrypted POST per call; a 3xx is refused as
  `endpoint-redirect` (the endpoint is exact, redirects are never followed);
  a response that is not a valid sealed record is refused as
  `unsealed-response`. There is **no ordinary fetch and no live mode** in this
  subsystem; a production deployment injects its own reviewed implementation.
- `budget-journal.mjs` — durable authorized-budget journal. Amounts are
  integer base-unit strings; no float ever enters spend accounting. One
  `authorize` event fixes the durable cap: a restart re-opens it idempotently,
  a different cap is refused, and **restart never resets the budget**. Each
  logical request appends `reserve` before transmission and `settle`/`abandon`
  after resolution; duplicate ids are refused forever (including across
  restarts); unresolved reservations at startup are swept to `abandon`
  (outcome unknown, charged, never refunded).
- `request-log.mjs` — bounded, sanitized per-request outcome log (ids, fixed
  model, outcome codes, integer amounts, byte counts; never prompts, tool
  payloads, endpoints or credential material). Full or unwritable log fails
  closed.
- `lock.mjs` — the kernel-flock mutation primitive adapted from
  [portable/credit-journal](../credit-journal/README.md) (separate files and
  directories; that module is not edited or imported): a stdlib python3
  helper holds the lock exactly as long as the writer lives, a competing live
  writer is refused immediately, and contention is retried a bounded number
  of times before failing closed.
- `testing.mjs`, `*.test.mjs` — offline fixture doubles and checks (below).

## Trust and accounting rules

- **Authority is a separate UID, not the working directory.** The broker
  refuses to start when it runs as the caller's uid (an explicit testing flag
  exists for single-user offline tests), keeps its durable state in an owned
  private directory outside cwd, and a net-level gate checks every
  connection's kernel `SO_PEERCRED` *before the HTTP parser attaches*, so an
  unverified or wrong-uid connection is destroyed before any byte of its
  request is parsed; the request handler re-checks the gate's verdict in
  depth. Any failure to run the check fails closed.
- **At most one raw encrypted POST per logical request.** The sealed transport
  is called exactly once; a duplicate logical id is refused durably; a key
  mismatch is refused (never re-keyed, never retried); an endpoint redirect is
  refused (exact endpoint only).
- **Reservation before transmission.** No bytes leave before the integer
  reservation is durably recorded. Any journal or request-log write failure
  fails closed: nothing is transmitted and the broker suspends.
- **Post-transmission loss or cancel is outcome-unknown and charged.** The
  reservation is consumed, the id stays burned, and the caller cannot
  translate a failure into an uncharged request. Settlement is usage-priced
  with integer per-token base-unit prices when the upstream reports usage;
  otherwise the full reservation is consumed.
- **Injected reviewed verifier required.** Before reserving, the broker asks
  the injected verifier for attestation admission **and** a key release; a
  missing attestation, a missing release, or a missing sealed response
  refuses the request. There is no fallback path of any kind. The pinned
  previous source (ppq private-mode 0.7.0 + tinfoil 1.1.11) is provenance
  context only: a historical release qualification is not an eternal
  admission policy, and this broker re-admits nothing on its own.
- **The inference key exists only inside the broker process** (in practice:
  inside the injected sealed transport, which seals it into the envelope). The
  worker-side caller never sees it. No master-credit identifier or account
  concept exists in this subsystem.

## Deployment shape (not implemented here)

Run the broker as a dedicated uid with its private state directory outside any
workspace, and hand the worker only the socket path inside a per-worker scope
directory the operator provisions. The `SO_PEERCRED` check enforces the peer
uid regardless of filesystem permissions. Rotation of a full request log is
an explicit operator action. Live use additionally requires a reviewed
sealed transport, a reviewed verifier, whole-Tor routing and live
qualification — none of which this prototype provides or claims.

## Checks

Offline only, no network beyond loopback Unix sockets the test process
creates:

```sh
node --test portable/inference/budget-journal.test.mjs
node --test portable/inference/broker.test.mjs
```

The broker checks cover: delayed streams over an actual Unix socket; native
read/tool-result/edit roundtrips with empty-tools normalization; request,
model and target override rejection; header and credential refusal; the
absent account API; missing attestation, release and sealed response (no
fallback); key-mismatch and redirect refusal; at-most-once transmission with
restart duplicate refusal; concurrent budget races; usage-priced integer
settlement; journal and log fail-closed behavior; post-transmission cancel
charging; request and response frame bounds; uid separation and wrong-uid
connection destruction; stale and live socket takeover refusal; explicit
streaming backpressure; and a credential canary proving the key appears in no
error, event or durable artifact.


Trusted charge policy is mandatory for request admission (see charge-bound.md).
No provider tariff is admitted by default. JSON size is a frame bound, never
input-token accounting. A current reviewed contract must cover full model input
ceiling, all output/reasoning charges, ledger units and prices. Missing/expired
contracts refuse before POST. Validity is rechecked after attestation and durable
writes; expiry before transport settles a known zero cost and burns that request
id. The production adapter must repeat the validity/abort gate immediately before
its raw paid POST; broker checks cannot replace that transport check.

## NEAR response output limit

The content-tool bridge accepts a complete, otherwise valid SSE response ending
with `finish_reason: length` as a successful but incomplete answer. It preserves
the length status, final usage and plain partial text/reasoning, and appends an
output-limit notice. Native Pi also displays its existing truncation warning.
The current 1,024-token request cap is unchanged; no automatic retry or
continuation is added.

A length response never enters the tool decoder or releases a tool call, even
when it contains a complete tool block. If content or reasoning contains angle
brackets or their `&lt;`/`&gt;` forms, the whole unfinished response is withheld
and replaced with a notice. This deliberately also withholds ordinary markup
and comparisons rather than displaying ambiguous tool-request fragments.
Ordinary stop responses retain their existing strict tool decoding. Missing
`[DONE]`, incomplete framing, native tool fields, identity changes and usage
regressions still fail closed; none is treated as an output-limit success.

Focused offline checks:

```sh
node --test tests/near-tool-bridge.test.mjs tests/near-tool-codec.test.mjs portable/inference/near-session.test.mjs
```
