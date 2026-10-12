# Test fixture provenance

These inputs support reproducible checks. A passing synthetic test or replay of a
recording does not qualify a current live issuer, provider or hardware platform.
Keep only inputs used by a test; review recorded content before uploading it.

| Category | Paths | Purpose and provenance |
| --- | --- | --- |
| Synthetic services and adversarial tools | Root scripts, `scripts/`, `browser/`, `evil-skill/`, `config/`, `coupon/` | Deterministic stubs, injection/refusal checks, offer vectors and signed test approvals. Test roots and credentials are synthetic authority. |
| Synthetic documents and UI | `docs/`, `snapshots/` | Fictional selected-file/disclosure inputs and terminal snapshots; no user documents. |
| Generated bundles | `bundle/fixture*`, `bundle/pre-settlement/`, `bundle/make-fixture.mjs` | Task/receipt integrity and negative attestation cases. `FIXTURE` marks development evidence; generated signatures are not production execution. |
| Recorded runner evidence | `bundle/recorded-runner/` | Historical compose, attestation and receipt bytes used by bundle verification. Their captured identity is not proof of a current task or service. |
| Recorded provider evidence | `near/`, `aci-upstreams/` | Captured NEAR reports/signatures and ACI session/receipt inputs for verifier replay and refusal tests. Captured TCB and nonces apply only to the recording. |

Adjacent verifier fixtures also live in `aci/verifier-ts/test/fixtures/`; Pi keeps
upstream test inputs in its own workspace. Preserve their licenses and notices.
For a new recording, state its source/date, exact consumer, synthetic versus
recorded status and redactions in a sibling provenance note. Omit auth/cookie
headers, bearer tokens, user prompts and raw operator state. Existing recordings
remain historical test inputs; this index is not a fresh byte-level secret audit.
