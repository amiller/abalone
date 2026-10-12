<p align="center"><img src="docs/assets/abalone-shell-light.svg#gh-light-mode-only" width="360" alt="Line drawing of an abalone shell: an asymmetric ear-shaped outline, growth lines, and a row of breathing holes along one edge."><img src="docs/assets/abalone-shell-dark.svg#gh-dark-mode-only" width="360" alt="Line drawing of an abalone shell: an asymmetric ear-shaped outline, growth lines, and a row of breathing holes along one edge."></p>

# Abalone

Abalone, a cypherpunk AI privacy shell. Give your user an incognito session using TEE-based private inference.

A session sends each request encrypted to a model whose attestation Abalone has
checked. Around the agent, Abalone also controls the environment: a bubblewrap
sandbox, egress limited to admitted hosts, and canary values that the disclosure
gate refuses to send out. In this release these come from two launchers:

- `abalone credit session`: the coupon route. Direct NEAR inference, the
  conversation kept in memory only, run as your own user without a sandbox or
  canaries (the owned-host profile in [security details](docs/security.md)).
- `abalone sandbox [folder]`: the bubblewrap session, with egress limited to
  admitted hosts and canaries required in the folder (`abalone canary init`)
  unless started with `--no-canaries`. Models come from
  [providers.json](providers.json).

The credit session's model is NEAR, attested. The sandbox's model is an admitted
provider whose attestation Abalone verifies, or a local model. Without
`--incognito`, the sandbox can also send text to a frontier model through
`ask_frontier`, after the disclosure gate approves it; the canaries guard that
path. There is no mode for an unverified provider key yet.

You need a Linux x86_64 computer you trust, with Node 24. Use synthetic,
non-sensitive material.

## Run abalone

Plain `abalone` is the front door. With one ready (installed) credit it starts
that credit's session; with several it lists them. With nothing saved it names
the two ways in: paste a gift link or code at its prompt, or bring a provider
key ([acquiring private inference](guides/acquiring-private-inference/README.md))
and save it with `abalone key add <provider>`, which `abalone sandbox` uses and
plain `abalone` does not.
A pasted gift is inspected, its terms are shown, and after you type the first 8
characters of its offer hash it is redeemed and the session opens, in one run.
Install first with `install.sh --credit`. The same steps one at a time are
`abalone credit inspect`, `redeem`, `recover`, `status`, `session` and `forget`.
`abalone help` lists every command.

## Get access

- **Coupon:** someone gives you a gift link, and an issuer on the
  [Dsmack](https://github.com/amiller/dsmack) network turns it into model access.
  [Redeem a coupon](docs/abalone-coupon-redeem.md) has the procedure.
- **Your own provider key:** `abalone key add <provider>` saves a key for a
  provider in [providers.json](providers.json), read from hidden standard input
  or a 0600 file. `abalone sandbox` uses it; plain `abalone` does not yet
  ([#21](https://github.com/amiller/abalone/issues/21)). There is no local
  spending cap; the provider's limit applies.
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
  one reason it is for synthetic material only.
- Your own computer is trusted. Local tools have your account's file and network
  access, and the administrator can inspect the session's memory. Nothing enforces
  that your setup agent stays out of the session; it stays out by following the skill.

Abalone does not hide your IP address. `abalone credit session` and
`abalone sandbox --incognito` keep the conversation in memory only; `abalone
sandbox` without `--incognito` keeps a resumable Pi session under
`~/.abalone/agent`. Optional encrypted traces, files you write and terminal
scrollback have their own lifetimes.

After a session closes, `~/.abalone/credit` keeps the gift code, the model
credential and the recovery keys until `abalone credit forget` removes them; no
conversation file is written by default. One session at a time uses a credit; a
second is refused while the first runs. A fresh session is not deletion; see
[local host and retention](docs/security.md#local-host-and-retention).

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
