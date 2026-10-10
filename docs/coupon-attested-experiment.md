# Connection-bound issuer identity and policy offers

This adds `/dsmack/coupon/issuer/2` discovery and a fresh identity challenge on the
same retained Noise connection used by `/dsmack/coupon/4`. It connects the reviewed
dstack identity verifier to an accountless offer, encrypted delivery and local
observation. The runnable interoperability profile is explicitly synthetic. It
does not qualify the [public preview](gift-public-preview.md) or enable a live
provider credential.

## Identity before bearer material

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
issuance hash grants production approval. The next live adapter — the current draft is
the [strict NEAR recipient adapter](coupon-near-adapter.md) — must consume an
independently reviewed custody capability backed by the exact measured code and
configuration authority, provider-owner behavior, KMS/recovery obligations and
rollback enforcement. There is no approved live capability in this change.

The identity verifier is [vendored from a pinned reviewed source](../lib/vendor/dstack-issuer/README.md).
Abalone adapts only worker dependency lookup to its existing
`aci/verifier-ts` package and requires `@phala/dcap-qvl` 0.6.6. The genuine quote
worker has a bounded lifetime, minimal environment and actual process termination
on timeout or abort; collateral and provider errors are replaced with stable
messages. Neither the policy nor test reports are a production allowlist.

## Exact version 4 terms and delivery

Existing `/1`, `/2` and `/3` remain separate and unchanged. The v4 offer retains
[accountless first-bearer semantics](coupon-accountless-experiment.md) and common
[offer terms](coupon-offer-experiment.md), changes `version` to 4, and replaces
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

## Asynchronous claim status

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

## Lifetime, bounds and explicit synthetic profile

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

The helper retains Noise and X25519 keys in memory and deliberately returns the
decrypted credential to recipient code. It neither installs a credential nor
chooses permanent retention or restart recovery. The existing
[synthetic recipient command](coupon-recipient-session.md) continues to use its
v3 experimental profile; this change does not silently promote that UX to an
attested release. A future approved provider adapter must preserve explicit
consent, nonreplacement, admission and retention boundaries. Provider/model
attestation and the [host VPN boundary](vpn-qualification.md) remain independent
requirements; issuer identity is no substitute for either.

## Evidence

```sh
node --test tests/coupon-attested.test.mjs
DSMACK_CODE_DIR=/absolute/path/to/dsmack-code node tests/coupon-attested-e2e.mjs
DSMACK_CODE_DIR=/absolute/path/to/dsmack-code node tests/coupon-attested-async-e2e.mjs
```

Focused tests exercise exact terms, issuer peer/key/policy/challenge and signature
substitution, another client's acceptance, genuine-verifier rejection of synthetic
reports, immutable caller pins, identity expiry and refresh on one connection,
changed discovery, closing during quote verification, frame limits and actual
stream deadlines, and pending-claim polling that retains the winner key/hash,
cancels actual reads and never initiates or reconstructs issuance.

The paired fixture uses the dsmack explicit synthetic worker, actual local Noise
peers and the [shared v4 vector](../tests/fixtures/coupon/offer-v4.json). Both
recipients are absent from its configured ACL. Exactly one concurrent first claim
wins and one synthetic provider key is created. The winner replays after issuer
restart and claim expiry, losers cannot access the offer/status/envelope, and the
fixture checks `/1`–`/3` compatibility and cross-protocol refusal. It performs a
direct loopback inference, verifies a signed offer/winner-bound observation, and
checks coupon-service traffic and error logs for secret and prompt canaries. It
prints only summary outcomes and removes disposable state. A second paired fixture
(`tests/coupon-attested-async-e2e.mjs`) drives the same client against the service's
real `AsyncCouponServiceV4` over genuine local Noise peers, holding the service's
forked issuance job with a gate-file authorization double: an accepted claim answers
exactly `in_progress`, bound winner status reports the live job, unbound status is
refused, a polling deadline stays `claim_pending` without provider-key creation,
grant delivers through the original keys with exactly one provider create, and a
restart with an unresolved job requires reconciliation. These are local
synthetic results, with no hardware, custody, live-provider, chain, gas, VPN or
deposit qualification.
