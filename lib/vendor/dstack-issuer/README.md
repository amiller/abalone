# dstack issuer identity verifier provenance

Copied from dsmack commit `f70b1152dfac2952178cc540fb4b4b1808e3d109`,
`runner/verify/dstack_issuer.mjs` and `runner/verify/dstack_quote_worker.mjs`.
This is a reviewed local candidate; copying it does not clear publication.

The verifier module now adds `appId` to its verified identity result, taken from
the exact approved runtime measurement after quote and RTMR3 event replay
verification. Coupon staging uses it with `composeSha256` to bind the signed
app/compose on every refresh. Its current SHA256 is
`5d13d3c0532b6d592e01a1ae437db6ae700b3b10b7d7863b298b97cde5d20fa4`.
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
