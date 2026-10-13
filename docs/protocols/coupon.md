# Coupon redemption protocol

Dsmack defines four coupon versions. Their accepted terms, recipient bindings
and delivery domains are incompatible by design. The client implements only
version 4, with explicit signed debug-staging authority. The issuer still serves
versions 1 to 3 for older clients; this client has no implementation of them, and
its version 4 requests for their coupons are refused. They are described here
because version 4 builds on their terms.
[Getting started](../getting-started.md) is the user path; the
[development gift trial](../gift-trial.md) specifies source-wrapper inputs.

Issuer identity is not private credential custody, rollback safety or settlement
approval. Inference goes directly to the admitted provider after credential
delivery; the issuer is not a prompt relay. See [security profiles](../security.md).

| Version | Client implementation | Recipient binding | Issuer evidence |
| --- | --- | --- | --- |
| 1 | Removed | Protected preauthorized subject and delivery key | Experimental peer/service evidence |
| 2 | Removed | Preauthorized subject plus exact accepted offer | Explicit local-unattested fixture |
| 3 | Removed | Atomic first authenticated bearer, Noise peer and delivery key | Explicit local-unattested fixture |
| 4 | `lib/coupon-attested.mjs` | Same winner/keys plus exact issuer policy and signing-key commitments | Fresh TDX or Mac identity; live debug staging is separately signed |

Amounts in these offers are canonical integer nanoUSD strings. A nominal provider
limit is not a reserved purse or verified remaining balance. An ambiguous create
must not trigger a replacement credential; lost recipient private keys do not
have qualified transparent recovery.

## Version 1 compatibility

### Authenticated service callback

`servePeer({services})` retains existing `fn(lp, send, recv)` JSON callbacks and
adds a fourth immutable argument from the actual Noise connection:

```js
{ remotePeer, localPeer, protocol, authenticated: true, transport: "noise" }
```

The remote PeerId authenticates possession of its transport key. It establishes
neither application roles nor measured code identity. Request fields never alter
the context. Each service handler requires an authenticated Noise connection;
missing identities are refused before its callback runs.

Descriptors support `{handle, maxDataLength, raw, timeoutMs}`. `raw: true`
preserves bytes for strict parsers, including duplicate JSON keys. Frame bounds
apply before reading the payload and to callback replies. `timeoutMs` sets a
deadline covering the callback and stream close; expiry aborts the stream.
Service failures abort with a generic error and never log their exception text.
Existing functions retain the 40 MiB limit and JSON framing. Handlers may still
receive `lp`; its use is trusted host code and can bypass callback reply checks.

The experimental dsmack mount uses `/dsmack/coupon/1`, raw framing, a 64 KiB
limit and a configured deadline. Its anonymous-pipe worker maps the authenticated
peer through protected operator configuration to a subject and roles. Coupon
wire frames cannot select that mapping, provision a coupon, or supply provider
management/reporting credentials. Production still requires admission, rate
policy and qualified issuer/observer attestation.

## Version 2 prebound offers

### Exact v2 offer

`/dsmack/coupon/2` runs beside unchanged `/dsmack/coupon/1` operations. The protected
dsmack worker stores each coupon's protocol version and refuses cross-protocol
redemption. Authorization comes from the Noise connection and protected peer to
subject/role mapping. Its configured issuer PeerId is durably pinned and must
match the connection's actual local peer.

The authorized `offer` operation returns `{offer, offer_hash}` with exact fields:

| Offer field | Required value or meaning |
| --- | --- |
| `version` | Integer 2 |
| `coupon_digest` | SHA-256 of the coupon, lowercase hex |
| `issuer` | Exact `{peer_id, policy}`; policy is `experimental-local-unattested` |
| `provider` | Exact `{id, scope_commitment}`; ID `near` or `synthetic-near` |
| `recipient_subject` | Opaque previously authorized service subject |
| `delivery_profile` | `x25519-aesgcm-session-only` |
| `budget_nano_usd` | Canonical positive decimal string, at most 9223372036854775807 |
| `cap_semantics` | `nominal-provider-limit`; provider enforcement is not qualified here |
| `claim_expires_at` | UTC `YYYY-MM-DDTHH:MM:SSZ`, calendar years 1 through 9999 |
| `provider_expires_at` | Null; upstream expiry is not established |
| `sponsor_powers` | Fixed ordered array `["revoke", "change_limits"]` |

