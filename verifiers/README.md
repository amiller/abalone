# Private inference provider integrations

Dsmack welcomes integrations for any private inference provider. Each provider
needs a clear account of what its evidence verifies and which request fields are
protected. The guides can be followed independently; client integrations bind
actual requests to the checked provider rather than merely checking once.

| Provider | Integration | Coverage |
| --- | --- | --- |
| Chutes | [Ordinary Pi source preview](../guides/private-inference/pi.md), also used by the optional client | Instance TDX/GPU evidence, pinned VM measurements and complete encrypted requests; serving code and model identity unqualified |
| NEAR | Existing optional Dsmack client | Gateway/model evidence, pinned TLS, encrypted text and custom protected tool protocol; current gift trial permits outdated firmware |

## Add an integration

A focused package should load without coupon acquisition or another agent's
session store. Keep provider-specific verification, request encryption and
credential handling together; use the agent's existing tools and interface where
the protected request format allows it. Follow the
[Chutes package](chutes/README.md) for an example.

Document actual Node, operating-system and architecture dependencies separately
from the platforms you tested. State the provider's metadata and retention
limits. Include bad-evidence, changed-key and corrupted-response checks, and
prove that a verification refusal sends no prompt. Check native tool arguments
and results as well as ordinary chat content.

Integrations for other agents can reuse the transport independently of Pi.
An ordinary provider-compatible endpoint may require fewer components but does
not automatically provide the same attestation and encryption coverage.
