# Quote signature provenance

The signed-field projection in `quote-signature.mjs` is adapted from
`@defuse-protocol/one-click-sdk-typescript` **0.1.26**,
`dist/index.mjs`, section `src/quote-signature.ts`. Its ISC license and
NEAR Foundation copyright are retained in [quote-signature.LICENSE](quote-signature.LICENSE).

- [Exact npm tarball](https://registry.npmjs.org/@defuse-protocol/one-click-sdk-typescript/-/one-click-sdk-typescript-0.1.26.tgz)
- Tarball SHA-256: `3cdee91d6b76019b4f98624714911a0be0c63c904f100c10ede2eb91547bf280`
- Tarball SRI: `sha512-vYoBgEbppergtYd/H1IaJW9Jm5mPrX+jAwuuhMvDFstirJB53KFe2HnGLTg0KNyg6qztbOeDK0sA/oEAee+EAw==`
- Upstream `dist/index.mjs` SHA-256: `2b21d82edef5c4a020503bc3ca12e8577e79ac22edf14cc25587be057c18060b`
- [Provider signature documentation](https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature)

The implementation uses Node's built-in SHA-256 and Ed25519 verification.
The message is the UTF-8 encoding of the Base58 SHA-256 digest of the
lexicographically ordered projected JSON. Only JSON primitive values are
supported in projected fields. For that domain, serialization matches
`json-stable-stringify`; nested projected values are refused. Unknown fields
are omitted exactly as in the upstream projection. Input must be JSON text
bounded to 128 KiB, avoiding executable object getters or `toJSON` hooks.

The signer is the upstream pinned manager key:
`ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc`.
There is no caller override, key discovery or fallback to SDK 0.1.24.
Key rotation requires a reviewed source change.

For issued quotes, 0.1.26 includes execution fields such as deposit address
and returned deadline; 0.1.24 omitted these. Optional falsy fields are omitted.
The upstream spread merge allows `quote.deadline` to replace
`quoteRequest.deadline`, including omission when the returned deadline is
absent. Request semantics must therefore be validated independently.

This is a signature-only prototype. It does not validate request echoes,
network, controlled recipients, amounts, fees, timestamp freshness, expiry or
payment authorization. It does not authenticate the outer execution-status
response, transaction hashes or account credit. Those still require explicit
provider TLS provenance and reconciliation. A valid stale signature remains
valid here; application policy must refuse it when stale.

Offline comparison used the actual 0.1.26 helper and its cryptographic
libraries in a network-disabled namespace. Synthetic keys existed only in a
private test copy of this module: 42 checks matched message bytes and signature
results, including amount/address/deadline mutation rejection and unsigned
status behavior. This is not a genuine provider quote test or a claim of
identical acceptance for every malformed Ed25519 encoding. An adversarial
comparison found that Node rejects an otherwise valid signature whose scalar
is encoded as `S + L`, while the pinned TweetNaCl implementation accepts it.
This helper deliberately retains Node's stricter rejection; it is not a
drop-in replacement for every upstream acceptance case. No fallback verifier
is attempted after rejection. The production
pinned key has no test bypass. A separate actual ARM64 QEMU check on Node
24.22.0 passed the three public tests plus synthetic signature verification,
four signed-field mutation refusals and production-anchor refusal. Networking
was disabled with `unshare -Urn`, with `ENETUNREACH` checked before import;
temporary guest files were removed. This qualifies the native helper on that
runtime, not a genuine provider quote or the complete funding flow.
