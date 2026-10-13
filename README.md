<p align="center"><img src="docs/assets/abalone-shell-light.svg#gh-light-mode-only" width="360" alt="Line drawing of an abalone shell: an asymmetric ear-shaped outline, growth lines, and a row of breathing holes along one edge."><img src="docs/assets/abalone-shell-dark.svg#gh-dark-mode-only" width="360" alt="Line drawing of an abalone shell: an asymmetric ear-shaped outline, growth lines, and a row of breathing holes along one edge."></p>

# Abalone

Abalone, a cypherpunk AI privacy shell. Give your user an incognito session using TEE-based private inference.

## The problem

Start with the ordinary setup. You run a coding agent in a terminal and point it at a
model API with a key. It works, and here is who sees what. The model provider's
operators see every prompt in the clear, because the key only authenticates you, it does
not hide anything. The agent's tools run as you, so anything the agent decides to `curl`
can carry your files out. The key lives in the agent's config file, so it is now a
long-lived identity. The conversation is written to a session file so the agent can
resume it, and that file outlives the conversation.

Private inference providers fix the first leak: the model runs inside a TEE, and you
can encrypt each request to a key held inside it, so the operator handles ciphertext.
But a TEE claim on a pricing page is a claim. Someone has to check the attestation,
pin the measurement, and refuse when the check fails. And the other three leaks are on
your side of the wire, where no provider can help.

Abalone is the shell that closes all four.

## What it does, from the observer's seat

A session is a coding agent ([Pi](vendor/pi/)) started by Abalone, with the environment
arranged so that:

- **The provider's operator sees ciphertext.** Before the first byte leaves, Abalone
  verifies the provider's TEE attestation against pinned anchors (`verifiers/`) and
  encrypts each request to the key in the quote. What the operator still sees is
  metadata: model name, request sizes, timing, which account paid.
- **Tools cannot phone home.** In the developer session the agent's tools run in a
  bubblewrap sandbox with egress only to admitted hosts. Canary values planted in your
  folder are refused by a disclosure gate on anything the agent tries to send to an
  outside model, so a leak shows up as a refusal, not a surprise.
- **The agent never holds the key.** Credentials live in a small store on your
  computer, are handed to the agent at launch for that session only, and can be
  forgotten. A burned identity is replaced, not nursed.
- **Nothing of the conversation is written.** The conversation stays in process memory;
  run files sit on tmpfs and go at exit. Saved credentials, your workspace files and
  your terminal scrollback stay, and the docs say so plainly.

Each session reports an assurance level. Today a provider that fails attestation is
refused; a lower level for providers Abalone cannot verify is planned, and will be
labelled as such.

Related work in two sentences: every private inference provider exposes an
OpenAI-compatible endpoint, which gives you the claim; Abalone gives you the check,
and the clean environment around it. Tor and Tails give you network anonymity, which
Abalone does not; the [guides](guides/README.md) say how to combine them.

## Run it

A session needs a model. Pick where yours comes from.

**Your own provider key, or a local model.** Build from source
([CONTRIBUTING](CONTRIBUTING.md); Linux x86_64, Node 24), then:

```
abalone key add <provider>
abalone canary init <folder>
abalone sandbox --incognito --model <provider>/<model>
```

`key add` reads the key from hidden input and checks it with the provider; it ships
in the next release. Admitted providers are listed in [providers.json](providers.json).

**A gift from someone running [Dsmack](https://github.com/amiller/dsmack).** Open the
link they sent you. The [redeem page](https://amiller.github.io/abalone/redeem) walks
you through installing the released client and turning the gift into a saved credit;
after that, plain `abalone` opens the session. This is the route the released installer
ships today. The procedure, and what the installer changes, is in
[Redeem a coupon](docs/abalone-coupon-redeem.md).

**Zcash.** Planned: swap Zcash for a slice of model access and open the session. The
[acquiring guide](guides/acquiring-private-inference/README.md) tracks it.

Use synthetic, non-sensitive material for now. The current trial is a preview.

## What it does not do

- It does not hide your IP address; use it over Tor or from Tails for that.
- It does not verify what the provider retains after answering.
- The gift route runs as your own user without the sandbox, and today its provider
  verifies with a dated, visible out-of-date firmware warning.

## What incognito means here

Incognito is a property of the session, not of you. The conversation is held in memory
and not saved; the next session starts fresh. A fresh session is not deletion: the
credential stays in `~/.abalone/credit` until `abalone credit forget` removes it,
workspace files and scrollback keep their own lifetimes, and your own computer is
trusted. [Local host and retention](docs/security.md#local-host-and-retention) lists
exactly what each mode keeps.

On the gift route the coupon is redeemed with an issuer on the Dsmack network. Abalone
accepts the issuer only if its fresh admission matches the identity pinned in the
release, and the issuer delivers the model credential encrypted to keys your computer
generated. The issuer sees the coupon, not your prompts. The coupon's operator can
revoke the credential, and spending can overshoot the cap.

## Details

Plain `abalone` opens a saved credit's session, or asks for a gift if none is saved.
`abalone sandbox [folder]` is the developer session: bubblewrap, admitted-host egress,
canaries required unless `--no-canaries`, models from `providers.json` or local. Without
`--incognito` the sandbox keeps a resumable session under `~/.abalone/agent` and may
pass gate-approved text to a frontier model through `ask_frontier`. The one-at-a-time
commands behind the front door are `abalone credit inspect`, `redeem`, `recover`,
`status`, `session` and `forget`; `abalone help` lists everything.

## Where to go next

- [Guides](guides/README.md): what private inference protects, how to pay for it, which network to connect from
- [Getting started](docs/getting-started.md) and [Redeem a coupon](docs/abalone-coupon-redeem.md)
- [Watch a synthetic PDF become meeting minutes](https://pod.dstack.soc1024.com/artifact-reports-2026c/abalone-coupon-pdf-meeting-minutes--lWMO2qY1hfbnqZdRWwg8cQ/) over a real coupon
- [Architecture and source layout](docs/architecture.md), the [documentation index](docs/README.md), [Contributing](CONTRIBUTING.md), [issues](https://github.com/amiller/abalone/issues), [security reporting](SECURITY.md)

First-party code is [MIT licensed](LICENSE); preserve [component notices](THIRD_PARTY_NOTICES.md).
