---
name: attestation-analyst
description: Profile a remote TEE service on four separate axes (hw, code, operator, assurance) with a cited gap for every axis that is not ✓, and a conservative review stage. Use when given a service URL, an attestation quote or report, a dstack app id, or an audit directory, and asked whether the service can be trusted with private data.
---

# Attestation analyst

"Runs in a TEE" is one claim. "The code is open and reproducible", "the operator cannot rug users" and "the code has been audited or proven" are three more. Keep them separate. Never let a passing quote stand in for a trust verdict.

Read [the review checklist](references/checklist.md) and
[gap tags](references/gap-tags.md) before an analysis. Both are shipped here;
no maintainer checkout or private case-study guide is required. This is a
source/evidence review skill, not a substitute for the runtime's provider gate.

## Inputs
One of: a service URL; a raw quote or attestation report; a dstack app id and cluster; a repo and commit; or a directory of evidence. Work from what you are given. If you need something you cannot fetch, say so as a gap with status `unknown`; do not guess.

## Procedure

1. **Map the plaintext path.** List every component that sees the user's plaintext (client, gateway, router, coordinator, model server) and who runs each. A component with no attestation that sees plaintext is a `hw:no-quote` gap no matter how good the rest is.

2. **hw: verify the quote.**
   - ACI services (`GET /v1/aci/attestation?nonce=…`): use the in-tree verifier `vendor/phala-aci/verifier-ts` (`verifyService`, or `verifyReportBinding` + `verifyQuote` + `verifyComposeMeasurement`). Check its actual nonce, channel-key, quote, compose, TCB and production/debug enforcement against the supplied policy. For the strict profile, TCB `UpToDate` and production OS are blocking requirements; a separately explicit warned synthetic trial is not a strict pass.
   - dstack apps: the 8090 metadata endpoint gives `tcb_info`, `app_compose` and the event log. Use `@phala/dstack-verifier` or trust.phala.com for the quote and RTMRs.
   - An external verifier or hosted verdict needs a pinned version, inspectable checks and authenticated evidence. Comparing two server-supplied hashes or accepting a bare remote boolean does not establish binding to the live channel. Record absent verification as a gap.
   - Check freshness (nonce), binding (TLS SPKI or E2EE key in `report_data`, checked against the live connection), debug bit, TCB status, and GPU binding.

3. **code: trace measurement to source.** Check the full chain: `sha256(app_compose)` equals the attested compose hash → read `docker_compose_file` → every image pinned by digest, none supplied via `${VAR}` in `allowed_envs` → digest → the deployed commit (not branch HEAD) → rebuild using the documented locked/deterministic build and compare digests. If you cannot rebuild here in the current environment, say whether someone else has published a rebuild, and if no one has, the gap is `code:not-reproducible`. Check model weights are pinned by hash and that no post-boot manager launches unmeasured workloads.

4. **operator: walk the Stage 1 checklist.** All seven items of the shipped checklist, then the operator-control test: every URL or env that touches user data must be hardcoded in the measured compose. Check `allowed_envs`, `public_logs`, log APIs, SSH or root-key inputs, KMS type and upgrade log, notice period (including the checklist's ephemeral-data exception), and centralized dependencies. For aggregators, check whether attested serving is forced and visible before sending (`op:unforced-serving`).

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
- Use the shipped checklist's conservative stage rules. A failed requirement gives `0`; missing evidence leaves stage 1 unestablished, with explicit unknown gaps. `~1` is conditional, never a passing stage. Use `n/a` for a protocol or tool, and do not infer stage `2` from a single-enclave quote.
- Then a strip line in the resource-strip form, e.g. `hw✓ code– op:S0 proof–`, and at most five sentences of summary naming the top gap first.
