# Abalone product roadmap

Abalone is a curated skill for using private inference to set up an incognito
window. Easy onboarding is the product: receive a coupon, start private inference,
complete a useful task, and close with a clear account of what remains. The current
CLI and minimally patched Pi client provide reference mechanisms for that skill;
they do not turn Abalone into a node-operations platform. Incognito remains optional
for ordinary use; this ordering does not change ordinary-session defaults.

DSMACK is a peer-to-peer router for private inference. Coupon redemption and
API-key routing belong to that product, while Abalone guides their use through
one understandable entry experience. Backend provisioning belongs to operators,
not the recipient.

## First milestone: one usable $1 route

Qualify one bounded route from a $1 coupon to a useful incognito session on a
supported machine. The guide explains the actual provider/model, privacy boundary,
amount and units, expiry, caps, remaining authority and retention before redemption.
The recipient does not operate a node or supply provider-management credentials.
Prioritize an on-chain-only coupon entry using a locally generated fresh spending
secret, without an existing account, email, card or manually supplied API key.
Anonymous redemption is a target, not a property established by a fresh public
wallet: qualify the observer model, funding/spend links and transport metadata
before advertising it. The current debug NEAR candidate does not establish that
target. A separately qualified access mode remains usable without pretending it
closes the anonymous-redemption work.

An operator or setup agent prepares the environment and rehearses with synthetic
material, then steps aside before the user's private input. Same-user
non-observation is cooperative unless a separate boundary enforces it.

A route must pass its privacy, model and budget requirements before use. Select
among eligible routes by latency only after those requirements pass. One qualified
route is sufficient for this milestone; supporting every provider or delivery mode
is not required. The [gift acceptance contract](gift-public-preview.md) separates
this first journey from broader funded/private release qualification.

Accept the first milestone when a newcomer follows public acquisition and guided
redemption, receives the stated bounded entitlement, completes a useful task,
understands its destinations and limits, and closes without automatic private
content escaping to the setup agent. Demonstrate an applicable disclosure refusal
and understandable expiry, unavailable-service and ambiguous-claim behavior. A
separate smoke coupon must not consume the recipient's coupon. Record the revision,
environment, elapsed time, actual outcome and any intervention; tests or screenshots
alone do not establish this journey.

## Access and delivery modes

Funding source and delivery mode are separate choices. Pool-owned stake/assets
and retained-owner provider-account allowance have different funding authority.
Neither determines where prompts travel or who can see them. Provider-native
credit, a capped key and a wallet are delivery instruments, not funding sources.

| Mode | Recipient experience and qualification |
| --- | --- |
| Direct provider access | Redeem into provider-native credit, a capped inference key, or a recipient wallet where the accepting provider actually supports that instrument. Abalone verifies the named endpoint, model/privacy profile, units, caps and authority, then calls the provider directly. A wallet address alone is not spendable API credit. |
| DSMACK routed balance | Redeem a bounded router balance backed by contributed provider keys or separately qualified capacity. The router selects only eligible provider/model routes and accounts for the shared balance. Disclose the router's access to plaintext and the contributor/provider's revoke, expiry and cap powers. |

Both modes use the same simple guide and consent experience; backend setup and
operator credentials stay out of the recipient flow.

A coupon allocates entitlement to one delivery mode. It must not also fund the
other mode, create a second full balance during fallback, or restore spent credit
on retry. Changes and recovery preserve original entitlement minus settled usage
and unresolved exposure; an unavailable route is not permission to duplicate it.

A capped provider key draws from shared account funds; it is not a reserved
credit purse. State the shared exposure, enforcement and possible cap overshoot.

The current direct NEAR coupon candidate and its reviewed issuer, encrypted
delivery, model-admission and session evidence remain useful. Its live status is
recorded in the [trial instructions](coupon-first-use.md); it is not evidence that
provider-native wallet payment or instant NEAR wallet-to-API credit is available.
The existing NEAR adapter encrypts/decrypts in its host, currently the recipient
host broker. If hosted by a remote DSMACK router, it would expose plaintext
requests and responses there while constructing provider E2EE traffic. That new
router is not implemented or qualified by the current adapter. Recipient-side
encryption through an opaque relay requires a new protocol and qualification.

## Incognito lifecycle and handoff

The session contract specifies admitted inference, workspace/tool authority,
outbound disclosures, persistence and return to the outside agent. Permission to
read does not automatically authorize tools to send that context elsewhere;
enforcement must not rely solely on the model resisting prompt injection. Preserve
Nacre's welcoming character and a clear transition into private work.

Current incognito retains an encrypted recoverable trace and cleans up temporary
session state. Workspace output files can remain. Never-persist, deletion, secure
erasure, trustworthy-host isolation and network anonymity are separate properties.
See the [handoff requirements](../notes/private-room-handoff.md) and
[trace contract](../notes/contracts/trace-store.md).

Incognito has no VPN or IP-hiding requirement. The launcher and broker use host
routing; incognito alone does not hide the original IP. Portable USB/Tails and
node-provided VPN are a separate milestone. Its privacy profile must confine the
whole launcher, broker, DNS, login/bootstrap, RPC, attestation and inference traffic
from the first network operation, fail closed without direct fallback, and separate
wallet/API/peer/browser/session identities from ordinary use. Reusing an identity
or identifiable funding can preserve links even under protected routing. See
[Journey 0, J0.5](../notes/journey-0-audit-to-private-session.md) and the
[network qualification plan](vpn-qualification.md).

## Follow-on milestones

- Qualify a second eligible delivery route, then compare latency within the same
  declared privacy/model/cap tier. Explain selection, failure and recovery without
  weakening admission or duplicating coupon value.
- Improve ordinary connected private work, Activity and existing-browser integration.
- Qualify portable network isolation and node-provided VPN with their own supported
  environments, identity/persistence choices and route-loss evidence.
- Develop pooled funding and provider-capacity acquisition as an orthogonal DSMACK
  track. Treasury authority, staking, supplier accounting, withdrawals and settlement
  need their own contracts; they are not dependencies of the first $1 journey.
- Continue [credential redemption](credential-redemption.md), delegated remote
  tasks and broader research without turning Abalone into a node-operations product.

The [public backlog](https://github.com/amiller/abalone/issues) and
[milestones](https://github.com/amiller/abalone/milestones) track current work.
Historical private issue numbers and evidence retain their original scope; do not
assume they identify current public tasks or demonstrate a new route.

## Lean maintenance

Prefer configuration, curated skills and small upstreamable Pi changes. Record
why each maintained patch is needed and how to rebase or remove it. Keep provider
admission criteria explicit and provider-neutral. Evaluate additions by the user
journey they improve and the trust or maintenance burden they introduce.

Source publication, installable-release qualification and a successful live user
journey are separate evidence. Preserve reviewed source/fixtures, licensing and
notices, clean build and installed checks, release provenance, security reporting
and maintainer procedures. Integrating this roadmap does not publish, deploy,
spend funds or close any milestone.
