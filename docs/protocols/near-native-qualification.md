# NEAR native encrypted-tool qualification

This is an experimental qualification tool, separate from the normal NEAR and
coupon providers. It does not enable native tools in a user's configuration.
Tracking: [issue 73](https://github.com/amiller/abalone/issues/73),
[research issue 23](https://github.com/amiller/awesome-private-inference/issues/23),
and the [DevProof supplement](https://github.com/amiller/devproof-audits-guide/pull/5).

## Evidence from 14 October 2026

The configured model, `z-ai/glm-5.3-flash`, accepted encrypted native function
schemas, names, arguments and tool-result history. Two consecutive native tool
calls completed with the expected synthetic arguments. A separate complete
call/result/final-answer round trip passed. Every accepted reply had a genuine attested **model** signature (`provider_tee`)
whose declared request hash matched the client's wire request and whose response
hash matched the received encrypted bytes. A gateway signature is insufficient.
The request-hash authority dependency below limits what this proves about input origin.

Six synthetic chat POSTs were made in total. Catalog prices applied to signed
reported token usage give an estimated total of **$0.00022808**, within the
user-authorized $0.25 cap. This is a usage-priced estimate, not an invoice or a
provider account-balance observation. No provider credentials, private files or
external search queries were given to the model. The only executable tool was
a local echo of an exact expected synthetic value.

Strict admission requiring `UpToDate` for both gateway and model failed. The
model TCB was `UpToDate`; the gateway was `OutOfDate`, with INTEL-SA-01192,
INTEL-SA-01245, INTEL-SA-01312 and INTEL-SA-01313. The protocol-only test used the
already-configured policy that reports TCB status, while retaining quote,
fresh nonce, key binding, GPU signature, measured compose, Base registry and
pinned gateway TLS checks. This does not qualify the stricter profile.

Observed compose hashes:

- Gateway: `41e18f38978b031431dfc8a4fcf6d8c38da62b1b093fd1d0e39e26ee6fad030c`.
- Model: `c82b1a2eaf6996154a5f39ae621643f034b082d5e51edd3d2ba6009273881d86`.

These identify the observed workloads. They do not close the inner serving
code/model supply chain to the reviewed source. The existing verifier reads
NEAR's compose registry through a pinned Base RPC; it is not an independent
light-client finality proof. Source-to-deployment closure, gateway request-hash authority/credential custody,
independent review and normal-provider integration remain outstanding.

## Field and response contract

The codec follows the ECDSA all-fields implementation at
[inference-proxy efd600a4](https://github.com/nearai/inference-proxy/blob/efd600a46c4327c8d8d038ab8b01c25a0e74b5bd/src/encryption.rs).
Both `X-Encryption-Version: 2` and `X-Encrypt-All-Fields: true` are explicit.
Version alone does not enable tool-field encryption. Extended server decryption
accepts plaintext for compatibility, so client-side wire canaries matter.

| Surface | Qualification behavior |
| --- | --- |
| Text content, reasoning, refusal and message names | Encrypt before sending; require ciphertext before accepting replies |
| Function definitions | Encrypt name, description and serialized parameters |
| Named function selection | Encrypt the selected name |
| Native assistant history | Encrypt function names and argument strings |
| Tool-result history | Encrypt result text and name; keep the opaque call ID as metadata |
| Streamed tool fragments | Authenticate the whole response, decrypt every field, then assemble calls |
| IDs, roles, type labels, model name and usage | Visible metadata |
| Legacy functions, images/audio, structured-output schemas, logprobs, server-side search and unknown fields | Refuse; not qualified by this codec |

A successful ciphertext decryption is not sender authentication: anyone with
the public client key can encrypt a fabricated command. The codec therefore
holds the full response until the attested model's signature verifies over the
declared request and response hashes. It refuses wrong signers, altered requests, spliced
responses, missing completion, malformed fields, invalid argument JSON and
unsupported shapes. Returned results are immutable and internally marked;
only those results can be converted into Pi's native tool stream.

The upstream proxy excludes the exact `: keep-alive` transport-padding frame
from its signed bytes. The codec handles that defined exception without
ignoring arbitrary comments or changing signed JSON. Numeric SGLang stop-token
metadata is accepted; plaintext stop strings are refused.

Pi expects the complete function name in its first tool delta. The codec
consolidates authenticated name/argument fragments before returning a native
OpenAI-compatible stream. Its Pi compatibility settings disable `store`, select
`max_tokens`, and use the model's chat-template thinking parameter. GLM still
emits an inline reasoning prefix ending in `</think>` with thinking disabled;
the synthetic final-answer check strips that known prefix. This is a rendering
behavior, separate from encryption or signature verification.

## Request-integrity trust dependency

The reviewed [chat dispatcher](https://github.com/nearai/inference-proxy/blob/efd600a46c4327c8d8d038ab8b01c25a0e74b5bd/src/routes/chat.rs)
lets a caller authenticated with the trusted service token (`config.token`)
supply `X-Request-Hash`, including a hash different from the backend's received
body. End-user cloud API keys cannot use that override. This supports gateways
that re-serialize requests, but places that gateway authority in the integrity
trust boundary.

Consequently, a model signature matching the client's request hash does not by
itself prove which body the model received: a privileged gateway could supply
that hash while substituting another encrypted request. Anyone can encrypt new
fields for the public model key; reply authentication alone does not authenticate
the client as the request's author. The regression suite demonstrates this
signature-level limitation using synthetic model signatures. It does not use a
real service credential or demonstrate an attack on the deployed service.

Gateway-independent tool execution needs request binding enforced inside the
model enclave without a gateway-asserted hash, or a verified client-authorized
request signature. Alternatively the gateway, its code and privileged service
credential custody must be explicitly included and qualified in the trust model.
The current live encryption observations establish neither alternative. Keep
private-work migration gated on this question as well as source/deployment review.

## Reproducing the checks

After the repository's normal dependency/build setup, offline checks are:

```sh
node --test tests/near-native-qualification.test.mjs
```

The fifteen tests cover real ECDSA encryption/signatures, wire canaries,
unsupported inputs, corrupt/plaintext fields, stream completeness, signer
substitution, authenticated-result immutability, and actual Pi tool calls with
encrypted result history. They make no provider calls. Local SDK evidence used
the existing compiled Pi build; it is not fresh installed-release evidence.

Live qualification requires a separately authorized budget and synthetic data:

```sh
node tools/qualify-near-native.mjs --model z-ai/glm-5.3-flash \
  --budget-usd 0.25 --out local-data/native-check/run-1
```

Use `NEARAI_API_KEY` in the environment. `--configured-key` reads the existing
local node keystore without copying the credential to logs. Strict TCB admission
is the default. `--protocol-only` explicitly selects reported TCB for synthetic
interoperability evidence; it cannot claim private-work eligibility.

By default there are two echo calls and one final completion; `--rounds 2` uses
one echo and one completion. At most six POSTs are allowed across runs sharing
an output parent. Before each POST, a locked ledger reserves the catalog cost
of an entire context window plus the requested output cap. A failed/unknown
charge keeps its reservation; only authenticated token usage releases it.
Requests are never automatically retried. A crash leaves the ledger lock for
reconciliation. Do not reset or move the ledger to bypass its authorized cap.

Raw attestations, encrypted wires, signatures, decoded synthetic results and
pricing evidence remain under the ignored output directory with owner-only
permissions. Review them before any publication. Re-run against a fresh source
revision/model deployment before claiming broader or future qualification.