The provider/account scope commitment uses a persisted random service salt and
protected provider binding; raw account identifiers and management/reporting
tokens do not appear in the offer. The commitment is stable for that service
scope and can correlate its offers. It is not independent provider certification.

Canonical JSON recursively sorts object keys, preserves array order, has no
whitespace, uses the restricted ASCII schema and contains no floating numbers.
`offer_hash` is SHA-256 of `dsmack-coupon-offer-v2\0` followed by those bytes.
Decimal strings preserve budget precision across JavaScript and Python.

### Authenticated delivery

Claim wire fields are exactly `id`, `op`, `coupon`, `recipient_key`, `offer_hash`.
Before a provider effect, dsmack checks the accepted hash and recipient grant.
Encrypted delivery keeps the v1 X25519/HKDF/AES-GCM crypto wrapper; its authenticated
data is exact canonical JSON `{domain:"dsmack-coupon-delivery-v2", version:2,
offer_hash, coupon_digest, key_id, recipient_key_sha256}`. Altering provider scope,
issuer policy, terms or recipient changes the authenticated binding.

### Expiry, status and observation

The issuer enforces claim expiry before `ready` transitions to `issuing`. Already
delivered same-key/same-offer replay remains permitted after claim expiry, including
through a worker restart. A different delivery key or accepted hash is refused.
Claim expiry does not extend or establish a provider credential's lifetime.
An interrupted or ambiguous issuance never triggers automatic reissuance.

Authorized `status` returns exact state `ready`, `delivered` or
`reconciliation_required`, plus boolean `claim_expired`, `accounting_blocked`,
`automatic_retry_allowed:false`, `deposit_release_authorized:false`. A delivered
state includes a valid `key_id`; ready omits it. Persisted `issuing`/quarantined
state maps to reconciliation required because this serialized worker cannot
offer an independently observed live-progress state. Denied/malformed requests
keep the generic `request_failed` envelope. Status never returns a secret or
encrypted delivery.

An authorized observer obtains a v2 signed local observation with accepted
`offer_hash`, coupon/key/delivery/recipient commitments, requested window and
verifier-originated challenge. Threshold and cumulative reported usage are decimal
strings; the cumulative total is a canonical nonnegative value of at most 39 digits.
The embedded public key alone supplies no trusted signer provenance.
Even a separately pinned local key is not attested policy; replay tracking,
freshness/finality and deposit release remain outside this experiment.

## Version 3 accountless claims

### Stable offer and one winning recipient

