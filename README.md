<p align="center"><img src="docs/assets/abalone-banner-light.png#gh-light-mode-only" width="556" alt="Abalone, a cypherpunk AI privacy shell. A cartoon abalone peeks out from under its mottled shell, eye stalks up and smiling, beside the wordmark."><img src="docs/assets/abalone-banner-dark.png#gh-dark-mode-only" width="556" alt="Abalone, a cypherpunk AI privacy shell. A cartoon abalone peeks out from under its mottled shell, eye stalks up and smiling, beside the wordmark."></p>

# Abalone

Abalone, a cypherpunk AI privacy shell. Give your user an incognito session using TEE-based private inference.

[Website](https://amiller.github.io/abalone/) · [Guides](guides/README.md) · [Security](docs/security.md)

## The problem

Run a coding agent against a model API. The provider can read your prompts, the
agent's tools inherit your account's files and network, and the transcript remains
after you close the terminal.

Put the model inside a trusted execution environment (TEE) and encrypt each request to
a key held there. The operator now handles ciphertext. But how do you know which
program holds that key? And what stops the agent from sending your files somewhere
else?

Abalone checks the remote program before sending a prompt, and starts the agent
without a saved conversation. Its separate sandbox mode restricts what the agent's
tools can reach.

## Who sees what

A session is a coding agent ([Pi](vendor/pi/)) started by Abalone, with the
environment arranged so that:

- **The provider handles ciphertext.** Before sending the first prompt byte, Abalone
  verifies the provider's attestation, the signed hardware evidence identifying the
  running program, compares its code fingerprint with the expected value pinned in
  [`verifiers/`](verifiers/), and encrypts each request to the key bound to that
  evidence. The operator still sees metadata: model name, request sizes, timing, and
  which account paid.
- **Tool connections are restricted.** In the sandbox session the agent's tools run
  under bubblewrap, a Linux isolation tool, with connections only to permitted
  destinations. Planted test secrets in your folder, and checks on outgoing text,
  reject the obvious leaks; they do not catch a paraphrase.
- **Credentials are separate from the agent.** They live in a small store on your
  computer, are supplied to the agent at launch for that session, and survive the
  session until you forget them.
- **Incognito disables saved conversation history.** Temporary agent state uses
  memory-backed storage and is removed at exit. Credentials, workspace files and
  terminal captures remain, and the docs say so plainly.

Each session reports an assurance level. Today a provider that fails verification is
refused; a lower level for providers Abalone cannot verify is planned, and will be
labelled as such.

Private inference providers protect the remote computation. Abalone checks the
provider's evidence and manages the local session; Tor and Tails address network
anonymity, and the [guides](guides/README.md) say how to combine them.

## Run it

A session needs a model. Pick where yours comes from.

**Own key or local model: source build; key setup lands in the next release.**
Build from source ([CONTRIBUTING](CONTRIBUTING.md); Linux x86_64, Node 24), then:

```
abalone key add <provider>
abalone canary init <folder>
abalone sandbox --incognito --model <provider>/<model>
```

`key add` reads the key from hidden input and checks it with the provider. Admitted
providers are listed in [providers.json](providers.json); a local model needs no key.

**Gift: the released installer.** Someone running
[Dsmack](https://github.com/amiller/dsmack) sends you a link. The
[redeem page](https://amiller.github.io/abalone/redeem) walks you through installing
the released client and turning the gift into a saved credit; after that, plain
`abalone` opens the session. The procedure, and what the installer changes, is in
[Redeem a coupon](docs/abalone-coupon-redeem.md).

**Zcash: planned.** Swap Zcash for a slice of model access and open the session. The
[acquiring guide](guides/acquiring-private-inference/README.md) tracks it.

Use synthetic, non-sensitive material for now. The current trial is a preview.

## What it does not do

- It does not hide your IP address; use it over Tor or from Tails for that.
- It does not verify what the provider retains after answering.
- The gift trial has no tool sandbox and accepts outdated platform firmware under an
  explicit warning; strong privacy guarantees remain unqualified while that holds.

## What incognito means here

Incognito is a property of the session, not of you. Saved conversation history is
off; the next session starts fresh. A fresh session is not deletion: the credential
stays in `~/.abalone/credit` until `abalone credit forget` removes it, workspace files
and scrollback keep their own lifetimes, and your own computer is trusted.
[Local host and retention](docs/security.md#local-host-and-retention) lists exactly
what each mode keeps.

On the gift route the coupon is redeemed with an issuer on the Dsmack network. Abalone
accepts the issuer only if its fresh admission matches the identity pinned in the
release, and the issuer delivers the model credential encrypted to keys your computer
generated. The issuer sees the coupon, not your prompts. The coupon's operator can
revoke the credential, and spending can overshoot the cap.

## Details

Plain `abalone` opens a saved credit's session, or asks for a gift if none is saved.
`abalone sandbox [folder]` is the developer session: bubblewrap, permitted-host egress,
planted test secrets required unless `--no-canaries`, models from `providers.json` or
local. Without `--incognito` the sandbox keeps a resumable session under
`~/.abalone/agent` and may pass approved text to a frontier model through
`ask_frontier`. The one-at-a-time commands behind the front door are `abalone credit
inspect`, `redeem`, `recover`, `status`, `session` and `forget`; `abalone help` lists
everything.

## Where to go next

- [Guides](guides/README.md): what private inference protects, how to pay for it, which network to connect from
- [Getting started](docs/getting-started.md) and [Redeem a coupon](docs/abalone-coupon-redeem.md)
- [Watch a synthetic PDF become meeting minutes](https://pod.dstack.soc1024.com/artifact-reports-2026c/abalone-coupon-pdf-meeting-minutes--lWMO2qY1hfbnqZdRWwg8cQ/) over a real coupon
- [Architecture and source layout](docs/architecture.md), the [documentation index](docs/README.md), [Contributing](CONTRIBUTING.md), [issues](https://github.com/amiller/abalone/issues), [security reporting](SECURITY.md)

First-party code is [MIT licensed](LICENSE); preserve [component notices](THIRD_PARTY_NOTICES.md).
