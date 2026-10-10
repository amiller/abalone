# Gap tags

Every gap in a profile carries exactly one tag from this list. The eval scores tag sets, so do not invent tags; if nothing fits, use the closest and say why in the gap text.

Sources cite only the general framework, never a case study, so the attestation eval is not fed answers. Sources: devproof-audits-guide `LEARNINGS.md` (§N), `framework/STAGE-1-CHECKLIST.md` (§N), sealed-agent `notes/aci-gaps.md` (strip field).

## hw — does it run in a TEE?
| Tag | Meaning | Source |
|---|---|---|
| `hw:no-quote` | No externally fetchable quote for the component that sees plaintext (e.g. a coordinator, router, or gateway with no attestation) | LEARNINGS §19 |
| `hw:not-bound` | Quote not bound to this session: no fresh nonce, no TLS SPKI / E2EE key in `report_data`, or binding only checked against server-supplied values | aci-gaps G1/G8 |
| `hw:delegated-verdict` | Quote verification delegated to an operator-run or opaque service returning a bare boolean | checklist §6 |
| `hw:debug-or-stale` | Debug TD / dev OS image, or TCB not `UpToDate` | aci-gaps G3/G6 |
| `hw:gpu-unbound` | GPU attestation missing, failing, or not bound to the serving CPU TEE | aci-gaps "GPU not bound" |

## code — is the measured code open and reproducible?
| Tag | Meaning | Source |
|---|---|---|
| `code:closed` | Core component closed source or binary blob | LEARNINGS §4; checklist §2 |
| `code:image-unpinned` | Image by mutable tag, or `${VAR}` image in `allowed_envs` | LEARNINGS §8, §15; strip `pinned` |
| `code:weights-unpinned` | Model weights fetched by name / not hash-anchored | LEARNINGS §18; strip `weights` |
| `code:not-reproducible` | No demonstrated reproducible build from source to measurement | LEARNINGS §5, §14; checklist §3; strip `repro` |
| `code:unmeasured-workload` | Real workload launched post-boot or from an unmeasured disk, outside RTMR3 / launch measurement | LEARNINGS §16 |
| `code:model-unbound` | Attestation does not bind which model served the request (substitution possible) | aci-gaps `model:bound` |

## operator — can the developer rug users?
| Tag | Meaning | Source |
|---|---|---|
| `op:config-url` | Operator-settable URL or env on the prompt path (exfiltration / redirect) | LEARNINGS §1, §2; checklist "Operator Gap Test" |
| `op:secret-access` | Developer can obtain app secrets: hardcoded or fallback keys, DEV_MODE, operator-injected secrets, key custody outside the TEE (incl. TLS private key) | LEARNINGS §9; checklist §4; aci-gaps G7 `custody` |
| `op:no-upgrade-log` | No public upgrade history (Pha KMS, no on-chain compose log, current-state-only trust center) | LEARNINGS §3, §7; checklist §1, §5 |
| `op:no-notice` | No timelock / notice period on upgrades where it matters (persistent data) | checklist §5 |
| `op:logs` | Operator-readable logs (public_logs, log APIs, telemetry collecting all containers) | LEARNINGS §17 |
| `op:debug-path` | SSH, admin endpoints, break-glass keys, root key inputs | checklist §7; aci-gaps "operator surfaces" |
| `op:central-dep` | Centralized non-TEE dependency on the trust path (coordinator, hosted verifier, CDN serving the client) | checklist §6 |
| `op:unforced-serving` | Nothing visible pre-send forces attested serving; plaintext can be forwarded to a non-TEE upstream | aci-gaps "forced attested serving" |

## client — does the verifier the user runs check what it claims?
| Tag | Meaning | Source |
|---|---|---|
| `client:verifier-gap` | The shipped client / SDK / skill skips checks, compares server-supplied values to each other, or reports "verified" without establishing a confidential channel | aci-gaps §1 "The todo's reference verifier" |

## assurance — what has been audited or proven?
| Tag | Meaning | Source |
|---|---|---|
| `assurance:none` | No published audit or proof covering the trust-critical code | checklist §2 |

## Stage values
`0`, `~1`, `1`, `2`, or `n/a` (the subject is a protocol or a tool, not a deployment). Use the ERC-733 rule: fail any Stage 1 item → `0`. `~1` means one residual gap that the report itself calls near-Stage-1.
