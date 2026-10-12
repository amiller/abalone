# Abalone

**An incognito session for working with AI.**

Abalone is a setup guide and a terminal app for bringing a document or question
to private inference. A gifted coupon provides model access without a provider
account or a manually supplied API key. Dsmack handles redemption; Abalone checks
the remote provider's attestation and encrypts inference directly to the model.

Your usual coding agent can explain the setup, inspect the installation, redeem
a coupon and save access for you. Then open Abalone in your own terminal for the
conversation. Keep the documents and questions you want private out of your
setup agent's chat. Saved access and conversation history are separate: closing
a conversation does not mean throwing away your model credential.

[Start with a gift](https://amiller.github.io/abalone/redeem) ·
[Read the setup skill](skills/abalone-incognito/SKILL.md) ·
[Inspect the architecture](docs/architecture.md)

## From a coupon to useful work

1. Ask your coding agent to read the setup skill. It explains what Abalone does
   and what installation changes before running anything.
2. Reuse saved access, bring a supported provider credential, or redeem a coupon.
   Your agent can inspect the offer, redeem when asked and test with synthetic input.
3. Open a fresh Abalone terminal. Read a document, ask a question, and close when
   finished. By default, managed conversation history stays in memory for that session.

[Watch a synthetic PDF become meeting minutes](https://pod.dstack.soc1024.com/artifact-reports-2026c/abalone-coupon-pdf-meeting-minutes--lWMO2qY1hfbnqZdRWwg8cQ/):
a real coupon, direct NEAR inference and useful output. The recording uses a
preinstalled app and scripted interaction; it does not show first-time setup.

## Start deliberately

Read the [setup skill](skills/abalone-incognito/SKILL.md) and
[access instructions](docs/friend-preview.md) for the supported distribution,
Linux requirements and current availability. Download and inspect the installer,
check its published digest, then run the inspected local file. A checksum helps
identify the bytes; it does not replace understanding what the script does.

The skill guides setup. The app supplies patched Pi, provider verification,
encryption and credential handling; a skill alone does not add those mechanisms
to another agent. [Architecture and source layout](docs/architecture.md) explain
what each component does and what you are trusting.

## What incognito means here

**Use synthetic, non-sensitive material with the available NEAR access route.**
It accepts verified firmware warnings, and the coupon operator can access and
revoke the model credential. Check [access conditions](docs/friend-preview.md)
before redeeming.

Abalone runs on a trusted Linux computer. Local tools have your account's file
and network access; the administrator remains trusted. Your setup agent stepping
aside is cooperation, not enforced exclusion. Incognito does not hide your IP
address. Optional encrypted conversation traces, workspace files and terminal
captures have separate lifetimes. See [security details](docs/security.md).

## Build and contribute

- [Build and contribute](CONTRIBUTING.md)
- [Documentation guide](docs/README.md)
- [Roadmap](docs/roadmap.md) and [issues](https://github.com/amiller/abalone/issues)
- [Security reporting](SECURITY.md)

First-party code is [MIT licensed](LICENSE); preserve
[component notices](THIRD_PARTY_NOTICES.md).
