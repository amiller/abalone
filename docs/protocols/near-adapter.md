# NEAR recipient adapter

`lib/coupon-near.mjs` connects a delivered
version 4 coupon credential to real NEAR AI inference: a selected provider profile,
fresh remote attestation before the first prompt byte, a pinned transport, model
end-to-end encryption and a launcher-side credential broker. It is client inference
code only. Issuance remains the separately gated
[issuer-bound coupon protocol](coupon.md); nothing here qualifies private
issuance, rollback recovery, settlement, the [host VPN boundary](../gift-trial.md#separate-later-portable-agent-and-node-provided-vpn-milestone)
or an installed release.

## Selected profile

The adapter accepts no inherited `providers.json` defaults. The normal policy
requires `UpToDate`; the separately selected signed synthetic trial can allow
`OutOfDate` only with actual warnings, as described in
[the development trial](../gift-trial.md). `validateCouponNearProfile`
requires the exact endpoint `https://cloud-api.near.ai/v1`, an explicit model id, a
`maxTokens` bound, and a policy whose `gatewayTcb` and `modelTcb` are both `UpToDate`,
whose `gpuSignature` is `required`, and whose `composeRegistry` is exactly
`https://mainnet.base.org` on chain 8453. The profile is deeply frozen; caller mutation
after opening cannot move any pin. The ordinary NEAR policy reports a gateway TCB it
does not gate; the recorded attestation's gateway is `OutOfDate`, and the selected
profile refuses that recording — a deliberate offline negative in `tests/g8-offline.mjs`.

Admission runs the reviewed verifier (`verifyNearModel`) with this policy: fresh nonce,
TDX quotes with UpToDate TCB, NVIDIA NRAS verdict with its ES384 signature checked
against the pinned intermediate, and the compose measured into RTMR3 admitted by NEAR's
DstackApp governance on Base. **The compose registry check is an RPC-trusted read at one
block from the pinned Base mainnet endpoint; it is not a Helios light-client finality
proof.** Its trust is the RPC endpoint plus NEAR's on-chain governance, which is the
same trust the [ordinary profile](../../lib/near.mjs) documents. Admission collateral
fetches are pinned to the Intel, NVIDIA and Base hosts above, refuse redirects and any
credential header, and are byte-bounded. The chat transport is pinned to the gateway
TLS SPKI from the verified quote.

Prompts are encrypted to the attested model signing key (secp256k1 ECDH, HKDF, AES-GCM
per the ported NEAR protocol), and each request carries a fresh client key so only this
process can read the streamed answer. The adapter accepts exactly one endpoint, method,
placeholder authorization (`Bearer coupon-session`), model and request shape; explicit
tool request fields are dropped (tools travel in the encrypted text of the in-content
protocol, never as wire tool calls); responses must be SSE, hex-encrypted in the known
fields, and are decrypted, byte-bounded and scrubbed of the credential before delivery.
Optional request fields are limited to `max_tokens` (at most the profile's `maxTokens`),
`temperature`, `top_p`, `chat_template_kwargs` with exactly a boolean `enable_thinking`
(Pi sends it from its thinking level), and `stream_options` of exactly
`{"include_usage": true}`. The broker records the provider's reported token counts;
a response without usage is counted as "not reported", never as zero tokens.
A refused endpoint identity at the pinned transport is reported as `transport_refused`,
distinct from `access_revoked_or_expired`. Every failure is a stable code; upstream
text, collateral errors and wire payloads never surface.

## Tool confidentiality and execution boundary

This integration encrypts message content and reasoning with the attested model
key. It does not implement NEAR's opt-in all-fields tool protocol. Native tool
schemas are removed before sending; structured tool history is refused. The
coupon adapter also refuses structured tool calls in responses.

Tools remain available through [the in-content protocol](../../lib/intools.mjs):
the system prompt describes them inside encrypted text, the model returns a tool
request inside encrypted answer text, Abalone executes it locally, and the result
returns as another encrypted message. “Tools off” in the ordinary NEAR status
means native API tools are disabled; it does not mean local tools are disabled.

| Data or action | Current integration boundary |
| --- | --- |
| Tool descriptions, requests and results in message text | Encrypted to/from the attested model |
| Native request tool schemas | Removed before sending |
| Native tool-call history | Refused |
| Native response calls on the coupon route | Refused |
| Native response calls on the ordinary route | Decoder does not explicitly refuse them; qualification remains open |
| Local tool execution | Runs on the client under the selected host/sandbox profile |
| Data sent by a tool to an external service | Disclosed to that destination; inference E2EE does not cover its use there |

NEAR's [published agent-loop example](https://github.com/nearai/nearai-cloud-verifier/blob/main/py/encrypted_agent_loop_verifier.py)
uses `X-Encrypt-All-Fields: true` with encryption version 2 and describes encryption
of tool names, arguments, definitions, reasoning and search-result output. Its
server-side search loop is described as running in the confidential VM, with the
query sent to Brave over TLS. This is source evidence checked on 2026-10-14,
not a fresh live test or qualification of every model. The example retrieves a
key from an attestation report; that operation alone is not cryptographic
verification of the key.

Adopting native encrypted tools requires verified key binding, complete field
coverage in both directions, response integrity checks, and refusal of plaintext
or unsupported protocol fallback. Keep the current encrypted-text path until
those properties are qualified. See [integration issue 73](https://github.com/amiller/abalone/issues/73),
[parser issue 56](https://github.com/amiller/abalone/issues/56), and the
[research thread](https://github.com/amiller/awesome-private-inference/issues/23).

## Bounded session lifetime and expiry

An adapter session is a bounded monotonic window set at opening — default 60 seconds,
at most five minutes. It cannot be extended. On expiry the adapter aborts active work
through its deadline signals, closes the pinned transport and drops the credential.
Repeated requests never reuse an expired admission: any later call fails with
`provider_admission_expired` before contacting any host.

Expiry does not consume or invalidate the delivered credential. Reusing the same
already-delivered credential means opening a fresh adapter — a fresh attestation
nonce, report and admission — not another coupon claim and not new recipient or
delivery keys. The issuer's delivered envelope remains replayable under the version 4
terms regardless of this window. The broker (below) explains exactly this to a caller
that hits expiry.

## Recipient credential broker

`couponNearCredentialBroker({ socketPath, adapter, ... })` connects the adapter to the
selected child process the same way the synthetic session broker does: a mode-0600 Unix socket
in an unused, user-owned private directory is the only thing that crosses into the
child, with the placeholder authorization. The raw provider key stays in the launcher
process inside the adapter; the broker itself never holds it. Only
`POST /v1/chat/completions` is served; the adapter independently re-pins endpoint,
model, auth and request shape. Requests and answers are size-bounded with absolute
deadlines and bounded concurrency. Upstream conditions become stable states
(`credit_exhausted`, `access_revoked_or_expired`, `provider_unavailable`,
`provider_response_refused`); raw coupon/credential echoes in answers are removed.
This is not a defense against a malicious provider's covert encoding of secrets.
Closing the broker aborts pending work, destroys sockets, removes the socket file and
closes the adapter, which drops the credential.

An inference failure never issues another credential or uses an alternate key. A
possession-of-socket capability is not sealing against the host or proof that
arbitrary sandbox code cannot use it.

## Synthetic testing boundary

`openCouponNearAdapterForTesting` is a separately named factory whose admission verdict
must be explicitly synthetic — its exact shape cannot carry a genuine verification
result — while every runtime bound above stays fully enforced. It exists so the
post-admission runtime (both-direction encryption, sanitization, expiry, broker
discipline) is tested offline with real provider code and synthetic prompt content.
Full admission cannot be replayed offline at all: the attestation nonce is fresh per
admission and the quotes are genuine bytes, so a recording only verifies against its
own nonce. A future bounded staging drill against the real service will use this
adapter unmodified with synthetic prompt content under an explicitly authorized,
budgeted task; the fixture path does not qualify live service behavior.

## Service staging manifest coordination

Staging admission uses a signed, independently pinned manifest with an exact
versioned approval schema. The client validates it in
`lib/coupon-staging.mjs` (`verifyCouponStagingAdmission`), verified against vectors the
service's own fixture signed — not a boolean and not an always-refuse wrapper. The
approval envelope is `{domain, payload, signature_hex}` with domain
`dsmack-coupon-staging-approval-v1` and an Ed25519 signature over the domain, a NUL,
and canonical ASCII JSON, checked against the approval root the service compiles into
its measured image (`packaging/coupon/approval-root.json`); the recipient pins that
root independently. This is the legacy TDX/version 1 Sepolia payload:

```js
{ "version": 1, "profile": "debug-staging", "app_id": "<40 hex>",
  "compose_hash": "<64 hex>", "identity_policy_sha256": "<64 hex>",
  "issuance_policy_sha256": "<64 hex>", "issuer_public_key_sha256": "<64 hex>",
  "provider_scope_commitment": "<64 hex>",
  "guard": { "chain_id": 11155111, "address": "0x<40 hex>",
             "code_hash": "0x<64 hex>", "issuer_address": "0x<40 hex>" },
  "powers": ["operator-secret-access", "application-exec", "debugger", "host-clock"],
  "prompt_policy": "synthetic-only",
  "max_coupon_nano_usd": "<positive int63 decimal, 1-19 digits, <= 2**63-1>",
  "max_total_nano_usd": "<same domain; max_coupon <= max_total>",
  "expires_at": "<ISO-8601 Z>", "generation": 1 }
```

The current Mac profile uses envelope domain `dsmack-coupon-mac-approval-v1`.
Its payload has `version:2`, adds exactly `issuer_profile:"mac-appattest-coupon-v1"`
and a lowercase 64-hex `cdhash`, and uses an application identifier matching
`[A-Za-z0-9:_./|+-]{1,200}` rather than the TDX 40-hex app id. Other payload fields
and fixed ordered `powers` are unchanged. Domain, payload version and profile
must agree; a valid signature does not permit unknown or extra fields.

Both identity variants accept either the legacy Sepolia guard shown above or
chain 8453 with these exact additional Base guard confirmation fields:

```js
confirmation: {
  version: 1, profile: "base-mainnet-rpc-safe-debug-v1", block_tag: "safe",
  rpc_url: "https://mainnet.base.org", trust: "configured-rpc",
  l1_finality_verified: false, reorg_action: "quarantine-no-retry"
}
```

For Base, each coupon and the aggregate approval cap are at most 5000000000
nanoUSD. The recipient verifies the signed descriptor, not independent chain
state or Ethereum L1 finality. `generation` is a positive safe integer and
`expires_at` must be a future UTC timestamp. Exact validation lives in
`lib/coupon-staging.mjs`; signed Mac and TDX negatives are exercised by
`tests/mac-coupon-issuer.test.mjs` and `tests/coupon-staging.test.mjs`.

Genuine hardware identity is stated, never inferred: the manifest binds the app id,
compose hash and issuer key hash the service proves over `/dsmack/coupon/issuer/2`,
and the client cross-checks those pins against its own identity admission. The powers
are an exact allowlist — debug staging permits operator secret access — so a verified
manifest can never claim private issuance, rollback qualification or settlement
approval; the verifier's typed verdict states `operatorSecretAccess: true` alongside
`privateIssuance/rollback/settlement: false`, and broader private-inference qualification
requires a restrictive custody profile. The companion
`dsmack-coupon-staging-config-v1` envelope (approval hash, peers, provider account,
finality profile) is operator-side and carries provider secrets, so recipient code
never consumes it. The fixture vectors in `tests/fixtures/coupon/staging/` are signed
by the service's published test root — not the measured image root and not a staging
authority — and the exact field set is enforced by `lib/coupon-staging.mjs` and must match the issuer implementation.

## Evidence

```sh
node --test tests/coupon-near.test.mjs
node --test tests/coupon-staging.test.mjs
node --test tests/g8-offline.mjs
DSMACK_CODE_DIR=/absolute/path/to/dsmack-code node tests/coupon-attested-e2e.mjs
DSMACK_CODE_DIR=/absolute/path/to/dsmack-code node tests/coupon-attested-async-e2e.mjs
```

Focused tests cover profile immutability; wrong model, authorization, endpoint or
pre-aborted requests refusing before any upstream move; admission fetch discipline
(no redirects, sanitized failures, close aborting admission); the admitted runtime
(prompts decrypted only with the attested model key, answers decrypted with the fresh
client key, upstream statuses and tampered or cleartext answers refused, caller abort
sanitized); expiry dropping admission without reuse; the same delivered credential
serving again through a fresh adapter and broker; and the broker's socket capability,
placeholder-auth pinning, size bounds, expiry explanation and cleanup. The g8 offline
suite adds the strict-profile negatives against the recorded attestation (required
NVIDIA signature, refused OutOfDate gateway TCB); and the signed staging admission
against service-fixture vectors (valid, expired, altered powers, production profile,
tampered bytes, wrong root, non-canonical encoding, operator-config domain refused).
The paired issuer E2Es require the dsmack service checkout: the synchronous one covers
the /4 claim path, and `tests/coupon-attested-async-e2e.mjs` drives the service's real
`AsyncCouponServiceV4` over genuine local Noise peers — an accepted claim answering
exactly `in_progress`, bound winner status, unbound refusal, a polling deadline that
stays `claim_pending` with no provider-key creation, grant delivering through the
original keys with exactly one provider create, delivered replay, and restart with an
unresolved job requiring reconciliation. These are local synthetic results with
no hardware, custody, live-provider, chain, gas, VPN or deposit qualification.

Coupon sessions disable SDK and agent automatic retries, automatic compaction,
and background cache warming. Project settings and runtime toggles cannot
re-enable those automatic requests while the coupon socket is active. A failed
request may already have been charged; a later explicit user request is a new
request, not proof that repeating the earlier one is safe. Tool continuations
requested by the model remain part of normal work and may make further requests.
