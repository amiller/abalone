---
name: abalone-incognito
description: Open an Abalone incognito inference session from a Dsmack coupon on supported Linux, preparing the pinned helper and handing the terminal to the user. Do not collect secrets or operate the issuer.
---

# Abalone incognito

Use this skill to prepare a session, then hand it to the human. The public friend
URL and explicit trusted-owned-host baseline are still being qualified; do not invent a
working release or use an expired trial. Read the [current release status](../../README.md).

1. **Check support.** Initial profile: ordinary-user Linux x86_64, compatible
   Node24, bash, curl, tar and sha256sum, with an existing Linux tmpfs.
   Check Node rather than assume an agent host includes it. If a prerequisite is
   missing, name the gap before private input. The first release explicitly trusts
   the owned host and has no OS isolation; never silently substitute profiles.
2. **Prepare the pinned helper.** Once the release is public, use its current
   reviewed landing and expected checksums. The installer pins the artifact and
   all four public files by checksum. The helper verifies the signed issuer controls. Reuse an exact matching installation or prepare
   it through the reviewed setup path; do not build a private checkout, bypass
   checks, or introduce operator/provider credentials. The exact owned-host
   launch is pending qualification; do not ask a friend to repair its environment.
3. **Choose retention.** Default session-only use needs no trace passphrase and
   keeps no durable prompt/response trace. Use `--keep-trace` only if requested:
   it retains encrypted traces and needs a user-held passphrase to reopen them.
   This protects traces, not the coupon. Workspace files can remain after close.
4. **Hand off.** The current helper entry after verified acquisition is
   `sh install.sh --friend` (optionally `--keep-trace`). Open a separate interactive
   terminal controlled by the user if supported. Otherwise give that launch
   instruction for the human to run; do not route hidden prompts through agent
   tool stdin. Stop setup recording and observation before coupon, passphrase
   or private document entry. Never put them in chat, arguments, URLs, environment
   values, captures or the setup agent's context. The user reads the offer and
   confirms CLAIM; keep the same window open during delivery. No automatic consent.
5. **Explain the boundary briefly.** Current NEAR debug trial: synthetic,
   non-sensitive documents only; attestation/E2EE required, explicit firmware
   exceptions shown. Issuer operator can read created keys/control access. A cap
   is not a reserved purse or verified balance. `/coupon` provides details. There
   is no VPN/IP anonymity or confidentiality from the host administrator. A same-
   user setup agent stepping aside is cooperation, not enforced isolation.
6. **Close normally.** Closing loses live delivery/credential keys; closed-session
   recovery is not qualified and does not revoke the provider key. Do not read
   private traces to debug setup. Use deliberate metadata-only diagnostics. Never
   replay a sent request, replace a coupon after ambiguity, or claim recovery of
   lost keys. Normal verified admission renewal uses the same live credential.

The supporting [reference implementation](../../README.md#use-the-skill) includes
patched Pi, Abalone launcher/extensions, verifiers and a credential broker;
bubblewrap containment and its setup are milestone2 after public release.
The initial profile trusts the host: local tools have ordinary filesystem/network
access, while provider verification/E2EE and minimal retention remain required.
Installing this skill alone does not install them or establish stock Pi/Hermes support. Short instructions do not
qualify the entire dependency surface. This skill-to-human handoff and time from
URL/coupon/document to useful review still require an independent walkthrough.
