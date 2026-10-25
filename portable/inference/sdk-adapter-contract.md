# SecureClient child adapter prototype

`sdk-adapter-child-core.mjs` is an isolated admission/transport prototype, not
wired into the inference broker or approved for provider traffic. It uses the
supported Tinfoil `SecureClient` interface and does not fabricate an ABIF1 key
release. The existing fixture transport and broker remain unchanged.

## Process and authority contract

Create exactly one core in a **dedicated adapter child process**. It installs the
final global-fetch guard before the injected `loadSDK()` imports the supported
root export. A second core in the same process refuses, even after closing the
first. `close()` aborts work, bounds reader cleanup, and leaves global fetch
denied permanently. The parent must terminate and reap the child on completion,
abort, lost private IPC, or deadline. Do not import this core into a UI, agent,
shared server, or persistent worker pool.

All constructor functions are trusted capabilities, never request fields:

- `loadSDK()` returns the pinned root module containing `SecureClient`.
- `privateCreditReader()` supplies `authorization` and nonempty
  `userCacheSecret` privately. Neither comes from arguments, environment, HOME,
  worker messages, or a generated fallback identity.
- `admissionPolicy(binding)` explicitly approves the actual SDK verification
  document and release. There is no admitted default or historical-pin shortcut.
- `chargePolicy` and `clock` use the existing `charge-bound.mjs` contract.
  Missing, expired, or unbounded billing policy refuses before SDK initialization.
- `permitRawPost(details, signal)` bridges bounded **private** IPC to the existing
  broker journal. The prototype tests inject a synthetic callback; a production
  IPC bridge is not implemented here.
- `rawFetch(Request)` is the captured native network capability. Test processes
  instead inject an in-memory fixture and separately deny kernel networking.

The production host must provide a separate non-Tor broker UID under the reviewed
transparent Tor firewall. The JavaScript guard is not OS network isolation.

## Request lifecycle

```js
const admission = await child.prepare({ logicalId, body, signal });
// Broker durably reserves the derived worst-case charge here.
const { stream } = await child.post({
  handle: admission.handle, body, signal,
});
```

`body` is the broker's already validated, normalized native OpenAI request with
external model `private/gpt-oss-120b`. `post` requires the identical canonical
body, maps only the fixed model to `gpt-oss-120b`, and preserves other fields.
Empty-tools/orphan-tool-choice normalization remains the broker's responsibility;
this prototype does not silently introduce a new normalization rule.

The opaque handle is single-use and valid only by identity within its child.
It binds the logical ID, canonical request digest, fixed route/model, same client,
and copied actual verified document, repository, release digest, resolved URLs,
and a locally computed digest of the document's HPKE public key. That last digest
is labeled `hpkeKeyDigest`: it is not an SDK-issued key ID or an X25519 release.
An IPC host must keep handles in its private child-owned token map; serializing
and resubmitting the object does not create authority.

The global-fetch guard permits only GET
`https://api.ppq.ai/private/attestation` (at most two initial attempts) and POST
`https://api.ppq.ai/private/v1/chat/completions` (at most one attempt). It forces
`redirect: error`, denies all other routes and denies further attestation calls
after the POST slot is consumed. It preserves ordinary HTTPS validation.

Immediately before the raw encrypted POST, the guard rechecks admission, then
awaits the private permit. The broker must verify the durable reservation,
logical ID, request digest, current frozen tariff, bound, and cancellation. Its
reply must contain `allowed: true`, matching `logicalId`, `requestDigest`, and
`reservedBound`. After that await, the child synchronously rechecks admission,
abort, and the same tariff before invoking raw fetch. The raw POST slot is
consumed before the asynchronous permit; SDK key-mismatch recovery cannot send
again. Ambiguous transmission consumes the existing reservation and requires
reconciliation; no automatic paid retry is authorized.

Only authenticated decrypted response bytes leave the adapter, under encrypted
and plaintext byte limits and the whole-child deadline. Upstream headers and
session recovery tokens are not projected. Authorization is still an HTTPS
header visible to the relay: EHBP body sealing does **not** seal headers.
Failures are projected onto fixed enums without raw SDK exception text.

## Required broker changes, not implemented

Add an explicit production adapter admission branch instead of the current
`admission.release.keyId/publicKeyBase64` requirement. Preserve the ABIF1 branch
only for explicit offline fixtures. Wire prepare, durable reservation, the
single-use private raw-POST permit, bounded stream relay, existing journal
settlement/discrepancy handling, and child termination. Pass cancellation before
prepare and through permit/stream phases. No new account/balance API belongs on
the worker socket. Do not add a default real charge or release policy.

## Evidence boundaries

Control-flow tests use a stub SDK and run every case in a separate child process.
Actual offline proof uses the pinned 28-package closure, supported SDK root
import, and cached signed public bundle. It proves SecureClient readiness and
real attestation/key binding, real ciphertext interception, missing-nonce
refusal, one-POST key-mismatch refusal, denied release policy, and tariff expiry
after asynchronous permit. Those responses deliberately fail authentication.

A separate real EHBP test with a synthetic server key proves authenticated
response decryption and native structured tools. We do not possess the real
cached fixture enclave's private key, so these two proofs are not described as
one successful attested provider round trip. No live provider request, durable
budget integration, Tor inference, physical Pi, or financial recovery is claimed.

## Cancellation settlement

Every stream/body cancellation is best-effort with a 100 ms wait bound, including
redirect responses, non-success responses, reader errors and caller cancellation.
The failure aborts the request before waiting for cancellation. The public
operation therefore settles even if an upstream `cancel()` never resolves.
Closing the core retains its separate one-second overall cleanup bound and
permanent fetch denial. These bounds do not replace terminating/reaping the child.

A private permit timeout aborts the controller with `permit-refused`, not just
the local promise. The callback receives that aborted signal. The consumed POST
slot is not released; a callback that ignores cancellation and later returns
`allowed` cannot resume transmission or authorize another call.
