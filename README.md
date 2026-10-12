# Abalone

**An incognito session for working with AI.**

Abalone is a terminal app for asking a remote AI model about a document or a
question, with the request encrypted directly to a model whose attestation it has
checked. A gift coupon pays for the model access, so you need no provider account
or API key.

## Redeem a coupon

You need a Linux x86_64 computer you trust, with Node 24; the
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

- [Redeem a coupon](docs/redeem.md): the full procedure, what a release contains
  and what the installer changes
- [Getting started](docs/getting-started.md): using the session
- [Watch a synthetic PDF become meeting minutes](https://pod.dstack.soc1024.com/artifact-reports-2026c/abalone-coupon-pdf-meeting-minutes--lWMO2qY1hfbnqZdRWwg8cQ/),
  with a real coupon and direct NEAR inference
- [Architecture and source layout](docs/architecture.md) and the
  [documentation index](docs/README.md)
- [Contributing](CONTRIBUTING.md), [issues](https://github.com/amiller/abalone/issues)
  and [security reporting](SECURITY.md)

First-party code is [MIT licensed](LICENSE); preserve
[component notices](THIRD_PARTY_NOTICES.md).
