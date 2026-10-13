<p align="center"><img src="docs/assets/abalone-banner-light.png#gh-light-mode-only" width="556" alt="Abalone, a cypherpunk AI privacy shell. A cartoon abalone peeks out from under its mottled shell, eye stalks up and smiling, beside the wordmark."><img src="docs/assets/abalone-banner-dark.png#gh-dark-mode-only" width="556" alt="Abalone, a cypherpunk AI privacy shell. A cartoon abalone peeks out from under its mottled shell, eye stalks up and smiling, beside the wordmark."></p>

# Abalone

**Use private inference with your usual coding agent.**

Abalone provides guides and focused provider integrations for private inference:
choose how to get access, check the provider, and protect the requests your agent
sends. Start with your usual agent; the included Abalone client is an optional
way to see its connections, local protections and retention together.

[Guides](guides/README.md) · [Website](https://amiller.github.io/abalone/) · [Security](docs/security.md)

## Start with private inference

**Already have private inference access?** Try the
[Chutes integration for ordinary Pi](guides/private-inference/pi.md). It checks
instance evidence and encrypts complete requests, including tool calls. Pi keeps
its usual tools and interface; no coupon software or Abalone launcher is needed.
This source preview uses published Pi 1.1.0 and its own small dependency package.
It has not been published to npm or qualified as an installed release.

**Looking for private inference access?** Read the
[acquiring private inference guide](guides/acquiring-private-inference/README.md).
The guides describe choices independently of the client; reading them needs no
installation. Individual procedures state their own requirements and status.

**Have a gift link or paper wallet?** Use the
[gift redemption procedure](docs/abalone-coupon-redeem.md). Existing released
coupons deliver NEAR access and open in the included client. The new
[optional acquisition tool](plugins/coupon/README.md) can redeem without opening
an agent. A NEAR coupon is not a credential for the Chutes Pi integration.

Provider integrations are open to any private inference provider. Each needs its
own tested verification and request protection; an ordinary API endpoint is not
a substitute for those checks. Chutes is the first standalone Pi integration;
[the provider integration guide](verifiers/README.md) describes adding others.

## Try useful work

The [Pi guide](guides/private-inference/pi.md) includes a small example: summarize
a meeting, answer a question and edit the file. You can instead work in a folder
you choose, or start with a question. There is no need to populate a workspace
before talking to the model.

## The optional Abalone client

The included client launches Pi with an explicit local policy. Its compact view
shows the inference destination, whether evidence has been checked, shell
network access, filesystem boundary and conversation or trace retention.
`/banner art` adds a small shell; `/banner compact` returns to the status view.
Those display changes are in source and require a new client release.

The released gift route runs tools with your ordinary account's access. The
separate Linux sandbox limits filesystem access and shell networking. Temporary
state and encrypted traces are explicit client choices; a provider integration
alone does not supply them. See [getting started](docs/getting-started.md) and
[what the client keeps](docs/security.md#local-host-and-retention).

[The released client setup](docs/abalone-coupon-redeem.md#what-installsh-does)
explains its installer and the manual alternative. Installation places files in
your home directory and adds a launcher; it is separate from using the guides or
loading the focused Pi integration. A simpler one-download client distribution
is [being developed](https://github.com/amiller/abalone/issues/44).

## What incognito means here

In the included client's incognito mode, conversation history is not saved by
default. Managed temporary state uses memory-backed storage; an encrypted trace
is retained only by explicit choice. Saved private inference credentials can
survive the conversation. Workspace edits, terminal captures and memory swap
have their own lifetimes. Ordinary Pi's `--no-session` controls conversation
history but does not provide all of this client's temporary-state preparation.

## What the checks establish

Provider verification checks hardware evidence and binds protected requests to
an attested key. It does not establish your computer's security, tool isolation,
network anonymity or audited provider retention. Chutes' checked VM measurements
do not bind its serving code or prove which model answered.

The current NEAR gift trial permits an explicit outdated-firmware exception and
is for synthetic, non-sensitive material. Its operator can access and revoke the
credential. The [security document](docs/security.md) gives route-specific limits.

## Explore and contribute

- [Private inference guides](guides/README.md): providers, acquisition and network choices
- [Provider integrations](verifiers/README.md): coverage and extension points
- [Development and build instructions](CONTRIBUTING.md)
- [Roadmap](docs/roadmap.md), [issues](https://github.com/amiller/abalone/issues) and [security reporting](SECURITY.md)
- [Architecture](docs/architecture.md) and [documentation index](docs/README.md)

First-party code is [MIT licensed](LICENSE); preserve [component notices](THIRD_PARTY_NOTICES.md).
