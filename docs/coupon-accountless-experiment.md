# Accountless atomic claim experiment

This advances the atomic first-bearer requirement in the
[public preview contract](gift-public-preview.md) through a local synthetic peer
and client experiment. Two recipients need no account, registration or pairing.
It does not qualify the full preview: public acquisition, measured private issuance,
provider custody, credential installation, retention, VPN behavior, sponsored
transactions and independently verified deposit release remain separate gates.

## Stable offer and one winning recipient

`/dsmack/coupon/3` is separate from existing v1 and prebound v2 coupons. Its exact
[offer schema](coupon-offer-experiment.md) replaces `recipient_subject` with
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

## Client identity and delivery

`lib/coupon-accountless.mjs` exposes `couponAccountlessClient`,
`couponAccountlessRecipient`, exact offer validation, recipient peer hashing and
local observation verification. The client creates a Noise identity unless the
caller explicitly injects an existing private key. The recipient object separately
holds a generated X25519 private key in its closure. Both objects belong to the
current in-memory session; no account, credential slot or persistence is created.

The client admits the pinned service's existing evidence before sending coupon
frames. `client.offer(coupon)` returns a deeply frozen authoritative bundle, retained
with that client's actual local PeerId. The caller passes it explicitly to
`client.claim(coupon, recipient, accepted)`. A different client's offer or a copied
bundle cannot replace this acceptance. Reconnecting callers can refetch with
`{expectedHash: previous.offer_hash}` to refuse changed terms.

Delivery uses the same crypto wrapper as v1/v2, with canonical authenticated data:

```js
{ domain: "dsmack-coupon-delivery-v3", version: 3,
  offer_hash, coupon_digest, key_id, recipient_key_sha256,
  recipient_peer_sha256 }
```

The peer commitment is SHA-256 of `dsmack-coupon-recipient-peer-v3\0` followed by the
actual ASCII PeerId. The recipient helper reconstructs it from privately retained
client metadata, not from a claimed peer in a frame or envelope. It checks the
accepted offer, coupon, result key ID and its own public key before decrypting.
This prevents another peer from substituting the winner's name while retaining
the same delivery key. Voluntary transfer of all key material or the resulting
provider bearer secret remains outside that guarantee.

Lost acknowledgements and issuer-worker restarts permit replay only to the same
winner, delivery key and accepted offer. Delivered replay remains possible after
claim expiry; a new claim after expiry is refused. Provider expiry remains null,
meaning no upstream-expiry promise. Losing either local private key is not
transparently recoverable. These helpers choose no automatic replacement, permanent
retention, secure-erasure guarantee or UI policy.

## Status, observer and direct use

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

Successful decryption returns a provider credential deliberately to recipient
code for direct use. It is never installed or logged by the helper. Ordinary
provider/model admission still applies. This synthetic path does not establish
that a real sponsor's provider account-owner APIs cannot retrieve issued secrets.
Neither inference prompts nor provider credentials need travel through dsmack.

## Synthetic evidence

```sh
node --test tests/coupon-accountless.test.mjs tests/coupon-offer.test.mjs tests/coupon.test.mjs tests/p2p-services.test.mjs
DSMACK_CODE_DIR=/absolute/path/to/dsmack-code node tests/coupon-accountless-e2e.mjs
```

Both repositories carry the visibly synthetic
[v3 vector](../tests/fixtures/coupon/offer-v3.json). Unit checks cover its exact
canonical bytes, decimal precision, malformed terms, wrong issuer, strict replies,
wrong recipient and peer AAD, and another client's accepted bundle.

The real local Noise harness leaves both recipients out of the protected ACL and
races their claims: exactly one wins and one provider key is created. It denies
loser envelope/status/offer access, a new winner delivery key and identity spoof
fields. A second coupon loses its acknowledgement; independent SQLite polling
proves the abandoned request committed delivery before any retry. Both coupons
replay through restart without new creation. The fixture also tests expiry,
v1/v2 isolation and unchanged status behavior, direct loopback inference without
prompt/secret leakage to the coupon bridge, and winning-peer-bound observer
integrity. A separate Python executable fixture records one synthetic provider
create then raises, proving durable reconciliation and no retry after restart.
It changes no runtime failure flags or live provider configuration.

The harness prints only summary outcomes and removes disposable state. It does
not qualify a real issuer, provider, funded gift, VPN, chain, gas sponsor or deposit
return, and supplies no complete recipient command or public installation flow.
