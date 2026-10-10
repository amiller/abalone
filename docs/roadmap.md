# Abalone product roadmap

Abalone is a curated guide and a minimally patched Pi client. The first milestone
is a useful incognito session: the shortest intended introduction to private work.
Incognito remains optional. This ordering neither changes ordinary-session
defaults nor makes other supported ways of working less legitimate.

## First useful incognito session

The complete journey is: inspect the repository, acquire Abalone, rehearse with
synthetic material, hand over to the user, complete a useful private task, close,
and understand what remains. A fresh contributor should be able to reproduce it
without the maintainer's private workspace or operator credentials.

The first delivery path is commands for the user's own terminal. An outside
agent may help prepare and rehearse; private content arrives after handoff.
Same-user non-observation is cooperative unless a separate boundary enforces it.
Preserve Nacre's welcoming character and a clear transition into private work.

The session contract must specify admitted inference, file/tool authority,
outbound disclosures, persistence and return to the outside agent. Sensitive
context may intentionally enter admitted TEE inference. Permission to read does
not automatically authorize tools to send that context elsewhere. Enforcement
must not rely solely on the model resisting prompt injection.

Current incognito retains an encrypted recoverable trace. Decide and document the
introductory profile's retention semantics before stronger ephemeral claims;
no global retention-default change is implied. Never-persist, deletion, secure
erasure and network anonymity are separate properties.

The [GitHub milestone list](https://github.com/amiller/abalone/milestones) and
[issues](https://github.com/amiller/abalone/issues) track current work. Existing
admission issues #3 and #13, observable activity #4, entry point #10, source setup
#2 and acquisition/release #7 supply parts of the journey. Historical issue
findings must be reconciled against the selected candidate, not assumed current.

Accept this milestone when a newcomer completes a useful synthetic task through
the documented entry point, understands destinations and retention, sees a
meaningful disclosure refusal, and closes/returns without automatic private
content escaping to the setup agent. Record the revision, environment and limits.
Code presence, a passing unit test or a concept rendering alone is insufficient.

## Subsequent capabilities

The [Gift to first private inference public preview](gift-public-preview.md) is a
coordinated release milestone with dsmack: accountless first claim, network gas
sponsorship and a qualified VPN path. It can advance alongside the introductory
incognito milestone; it is no longer merely an unspecified later integration.

- Ordinary connected private work, richer Activity and provider choices.
- Existing-browser integration, including the extension journey.
- Portable USB/Tails environments with their own supported-profile qualification.
- dsmack client integrations, including the [credential recipient journey](credential-redemption.md)
  and the separate inference-routing path.
- Broader research and shared services.

These remain visible and may progress independently. They are not prerequisites
for the introductory milestone unless a specific demonstrated dependency demands it.
Operating a node, receiving a coupon and building a general platform are not
requirements for the first private session.

## Lean maintenance

Prefer configuration, curated skills and small upstreamable Pi changes. Record
why each maintained patch is needed and how to rebase or remove it. Keep provider
admission criteria explicit and provider-neutral. Evaluate additions by the user
journey they improve and the trust or maintenance burden they introduce.

Before a public release: settle first-party licensing, review source/fixtures and
assets, qualify a clean build and installed journey, establish CI and release
provenance, and provide security-reporting and maintainer procedures. A private
development repository does not establish public-release readiness.
