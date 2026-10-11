# Abalone friend preview

**Limited synthetic-text preview.** Use only synthetic, non-sensitive inputs.
The issuer runs on the Mac mini; the reference client runs on your trusted Linux
host. Public client/source qualification and service admission do not replace the
owner's useful-document walkthrough acceptance.

Public acquisition and fresh public-installed Mac admission passed in preview.2.
**Redemption is paused while the owner’s failed issuance is reconciled. Do not retry or redeem another coupon.**
No credential was installed during that failed attempt; its provider/chain outcome is being checked. Owner useful-document acceptance remains pending.

## Start with the skill

Ask your setup agent to use the [Abalone incognito skill](../skills/abalone-incognito/SKILL.md).
It checks support, prepares the pinned reference runtime, and hands the interactive
terminal to you. The distribution includes patched Pi, the Abalone launcher,
verification and a credential broker; a short skill does not replace that code.

Supported: Linux x86_64, compatible Node 24, bash, curl, tar, sha256sum, and an
existing Linux tmpfs. Run as an ordinary user on a trusted owned host. No manual
bubblewrap installation is needed in this profile. Tools retain your account's
filesystem and network access; OS isolation is a later milestone. No VPN, provider
account, manual API key or funded recipient wallet is required.

The setup agent must stop observing and recording before you enter your coupon,
passphrase or private session input. Do not send those to its chat. A same-user
agent stepping aside is cooperation, not isolation from that agent or administrator.

Download and inspect the
[installer](https://github.com/amiller/abalone/releases/download/v0.1.0-preview.2/install.sh)
and verify it against
[FRIEND-SHA256SUMS](https://github.com/amiller/abalone/releases/download/v0.1.0-preview.2/FRIEND-SHA256SUMS).
The installer pins the package and all four public trial files by checksum; the
helper verifies the signed issuer controls. In your interactive terminal, run:

```sh
sh install.sh --friend
```

Enter the coupon at the hidden prompt. Review the offer before confirming CLAIM;
keep that window open through pending delivery. Never put the coupon in a command
argument, environment variable, URL or AI message. An uncertain claim is not
permission to redeem again with new keys.

Session-only is the default: no trace passphrase and no durable managed
prompt/response trace. To deliberately retain a local encrypted trace, use:

```sh
sh install.sh --friend --keep-trace
```

The passphrase protects that trace, not the coupon; keep it for later unlocking.
Files you deliberately create in the workspace can remain after close.

## Review a selected text file

This preview permits **synthetic, non-sensitive input only**. Put a synthetic text
file in the working folder without sharing its contents with the setup agent.
Inside Abalone, type:

```text
@meeting-notes.txt Summarize this file
```

For spaces: `@"meeting notes.txt" Summarize this file`. Abalone reads the selected
file and includes its contents in the encrypted model request. PDF extraction is
not qualified by this text walkthrough. Review the answer inside Abalone; send
only content you deliberately approve back to the setup agent. Close normally
when finished.

## What the preview promises

The issuer runs on the Mac mini through the native signed runner and an Apple
Containerization ARM workload. Apple App Attest admission binds code identity,
compose, a fresh challenge, issuer key and policies. The host/operator and stand-in
KMS can read issuer secrets and created API keys; this is an identity-only preview,
not Secure Enclave custody. Direct NEAR inference has its separate verified
encryption and admission boundary; accepted security-update exceptions remain
visible. Ordinary IP connectivity does not hide your address.

A coupon delivers capped, owner-revocable provider access, not an owned reserved
purse or a verified remaining balance. Admission renewal uses the same live
credential; it cannot undo upstream revocation and does not create a replacement
entitlement. Keep session keys alive for pending delivery. Closed-session recovery
is not qualified. Use `/coupon` for details. Base RPC-safe confirmation is not
independent Ethereum L1 finality.

[Client preview and immutable provenance](https://github.com/amiller/abalone/releases/tag/v0.1.0-preview.2)
· [Dsmack source](https://github.com/amiller/dsmack)
· [Friend acceptance](https://github.com/amiller/abalone/issues/4)
