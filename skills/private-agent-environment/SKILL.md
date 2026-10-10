---
name: private-agent-environment
description: Prepare and maintain an Abalone agent environment with explicit host trust, persistence, credentials, model routes, recovery and teardown. Use for an owned host, encrypted portable USB environment or borrowed execution; distinguish proposed procedures from qualified boundaries.
---

# Private agent environment

**Reviewed E0 design; runtime profiles remain unqualified.** This skill is not in
Abalone's curated manifest and is not installed or enabled by adding this file.
It guides preparation; OS/runtime mechanisms enforce a boundary. Do not use its
presence, a successful model reply or a setup agent's report as qualification.

## Choose a declared boundary

Read [profiles](references/profiles.md) for USB, Mac or borrowed execution. For
the first qualification target, an owned Linux host, read
[owned Linux rehearsal](references/owned-linux.md). Preserve the user's chosen
profile; report missing support rather than silently substituting another host
or weaker route.

Before introducing private material, record a short environment contract:

- Host/platform and trusted operator; which agent, account and VM can read the
  workspace or administer the runtime; whether outside-agent privacy is
  cooperative or enforced.
- Durable state and disposable state, their locations and encryption coverage;
  unlock/key custody, terminal captures, swap, backups and crash remnants.
- Granted mounts, tools and destinations; credential origin and scope; main,
  auxiliary, delegated and fallback inference routes, including local servers.
- Stop/lock, restart, recovery, migration and removal procedures; who performs
  each, what requires user-held secrets, and the remaining limits.
- Each claim's status: proposed, source-inspected, independently tested, or
  qualified for an exact revision and host. Keep unknowns explicit.

Keep three claims separate: containing the agent to protect the host, protecting
locked state, and confidentiality of a running session from an administrator.
A separate account or ordinary VM does not establish the third. Local inference
does not hide prompts from the machine's administrator. Borrowed ordinary hosts
require trust in their operator; confidential execution needs separate verified
evidence and a bound session channel.

## Prepare, rehearse, hand over

Inspect the checkout's launcher, provider policy and skill admission before
choosing commands. At the inspected candidate, interactive private sessions
require Linux, Node 24 and bubblewrap. macOS client/remote commands do not imply
support for a private local session. `abalone setup --separate-user` prints
Linux administrator commands for a separate MCP service; it neither executes
them nor sets up encrypted storage. Do not invent a portable installer.

Use fresh synthetic state and no real credentials for rehearsal. Keep the whole
agent, extensions, tools and subprocesses inside the declared boundary. Proxy
environment variables alone do not enforce egress. A required-route or admission
failure must stop that operation; never fall back to direct networking, an
ordinary model or an unsandboxed process.

Have an independent actor check useful output, mounts, denied access, actual
outbound requests, state placement and recovery before describing the environment
as qualified. Include positive controls and the known administrator access.
If evidence or prerequisites are missing, return a bounded dependency report.
Do not collect private sessions to diagnose setup.

Hand the user a concrete launch/reopen instruction plus a plain explanation of
who receives input and what remains. End preparation captures and background
watchers before private input. A same-user outside agent stepping aside supplies
cooperation only. Returning or closing does not authorize sharing a transcript.

## Maintain the contract

On stop, distinguish process exit from storage lock and verify both when claimed.
On restart or migration, recheck revision, mounts, credentials and every route;
never reuse a pass result for a changed host or image. Recovery must preserve the
declared boundary and report absent freshness evidence. Test with synthetic
backups before depending on recovery. Deleting local files does not erase backups,
SSD remnants, terminal captures or provider copies; local key removal is not
provider credential revocation.

For evaluation and the bounded next implementation, see the
[E0 research and E1 design](../../docs/private-agent-environments-research.md).
