# Abalone access and installation

This page explains how to obtain a credit-capable Abalone release, check it, and
save model access from a gifted coupon. The [setup skill](../skills/abalone-incognito/SKILL.md)
is the agent-facing version of the same procedure; [getting started](getting-started.md)
covers the session itself.

**Availability:** no published release implements the `abalone credit` commands yet. Until one is listed, this procedure cannot be completed.

## Conditions before you start

- Linux x86_64, run as an ordinary (non-root) user on a computer you trust.
- Node 24, bash, curl, tar, sha256sum, `flock` (util-linux) and an existing
  Linux tmpfs at `/dev/shm`. The current installer template also refuses
  install-only use on Linux without bubblewrap (`bwrap`), although the session
  does not use it; check the selected release's installer for that requirement.
- No VPN, provider account, manual API key or funded wallet is needed.
- **Use synthetic, non-sensitive material with the available NEAR access route.**
  It accepts verified `OutOfDate` firmware warnings, and the coupon operator can
  read and revoke the model credential it issues.
- There is no OS isolation: local tools have your account's file and network
  access, the administrator is trusted, and Abalone does not hide your IP
  address. See [security details](security.md).

## What is installed and what changes

A release contains a client archive `abalone-REV.tar.gz` (the launcher, patched Pi,
Abalone extensions, provider verification and credential broker), an `install.sh`
pinned to that archive's SHA256, four signed public trial files (`trial.json`,
`issuer-pin.json`, `staging-approval.json`, `readiness.json`) and a
`FRIEND-SHA256SUMS` listing the installer and those files.

Run without arguments, `install.sh` downloads the archive, verifies its digest,
extracts it to `~/.abalone-app/REV/` and links `~/.local/bin/abalone`. It then
asks whether to plant a canary file in the current folder; answer no, or set
`ABALONE_PLANT_CANARIES=no`, if you do not want one. Nothing is redeemed.

Saved access lives in `~/.abalone/credit/` (or `$ABALONE_DIR/credit/`), with a
0700 directory and 0600 files owned by your account. These files hold the
credential and its recovery keys, never conversations.

## Select and check a release

Open the [release listing](https://github.com/amiller/abalone/releases) and pick
the newest release whose notes state it provides the `abalone credit` commands.
Earlier releases, including `v0.1.0-preview.5`, only provide the process-only
`install.sh --friend` launcher and do not save access; do not use them for this
procedure.

Download `install.sh`, `FRIEND-SHA256SUMS` and the four trial files into one new
private directory, then:

```sh
sha256sum -c FRIEND-SHA256SUMS
less install.sh
sh install.sh
abalone credit --help
```

Read the installer before running it: its version, archive URL and pinned digest,
and the install locations above. A matching checksum shows the bytes are the
published ones; it does not make them safe. `abalone credit --help` must list
`inspect`, `redeem`, `status`, `recover` and `session`. If `credit` is unknown,
the installed client is the wrong release; stop rather than use `--friend`.

## Inspect, redeem and save access

Put the gift link or code in a 0600 file in a private directory, or pass it on
standard input with `--stdin`. Never put it in a command argument, URL query,
environment variable or public log. Use the absolute path of the downloaded
`trial.json`:

```sh
abalone credit inspect --trial /ABS/trial.json --input-file /private/gift.txt
```

Read the returned offer: provider, cap, expiry and restrictions. To accept that
exact offer:

```sh
abalone credit redeem --trial /ABS/trial.json --input-file /private/gift.txt --accept-offer OFFER_HASH
abalone credit status
```

Keep the returned credit ID. If redemption is interrupted or uncertain, do not
redeem again; resume the same claim:

```sh
abalone credit recover --credit CREDIT_ID
```

A nominal cap is not a spent amount, an owned wallet or a verified remaining
balance. The operator or provider can revoke access; caps can overshoot.

## Open a session

Open a fresh terminal of your own and run:

```sh
abalone credit session --credit CREDIT_ID
```

No password, tmux or new coupon is needed. Closing discards the managed
conversation by default and keeps saved access for the next session; reopening
uses the same credit with fresh provider admission and never redeems again.
Continue with [getting started](getting-started.md).

[Releases](https://github.com/amiller/abalone/releases) ·
[Source](https://github.com/amiller/abalone) ·
[Dsmack source](https://github.com/amiller/dsmack) ·
[Acceptance](https://github.com/amiller/abalone/issues/4)
