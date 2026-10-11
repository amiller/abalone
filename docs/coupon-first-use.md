# Gift to first AI session: development trial

This source trial joins the actual `/dsmack/coupon/4` recipient command to an
interactive incognito Pi session and the strict direct NEAR adapter. It is not
an installable release. Supported recipient profile: **Linux, Node 24,
bubblewrap**. Native macOS recipient parity is not qualified; the existing Mac
network participant is a separate role.

Use synthetic, non-sensitive prompts only. The signed debug-staging approval
still requires `prompt_policy: "synthetic-only"`. The operator may know, use or
revoke the API key. The issuer is not a prompt relay: the launcher separately
admits fresh NEAR gateway/model quotes, signed NVIDIA evidence and Base compose
admission, then encrypts directly to the admitted model through pinned transport.
Private issuer custody, rollback safety and settlement remain unqualified.
Incognito defaults to session-only conversation retention; `--keep-trace` explicitly retains an encrypted trace; it does not establish VPN anonymity, erase
workspace files or prevent a privileged host from reading process memory.

## The user command

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

The operator provisions the Linux sandbox and public trial bundle
before handing over the environment. The recipient enters only the gift and
reviews its consent. No trace key or passphrase is needed by default. Selecting `--keep-trace` explicitly initializes an encrypted key with a hidden passphrase before gift entry if no key exists; writing later traces uses only its public recipient.
Preflight checks the local candidate/build,
curated Pi/ACI closure, Linux sandbox, state conflicts, public issuer/approval
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

For a checksum-pinned built artifact, the operator supplies the actual release
URL, installer digest and public trial bundle. Download and inspect the installer
before running it; do not use an unverified pipe-to-shell command. Its first-use
option is:

```sh
sh /ABS/reviewed-install.sh --trial /ABS/trial.json
```

This installs the pinned artifact and starts the same `/4` incognito wrapper.
Gift entry remains hidden. The legacy `redeem` installer option is a separate
historical path and does not implement this trial. The operator must provision
the selected retention mode and source/build pins for the actual artifact before handing it
to a recipient. No published artifact URL is asserted by these source instructions.

## Exact public inputs

[The schema](coupon-first-use.schema.json) describes version 1.
[The example](coupon-first-use.example.json) is an **incomplete template**:
`null` values and the empty source map deliberately fail preflight. They are
not fixture-selected live authority, model, budget or route pins.

| Input | Required value |
| --- | --- |
| Issuer | Actual private advertised `/p2p` multiaddr and approved route description |
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
coupon and the entire trial at 5000000000 nanoUSD; the token bound remains 512.
The strict template stays unchanged. No ambient provider setting selects the
exception.

This permits only cryptographically verified `UpToDate` and `OutOfDate`, with a
warning before gift entry/consent and actual component statuses and Intel advisory
IDs before every fresh provider admission, including lease renewal. Every other
TCB status, bad signature, stale evidence, broken nonce/key/measurement/TLS binding,
unapproved compose or failed NVIDIA check still refuses. The verified gateway
and Qwen platforms observed on 10 October were `OutOfDate`; accepting known
firmware exposure does not establish private guarantees. Only synthetic,
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

## Local evidence and the next live step

The focused composition check reuses the existing service/client fixture:

```sh
DSMACK_CODE_DIR=/ABS/reviewed-dsmack-source \
  node tests/coupon-session-e2e.mjs --attested
node --test tests/coupon-attested-session.test.mjs tests/coupon-first-use.test.mjs
make verify-offline
```

The first command exercises the actual async service, Noise `/4` connection,
offer consent, pending same-key polling, encrypted delivery, credential broker,
incognito sandbox Pi response and cleanup. Its issuer evidence and inference
provider are explicitly synthetic. It checks actual child argv/environment,
retained files and transcripts for the fixture bearer/key. It establishes no
genuine quote, real inference, live VPN loss result or private custody claim.

A live trial requires an operator-managed issuer. The service can remain closed
for this initial friend trial; recipients do not need its source, SDK bootstrap
commands or private deployment packet. The operator keeps image, protected
provisioning and deployment inventory in its private packet and supplies only
the public inputs described above. Before an authorized live run, the operator
must prepare:

- The reviewed image/compose and captured old compose/environment/state for rollback.
- Actual guest SDK bootstrap app/compose/issuer/peer/scope observations, then authority-signed approvals/config and NEAR account credentials through the protected pipe.
- Bounded coupon/aggregate allowance and expiry; guard address, code/issuer pins, the signed confirmation profile and its required checker inputs, courier/gas inputs and authorization for required transactions.
- The reachable private listener/tunnel route and exact advertised multiaddr.
- The approved explicit NEAR model, independently pinned public trial bundle, and operator-provisioned Linux incognito environment. A qualified VPN profile/report belongs to the separate later VPN milestone.

A signed Base mainnet trial uses chain 8453 and the exact
`base-mainnet-rpc-safe-debug-v1` confirmation descriptor. It trusts
`https://mainnet.base.org` to report a `safe` block and relies on the operator's
host clock for freshness. The recipient verifies the signed profile and issuer
identity; it does not independently verify chain state or Ethereum L1 finality.
RPC dishonesty or an Ethereum reorganization can invalidate the report, and a
provider effect cannot be undone afterward. Ambiguous issuance is quarantined
without automatic retry. This profile remains synthetic-only, at most $5 per
coupon and in aggregate, with rollback qualification false. Its warning appears
before gift entry and in the offer before consent. NEAR model governance on Base
is a separate, unchanged verification step. The legacy Ethereum Sepolia signed
guard profile remains separate and unchanged; Base `safe` is not a substitute
claim of independently verified finalized state.

A guarded create still requires the inputs of its signed confirmation profile. A funded settlement
reader is not a prerequisite for this unfunded intermediate trial. Keep deployment changes within the operator's authorized scope and keep
development staging private. The full
[friend gift public-preview acceptance](gift-public-preview.md) remains open.
