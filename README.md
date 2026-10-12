# Abalone

**An incognito session for working with AI.**

Abalone is a setup guide and a terminal app for bringing a document or question
to private inference. A gifted coupon provides model access without a provider
account or a manually supplied API key. Dsmack handles redemption; Abalone checks
the remote provider's attestation and encrypts inference directly to the model.

## Redeem a coupon

You need a trusted Linux x86_64 computer with Node 24; the
[full requirements](docs/redeem.md#conditions-before-you-start) list the rest.
Use synthetic, non-sensitive material.

1. Open the gift link and paste the page's full link into your coding agent. The
   agent reads the [setup skill](skills/abalone-incognito/SKILL.md), checks the
   current release's installer digest and runs `sh install.sh --credit`
   ([installer details](docs/redeem.md#check-and-run-the-installer)). The installer
   prints the launcher and `trial.json` paths used below.
2. Keep the gift link in a 0600 file, then inspect the offer: provider, cap,
   expiry and restrictions.

   ```sh
   abalone credit inspect --trial /path/to/trial.json --input-file /private/gift.txt
   ```

3. Accept that exact offer by its hash and check that access was saved:

   ```sh
   abalone credit redeem --trial /path/to/trial.json --input-file /private/gift.txt --accept-offer OFFER_HASH
   abalone credit status
   ```

   Keep the returned credit ID. If redemption is interrupted, do not redeem
   again; run `abalone credit recover --credit CREDIT_ID`.
4. Open a fresh terminal of your own and start the session:

   ```sh
   abalone credit session --credit CREDIT_ID
   ```

   Keep the documents and questions you want private out of your setup agent's
   chat. Closing the session discards the conversation and keeps the saved access.

[Redeem a coupon](docs/redeem.md) has the full procedure. To watch the result,
see [a synthetic PDF become meeting minutes](https://pod.dstack.soc1024.com/artifact-reports-2026c/abalone-coupon-pdf-meeting-minutes--lWMO2qY1hfbnqZdRWwg8cQ/):
a real coupon, direct NEAR inference and useful output, from a preinstalled app
with scripted interaction.

## Before you install

Download and inspect the installer and check its published digest before running
it. A checksum identifies the bytes; it does not replace reading what the script
does. The skill guides setup. The app supplies patched Pi, provider verification,
encryption and credential handling; a skill alone does not add those mechanisms
to another agent. [Architecture and source layout](docs/architecture.md) explain
what each component does and what you are trusting.

## What incognito means here

**Use synthetic, non-sensitive material with the available NEAR access route.**
It accepts verified firmware warnings, and the coupon operator can access and
revoke the model credential. Check [access conditions](docs/redeem.md#conditions-before-you-start)
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
