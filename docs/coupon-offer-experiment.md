# Versioned accepted-offer binding experiment

This implements reusable offer, envelope and accounting binding primitives for
the [recipient contract](credential-redemption.md). It remains a prebound,
session-only synthetic fixture. The [public preview](gift-public-preview.md)
requires accountless first-bearer claim; this experiment does not satisfy that
release gate, choose a permanent identity model, or qualify a deployment.

## Exact v2 offer

`/dsmack/coupon/2` runs beside unchanged `/dsmack/coupon/1` operations. The protected
dsmack worker stores each coupon's protocol version and refuses cross-protocol
redemption. Authorization comes from the Noise connection and protected peer to
subject/role mapping. Its configured issuer PeerId is durably pinned and must
match the connection's actual local peer. The client independently checks it
against the service PeerId pinned in its admitted dial address.

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

## Explicit acceptance and authenticated delivery

`lib/coupon-offer.mjs` exports `couponOfferClient`, `couponOfferRecipient`, schema
validation, canonicalization and observation verification primitives. No UI,
credential slot or persistence policy is implemented. The client verifies existing
peer evidence before sending any coupon frame. Development admission is explicit;
neither existing edge evidence nor local signature integrity establishes an
approved private-issuance workload, key confinement or provider-account custody.

`client.offer(coupon)` validates the exact authoritative response and returns a
deeply frozen bundle retained by that client. The caller explicitly supplies this
bundle to `client.claim(coupon, recipient, accepted)`. A fabricated/cloned bundle,
one obtained from another client, or one for another coupon is rejected locally.
On reconnect, fetch again with `{expectedHash: previouslyAccepted.offer_hash}`
to refuse changed terms rather than silently accepting them.

Claim wire fields are exactly `id`, `op`, `coupon`, `recipient_key`, `offer_hash`.
Before a provider effect, dsmack checks the accepted hash and recipient grant.
Encrypted delivery keeps the v1 X25519/HKDF/AES-GCM crypto wrapper; its authenticated
data is exact canonical JSON `{domain:"dsmack-coupon-delivery-v2", version:2,
offer_hash, coupon_digest, key_id, recipient_key_sha256}`. The recipient helper
checks every binding against the retained offer, coupon, result key ID and its
own public key before returning the provider secret. Altering provider scope,
issuer policy, terms or recipient changes the authenticated binding.

The delivery private key remains in the recipient object's closure. The returned
secret belongs only in recipient code calling its provider directly. These helpers
do not log it, install it, overwrite another key, or bypass ordinary provider/model
admission. Losing the in-memory key loses recovery of that envelope. Forgetting,
secure erasure and upstream revoke behavior are not qualified.

## Expiry, status and observation

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
The client checks exact fields, accepted terms, challenge/window and signature
integrity. Callers can additionally pin `expectedPublicKey`, `keyId`, `recipientKey`
and `envelope`. The embedded public key alone supplies no trusted signer provenance.
Even a separately pinned local key is not attested policy; replay tracking,
freshness/finality and deposit release remain outside this experiment.

## Synthetic evidence

```sh
node --test tests/coupon-offer.test.mjs tests/coupon.test.mjs tests/p2p-services.test.mjs
DSMACK_CODE_DIR=/absolute/path/to/dsmack-code node tests/coupon-offer-e2e.mjs
```

The offline gate includes schema/hash/delivery checks, large and malformed decimal
budgets, invalid dates, changed issuer/provider terms, unknown fields, status and
AAD substitutions, and v1 compatibility. Both repositories carry the visibly
synthetic [canonical vector](../tests/fixtures/coupon/offer-v2.json).

The optional real local Noise integration compares those vectors and canonical
hashes, concurrently claims one v2 coupon, replays after restart and expiry, denies
an expired initial claim and both directions of cross-protocol redemption, then
claims a separate v1 coupon. Exactly two provider creations represent those two
successful coupons. It calls a direct loopback provider fixture with synthetic
content and verifies offer-bound observer integrity without sharing the prompt
or plaintext secret with the coupon bridge. The larger same-host fixture paces
connections under libp2p's ordinary admission limit. It prints summary outcomes
and removes disposable state. No live service, provider, VPN, funds or settlement
is exercised.
