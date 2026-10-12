---
name: abalone-incognito
description: Explain Abalone, reuse or obtain model access, redeem a gifted coupon when instructed, and open an incognito session in a fresh user terminal. Keep durable access separate from private conversation content.
---

# Abalone incognito

Help the user understand and use Abalone. Start with their purpose, not an install
command. A request for an explanation does not authorize installation or spending;
an instruction to set up or redeem does not require repeated permission questions.

## Explain before installing

Abalone is a curated guide and a terminal app built around Pi. Dsmack exchanges a
coupon for provider access; it does not relay the conversation. Abalone verifies
the remote NEAR provider and encrypts inference directly to the model. The setup
agent can manage the coupon and saved credential. This does not authorize reading
the user's private documents, prompts, answers or retained conversation traces.

Explain the relevant limits in ordinary language: the available NEAR route allows
verified firmware warnings, and its operator can access and revoke credentials;
use synthetic, non-sensitive material with that route. The Linux computer and
its administrator are trusted. Local tools have ordinary account filesystem and
network access. Stepping aside is cooperation, not OS isolation or IP anonymity.
See [security details](../../docs/security.md).

Before any install, inspect the proposed installer and explain its version,
download sources, dependencies, installation and state locations, and what will
be run. Download to a file, inspect it, compare its digest with the published
manifest, then execute the reviewed local file. A matching checksum establishes
matching bytes, not safety. Never pipe a download into a shell. Do not install
merely because the user asked what Abalone does.

## Choose the access path

- **Saved Abalone access:** use `abalone credit status`, select the relevant saved
  credit, and open a fresh session. Do not redeem another coupon.
- **Existing provider credential:** importing a separate provider key is not
  implemented. Say so plainly; do not invent an import command, treat it as a
  NEAR key or send it to a different provider.
- **Coupon or gift link:** inspect the offer and redeem when instructed, using
  the commands below. Save delivered access independently of conversation state.
- **No access yet:** explain the currently available coupon and provider-account
  options, help the user obtain the chosen supported access, then continue setup.
  Consult the published access instructions and the user's existing arrangements.
  Do not invent a checkout, payment address, Zcash funding endpoint or availability
  claim. A future funding design is not a working acquisition path.

Use the [release/access instructions](../../docs/redeem.md) to obtain the
reviewed distribution; its `install.sh --credit` fetches and checks the pinned
public trial files and prints their path. Check actual
availability and expiry there. Use a release exposing the `credit` commands;
do not substitute an older process-only coupon launcher. Supported recipient:
trusted Linux x86_64 with the documented Node 24 and system prerequisites, plus
`pdftotext` (Poppler) if the user will select PDFs. Name a
missing capability before changing anything; do not silently switch profiles.

## Read a gift link safely

The public entry is `https://amiller.github.io/abalone/redeem`. A supplied gift link
adds a `#code=` fragment. The code is present in the user's full URL, not in the
HTTP response: fragments are not sent to the server. Read the instructions at
the fragment-free page and the code from the user-provided link. If the fragment
is missing, ask for the original gift link; do not guess it.

The user may give the setup agent the coupon for redemption. Keep it out of public
posts, command arguments, query strings, request paths and verbose diagnostics.
Pass the full link or raw code through stdin or a private input file with mode
0600, in an account-private directory. Do not echo it into terminal recordings.
No web page fetch or link opening authorizes redemption automatically.

## Inspect, redeem and save access

In the reviewed installed distribution, `abalone` below names its launcher; use
the absolute launcher path the installer printed. Use the `trial.json` path it
printed. The following paths are placeholders, not downloadable files.

```sh
abalone credit inspect --trial /path/to/trial.json --input-file /private/gift.txt
```

Explain the returned offer's provider, cap, expiry and material restrictions.
When the user has requested redemption, accept that exact inspected offer using
its returned hash; no ceremonial confirmation phrase is needed:

```sh
abalone credit redeem --trial /path/to/trial.json --input-file /private/gift.txt --accept-offer OFFER_HASH
abalone credit status
```

`--stdin` is an alternative to `--input-file`; pass input through the tool's stdin,
not a shell command containing the coupon. Save and use the returned credit ID.
The credential and delivery/recovery state use account-private durable storage
at `~/.abalone/credit` (or `$ABALONE_DIR/credit`), with mode 0700 directories and
0600 files;
conversation privacy does not require throwing away paid access on process exit.
A nominal coupon cap is not an amount already spent, an owned wallet, or a
verified remaining balance. Do not infer credential expiry from an issuer login's
expiry. Report only observed usage and known provider limits.

If interrupted or uncertain, inspect status and recover the existing credit with
its saved identity; never create another claim as a blind retry:

```sh
abalone credit recover --credit CREDIT_ID
```

A failed or pending recovery is not a new coupon. Preserve the state and report
the specific issue without posting credentials or promising recovery that failed.

## Test when requested, then open a fresh terminal

A requested test uses bounded synthetic input and the same saved access. Do not
send a private document as a setup test. Confirm only the result and observed
usage; never describe the full cap as spent merely because it was redeemed.
The automation interface is `abalone credit session --credit CREDIT_ID --mode rpc`
(Pi RPC mode); do not invent another prompt protocol.

Hand the user a fresh interactive terminal running:

```sh
abalone credit session --credit CREDIT_ID
```

If opening a user-controlled terminal is unavailable, give that exact launch
command. Do not require tmux, reuse of the setup agent's process, another coupon
or a credential password. Stop capturing/observing before the user's conversation.
The user selects documents inside Abalone; their contents and the answer do not
return to the setup agent unless the user deliberately shares them.

By default, closing ends the managed conversation history; saved access remains
available for a later session. Optional encrypted conversation retention is a
separate choice. Files, terminal captures and host remnants can remain. Closing
is not provider revocation or secure erasure. Reopening still requires valid
provider access and fresh admission, and must never trigger automatic redemption.

The app includes patched Pi, Abalone extensions, verification and a credential
broker. Installing this skill alone does not install those mechanisms or qualify
stock Pi/Hermes support. See [architecture](../../docs/architecture.md).
