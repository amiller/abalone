# NEAR v2 text and native tool codec

This standalone Dsmack package prepares NEAR's Ed25519 all-fields wire format
for a future provider integration. It does not register a Pi provider, contact
an endpoint, acquire credentials, verify hardware attestations, or change the
existing coupon/NEAR runtime. Use synthetic content during integration work.

`encryptRequest` accepts a narrow OpenAI chat shape: text messages, native
function schemas/calls/results, explicit `max_tokens`, and streaming. It seals
function names, descriptions, JSON schemas and arguments alongside text. Model,
roles, tool IDs/indexes, generation controls and structural metadata stay clear.
Unsupported fields, modalities, stop strings, legacy function calls, empty tool
arrays and non-null logprobs are refused. Limits are caller-selected buffer
bounds, separate from the provider's generation limits.

`prepareExchange` requires an already authenticated model assessment and an
explicit code policy. The assessment must come from a separately reviewed
hardware verifier; passing raw provider JSON does not authenticate it. The policy
must allowlist both compose and OS image hashes, identify the policy, and set a
maximum admission age. Unknown code, wrong model, missing policy and stale
assessment fail closed. This package does not supply a production policy or a
fixture bypass for one.

The exchange creates a fresh reply key and request ciphertext, retaining exact
serialized request bytes. Its `complete` method buffers bounded original SSE
bytes, verifies an Ed25519 `provider_tee` proof for the exact model/request/reply
hashes, then decrypts and checks complete native tool calls. It releases no
plaintext SSE until all checks succeed. Missing `[DONE]`, incomplete frames,
reader errors, malformed arguments, undeclared tools, truncated/refused finishes,
wrong signatures and decryption failures reject the entire exchange. An explicit
`tool_choice: none` permits no calls; a fixed function choice permits only that
declared function. Calls can
be completed once; `close()` clears an unused reply secret. Callers should also
supply an abort signal and enforce their own request deadline.

The optional proof resolver receives only a frozen object containing model and
request/response SHA256, not keys or plaintext. It must retrieve a proof under
its caller-owned deadline. For privateinference.gg, this means the signature
endpoint indexed by the response's `X-PI-Request-Id`; accounting fields returned
beside that proof are not bound by the model signature. This package performs no
proof lookup and does not retry or select alternate endpoints.

## Remaining privacy limitations

NEAR's reply-key header is outside the signed request-body bytes. A relay may
replace it and read a reply; later verification/decryption can detect the
exchange failure but cannot undo disclosure. The synthetic substitution test
makes this limitation explicit. A valid signature also does not establish an
approved code baseline, billing amount, balance, local tool sandbox or retention
policy. See the [intermediary disclosure](https://privateinference.gg/how-it-works)
and [NEAR issue 1061](https://github.com/nearai/cloud-api/issues/1061).

## Focused checks

```sh
npm ci --ignore-scripts --no-audit --no-fund
ABALONE_DIR="$PWD/local-data/state" npm test
```

Dependencies and integrity values are pinned in the adjacent lockfile. This
package's focused tests are an additional explicit check; the repository's
ordinary offline gate does not currently discover them automatically. Before
connecting this package to the runtime, retain the repository's offline gate
and independent security review. Passing these synthetic tests is not live
provider or installed-release qualification.

The [synthetic fixture provenance](test/fixtures/README.md) explains the pinned
browser-reference vectors. To reproduce them, obtain the exact public browser
asset specified there into an ignored evidence directory, then run:

```sh
node test/reference-vectors.mjs /path/to/browser-xfq6xewy.js
```

The maintenance generator refuses any different source hash, evaluates only the
original upstream envelope helper definitions with explicit crypto bindings,
and exercises cross-opening in both directions. It makes no network requests.
Do not use its deterministic fixture seeds or nonces for inference.
