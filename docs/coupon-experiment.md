# Experimental coupon peer primitives

This bounded local-test profile implements part of the
[recipient contract](credential-redemption.md), tracked in
the historical private peer-context and client-primitives planning issues.
Current public work belongs in the [Abalone backlog](https://github.com/amiller/abalone/issues).
It is not a completed recipient journey or a qualified issuer deployment.

## Authenticated service callback

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

## Client profile and delivery boundary

`lib/coupon.mjs` exports `couponClient(address, admit, {privateKey, timeoutMs})`
and `couponRecipient()`. The address must pin a service PeerId. Existing peer
evidence verification finishes before any coupon frame is sent. The client
opens no HTTP proxy and accepts no provider configuration in coupon requests.
It provides `claim`, `status`, `observe` and `close` methods. A grant is explicitly
prebound to an authenticated recipient subject: this is not first-bearer claim.

Tests explicitly admit development peers. Existing App Attest/runner admission
does not qualify this new issuer policy, key confinement or private issuance.
There is no production fallback policy or qualified attested issuer profile here.

`couponRecipient()` keeps a generated X25519 key in memory and exposes its public
key plus `decryptDelivery(coupon, result)`. Decryption checks the current v1
coupon-digest/key-ID AAD and AES-GCM integrity; the wrong recipient key cannot
decrypt it. The provider secret is returned deliberately to the calling recipient
code for direct provider use. Never log it or expose it to an outside setup agent.
Retries must retain the same recipient object. Losing that object loses recovery
of that envelope; this helper supplies no persistence or replacement policy.

The current envelope does not bind provider/account identity, issuer policy or a
verified offer. Those are shared interface gates, together with service discovery,
error/status mapping and retention. Credential installation, provider/model
admission, UI, existing-slot protection, exhaustion/revocation and forgetting are
not implemented by this experimental module. Signed local observation integrity
does not authorize deposit release.

## Synthetic verification

The ordinary offline gate includes these focused tests:

```sh
node --test tests/p2p-services.test.mjs tests/coupon.test.mjs
```

The optional two-repository integration requires a dsmack code checkout with the
experimental bridge and its Python cryptography dependency:

```sh
DSMACK_CODE_DIR=/absolute/path/to/dsmack-code node tests/coupon-peer-e2e.mjs
```

It provisions protected disposable configuration and state, starts real local
Noise peers, refuses a stolen token from another peer, preserves strict raw
frames, concurrently claims/decrypts delivery and replays it through a worker restart with one
provider issuance. A direct loopback provider fixture receives the synthetic
prompt and credential. The coupon bridge receives neither plaintext secret nor
prompt. An observer gets signed local-unattested accounting, with deposit release
disabled. Only summary outcomes are printed; disposable fixture state is removed.
No real provider, account, live peer or paid inference is involved.
