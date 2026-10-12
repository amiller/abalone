# Start an Abalone incognito session

Abalone gives you a terminal session for working with a remote model. Dsmack
exchanges a gifted coupon for capped NEAR provider access; Abalone then checks
the provider's attestation and encrypts each inference request directly to the
model. Dsmack redemption and NEAR inference are separate network paths, and the
conversation never passes through Dsmack.

**Use synthetic, non-sensitive material with the available NEAR access route.**
It accepts verified firmware warnings, and the coupon operator can read and
revoke the issued credential. Read [security profiles](security.md).

## Let your setup agent explain first

Ask your coding agent to read the [setup skill](../skills/abalone-incognito/SKILL.md).
Before proposing installation it should explain what Abalone does, the two network
paths above, what the installer will download and change on your computer, and
the trust limits. An explanation request is not permission to install or spend.

The agent can then install the release, handle your coupon and save the
resulting credential under ordinary private file permissions, as described in
[access and installation](friend-preview.md). It can redeem and run a synthetic
test when you ask. Handling the credential does not entitle it to your private
documents, prompts or answers; none of these are sent to the setup agent
automatically.

## Supported system

Linux x86_64 with Node 24, bash, curl, tar, sha256sum, `flock` and an existing
Linux tmpfs, running as an ordinary user on a trusted owned host. There is no OS
isolation: tools have the account's filesystem and network access, and the
administrator is trusted. Abalone does not hide your IP address. macOS, Windows,
Docker and USB/Tails are unqualified. No VPN, provider account, manual API key
or funded wallet is required.

The distribution includes the launcher, patched Pi, curated extensions,
verification and broker. A skill installed in stock Pi or Hermes does not add
this runtime.

## Access paths

- **Saved Abalone access:** `abalone credit status` lists saved credits. Reuse one;
  do not redeem another coupon.
- **Coupon:** inspect, redeem and save it as in [access and installation](friend-preview.md).
- **Existing provider key:** importing a separate provider key is not supported
  in this release. Only NEAR access obtained through Abalone is supported.

## Open, work and close

Open a fresh terminal of your own and run:

```sh
abalone credit session --credit CREDIT_ID
```

Stop any recording or observation by the setup agent first; its stepping aside
is cooperation, not enforced exclusion. Ask a question or select a synthetic
plain text file: `Summarize @notes.txt`, or `@"meeting notes.txt"` for a name
with spaces. Abalone reads that file locally and places its text in the encrypted
model request. A read or extraction failure refuses before inference.

Closing discards the managed conversation by default. It does not delete saved
access or revoke the upstream credential; the next session reuses the same credit
with fresh provider admission and never triggers another redemption. Workspace files,
terminal scrollback, swap and host captures have their own lifetimes; closing is not
secure erasure.

An inference may already have been charged when its reply fails; do not blindly
repeat it. A nominal cap is not a verified remaining balance, and the provider or
operator can revoke access.

Keep diagnostics deliberate and metadata-only. Never post a coupon, credential,
private prompt or raw trace to an issue. Report private concerns through
[the security policy](../SECURITY.md).
