---
name: attestation-analyst
description: Profile a remote TEE service on four separate axes (hw, code, operator, assurance) with a cited gap for every axis that is not ✓, and an ERC-733 stage. Use when given a service URL, an attestation quote or report, a dstack app id, or an audit directory, and asked whether the service can be trusted with private data.
---

# Attestation analyst

"Runs in a TEE" is one claim. "The code is open and reproducible", "the operator cannot rug users" and "the code has been audited or proven" are three more. Keep them separate. Never let a passing quote stand in for a trust verdict.

The framework is Andrew's DevProof guide. Read these before the first analysis in a session:
- `~/projects/dstack/devproof-audits-guide/README.md` (ERC-733 stages, common failures)
- `~/projects/dstack/devproof-audits-guide/framework/STAGE-1-CHECKLIST.md` (the seven Stage 1 items and the Operator Gap Test)
- `~/projects/dstack/devproof-audits-guide/LEARNINGS.md` (§1–§19, the recurring patterns)
- `notes/aci-gaps.md` in sealed-agent (the ACI client gate G1–G11, R1–R6, and known protocol gaps)
- `references/gap-tags.md` in this skill (the only tags you may use)

## Inputs
One of: a service URL; a raw quote or attestation report; a dstack app id and cluster; a repo and commit; or a directory of evidence. Work from what you are given. If you need something you cannot fetch, say so as a gap with status `unknown`; do not guess.

## Procedure

1. **Map the plaintext path.** List every component that sees the user's plaintext (client, gateway, router, coordinator, model server) and who runs each. A component with no attestation that sees plaintext is a `hw:no-quote` gap no matter how good the rest is.

2. **hw: verify the quote.**
   - ACI services (`GET /v1/aci/attestation?nonce=…`): use the in-tree verifier `aci/verifier-ts` (`verifyService`, or `verifyReportBinding` + `verifyQuote` + `verifyComposeMeasurement`). Apply the gate in `notes/aci-gaps.md` §1: G1–G11, with TCB `UpToDate` and production OS treated as blocking.
   - dstack apps: the 8090 metadata endpoint gives `tcb_info`, `app_compose` and the event log (LEARNINGS §11). Use `@phala/dstack-verifier` or trust.phala.com for the quote and RTMRs (LEARNINGS §13: the local verifier build often fails).
   - `private-ai-verifier` (`~/projects/hermes-agent/refs/private-ai-verifier`, commit 2d2f5cf) can fetch and check NEAR AI, RedPill, Tinfoil and Chutes quotes plus NVIDIA NRAS. Its limits, per `notes/aci-gaps.md`: it speaks no ACI; on the NEAR path it compares two server-supplied compose hashes and never opens a live TLS connection to check the fingerprint; it delegates TDX verification to an opaque `dstack-verifier` sidecar on the NEAR/RedPill paths. A pass from it establishes genuine hardware only. It does not establish `hw:not-bound` is closed.
   - Check freshness (nonce), binding (TLS SPKI or E2EE key in `report_data`, checked against the live connection), debug bit, TCB status, and GPU binding.

3. **code: trace measurement to source.** Follow LEARNINGS §11–§15: `sha256(app_compose)` equals the attested compose hash → read `docker_compose_file` → every image pinned by digest, none supplied via `${VAR}` in `allowed_envs` → digest → the deployed commit (not branch HEAD, §12) → rebuild with the reproducibility flags of §14 and compare digests. If you cannot rebuild here (this laptop is not a build box), say whether someone else has published a rebuild, and if no one has, the gap is `code:not-reproducible`. Check model weights are pinned by hash (§18) and that no post-boot manager launches unmeasured workloads (§16).

4. **operator: walk the Stage 1 checklist.** All seven items of `STAGE-1-CHECKLIST.md`, then the Operator Gap Test: every URL or env that touches user data must be hardcoded in the measured compose. Check `allowed_envs`, `public_logs`, log APIs (§17), SSH or root-key inputs, KMS type and upgrade log (§3, §7), notice period (§5, and its note on ephemeral inference), and centralized dependencies (§6). For aggregators, check whether attested serving is forced and visible before sending (`op:unforced-serving`).

5. **assurance.** List published audits and formal proofs that cover the trust-critical code. For each proof, run the `formal-methods-reader` skill and carry over its stated gap between the verified artifact and the deployed measurement. No coverage → `assurance:none`.

6. **client.** If the service ships a client, SDK, verifier or agent skill, check that it actually performs the checks it claims (`client:verifier-gap`).

## Output

Write a JSON profile, then a short prose summary. JSON first, exactly this shape:

```json
{
  "subject": "what was analysed, with URL / app id / commit",
  "stage": "0 | ~1 | 1 | 2 | n/a",
  "axes": {
    "hw":        {"status": "✓ | partial | ✗ | unknown", "evidence": ["what was checked, with cite"]},
    "code":      {"status": "...", "evidence": ["..."]},
    "operator":  {"status": "S0 | S1 | unknown", "evidence": ["..."]},
    "assurance": {"status": "✓ | partial | none", "evidence": ["..."]}
  },
  "gaps": [
    {"axis": "hw|code|operator|assurance|client", "tag": "<from references/gap-tags.md>", "id": "G1 or null",
     "text": "one sentence", "cite": "file:line, URL, or command + output that shows it"}
  ]
}
```

Rules:
- Every axis whose status is not ✓ (or `S1` for operator) has at least one gap.
- Every gap has a cite you actually looked at. No cite, no gap.
- Stage follows ERC-733: failing any Stage 1 item is Stage 0. Use `~1` only when the single residual gap is one the evidence shows is narrow. Use `n/a` for a protocol or a tool rather than a deployment.
- Then a strip line in the resource-strip form, e.g. `hw✓ code– op:S0 proof–`, and at most five sentences of summary naming the top gap first.
