<p align="center"><img src="docs/assets/abalone-shell-light.svg#gh-light-mode-only" width="360" alt="Line drawing of an abalone shell: an asymmetric ear-shaped outline, growth lines, and a row of breathing holes along one edge."><img src="docs/assets/abalone-shell-dark.svg#gh-dark-mode-only" width="360" alt="Line drawing of an abalone shell: an asymmetric ear-shaped outline, growth lines, and a row of breathing holes along one edge."></p>

# Abalone

Abalone, a cypherpunk AI privacy shell. Give your user an incognito session using TEE-based private inference.

Abalone is a terminal shell around a coding agent (Pi). On the coupon route,
each request is encrypted to a NEAR model whose attestation Abalone has checked;
the session runs as your own user, with no sandbox. `abalone sandbox` adds a
bubblewrap sandbox, egress only to admitted hosts, canary values in your folder,
and a gate on text the agent sends to outside models (see [Details](#details)).

You need a Linux x86_64 computer you trust, with Node 24. Use synthetic,
non-sensitive material.

## Start

1. Download `install.sh` from the newest release whose tag starts with
   `v0.1.0-preview` on the [releases page](https://github.com/amiller/abalone/releases)
   (not a coupon bundle). Check `sha256sum install.sh` against the
   `install.sh SHA256` line in its release notes, read it, then run it:

   ```
   sha256sum install.sh
   sh install.sh --credit
   ```

   It installs into `~/.abalone-app/` and links `~/.local/bin/abalone`. It claims
   nothing and starts nothing. A matching checksum shows the bytes are the
   published ones, not that they are safe.
2. Run `abalone`. With nothing saved, it prints the two ways in and waits for a
   gift link.
3. Paste the gift link (it is not echoed). Abalone shows the offer's terms; type
   the 8 characters it names to accept, and the session opens. With your own
   provider key instead, `abalone key add <provider>` saves it for
   `abalone sandbox` (which needs bubblewrap).

Next time, plain `abalone` opens the saved credit's session.

## Where credit comes from

- **A gift coupon** from someone running [Dsmack](https://github.com/amiller/dsmack).
  An issuer on the Dsmack network turns it into model access; it sees the coupon,
  not your prompts.
  [Redeem a coupon](docs/abalone-coupon-redeem.md) has the step-by-step procedure.
- **Your own provider key:** `abalone key add <provider>` saves a key for a
  provider in [providers.json](providers.json), read from hidden standard input
  or a 0600 file. `abalone sandbox` uses it; plain `abalone` does not yet
  ([#21](https://github.com/amiller/abalone/issues/21)). There is no local
  spending cap; the provider's limit applies.
- **Zcash:** todo. See [acquiring private inference](guides/acquiring-private-inference/README.md).

## What it does not do

- It does not verify what the model provider retains.
- The coupon route accepts a verified out-of-date firmware warning from the
  NEAR model. Abalone makes no strong privacy claim for this route while that
  exception applies.
- It is not for real private material yet: the current trial is for synthetic,
  non-sensitive prompts only.

## What incognito means here

The coupon is redeemed with an issuer on the Dsmack network. Abalone accepts the
issuer only if its fresh admission matches the identity and policy pinned in the
release. The issuer delivers a model credential encrypted to keys your computer
generated. From then on, Abalone checks the NEAR model's attestation and sends
each request encrypted to that model; the issuer does not see your prompts.

What others can still do:

- The coupon operator can read and revoke the model credential. The operator or
  provider can end access at any time, and spending can overshoot the cap.
- Your own computer is trusted. Local tools have your account's file and network
  access, and the administrator can inspect the session's memory. Nothing enforces
  that your setup agent stays out of the session; it stays out by following the skill.

Abalone does not hide your IP address. A coupon session and
`abalone sandbox --incognito` keep the conversation in memory only; `abalone
sandbox` without `--incognito` keeps a resumable Pi session under
`~/.abalone/agent`. Optional encrypted traces, files you write and terminal
scrollback have their own lifetimes.

After a session closes, `~/.abalone/credit` keeps the gift code, the model
credential and the recovery keys until `abalone credit forget` removes them; no
conversation file is written by default. A second session on the same credit is
refused while the first runs. A fresh session is not deletion; see
[local host and retention](docs/security.md#local-host-and-retention).

## Details

In this release a session comes from one of two launchers:

- `abalone credit session`, which plain `abalone` runs for a saved credit: the
  coupon route. Direct NEAR inference, the conversation kept in memory only, run
  as your own user without a sandbox or canaries (the owned-host profile in
  [security details](docs/security.md)).
- `abalone sandbox [folder]`: the bubblewrap session, with egress limited to
  admitted hosts and canaries required in the folder (`abalone canary init`)
  unless started with `--no-canaries`. Models come from
  [providers.json](providers.json): an admitted provider whose attestation
  Abalone verifies, or a local model. Without `--incognito`, it can also send
  text to a frontier model through `ask_frontier`, after the disclosure gate
  approves it; the canaries guard that path. There is no mode for an unverified
  provider key yet.

Plain `abalone` with one ready credit opens its session; with several it lists
them. A pasted gift can also be the path of a 0600 file holding it. The same
steps one at a time, for scripts and recovery, are `abalone credit inspect`,
`redeem`, `recover`, `status`, `session` and `forget`. `abalone help` lists
every command.

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
