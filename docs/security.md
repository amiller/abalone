# Abalone security profiles

Security claims apply to the exact launcher profile, provider policy and deployed
service. A valid remote quote does not establish local host isolation, private
issuer custody, anonymous networking or deletion of retained data.

## Profiles and their boundaries

| Profile | Local boundary | Inference and retention | Qualification |
| --- | --- | --- | --- |
| Owned host: `linux-node24-owned-host` | Trusted ordinary account; **no OS isolation**; tools have its filesystem/network access | Direct admitted NEAR inference; session-only managed conversation retention by default; optional encrypted trace | Selected release candidate; complete public acquisition and handoff tracked in [issue 4](https://github.com/amiller/abalone/issues/4) |
| Isolated Linux: `linux-node24-bubblewrap` | Explicit bubblewrap mounts and network namespace; bash has its own restricted sandbox | Selected admitted/local model routes; incognito retention depends on explicit flags | Separate implementation/test profile; its evidence does not qualify the owned-host profile or every machine |
| Ordinary connected/MCP sessions | Configured disclosure gate and approval store; same-user callers can bypass local file permissions | Can disclose approved payloads; ordinary session, approval and output files can contain plaintext | Separate from the incognito gift journey; see [MCP setup](mcp-quickstart.md) |
| Separate-user MCP | Unix permissions separate the caller from private state; administrator remains trusted | Same disclosure rules and configured providers | Setup prints administrator commands; same-user socket tests do not qualify separate-user deployment |

A profile must be selected explicitly. Missing bubblewrap or a failed admission
check is never permission to silently weaken it. Runtime capability output must
be interpreted alongside the selected profile; it is not independent evidence
of enforcement.

## Current gift trial

The recipient is a Linux client. The selected issuer uses the Mac runner and an
ordinary Apple Containerization ARM guest. Apple App Attest binds runner code
identity, compose and fresh issuer key/policy evidence; it does not put issuer
secrets in Intel TDX or Secure Enclave custody. The host/operator and stand-in
KMS can read issuer secrets and control or revoke the delivered credential.
Mac issuer identity and recipient-provider admission are separate checks.

The signed profile is debug staging and permits synthetic, non-sensitive prompts
only. An explicitly selected firmware-warning trial can accept cryptographically
verified `OutOfDate` gateway/model platforms; actual warnings precede effects.
Bad signatures, stale evidence, broken bindings and other rejected TCB states
still refuse. Strong private guarantees are unqualified under this exception.
See the [gift trial](gift-trial.md) for exact input and approval rules.

NEAR inference is encrypted to the admitted model key and returned through a
pinned transport. Provider/model attestation checks precede the first prompt
byte. Verification errors do not authorize a fallback model, replacement
credential or automatic replay of an ambiguously charged request.

The trial's Base `safe` confirmation trusts the configured RPC and host clock;
it is not independent Ethereum L1 finality. Private issuance custody, rollback
protection, deposit settlement and anonymous funding remain unqualified. A
capped provider credential is not a segregated purse or a verified balance.

## Local host and retention

The administrator and same-user processes can inspect live memory, tools,
workspace files and terminal captures. Cooperative setup-agent handoff ends its
observation by agreement; it cannot exclude another process with those powers.
Neither incognito nor provider encryption gives IP anonymity.

What each mode keeps on this computer:

- `abalone` and `abalone credit session`: Pi runs with `--no-session`, so the
  conversation exists only in process memory. Pi's settings and logs, harness
  state and scratch go to a run directory on tmpfs (`/dev/shm/abalone-<uid>`),
  removed at exit. Nothing is saved to resume; the next session starts fresh.
- `abalone sandbox --incognito`: Pi also runs with `--no-session` and its agent
  directory is in the run directory, removed at exit. `--keep-trace` adds an
  encrypted trace in `.abalone/traces/` under a user-held key; see the
  [trace format and recovery](protocols/trace-store.md).
- `abalone sandbox` without `--incognito`: Pi keeps a resumable plaintext
  session under `~/.abalone/agent` until you delete it.
- Saved credit: `~/.abalone/credit/<id>.json`, mode 0600, holds the gift code,
  the delivered model credential, the recovery keys and reported token usage.
  It survives close. Abalone has no command that removes it; deleting the file
  does not revoke the credential.
- The model provider receives each request. Abalone does not verify what the
  provider retains.

A fresh session is not deletion. The administrator and same-user processes can
read all of the above while it exists. tmpfs may swap; workspace files, terminal
scrollback, the egress log's host names, backups, crashes and copied files have
their own lifetimes. Deleting files is not secure erasure.

## Disclosure and tool authority

The disclosure gate in `lib/gate.mjs` checks payload size and budget, permitted
answerer, control/bidi characters, planted canary forms, applicable JSON schema
and standing or human approval. Policy wording remains an instruction, not a
code-enforced secrecy proof; paraphrases and approved payloads can reveal private
information. No standing approval policy ships.

These checks govern managed disclosure paths. In the owned-host profile they
do not confine arbitrary tools or same-user processes. Incognito excludes the
managed outside-worker paths; it does not establish an account-wide network
firewall. The browser/CDP interface is a separate connected-session feature,
not permission to attach a browser during incognito use.

Ordinary MCP approval files are protected by account permissions, not exclusion
of same-user shell tools. A caller must have no direct shell/file access to the
private state or use a separately configured account. Root can still read and
modify it. Review [MCP setup](mcp-quickstart.md) before claiming separation.

## Verify a claim

Bind evidence to a source revision, exact configuration and environment. Inspect
actual child processes, mounts, outbound requests and retained files as well as
successful work and relevant refusal cases. Synthetic fixtures verify the paths
they exercise; recordings verify their captured evidence, not today's deployment.
[Fixture provenance](../tests/fixtures/README.md) explains the retained categories.
Use [private security reporting](../SECURITY.md) for sensitive findings.
