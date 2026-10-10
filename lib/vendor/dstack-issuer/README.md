# dstack issuer identity verifier provenance

Copied from dsmack commit `f70b1152dfac2952178cc540fb4b4b1808e3d109`,
`runner/verify/dstack_issuer.mjs` and `runner/verify/dstack_quote_worker.mjs`.
This is a reviewed local candidate; copying it does not clear publication.

The verifier module now adds `appId` to its verified identity result, taken from
the exact approved runtime measurement after quote and RTMR3 event replay
verification. Coupon staging uses it with `composeSha256` to bind the signed
app/compose on every refresh. Policy runtime-event pins also share the existing
4096-byte event-replay bound, accepting the 204-byte key-provider event emitted
by guest 0.5.9 while retaining exact event-content matching and strict TCB checks.
Its current SHA256 is
`19c30ada74e70d96aeb5a351ea9b3177536919bb7b0a7c7ca3a11009f8680617`.

Guest 0.5.9 SDK evidence reports runtime digests as empty strings. Only explicit
empty IMR3 digests are accepted: the verifier derives each digest from the exact
supported preimage, compares any reported digest, and extends its own computed
digest before checking the authenticated RTMR3. Boot and missing digests remain
refused. This matches the immutable upstream v0.5.9 source
[`TdxEvent::stripped` and `digest`](https://github.com/Dstack-TEE/dstack/blob/282eeb27d22d8f091ad0fa5a90e638f85cf68751/cc-eventlog/src/tdx.rs)
and [runtime event hashing](https://github.com/Dstack-TEE/dstack/blob/282eeb27d22d8f091ad0fa5a90e638f85cf68751/cc-eventlog/src/runtime_events.rs).
The original worker SHA256 is
`91f616c13e7a5245306ee055b9c829d51954343df7370d840a9a61da818404fc`.
The worker here adapts only dependency lookup: Abalone uses the existing
`aci/verifier-ts` package tree and refuses a DCAP dependency version other than
the reviewed `@phala/dcap-qvl` 0.6.6. Quote validation logic is unchanged.

The production factory verifies genuine Intel DCAP, measurement/event-log
bindings, challenge freshness and signing-key possession. Its result is
**issuer identity only**, with `privateIssuanceQualified: false` and
`rollbackQualified: false`. It does not approve custody, provider issuance or
settlement. The explicitly named testing factory always reports
`synthetic-only-not-hardware`; its fixtures are never a production allowlist.

The genuine quote worker runs in a separately killed/reaped process because the
pinned collateral-fetch library has no abort API. It receives only quote bytes,
with a minimal environment. Provider/collateral errors are never forwarded.
