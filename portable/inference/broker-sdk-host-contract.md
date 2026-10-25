# Broker SDK-host integration: offline-qualified prototype

`createInferenceBroker` accepts constructor-only `sdkHostFactory` as an explicit
alternative to the legacy `verifier` plus ABIF1 `transport` fixture. Supplying
both modes is rejected. There is no default host, credential reader, admitted
release, provider billing policy or financial-store discovery.

The trusted factory is called once per request with
`{chargePolicy, stateDir, signal, permitRawPost}`. Admission policy, fixed code/SDK
paths, runtime verifier and financial lease acquisition belong in that trusted
factory's closure, not worker request fields. The broker passes its deeply frozen
charge policy and its configured journal state directory. The factory must bind
that directory and its credential-record lease to the same expected unlocked
vault UUID, mount and record generation. That actual vault binding remains
unqualified; synthetic leases in tests establish no recovery/custody guarantee.

The factory returns the reviewed SDK child host interface: `prepare`, `post`,
`close`. It owns any acquired lease/child until successful return, must honor the
abort signal during bounded construction, and must clean up failed construction
itself. The broker retains a late returned host and awaits its close even after
the request aborts. Every concurrent or repeated `stop()` receives the same drain promise and its
success or rejection. `stop()` drains this ownership before releasing the existing
exclusive state lock. A trusted factory that never settles, or close that never
finishes, cannot be safely forgotten: draining remains pending and the lock stays
held. If close rejects, inference is degraded and `stop()` rejects while retaining
the state lock until process exit. Supervisor intervention and the actual trusted
factory's bounded lifecycle are required; no unknown live child is declared
reaped merely because a timeout elapsed.

The broker removes empty tool definitions and orphan tool controls once, freezes
the native request, and independently derives its canonical SHA-256 digest. The
SDK host prepares that exact native body and must return the same digest with its
actual document binding. No ABIF1 key-release object is constructed. Only then do
the existing request log and budget journal durably reserve the reviewed bound.

At the child's one raw POST boundary, its private permit callback is scoped to
the one live request/host and only usable during post. A single-use latch is set
before any await. The broker checks logical ID, independently computed body
digest, admitted document digest, exact bound and policy evidence ID. It reads
the real journal and requires an unresolved matching reserve with no discrepancy.
After that await it rechecks liveness, cancellation, degraded state and the same
frozen charge policy against the trusted clock. The child additionally checks
its own signal and tariff immediately after private IPC and before native fetch.
The permission contains only its allowed flag, request ID/digest and reserved
bound. It never carries a financial credential.

Partial-reservation refunds require a separate, explicit trusted policy field:
`settlementUsage: 'openai-prompt-completion-all-billed-tokens'`. This declaration
asserts that the authenticated prompt_tokens/completion_tokens pair covers every
billed template, input, output and reasoning token. Neither output-bound mode
implies those usage semantics. Missing or unknown declarations consume the full
reserved bound even when counters look valid; there is no admitted default.
When usage semantics are admitted, both counters must be nonnegative safe
integers. A malformed non-null usage record permanently invalidates usage for
that response, so an earlier or later valid record cannot authorize a refund.
Legitimate intermediate usage:null is ignored. Malformed/oversized/truncated SSE
also cannot authorize a refund. Valid admitted overspend still records the full
actual amount and a durable discrepancy.

The existing journal/flock, request log, cap and discrepancy machinery remains
authoritative. There is no second journal or account API.
Duplicate IDs remain burned across restarts. Failures after entering the transport
boundary conservatively abandon the full reservation, including when the child's
last check prevented transmission; this avoids inferring free retry authority
from ambiguous outcomes. A known expiry before entering post retains the existing
zero-cost settlement behavior. Stop/cancellation after reservation also consumes
unresolved reservations. Settlement failures remain failed closed.

`broker-sdk.test.mjs` exercises the real socket and journal with a synthetic host,
including late permit completion, cancellation, expired policy, durable failure,
digest mismatch, duplicate/restart, concurrent budget, truthful overspend and
cleanup ownership. Separate retained qualification evidence joins the real broker,
actual pinned SecureClient and actual child host in a network-denied UID972
namespace with cached attestation and a synthetic credential FD. This is neither
a real vault lease test nor permission for paid/live requests or deployment.
