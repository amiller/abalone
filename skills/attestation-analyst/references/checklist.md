# Attestation review checklist

Review hardware, code, operator control and assurance separately. This self-contained
rubric retains the stage vocabulary used by Abalone's historical DevProof evaluation.
It is a review classification, not a runtime allowlist or a claim of comprehensive
security audit. Cite inspected evidence for every pass, failure and unknown.

## Hardware and channel binding

Map every component that sees plaintext. For each, verify genuine hardware evidence,
verifier-owned freshness, production/debug state, TCB policy and binding of the
live TLS or inference encryption key to the report. Check GPU identity, signed
verdict and CPU/model binding when applicable. A server's two matching values or
an opaque hosted boolean does not independently establish these properties.
Inspect the shipped verifier's actual checks; an API's claim is not verification.

## Stage 1 requirements

Record each as pass, fail, unknown or not applicable, with a reason.

1. **Attestation and upgrade transparency:** verified attestation, an independently
   inspectable measurement registry and immutable deployment/upgrade history.
   State explicitly whether the evidence is on-chain or an alternative mechanism.
2. **Auditable code:** public trust-critical source, published formal proof or a
   published relevant audit. Check coverage rather than treating a badge as evidence.
3. **Reproducible measurement:** pinned images and weights, locked inputs, documented
   deterministic build and an actual source-to-deployed-measurement comparison.
   Build flags and digest syntax alone do not prove reproducibility.
4. **Secret custody:** trace key derivation, KMS release and configuration authority.
   Check fallback/development keys and operator-accessible injection, logs and APIs.
   Evaluate a credential by its ability to expose, redirect, decrypt or sign user
   data, not merely a variable name containing KEY or TOKEN.
5. **Upgrade controls:** public history and applicable notice/withdrawal protection
   against new code obtaining keys for previously retained data. An ephemeral
   service may not need withdrawal, but needs evidence of per-session measurement
   pinning, no recoverable historical plaintext/key material and public history.
   Simply calling the service ephemeral does not establish the exception.
6. **Central dependencies:** enumerate coordinators, databases, hosted verifiers,
   client delivery, revocable credentials and vendor dependencies. Separate
   confidentiality, integrity and availability effects. A scoped tolerated
   dependency is not silently a pass of a no-central-dependency claim.
7. **Debug and backdoor paths:** inspect SSH/root/admin interfaces, break-glass keys,
   sensitive logs and debug modes. Confirm which paths the measured policy permits.

## Operator-control test

Trace every data-path URL, image, secret, environment input and post-boot workload.
Can the operator change a destination, inject code, read keys or enable logging
without the verifying client detecting and refusing the change? Inspect compose
`allowed_envs`, log APIs, KMS policy and upgrade authority. A non-data telemetry
value is not automatically an exfiltration route; follow its actual effects.
For aggregators, check that attested serving is forced before sending plaintext.

## Stage and axis output

A demonstrated failed requirement yields stage `0`. Missing evidence leaves stage
`1` unestablished; use conservative `0` with explicit unknown gaps, never imply a
proven exploit. `~1` denotes a narrow conditional near-pass and is not acceptance.
Stage `1` requires evidence for every applicable item and declared interpretations.
Do not assign `2` unless supplied evidence establishes the claimed multi-enclave,
multi-vendor and independent-control properties beyond stage `1`. Use `n/a` for
protocols and tools. The axes carry the actual findings; a stage cannot replace them.

For each formal proof, inspect its verified artifact, assumptions, trusted base
and binding to the deployed measurement. Use the sibling formal-methods-reader
skill when available. Missing relevant audit/proof coverage is `assurance:none`.