`/dsmack/coupon/3` is separate from existing v1 and prebound v2 coupons. Its exact
[version 2 offer schema](#version-2-prebound-offers) replaces `recipient_subject` with
`claim_policy:"first-authenticated-bearer"`, changes `version` to 3, and hashes
canonical bytes under `dsmack-coupon-offer-v3\0`. Common provider/issuer commitments,
decimal amounts, nominal cap semantics, sponsor powers and expiry rules are
unchanged. The offer hash is stable; it never incorporates a mutable winner field.
Each stored coupon is restricted to its protocol version.

Any actual Noise-authenticated peer holding an unclaimed coupon can inspect its
offer/minimal ready status and attempt a claim. The protected worker derives this
recipient identity from the connection; no registration is needed. Wire fields
cannot choose a peer, subject or roles, and this path grants no sponsor or observer
authority. The gift code is a bearer capability before claim: theft or forwarding
before binding can let someone else win. The experiment does not prevent that risk.

After validating the X25519 key, one `BEGIN IMMEDIATE` transaction checks the accepted
offer and expiry before provider issuance, reserves the authenticated peer and delivery
key, updates the recipient grant, and stores durable `issuing` intent. A competing
claim cannot reserve or create a second key. Provider work happens after that
transaction commits. The delivery then authenticates the reserved identities.
An interrupted/ambiguous creation retains its original winner and stays
nonretryable; restarting does not reset an unacknowledged coupon to unclaimed.

Once reserved, only the winner or protected sponsor/observer can inspect offer
and status. Losing holders get the generic failure envelope and no delivery,
state detail or rebinding path. Sponsor/observer roles alone do not retrieve the
winner's envelope: claim still checks the reserved peer and delivery key.

### Delivery

Delivery uses the same crypto wrapper as v1/v2, with canonical authenticated data:

```js
{ domain: "dsmack-coupon-delivery-v3", version: 3,
  offer_hash, coupon_digest, key_id, recipient_key_sha256,
  recipient_peer_sha256 }
```

The peer commitment is SHA-256 of `dsmack-coupon-recipient-peer-v3\0` followed by the
actual ASCII PeerId of the authenticated winner, not a peer claimed in a frame or
envelope. Another peer therefore cannot substitute the winner's name while retaining
the same delivery key. Voluntary transfer of all key material or the resulting
provider bearer secret remains outside that guarantee.

Lost acknowledgements and issuer-worker restarts permit replay only to the same
winner, delivery key and accepted offer. Delivered replay remains possible after
claim expiry; a new claim after expiry is refused. Provider expiry remains null,
meaning no upstream-expiry promise. Losing either local private key is not
transparently recoverable.

### Status, observer and direct use

Authorized status keeps v2's strict `ready`, `delivered`, `reconciliation_required`
states and its `claim_expired`, `accounting_blocked`, false automatic retry and
false deposit-release fields. Delivered includes a valid key ID. It returns
neither plaintext credential nor encrypted envelope.

The v3 local observation authenticates the stable offer hash and adds the winning
`recipient_peer_sha256` to the existing key, recipient-key and delivery commitments.
The verifier must supply the expected winner's actual PeerId, its own challenge
and accepted offer; it can also pin the observer public key and exact delivery.
A self-contained signature establishes only integrity, and even a separately
pinned local key does not qualify measured observer provenance. Accounting and
deposit release remain local-unattested/fail-closed.

Ordinary provider/model admission still applies to a delivered credential. This synthetic path does not establish
that a real sponsor's provider account-owner APIs cannot retrieve issued secrets.
Neither inference prompts nor provider credentials need travel through dsmack.

## Version 4 issuer-bound claims

### Identity before bearer material

`lib/coupon-attested.mjs` exposes `couponAttestedClient(peerAddr, options,
transportOptions)`. Protected local options contain the exact identity policy,
its expected SHA-256, the independently expected issuance-policy SHA-256, and
optionally the expected SHA-256 of the issuer's raw Ed25519 public key. The client
copies these options before connecting; subsequent caller mutation cannot change
its pins. The actual Noise connection must authenticate the PeerId in the dial
address. Generic development peer evidence cannot satisfy issuer identity.

The public `info` request carries no coupon. Its exact result is:

```js
{ version: 2, issuer_public_key_hex,
  identity_policy_sha256, issuance_policy_sha256 }
```

Discovery is untrusted. The client checks its protected pins, then creates a
fresh verifier-owned binding for the actual authenticated issuer peer and that
specific public key. The `evidence` request carries only this binding:

```js
{ version: 2, peer_id, public_key_hex, challenge_hex, policy_sha256 }
```

The reviewed verifier authenticates genuine Intel DCAP evidence, approved boot
measurements and runtime event preimages, the exact compose hash, the fresh
challenge, the actual Noise PeerId, and possession of the quoted signing key.
Its policy includes the approved runtime app-id, key-provider and OS-image hash.
A quoted policy hash is a binding to the requested identity policy; it does not
prove that the issuer enforces a separate issuance policy.

The normal client can complete this identity probe and expose its typed verdict.
**Every normal coupon operation still refuses before inspecting or serializing
bearer material**, with `custody_policy_unqualified`. Even a successful genuine
identity verdict retains `privateIssuanceQualified:false` and
`rollbackQualified:false`. No boolean option, caller callback or service-discovered
issuance hash grants production approval. The real recipient adapter is the [NEAR recipient adapter](near-adapter.md) — must consume an
independently reviewed custody capability backed by the exact measured code and
configuration authority, provider-owner behavior, KMS/recovery obligations and
rollback enforcement. Signed debug staging is a separate explicit capability; it permits operator access and does not grant production custody approval.

The identity verifier is [vendored from a pinned reviewed source](../../lib/vendor/dstack-issuer/README.md).
Abalone adapts only worker dependency lookup to its existing
`aci/verifier-ts` package and requires `@phala/dcap-qvl` 0.6.6. The genuine quote
worker has a bounded lifetime, minimal environment and actual process termination
on timeout or abort; collateral and provider errors are replaced with stable
messages. Neither the policy nor test reports are a production allowlist.

### Exact version 4 terms and delivery

Existing `/1`, `/2` and `/3` remain separate and unchanged. The v4 offer retains
[accountless first-bearer semantics](#version-3-accountless-claims) and common
[offer terms](#version-2-prebound-offers), changes `version` to 4, and replaces
its issuer object with:

```js
{ peer_id, policy: "dstack-tdx-coupon-v1",
  identity_policy_sha256, issuance_policy_sha256,
  issuer_public_key_sha256 }
```

The issuer key commitment is SHA-256 of the raw 32-byte public key verified during
identity admission. All three commitments must match retained, pinned discovery.
The exact authoritative offer is hashed as SHA-256 of
`dsmack-coupon-offer-v4\0` followed by recursively sorted ASCII JSON. The client
retains a deeply frozen accepted offer with its actual local Noise PeerId. A
copied offer or another client's accepted bundle cannot select a different winner.

A v4 `delivery_profile` is either `x25519-aesgcm-session-only` or
`x25519-aesgcm-recipient-v1`. Both use the delivery format below; the label is part of
the hashed offer. Session-only recipients accept only the first label. `abalone credit`
saves the original Noise seed, X25519 key and delivered credential in private user
files, and accepts only `x25519-aesgcm-recipient-v1`. It refuses a session-only offer
before claim. `credit recover` reads bound status first with the same keys: `ready` inside the
claim window is retried once per explicit recover, `in_progress` is polled without a
claim, and `delivered` is retrieved from the same winner. `claim_expired`,
`reconciliation_required` and `accounting_blocked` are terminal; nothing is resent. The signed staging approval selects the profile:
an absent `delivery_profile` means session-only, and the only explicit value is
`x25519-aesgcm-recipient-v1` (other values and unknown fields refuse). The client
names its profile at connection; it must equal the approval's and every offer's.
Durable credit requires the explicit durable approval, and session-only entries refuse it.

Delivery authenticates canonical JSON:

```js
{ domain: "dsmack-coupon-delivery-v4", version: 4,
  offer_hash, coupon_digest, key_id, recipient_key_sha256,
  recipient_peer_sha256 }
```

The recipient peer commitment uses
`dsmack-coupon-recipient-peer-v4\0` followed by the actual ASCII PeerId. The helper
reconstructs the commitments from its own public key and retained offer metadata.
The crypto wrapper remains version 1, with the existing X25519/HKDF/AES-GCM format;
its authenticated data selects the v4 offer profile. Unknown or extra fields,
noncanonical budgets, stale hashes, malformed dates and changed issuer terms
refuse. Claim expiry gates a new reservation; a delivered same-peer/key/hash replay
remains permitted after claim expiry. Provider expiry stays null and promises no
upstream expiry or balance. Stored protocol guards prevent old endpoints from
bypassing these terms.

The v4 local observation binds the accepted offer hash and winning peer, key and
delivery under `dsmack-coupon-observation-v4`. It retains local-unattested provenance
and false deposit authorization. Signature integrity, a supplied local observer
key, and issuer identity admission each remain distinct from qualified observer,
private issuance or settlement approval.

### Asynchronous claim status

An accepted claim is no longer guaranteed to return the delivery synchronously: while
the issuer's current-process job waits for finalized guard consumption it answers
exactly `{ state: "in_progress", automatic_retry_allowed: false,
deposit_release_authorized: false }`. Both claim shapes are checked against the exact
shared schema — never a permissive catch-all parser — and unknown or extra fields
refuse as before. The winner's status request binds the original `recipient_key` and
`offer_hash` alongside the coupon and the authenticated Noise peer; only that bound
form may report `in_progress`. Polling never initiates or reconstructs issuance: it
re-reads status, and a delivered state replays exactly the original key/hash delivery.
After an issuer restart, unresolved issuance surfaces as `reconciliation_required`,
which the client reports as an operator action — it never retries into a live job and
never requests a replacement.

`awaitDelivery(coupon, recipient, accepted, ...)` wraps this loop for the session UX.
It is only valid after this client actually sent a claim with those keys (a lost
acknowledgement may still have reserved the winner; the attempt is recorded before
sending). It polls with bounded intervals under an absolute caller-abortable deadline;
on deadline it reports `claim_pending` with explicit same-key recovery guidance instead
of an ambiguous failure. `claim_not_reserved` means the claim never landed and the
original request may be retried with the same keys; `claim_expired` means the bound
winner window closed before delivery — an expired unclaimed gift, not a retryable
miss; `claim_reconciliation_required` means operator reconciliation is required
first. A caller abort or closing the client rethrows what happened; only a polling
deadline leaves the claim genuinely uncertain and reports `claim_pending`.

### Lifetime, bounds and explicit synthetic profile

An expired identity is refreshed with a new challenge on the retained connection
before another coupon frame. Discovery key or policy changes refuse refresh.
Starting a refresh clears the previous public verdict, and bearer requests wait
for that refresh even if its original lifetime has not expired. A failed refresh
leaves the identity unverified. A later
attempt must verify fresh evidence against the original pins before proceeding.
Requests have absolute abortable deadlines; issuer frames are bounded to 2 MiB
and coupon frames to 64 KiB. Closing aborts streams and verifier workers, stops
the peer and prevents a late identity refresh from reviving the client. Errors do
not include raw wire payloads or quote/provider failures.

`couponAttestedClientForTesting` is a separately named, direct-loopback-only
factory. Its verifier always returns `synthetic-only-not-hardware`; it accepts
only `synthetic-near` offers and never grants custody or rollback qualification.
The dsmack test executable injects a synthetic quote collector and authorizer,
which refuse real-provider configuration. Protected policy hashes by themselves
cannot enable this service authorization. The normal verifier rejects its JSON
report bytes as non-Intel quotes.

The helpers retain Noise and X25519 keys in memory and return the decrypted
credential only to recipient code. The separately selected provider adapter and
launcher implement credential-broker, retention and consent behavior. Preserve
explicit consent, nonreplacement, admission and retention boundaries. Provider/model
attestation and the [host VPN boundary](../gift-trial.md#separate-later-portable-agent-and-node-provided-vpn-milestone) remain independent
requirements; issuer identity is no substitute for either.

## Current Mac issuer profile

Version 4 also admits `mac-appattest-coupon-v1` through
`lib/mac-coupon-issuer.mjs`. The policy declares `custody:"operator-kms-readable"`
and pins application identity, approved measurements and challenge/enrollment
bounds. Its verifier checks fresh runner evidence, compose and issuer-key
possession on the actual retained Noise connection. The offer's issuer policy
must match the selected profile; it cannot be substituted with the TDX policy.

Apple code identity does not establish confidential workload or secret custody
against the Mac host or stand-in KMS. Signed debug-staging approval explicitly
permits those operator powers. Production private issuance, rollback and deposit
settlement remain unqualified. See [the selected trust profile](../security.md).

## Verification entry points

Exact field validation, version separation, changed-offer refusal, winning-peer
binding, replay without new issuance, expiry and asynchronous same-key delivery
are exercised by `tests/coupon*.test.mjs`. The shared synthetic offer vector is
`tests/fixtures/coupon/offer-v4.json`.
The separately named testing factories reject live-provider authority.

Paired Noise E2E checks need an explicitly selected Dsmack source checkout:

```sh
DSMACK_CODE_DIR=/absolute/path/to/dsmack-code node tests/coupon-attested-e2e.mjs
DSMACK_CODE_DIR=/absolute/path/to/dsmack-code node tests/coupon-attested-async-e2e.mjs
```

These fixtures do not qualify live hardware, provider custody, chain finality,
funding, VPN anonymity or settlement. Record the exact client and service revisions
when using their results. [NEAR adapter](near-adapter.md) describes inference
admission, the local broker and signed staging approval independently of issuance.
