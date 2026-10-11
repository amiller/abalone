# Gap tags

Every gap in a profile carries exactly one tag from this list. The eval scores tag sets, so do not invent tags; if nothing fits, use the closest and say why in the gap text.

The [review checklist](checklist.md) defines these categories without case-specific
answers or private prerequisites. Cite actual subject evidence in each profile.

## hw — does it run in a TEE?
| Tag | Meaning |
|---|---|
| `hw:no-quote` | No externally fetchable quote for the component that sees plaintext (e.g. a coordinator, router, or gateway with no attestation) |
| `hw:not-bound` | Quote not bound to this session: no fresh nonce, no TLS SPKI / E2EE key in `report_data`, or binding only checked against server-supplied values |
| `hw:delegated-verdict` | Quote verification delegated to an operator-run or opaque service returning a bare boolean |
| `hw:debug-or-stale` | Debug TD / dev OS image, or TCB not `UpToDate` |
| `hw:gpu-unbound` | GPU attestation missing, failing, or not bound to the serving CPU TEE |

## code — is the measured code open and reproducible?
| Tag | Meaning |
|---|---|
| `code:closed` | Core component closed source or binary blob |
| `code:image-unpinned` | Image by mutable tag, or `${VAR}` image in `allowed_envs` |
| `code:weights-unpinned` | Model weights fetched by name / not hash-anchored |
| `code:not-reproducible` | No demonstrated reproducible build from source to measurement |
| `code:unmeasured-workload` | Real workload launched post-boot or from an unmeasured disk, outside RTMR3 / launch measurement |
| `code:model-unbound` | Attestation does not bind which model served the request (substitution possible) |

## operator — can the developer rug users?
| Tag | Meaning |
|---|---|
| `op:config-url` | Operator-settable URL or env on the prompt path (exfiltration / redirect) |
| `op:secret-access` | Developer can obtain app secrets: hardcoded or fallback keys, DEV_MODE, operator-injected secrets, key custody outside the TEE (incl. TLS private key) |
| `op:no-upgrade-log` | No public upgrade history (Pha KMS, no on-chain compose log, current-state-only trust center) |
| `op:no-notice` | No timelock / notice period on upgrades where it matters (persistent data) |
| `op:logs` | Operator-readable logs (public_logs, log APIs, telemetry collecting all containers) |
| `op:debug-path` | SSH, admin endpoints, break-glass keys, root key inputs |
| `op:central-dep` | Centralized non-TEE dependency on the trust path (coordinator, hosted verifier, CDN serving the client) |
| `op:unforced-serving` | Nothing visible pre-send forces attested serving; plaintext can be forwarded to a non-TEE upstream |

## client — does the verifier the user runs check what it claims?
| Tag | Meaning |
|---|---|
| `client:verifier-gap` | The shipped client / SDK / skill skips checks, compares server-supplied values to each other, or reports "verified" without establishing a confidential channel |

## assurance — what has been audited or proven?
| Tag | Meaning |
|---|---|
| `assurance:none` | No published audit or proof covering the trust-critical code |

## Stage values
`0`, `~1`, `1`, `2`, or `n/a` (the subject is a protocol or a tool, not a deployment). Use the [checklist rules](checklist.md#stage-and-axis-output): demonstrated failure or unestablished stage 1 → conservative `0`, with unknowns explicit. `~1` is conditional and not a pass; historical gold labels can conflict with their findings.
