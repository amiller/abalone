# Abalone development workflow

GitHub issues are the authoritative work queue. The [roadmap](roadmap.md) explains
the product direction; private research is optional background, never a build
dependency. Read [CONTRIBUTING](../CONTRIBUTING.md) for setup and checks.

## Choose and carry a bounded change

Start with the first-session milestone and the smallest unmet user outcome. Check
the issue's current evidence before assuming an old finding remains present.
Record scope, dependencies, next action and expected acceptance. Assign a real
owner only when they take the task; historical assistant names are not assignments.
No particular assistant, model or automatic scheduler is required.

Use one topic branch per change. The optional tools/dev-worktree.sh helper
creates an isolated checkout; copied build outputs do not share writable inodes.
Use disposable ABALONE_DIR state and synthetic data. Preserve unrelated work.

An issue has one workflow label: queued, ready, active, review or blocked.
Ready means sufficiently scoped, not currently running. Blocked names a concrete
dependency and an unblock condition. Close only with an integrated revision and
relevant evidence, or explicitly mark superseded/duplicate without claiming success.
Milestones identify user outcomes; later work is not silently a release dependency.

## Review and verification

Explain the resulting behavior, boundary changes and limits. Seek independent
review before integration. Documentation changes need relevant link and whitespace
checks; runtime changes retain the required offline integration gate and targeted
positive/negative checks. Live or paid checks need a bounded purpose and budget.
Reuse applicable evidence with its original revision/environment; do not call it
a fresh run. A repeated failure needs a new diagnostic hypothesis, not blind retry.

Accept the actual entry point: useful outcome, enforced applicable boundary,
understandable state and coherent start-to-close journey. A claim about privacy
must name its scope. Provider attestation does not establish local host security,
tool-egress policy, trace ephemerality or network anonymity.

Keep curated/manifest.json consistent using the repository's staged-file checks.
Do not attach private transcripts, credentials or raw operator state to issues.
Publishing a release or changing repository visibility is separate from integrating
development work. First-party code is MIT licensed and SECURITY.md defines private reporting.
Release qualification and reviewed publication remain separate from integration.
