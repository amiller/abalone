# Development gift trial

This source trial joins the actual `/dsmack/coupon/4` recipient command to an
interactive incognito Pi session and the strict direct NEAR adapter. It is not
an installable release. Supported profiles are explicitly selected in `trial.platform`: Linux/Node 24
with bubblewrap (`linux-node24-bubblewrap`) or the trusted-owned-host profile
(`linux-node24-owned-host`) without OS isolation. The latter is the current
recipient profile; it is not a fallback after containment fails. Native macOS recipient parity is not qualified; the existing Mac
network participant is a separate role.

Use synthetic, non-sensitive prompts only. The signed debug-staging approval
still requires `prompt_policy: "synthetic-only"`. The operator may know, use or
revoke the API key. The issuer is not a prompt relay: the launcher separately
admits fresh NEAR gateway/model quotes, signed NVIDIA evidence and Base compose
admission, then encrypts directly to the admitted model through pinned transport.
Private issuer custody, rollback safety and settlement remain unqualified.
Incognito defaults to session-only conversation retention; `--keep-trace` explicitly retains an encrypted trace; it does not establish VPN anonymity, erase
workspace files or prevent a privileged host from reading process memory.

## Source-wrapper commands

From the reviewed, built source checkout, receive a **public** trial directory
containing `trial.json`, `issuer-pin.json`, the exact signed staging approval,
and the reviewed source hashes. The default profile is
`debug-staging-incognito-synthetic-prompts`, with `vpn: null`: VPN is not a
prerequisite for this standalone incognito milestone. Keep the gift separate.
No coupon, provider key, authority signing key or operator config belongs in
this directory. Relative public artifact paths remain inside the directory;
the directory can be moved without private sibling paths.

```sh
node tools/coupon-first-use.mjs preflight --bundle /ABS/trial.json
node tools/coupon-first-use.mjs run --bundle /ABS/trial.json
```

The operator provisions the selected Linux environment and public trial bundle
before handing over the environment. The recipient enters only the gift and
reviews its consent. No trace key or passphrase is needed by default. Selecting `--keep-trace` explicitly initializes an encrypted key with a hidden passphrase before gift entry if no key exists; writing later traces uses only its public recipient.
Preflight checks the local candidate/build,
curated Pi/ACI closure, selected host prerequisites, state conflicts, public issuer/approval
pins. If the operator selects an optional VPN profile, preflight also checks
its bounded read-only observations. It does not dial the issuer,
contact a paid API or read the gift. `run` repeats preflight, verifies genuine
issuer identity on the retained Noise connection, then reads the gift at the
hidden terminal prompt. Review the offer and type exactly:

```text
CLAIM DEBUG STAGING SESSION
```

The command hands the terminal to Pi after encrypted delivery. Try:
`Invent a name and a two-line poem for a fictional moon bakery.` The prompt
restriction is an approval boundary; software cannot identify all sensitive
content automatically. `/coupon` shows the state. `/coupon forget` closes the
session after confirmation. Exit clears the process's coupon identity, delivery
key and credential references; it does not revoke the upstream key or securely
erase host memory. Pending delivery uses `WAIT SAME KEYS`; interrupted delivery
uses `RETRY SAME KEYS`, within the original process. Leaving loses those keys.
Neither recovery nor provider admission renewal creates a replacement gift.
Signed approval expiry stops further bearer requests and provider effects;
an earlier claim may still exist and require operator reconciliation.

Automation may supply the gift on a dedicated anonymous descriptor through
`ABALONE_COUPON_FD` (3–63). Consent and trace passphrase have their existing
separate descriptors. The wrapper forwards them explicitly; never put a gift
or key in argv, environment values, command history or a model prompt.

The release installer does not start this trial. Its `--credit` option installs
the durable-credit runtime described in [access and installation](redeem.md).

## Exact public inputs

[The schema](coupon-first-use.schema.json) describes version 1.
[The example](coupon-first-use.example.json) is an **incomplete template**:
`null` values and the empty source map deliberately fail preflight. They are
not fixture-selected live authority, model, budget or route pins.

| Input | Required value |
| --- | --- |
| Issuer | Actual advertised `/p2p` multiaddr and approved route description |
| Identity pin | Exact `identityPolicy`, `expectedIdentityPolicySha256`, `expectedIssuancePolicySha256`, `expectedIssuerPublicKeySha256` |
| Staging | Exact canonical signed approval bytes and independently supplied 64-hex Ed25519 root **public** key |
| Provider | Explicit NEAR model, `https://cloud-api.near.ai/v1`, gateway/model `UpToDate` by default (explicit warning trial below), required GPU signature, Base 8453 at `https://mainnet.base.org`, 512-token bound |
| Source | Reviewed candidate's selected source/lock/build SHA256 map; curated manifest verifies its complete admitted trees |
| VPN | `null` for standalone incognito; optional reviewed profile/report only for a separately selected later VPN trial |

