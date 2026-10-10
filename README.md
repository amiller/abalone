# Abalone

Abalone is a curated guide and a minimally patched Pi agent for private work:
admitted inference providers, selected skills, and deliberate disclosure and
retention. Its introductory experience is an incognito session. Incognito is
optional, not a requirement for every session or a claim about the most common use.

Point your existing coding agent at this repository. It helps inspect and set up
Abalone, rehearses with synthetic material, then steps aside so you can do useful
private work. This is the shortest intended path to a satisfying first use.
See the [first-session roadmap](docs/roadmap.md), [handoff
requirements](notes/private-room-handoff.md) and [acquisition journey](notes/journey-0-audit-to-private-session.md).

Abalone owns the client experience. The [gift first-use trial](docs/coupon-first-use.md)
joins authenticated `/4` redemption, encrypted credential delivery and a direct
attested NEAR model connection to an incognito session. The operator provisions
the Linux environment and public trial inputs; the recipient enters the gift
and reviews consent. Debug staging uses synthetic, non-sensitive prompts and
does not establish private issuer custody. The issuer service can remain closed
source for this initial trial. Portable-agent and node-provided VPN support are
separate later milestones; ProtonVPN is not required for incognito.

## Status and entry points

This is a development source candidate, not a qualified installable release.
Linux private sessions use Node 24 and bubblewrap. macOS support is narrower;
do not assume Linux isolation or portable USB/Tails support there. Incognito
currently retains an encrypted recoverable trace. An outside agent stepping
aside is cooperation unless the environment enforces a separate access boundary.

- [Contributing and building](CONTRIBUTING.md)
- [Gift redemption to incognito first use](docs/coupon-first-use.md)
- [Development workflow](docs/development.md)
- [GitHub backlog](https://github.com/amiller/abalone/issues)
- [Threat model and enforcement limits](docs/threat-model.md)
- [MCP delegated-work integration](docs/mcp-quickstart.md)
- [Task contract](notes/contracts/task-v1.md)

First-party code is [MIT licensed](LICENSE). Existing component copyrights and
licenses are preserved in [third-party notices](THIRD_PARTY_NOTICES.md).
See [security reporting](SECURITY.md). Source publication does not establish
live issuer/provider admission or completion of the funded private-preview gates.
