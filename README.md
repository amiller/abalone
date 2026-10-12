# Abalone

Abalone, a cypherpunk AI privacy shell. Give your user an incognito session using TEE-based private inference.

A session sends each request encrypted to a model whose attestation Abalone has
checked. Around the agent, Abalone also controls the environment: a bubblewrap
sandbox, egress limited to admitted hosts, and canary values that the release gate
refuses to send out. In this release these come from two launchers:

- `abalone credit session`: the coupon route. Direct NEAR inference, the
  conversation kept in memory only, run as your own user without a sandbox or
  canaries (the owned-host profile in [security details](docs/security.md)).
- `abalone sandbox [folder]`: the bubblewrap session, with egress limited to
  admitted hosts and canaries required in the folder (`abalone canary init`). Models come from
  [providers.json](providers.json).

In both, the session's model is an admitted provider whose attestation Abalone
verifies, or a local model. There is no mode for an unverified provider key yet.

You need a Linux x86_64 computer you trust, with Node 24. Use synthetic,
non-sensitive material.

## Run abalone

Plain `abalone` opens your saved access. With one saved credit it starts that
credit's session; with several it lists them. With nothing saved it says how to
get a credit from a gift: install with `install.sh --credit`, then
`abalone credit inspect` and `abalone credit redeem`. `abalone help` lists every
command.

## Get access

- **Coupon:** someone gives you a gift link, and an issuer on the
  [Dsmack](https://github.com/amiller/dsmack) network turns it into model access.
  [Redeem a coupon](docs/abalone-coupon-redeem.md) has the procedure.
- **Your own provider key:** not supported in the release
  ([#21](https://github.com/amiller/abalone/issues/21)). From a source checkout,
  `abalone node keys add <provider>` stores a key for a provider in
  [providers.json](providers.json) and `abalone sandbox` uses it.
- **Zcash:** todo. See [acquiring private inference](guides/acquiring-private-inference/README.md).

## What incognito means here

The coupon is redeemed with an issuer on the [Dsmack](https://github.com/amiller/dsmack)
network. Abalone accepts the issuer only if its fresh admission matches the
identity and policy pinned in the release. The issuer delivers a model credential
encrypted to keys your computer generated. From then on, Abalone checks the NEAR
model's attestation and sends each request encrypted to that model; the issuer
does not see your prompts.

What others can still do:

- The coupon operator can read and revoke the model credential. The operator or
  provider can end access at any time, and spending can overshoot the cap.
- The current NEAR route accepts verified out-of-date firmware warnings. This is
  why it is for synthetic material only.
- Your own computer is trusted. Local tools have your account's file and network
  access, and the administrator can inspect the session's memory. Nothing enforces
  that your setup agent stays out of the session; it stays out by following the skill.

Abalone does not hide your IP address. By default the conversation is kept in
memory for the session; optional encrypted traces, files you write and terminal
scrollback have their own lifetimes. See [security details](docs/security.md).

Read the installer before running it. A matching checksum shows the bytes are the
published ones, not that they are safe.

## Where to go next

- [Redeem a coupon](docs/abalone-coupon-redeem.md): the full procedure, what a release contains
  and what the installer changes
- [Getting started](docs/getting-started.md): using the session
- [Watch a synthetic PDF become meeting minutes](https://pod.dstack.soc1024.com/artifact-reports-2026c/abalone-coupon-pdf-meeting-minutes--lWMO2qY1hfbnqZdRWwg8cQ/),
  with a real coupon and direct NEAR inference
- [Guides](guides/README.md): what private inference protects, how to pay for it,
  which network to connect from
- [Architecture and source layout](docs/architecture.md) and the
  [documentation index](docs/README.md)
- [Contributing](CONTRIBUTING.md), [issues](https://github.com/amiller/abalone/issues)
  and [security reporting](SECURITY.md)

First-party code is [MIT licensed](LICENSE); preserve
[component notices](THIRD_PARTY_NOTICES.md).
