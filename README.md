<p align="center"><img src="docs/assets/abalone-banner-light.png#gh-light-mode-only" width="556" alt="Abalone, a cypherpunk AI privacy shell. A cartoon abalone peeks out from under its mottled shell, eye stalks up and smiling, beside the wordmark."><img src="docs/assets/abalone-banner-dark.png#gh-dark-mode-only" width="556" alt="Abalone, a cypherpunk AI privacy shell. A cartoon abalone peeks out from under its mottled shell, eye stalks up and smiling, beside the wordmark."></p>

# Abalone

Abalone, a cypherpunk AI privacy shell. Give your user an incognito session using TEE-based private inference.

[Website](https://amiller.github.io/abalone/) · [Guides](guides/README.md) · [Security](docs/security.md)

Start with a coding agent and a model API. You can ask it to work on your files,
but now the provider can read your prompts, the tools inherit your account's
access, and the conversation stays on disk.

Move inference into a trusted execution environment (TEE) and encrypt requests
to it. That protects the remote computation. You still need to check which
program receives those requests and control what happens on your own computer.

Abalone puts those checks around an agent session. It verifies supported
providers, keeps credentials out of saved agent configuration, and starts
incognito sessions without saved conversation history. Its skills and guides
cover sandbox setup and network security.

Already have private inference? Use Abalone to check your provider and keep the
session clean. Need a model? Start with the
[acquiring guide](guides/acquiring-private-inference/README.md) to choose a
provider and find how to buy access.

## Run it

There are three ways to bring a model.

**Your own key or a local model.** The sandbox is available from source on
Linux x86_64 with Node 24; follow [CONTRIBUTING](CONTRIBUTING.md).
See [providers.json](providers.json) for admitted routes and the
[getting-started guide](docs/getting-started.md) for configuration.
A local model needs no provider key.

```sh
abalone canary init <folder>
abalone sandbox --incognito --model <provider>/<model>
```

The simpler key setup command is planned for a future release:

```sh
abalone key add <provider>
```

**A gift from someone running [Dsmack](https://github.com/amiller/dsmack).**
The [redeem page](https://amiller.github.io/abalone/redeem) takes you through
the released installer and saves the delivered credential as a credit.
Then run `abalone`. See [Redeem a coupon](docs/abalone-coupon-redeem.md)
for the procedure and what the installer changes.

**Zcash, planned.** Pay for a slice of model access and open a session.
Invoice and payment detection have a testnet prototype; the swap is dry-run
only, and buying provider credit with the proceeds remains unresolved.

Today plain `abalone` opens a saved credit or asks for a gift.
Bringing keys and coupons into the same launcher, with sandbox capabilities
independent of how you acquired access, is planned.

## What happens in a session

Abalone launches [Pi](vendor/pi/). On a supported TEE route, it checks
attestation before sending the first prompt: signed hardware evidence binds
the running program to a key. Abalone compares the program's measurement with
the expected value in [`verifiers/`](verifiers/) and protects requests using
the attested key. The provider operator sees encrypted traffic, along with
metadata such as timing, request sizes and the paying account.

In `abalone sandbox`, bubblewrap limits filesystem access and network
connections to permitted destinations. Canaries are planted test secrets;
outgoing-text checks reject recognizable leaks. Ordinary connected sessions
also have a disclosure gate for text sent to outside models.

Abalone supplies the credential at launch. With a coupon, the issuer delivers
it encrypted to keys generated on your computer. The issuer sees the coupon;
prompts go directly to the model provider.

Private inference providers supply the remote computation; Abalone checks
their evidence and manages the agent's local session. Tor and Tails address
network identity; the [guides](guides/README.md) cover combining them.

## What incognito means here

The conversation stays in process memory, with no conversation file or trace
written by default. Temporary managed state uses memory-backed storage.
The next session starts fresh; saved access stays until you remove it with
`abalone credit forget`.

A fresh session is not deletion. Workspace files, terminal captures, backups
and crash artifacts have their own lifetimes, and memory-backed storage may
swap. Your computer remains trusted.
[Local host and retention](docs/security.md#local-host-and-retention)
records each mode's behavior. Without `--incognito`, the sandbox saves a
resumable conversation.

## Work still to do

Provider retention is part of the verification work. Today Abalone pins
providers' published measurements. Establishing what their programs retain
requires auditing the source and deriving reference measurements from it;
that audit is unfinished.

Network identity is also in scope. Tor/Tails integration needs working
provider routes: NEAR's attestation service currently refuses Tor exits;
RedPill and Phala answer over Tor. Verification failures currently stop the
session. An explicitly labelled mode for unverified providers is planned.

Use synthetic, non-sensitive material with the current preview. The released
coupon route runs tools as your account without an OS sandbox and permits an
explicit outdated-firmware warning. Its operator can access and revoke the
credential, and spending can exceed the cap. Sandbox disclosure checks can
miss paraphrases. The [security document](docs/security.md) gives the exact
boundaries.

## Explore

- [Guides](guides/README.md): providers, payment and network setup
- [Watch a synthetic PDF become meeting minutes](https://pod.dstack.soc1024.com/artifact-reports-2026c/abalone-coupon-pdf-meeting-minutes--lWMO2qY1hfbnqZdRWwg8cQ/) using a coupon
- [Architecture and source layout](docs/architecture.md) and [documentation index](docs/README.md)
- [Contributing](CONTRIBUTING.md), [issues](https://github.com/amiller/abalone/issues) and [security reporting](SECURITY.md)

First-party code is [MIT licensed](LICENSE); preserve [component notices](THIRD_PARTY_NOTICES.md).
