# Strict real NEAR recipient adapter

Draft recipient adapter, 10 October 2026. `lib/coupon-near.mjs` connects a delivered
version 4 coupon credential to real NEAR AI inference: a selected provider profile,
fresh remote attestation before the first prompt byte, a pinned transport, model
end-to-end encryption and a sandbox-facing credential broker. It is client inference
code only. Issuance remains the separately gated
[attested issuer path](coupon-attested-experiment.md); nothing here qualifies private
issuance, rollback recovery, settlement, the [host VPN boundary](vpn-qualification.md)
or an installed release.

## Selected profile

The adapter accepts no inherited `providers.json` defaults. `validateCouponNearProfile`
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
same trust the [ordinary profile](../lib/near.mjs) documents. Admission collateral
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
A refused endpoint identity at the pinned transport is reported as `transport_refused`,
distinct from `access_revoked_or_expired`. Every failure is a stable code; upstream
text, collateral errors and wire payloads never surface.

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
sandbox child the same way the synthetic session broker does: a mode-0600 Unix socket
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

## Testing boundary and the future staging drill

`openCouponNearAdapterForTesting` is a separately named factory whose admission verdict
must be explicitly synthetic — its exact shape cannot carry a genuine verification
result — while every runtime bound above stays fully enforced. It exists so the
post-admission runtime (both-direction encryption, sanitization, expiry, broker
discipline) is tested offline with real provider code and synthetic prompt content.
Full admission cannot be replayed offline at all: the attestation nonce is fresh per
admission and the quotes are genuine bytes, so a recording only verifies against its
own nonce. A future bounded staging drill against the real service will use this
adapter unmodified with synthetic prompt content under an explicitly authorized,
budgeted task; this development handoff makes no live provider calls.

## Service staging manifest coordination

Staging admission of the dsmack service is a signed, independently pinned manifest, and
the service task now ships the exact schema. The client mirrors it in
`lib/coupon-staging.mjs` (`verifyCouponStagingAdmission`), verified against vectors the
service's own fixture signed — not a boolean and not an always-refuse wrapper. The
approval envelope is `{domain, payload, signature_hex}` with domain
`dsmack-coupon-staging-approval-v1` and an Ed25519 signature over the domain, a NUL,
and canonical ASCII JSON, checked against the approval root the service compiles into
its measured image (`packaging/coupon/approval-root.json`); the recipient pins that
root independently. The payload is exactly:

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

Genuine hardware identity is stated, never inferred: the manifest binds the app id,
compose hash and issuer key hash the service proves over `/dsmack/coupon/issuer/2`,
and the client cross-checks those pins against its own identity admission. The powers
are an exact allowlist — debug staging permits operator secret access — so a verified
manifest can never claim private issuance, rollback qualification or settlement
approval; the verifier's typed verdict states `operatorSecretAccess: true` alongside
`privateIssuance/rollback/settlement: false`, and the first private-inference release
still requires the restrictive target profile. The companion
`dsmack-coupon-staging-config-v1` envelope (approval hash, peers, provider account,
finality profile) is operator-side and carries provider secrets, so recipient code
never consumes it. The fixture vectors in `tests/fixtures/coupon/staging/` are signed
by the service's published test root — not the measured image root and not a staging
authority — and the exact field set remains owned by the service task's
`staging_approval.py`.

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
