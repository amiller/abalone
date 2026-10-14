# NEAR native encrypted-tool qualification

This is an experimental qualification tool, separate from the normal NEAR and
coupon providers. It does not enable native tools in a user's configuration.
Tracking: [issue 73](https://github.com/amiller/abalone/issues/73),
[research issue 23](https://github.com/amiller/awesome-private-inference/issues/23),
[request-origin sprint 77](https://github.com/amiller/abalone/issues/77),
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
light-client finality proof.

A later read-only capture verified the compose-manager quote with Intel PCS
collateral: its TCB was `UpToDate`, its report data bound the action digest and
our fresh nonce, and its MRTD and RTMR0–3 matched the model CVM. Its 186 recorded
actions were authenticated under the canonical action encoding described below.
The last recorded compose file also matched the bytes fetched at its reported
commit. The fresh report contains different model outer-compose bytes from
the earlier native-tool observations; those earlier interoperability results
are not silently carried forward to this capture. This authenticates reported
action history, not the current running state.
The [manager source](https://github.com/nearai/compose-manager/blob/aa9de34419c753c432259ecbcc717b6e2a7357c6/src/main.rs#L300)
explicitly notes that `compose_up` can be recorded before success; an attempted
or historical deployment cannot substitute for evidence of active containers.

Current [manager source](https://github.com/nearai/compose-manager/blob/aa9de34419c753c432259ecbcc717b6e2a7357c6/src/main.rs#L357)
defines sorted-key, compact UTF-8 JSON with string-valued action fields and
string-array services, omitting absent optional fields and empty services.
That canonical contract allows a digest to survive reformatting. The earlier
claim that reformatted records necessarily prevent digest verification was too
broad. Original bytes remain useful for legacy exact-byte variants and review;
the collector retains them and requires an explicit encoding rather than trying
alternate hashes until one passes. The inspected public source is not yet bound
to the deployed manager image.

The verified file was
[`prod/GLM-5.3-Flash-SGL-TP2x4-W4AFP8-V8KdaCanary.yaml`](https://github.com/nearai/cvm-compose-files/blob/46bfd83ec22c179693e06308e40950d540154b4d/prod/GLM-5.3-Flash-SGL-TP2x4-W4AFP8-V8KdaCanary.yaml),
SHA-256 `c7c1bf4d82e137b8d2e0788f41cd6637b38bd08fdc74f38e87b4571ce0c8562e`.
It configures the inference proxy's `TOKEN` from `PROXY_TOKEN` and gives the
registrar that same inference token. These placeholders establish a source-level
configuration path; they do not establish who can read the deployed credential.

Source-to-deployment closure, gateway request-hash authority/credential custody,
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
body. The [authentication extractor](https://github.com/nearai/inference-proxy/blob/efd600a46c4327c8d8d038ab8b01c25a0e74b5bd/src/auth.rs#L354)
compares configured service tokens first; a match sets `cloud_api_key` to
`None`, while ordinary validated cloud keys set it to `Some`. Multiple tokens
can be configured for rotation. End-user cloud API keys cannot use that override. This supports gateways
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
The public [cloud-api forwarding source](https://github.com/nearai/cloud-api/blob/752e2976a7ee2a8790163974ba4a70dd218bbf3b/crates/inference_providers/src/attested/nearai/mod.rs#L1941)
sets `X-Request-Hash` from the gateway's request-hash argument while rewriting
stream options and sending a configured upstream bearer credential.
Its [body-hash middleware](https://github.com/nearai/cloud-api/blob/752e2976a7ee2a8790163974ba4a70dd218bbf3b/crates/api/src/middleware/body_hash.rs)
computes SHA-256 over the received request bytes. This explains the intended
honest-gateway path; a gateway compromise is still inside the integrity TCB.
The gateway pool receives its bearer key from
[`config.inference_api_key`](https://github.com/nearai/cloud-api/blob/752e2976a7ee2a8790163974ba4a70dd218bbf3b/crates/api/src/lib.rs#L849),
loaded from [`INFERENCE_API_KEY`](https://github.com/nearai/cloud-api/blob/752e2976a7ee2a8790163974ba4a70dd218bbf3b/crates/config/src/types.rs#L63).
This is a source configuration path, not proof that its deployed value equals
`PROXY_TOKEN`. The registrar has the inference token in its environment, but the
inspected registration requests do not send it in their request bodies.
The gateway image-to-source mapping and deployed token custody remain open.
The current observations establish neither integrity alternative. Keep
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

Parsed attestation records, encrypted wires, signatures, decoded synthetic results and
pricing evidence remain under the ignored output directory with owner-only
permissions. Review them before any publication. Re-run against a fresh source
revision/model deployment before claiming broader or future qualification.

## Read-only deployment evidence

These tools make no chat POSTs and do not use or reset the paid-check ledger:

```sh
python3 tools/near-deployment-evidence.py --model z-ai/glm-5.3-flash \
  --configured-key --out local-data/deployment/run-1
node tools/verify-near-manager-quote.mjs --evidence local-data/deployment/run-1
python3 tests/near-deployment-evidence.test.py
```

The collector uses ordinary HTTPS for the initial report fetch. Evidence becomes
authenticated only through nonce-bound quote verification; this check alone does
not establish the full model signing-key/TLS/compose admission profile. The Node
check uses the repository's installed `@phala/dcap-qvl` dependency and Intel PCS.
It reports TCB status rather than granting private-work admission. It requires
matching manager/model measurements and recomputes the action digest from the
captured evidence. A separate negative check altered a byte in the captured manager quote and
confirmed refusal without writing a success verdict. Seven offline tests cover digest corruption, nonce swaps,
report-data mismatch, duplicate keys, unsupported action schemas and exact-byte
versus canonical encoding. They do not replace cryptographic quote tests.

To inspect a historical exact-byte manager contract, explicitly supply
`--action-encoding exact` to both tools. Do not use exact-mode success or a
canonical-mode success to infer the deployed manager source revision. Active
container/image evidence, model artifact integrity and privileged credential
custody are still separate checks.
