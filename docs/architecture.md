# Abalone architecture and repository layout

Abalone's public repository contains the client implementation and the source,
configuration, specifications and evidence needed to build and inspect it.
The entry skill coordinates setup; the launcher and its dependencies implement
the boundary. Private planning is not a build prerequisite.

## Runtime path

The [entry skill](../skills/abalone-incognito/SKILL.md) helps an outside agent
prepare a pinned distribution and hand its terminal to the user. The launcher
verifies the configured issuer, binds a coupon claim to local recipient keys
and the accepted offer, then receives an encrypted provider credential. A local
broker holds that credential while patched Pi uses the admitted remote model.
Inference goes directly to NEAR, independently of the Dsmack redemption channel.

Dsmack owns issuer operation, backing accounts and service deployment. Some
peer/task compatibility implementation remains in this tree because the current
client and tests use it. Extracting that implementation needs a separate interface
and dependency change; editorial cleanup does not alter those wire protocols.
The [security profiles](security.md) distinguish local host authority from
remote issuer and provider evidence.

## What belongs in the public repository

A maintained file should help an outsider use, build, verify, modify or understand
the implementation. Keep supported instructions and enduring specifications
public. Keep worker assignments, local release packets, personal feedback,
exploratory notebooks and abandoned variants in a private workspace or an issue.

| Path | Public purpose |
| --- | --- |
| `README.md` | Current status and one entry path |
| `LICENSE`, `THIRD_PARTY_NOTICES.md`, `SECURITY.md` | License, component provenance and private vulnerability reporting |
| `CONTRIBUTING.md`, `AGENTS.md`, `.github/` | Contributor setup, review policy and PR template |
| `.gitignore`, `.gitattributes` | Local state/build hygiene and file treatment |
| `package.json`, `package-lock.json`, `Makefile` | Locked runtime dependencies and verification commands |
| `bin/`, `lib/` | Launchers, client, verification, disclosure, trace, transport and compatibility implementation |
| `curated/` | Runtime extensions and exact hash admission manifest |
| `anchors/`, `providers.json`, `policy.json` | Verification roots and explicit model/disclosure policies |
| `skills/` | Entry instructions and supported analytical skills; experimental preparation guidance is labelled |
| `pi/` | Vendored Pi workspace used to build the reference agent |
| `aci/` | Provider and verifier packages used by the client |
| `contracts/` | On-chain contract implementation and tests for the paths that reference it |
| `tests/`, `tests/fixtures/` | Reproducible positive/adversarial checks and selected synthetic/recorded inputs |
| `tools/` | Build, installer, fixture recording, manifest and development-checkout tooling |
| `site/` | One supported hidden-entry gift landing source |
| `docs/`, `docs/protocols/` | User/security/build guides and maintained interface contracts |
| `evals/` | Skill evaluation harnesses, selected targets and scoring references |

Root `package.json` uses `"private": true` to prevent accidental npm publication;
it does not describe GitHub visibility. Root `.github/` contains a PR template,
not active release CI. Nested upstream workflow files are source, not root CI.

## Vendored source and generated files

Pi is a complete workspace with a build graph, including example workspaces.
Its file count is much larger than the Abalone-specific patch. Keep its package
manifests, locks, licenses and [component notices](../THIRD_PARTY_NOTICES.md).
A small intended patch is not a claim that the entire shipped runtime is small.
Before updating Pi, identify the upstream revision and local diff, rebuild its
workspace, review changed provider/tool behavior and run the relevant gate.
A documented repeatable upstream update procedure remains maintenance work.

ACI packages include source and committed generated `dist` trees. The client
imports generated modules and the curated manifest admits their hashes. Build
Pi before ACI because ACI adapters use generated Pi types. Removing generated
outputs, pruning Pi packages or replacing either tree with a dependency requires
a reproducible bootstrap and updated admission workflow first.

[Component notices](../THIRD_PARTY_NOTICES.md) record existing imports and licenses.
They do not imply every historical upstream reference is a fully specified
update procedure. Preserve provenance when making that procedure explicit.
