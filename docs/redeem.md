# Redeem a coupon

Get the release, check it, and save model access from a gift coupon. The
[setup skill](../skills/abalone-incognito/SKILL.md) gives your coding agent the
same procedure; [getting started](getting-started.md) covers the session itself.
[What incognito means here](../README.md#what-incognito-means-here) explains what
is protected and what is not.

**Current release:** [v0.1.0-preview.6](https://github.com/amiller/abalone/releases/tag/v0.1.0-preview.6)
provides `install.sh --credit` and the `abalone credit` commands. Download
[install.sh](https://github.com/amiller/abalone/releases/download/v0.1.0-preview.6/install.sh) and
[FRIEND-SHA256SUMS](https://github.com/amiller/abalone/releases/download/v0.1.0-preview.6/FRIEND-SHA256SUMS) from that release.
Its `install.sh` SHA256 is
`e2299755000240bf64110e2d38b3857e7e15779638e58b6598d1052ffc5df088`. The claim
deadline is 2026-10-18T18:00:00Z, when its signed issuer approval expires.

## Conditions before you start

- Linux x86_64, run as an ordinary (non-root) user on a computer you trust.
- Node 24, bash, curl, tar, sha256sum, `flock` (util-linux), the standard
  coreutils/findutils, and a Linux tmpfs at `/dev/shm` for sessions.
  Bubblewrap is not used.
- `pdftotext` (Poppler, e.g. the `poppler-utils` package) only if you will select
  PDF files in a session. Without it, a selected PDF is refused before inference;
  text files need no extra tool.
- No VPN, provider account, manual API key or funded wallet is needed.
- **Use synthetic, non-sensitive material.** The NEAR access route accepts
  verified `OutOfDate` firmware warnings, and the coupon operator can read and
  revoke the model credential it issues.
- There is no OS isolation: local tools have your account's file and network
  access, the administrator is trusted, and Abalone does not hide your IP
  address. See [security details](security.md).

## What a release contains

- `abalone-REV.tar.gz`: the client (launcher, patched Pi, Abalone extensions,
  provider verification and credential broker).
- Four public trial files. `trial.json` selects the profile and route and names
  its siblings; `staging-approval.json` is the issuer's approval, signed under the
  root public key the trial names; `issuer-pin.json` fixes the issuer identity and
  policy hashes that each fresh issuer admission must match; `readiness.json` is
  an unsigned availability observation, not a guarantee.
- `install.sh`, which pins the SHA256 of the archive and of each of the four
  files, and `FRIEND-SHA256SUMS`, which lists the installer and those files.

## Check and run the installer

Download
`install.sh` and `FRIEND-SHA256SUMS` into a new private directory, then:

```sh
sha256sum -c --ignore-missing FRIEND-SHA256SUMS
less install.sh
sh install.sh --credit
```

Read the installer before running it: its revision, archive URL, pinned digests
and the locations below. A matching checksum shows the bytes are the published
ones; it does not make them safe.

`sh install.sh --credit` takes no other arguments. It:

1. refuses before downloading unless the host is Linux x86_64, the user is not
   root, Node is version 24, the tools above (including `flock`) exist and the
   installer pins all four files for the `linux-node24-owned-host` profile;
2. downloads the archive and the four public files into a private staging
   directory and checks each against its pinned SHA256;
3. refuses an archive without the `abalone credit` runtime;
4. compares any existing install of the same revision byte for byte (including
   file modes and symlinks) and refuses, leaving it untouched, if anything differs;
5. writes the runtime to `~/.abalone-app/REV/abalone`, the four files plus an
   install receipt to `~/.abalone-app/REV/public-credit/BUNDLE_ID/`, and links
   `~/.local/bin/abalone`;
6. prints the absolute runtime, launcher, `trial.json` and receipt paths and the
   next command, with the paths quoted.

It redeems nothing, starts no session, plants no canary file and creates no
saved credit. Rerunning it rechecks an existing install against the same pins.

## Inspect, redeem and save access

Check for access you already have first:

```sh
abalone credit status
```

If a saved credit exists, open a session with it below; do not redeem another
coupon. Importing an existing provider key is not implemented.

Otherwise put the gift link or code in a 0600 file in a private directory, or
pass it on standard input with `--stdin`. Never put it in a command argument,
URL query, environment variable or public log. Use the `trial.json` path the
installer printed:

```sh
abalone credit inspect --trial /ABS/trial.json --input-file /private/gift.txt
```

Read the returned offer: provider, cap, expiry and restrictions. To accept that
exact offer:

```sh
abalone credit redeem --trial /ABS/trial.json --input-file /private/gift.txt --accept-offer OFFER_HASH
abalone credit status
```

Saved access lives in `~/.abalone/credit/` (or `$ABALONE_DIR/credit/`), in a
0700 directory with 0600 files owned by your account. These files hold the
credential and its recovery keys, never conversations. Concurrent commands are
serialized with a file lock.

Keep the returned credit ID. If redemption is interrupted or uncertain, do not
redeem again; resume the same claim:

```sh
abalone credit recover --credit CREDIT_ID
```

A nominal cap is not a spent amount, an owned wallet or a verified remaining
balance. The operator or provider can revoke access; caps can overshoot.
`abalone credit status` shows the token counts the provider reported for this
credit, totalled on this computer, or "not reported". They are not priced.

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
[Dsmack source](https://github.com/amiller/dsmack)
