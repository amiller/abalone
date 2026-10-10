# Synthetic recipient session

The `abalone coupon-session` entry point connects the
[accountless claim experiment](coupon-accountless-experiment.md) to a usable
interactive session. It exercises offer consent, encrypted delivery, a session
credential slot, direct synthetic inference, recovery messages and forgetting.
It does not qualify gates 4 or 6 of the [public preview](gift-public-preview.md).

## Entry and issuer admission

The normal command refuses before reading a coupon or connecting to a peer:

```sh
abalone coupon-session --peer <issuer-multiaddr> --model synthetic-near/fixture-model
```

No currently implemented coupon issuer policy qualifies production issuance.
`admitCouponSessionIssuer` is the separate admission adapter. Its production
branch fails closed. A future approved dstack issuer adapter must verify a fresh
challenge bound to the actual authenticated Noise peer, issuing public key and
approved policy/code measurement. A transport identity, generic peer attestation
or `local-unattested` policy cannot satisfy that boundary. The UX cannot promote
an experimental override into production approval.

The only enabled profile is explicit and synthetic:

```sh
abalone coupon-session --experimental-local --peer <loopback-issuer-multiaddr> \
  --model synthetic-near/fixture-model
```

The peer must be a direct `127.0.0.1` TCP peer, with development evidence explicitly
admitted by configuration. The provider must use `http://127.0.0.1:<port>/v1`,
without credentials, query, fragment, redirect or alternate hostname. The provider
ID is exactly `synthetic-near`, the decrypted key must have the synthetic fixture
format, and the selected model must be in this protected local configuration:

```json
{
  "couponSession": {
    "mode": "synthetic-loopback",
    "provider": "synthetic-near",
    "baseUrl": "http://127.0.0.1:9001/v1",
    "models": ["fixture-model"]
  },
  "peers": { "admit": { "dev": true } }
}
```

This is part of `providers.json`, not a complete replacement configuration. It
must describe a disposable synthetic service. A loopback address alone cannot
prove that its operator has not installed a proxy to another destination.

Coupon input is hidden in the user's terminal, never a command argument. A
dedicated `ABALONE_COUPON_FD` is available to synthetic automation; a separate
`ABALONE_COUPON_CONSENT_FD` carries consent lines. Both descriptor variables are
removed from the sandbox child environment. No coupon entry command is exposed
to a model, outside setup agent or sandbox launcher control.

The offer screen shows the authoritative offer hash, provider and local
destination, exact model, nominal nanoUSD cap, claim expiry, unknown provider
expiry/balance, sponsor revoke/edit powers and first-bearer theft risk. Before
any claim effect the user must type `CLAIM SESSION ONLY` for that retained offer.
Cancelling leaves the coupon unclaimed.

## Session use and credential custody

An existing synthetic-provider entry in the contributor keystore, an ambient
synthetic credential or an existing coupon socket refuses before connection or
claim. An active routed gift also refuses. This flow never replaces a key or
writes the recipient credential to the contributor keystore.

The launcher retains the coupon, its generated Noise identity, X25519 delivery
key and decrypted synthetic credential in memory. The sandbox receives an
owner-only Unix socket path and a placeholder auth string, not the provider key.
The socket directory is private and user-owned; the socket has mode `0600`.
Possession of the socket is a capability to use the chosen provider/model. It is
not sealing against the host or proof that arbitrary sandbox code cannot use it.

The launcher broker accepts only the selected model, fixed inference path and
placeholder auth. It sends the credential directly to the configured synthetic
provider. dsmack receives neither inference prompts nor the plaintext credential.
There are no redirects, alternate endpoint fields, ambient auth fallback or
automatic key replacement. Input and output are bounded to 2 MiB, the absolute
request deadline aborts the request/upstream, and concurrent work is bounded.
Upstream errors are replaced with stable private messages. Raw coupon/credential
echoes in the bounded synthetic response are removed before delivery to the
session; this is not a general defense against a malicious provider's covert
encoding of secrets.

The synthetic provider adapter admits only the configured model. Real provider
extensions are not loaded for this experiment, and other launcher commands or
session restarts are refused. This profile supplies no real-provider attestation
claim. The inherited NEAR provider policy still reports some TCB findings rather
than requiring UpToDate, and GPU-verdict signature qualification needs its own
selected-profile gate. Issuer admission, provider/model admission and issuance
secrecy must each be independently qualified for production.

`/coupon` shows actual local state and actionable messages, including unknown
balance/expiry, exhausted credit or rate availability, denied access that may
mean revocation/expiry, and unavailable inference. It never reports an inferred
numeric balance. An inference failure does not issue another credential or use
an alternate key. `/coupon forget` asks for confirmation and closes the session.

## Retention and recovery

The offer screen says **EXIT OR CRASH LOSES RECOVERY** before consent. On a lost
claim response, same-session recovery requires `RETRY SAME KEYS`. It retains the
original accepted offer hash, transport identity and delivery key. Authorized
delivered status replays that delivery; ready status permits the original request
only before expiry. Reconciliation-required or accounting-blocked status never
requests new issuance. Unavailable or denied status preserves the keys and asks
for operator reconciliation. Starting another process is not recovery, and
key-loss replacement is not implemented.

These credentials are session-only, but ordinary conversation history, notebook
records, workspace files and host egress names can persist under ordinary session
defaults. `--incognito` retains its existing encrypted-trace contract and requires
a trace key created before claim; it does not make this issuer trusted. The
runtime socket and broker are closed with the session, and references to coupon
keys are dropped. Local forgetting is not upstream revocation, secure memory or
disk erasure, or deposit release. No automatic summary is sent to the outside
setup agent.

## Evidence and remaining gates

Run focused offline checks:

```sh
node --test tests/coupon-session.test.mjs
```

The optional actual-session fixture uses the reviewed dsmack synthetic service,
real local Noise peers, hidden descriptor input, the real sandbox Pi session and
its scoped socket broker:

```sh
DSMACK_CODE_DIR=/absolute/dsmack/code node tests/coupon-session-e2e.mjs
```

It proves default refusal without coupon frames, cancellation before claim, a
useful direct synthetic response, one provider creation, no raw key/coupon in
the inspected child argv/environment/log/transcript or retained session files,
no keystore installation, and broker/socket cleanup. State tests separately
exercise exact consent and same-key lost-response recovery; broker tests cover
wrong model/auth/endpoint, revocation, redirect refusal, bounded output, actual
deadline abort and broker loss.

Production remains blocked on approved measured issuer evidence/private-issuance
policy, actual provider account-owner secret-retrieval behavior, admitted model
qualification, agreed encrypted restart/key-loss recovery, live funded use and
independent recipient review. This experiment does not qualify the
[VPN boundary](vpn-qualification.md): the host-side broker and egress sockets use
host routes, and sandbox destination filtering is not a VPN kill switch. Chain,
gas and deposit settlement also remain separate release gates.
