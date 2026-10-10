# Excluded cases

None. `case-studies/` holds 23 directories (not 24), and every one has a stage verdict or a numbered gap list.

## Included with `stage: null`

The report gives no numeric stage, so the stage is left unset and only the gaps are scored.

- `confer`: the report says "It is not scored" (DEVPROOF-REPORT.md:9). The README row says 0, "Analysis in progress".
- `targon-confidential-compute`: the stage section says only "does not reach the cohort's posture" (DEVPROOF-REPORT.md:144). Gaps F1–F7.
- `redpill-federated-inference`: the report calls it a "development-grade deployment" (DEVPROOF-REPORT.md:551). The subject is gone (502 since 2026-08-18). Its given `composes/` are still analysable.

## Borderline inclusions

- `alternate-futures`: session notes only, but they contain a "Preliminary verdict" of Stage 0 and gaps F1–F5.
- `phala-private-ai-verifier`: a verifier SDK, not a service. The report and the README both say Stage 0, so the gold keeps 0 rather than n/a.
- `tinfoil-confidential-containers`: a hosting platform, not one deployment. Its stage comes from STAGE-733-ANALYSIS.md, which supersedes the report's own stage section.