## Explicit firmware warning trial

Default admission requires gateway and model `UpToDate`. For the authorized
synthetic, non-sensitive $5 trial only, the operator may set **both**
`provider.policy.gatewayTcb` and `provider.policy.modelTcb` to
`UpToDate-or-OutOfDate-with-warning` in the public bundle. The wrapper translates
this explicit choice to `--allow-out-of-date-trial`; the direct coupon command
accepts that flag only with signed debug staging. A signed approval must cap each
coupon and the entire trial at no more than 5000000000 nanoUSD; the token bound remains 512.
The strict template stays unchanged. No ambient provider setting selects the
exception.

This permits only cryptographically verified `UpToDate` and `OutOfDate`, with a
warning before gift entry/consent and actual component statuses and Intel advisory
IDs before every fresh provider admission, including lease renewal. Every other
TCB status, bad signature, stale evidence, broken nonce/key/measurement/TLS binding,
unapproved compose or failed NVIDIA check still refuses. Accepting known firmware exposure does not establish private guarantees. Only synthetic,
non-sensitive prompts are authorized. Prompt sensitivity is a consent rule,
not an automatic content classifier. No live gift/inference success is asserted
by this option or its offline tests.

## Separate later portable-agent and node-provided VPN milestone

ProtonVPN is a later milestone, not a gift/incognito launch requirement.
The legacy `debug-staging-synthetic-prompts` profile preserves the historical
VPN qualification experiment for a separately selected later trial. The default incognito profile does not provide or
claim VPN privacy. VPN setup and credentials are operator responsibilities.

Preflight checks matching file hashes, not authorship of the bundle or report.
Obtain their pins independently from the operator/reviewer. A report hash is
not a generated proof of a kill switch. No actual OS VPN profile or real loss
report is supplied in the public template: the legacy VPN trial profile with
`vpn: null` yields `vpn_not_qualified` before gift entry. This wrapper does not configure a VPN or
install firewall rules. Profiles without inspectable matching nft lockdown
rules are not supported by these observations and remain pending qualification.

Establish the selected existing VPN and its OS lockdown using that profile's
reviewed manual steps. Capture the exact current rules and routes read-only:

```sh
nft -j list ruleset > /ABS/vpn-rules-observed.json
sha256sum /ABS/vpn-rules-observed.json
ip -4 -j route get <PROFILE_IPV4_OBSERVATION_TARGET>
ip -6 -j route get <PROFILE_IPV6_OBSERVATION_TARGET>
```

The operator must supply the actual profile-specific enable/disconnect/reconnect
commands and privileges; none are guessed here. Qualification must capture the
physical interface, DNS/IPv6, peer dial and upgrades, verifier collateral, Base
RPC and direct provider traffic for the full launcher process tree. In an
authorized controlled test, disconnect that VPN while a non-sensitive provider
request is active: the request must fail, and capture must show no traffic on
the ordinary path. Restore it and repeat the positive control. Record the exact
commands, candidate, interface and results in the pinned report. Matching route
and ruleset observations do not repeat that real loss test. See the existing
[VPN qualification boundary](vpn-qualification.md); its veth fixture is synthetic.

## Local verification and live qualification

```sh
DSMACK_CODE_DIR=/ABS/reviewed-dsmack-source \
  node tests/coupon-session-e2e.mjs --attested
node --test tests/coupon-attested-session.test.mjs tests/coupon-first-use.test.mjs
make verify-offline
```

The paired fixture exercises the actual async service, Noise connection, consent,
same-key polling, encrypted delivery, broker, Pi and cleanup with synthetic
issuer/provider evidence. It does not qualify genuine hardware, private custody,
live provider behavior, funds or VPN loss. Record both source revisions and the
actual host profile; evidence for a sandbox is not evidence for owned-host use.

The issuer operator supplies independently reviewed public identity, approval,
source/build, route, provider and readiness inputs. Keep protected deployment
configuration, signing keys, provider accounts, rollback inventory and private
management instructions outside the recipient package. The recipient needs no
issuer SDK bootstrap or private deployment packet.

A signed `base-mainnet-rpc-safe-debug-v1` confirmation descriptor uses chain 8453
and `https://mainnet.base.org` with the operator's host clock. It trusts RPC `safe`
state, not independent Ethereum L1 finality. Ambiguous issuance remains
nonretryable; a provider effect cannot be undone afterward. The explicit profile
allows at most $5 per coupon and in aggregate, with rollback qualification false
and synthetic-only consent. NEAR model-governance admission is a separate check.
The older Sepolia guard profile has distinct signed terms; do not substitute one
for the other. See [release qualification](release.md) and
[the coupon protocol](protocols/coupon.md).
