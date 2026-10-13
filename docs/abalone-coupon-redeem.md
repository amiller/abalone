# Redeem a coupon

Get the release, check it, and save model access from a gift coupon. The
[setup skill](../skills/abalone-incognito/SKILL.md) gives your coding agent the
same procedure; [getting started](getting-started.md) covers the session itself.
[What incognito means here](../README.md#what-incognito-means-here) explains what
is protected and what is not. The coupon is one way to get access; see
[acquiring private inference](../guides/acquiring-private-inference/README.md)
for the others and what each links to you.

<!-- Release step: point the links, the install.sh SHA256, the claim deadline, and the URLs, line numbers and archive SHA256 in "How to confirm it" and "Without the script" below at the new release. -->
**Current release:** [v0.1.0-preview.8.1](https://github.com/amiller/abalone/releases/tag/v0.1.0-preview.8.1)
provides `install.sh --credit` and the `abalone credit` commands. Download
[install.sh](https://github.com/amiller/abalone/releases/download/v0.1.0-preview.8.1/install.sh) and
[FRIEND-SHA256SUMS](https://github.com/amiller/abalone/releases/download/v0.1.0-preview.8.1/FRIEND-SHA256SUMS) from that release.
Its `install.sh` SHA256 is
`f8597b32efe27e7e8a123a14aae5e6c5e032e97a1e6f4eb19d655b0a580e9e03`.
The signed issuer approval expires 2026-11-12T03:00:00Z;
each gift's own claim-by time is earlier, and `abalone credit inspect` shows it.

The [portable client source preview](portable-client.md) provides a one-archive
layout and an optional installer with `--plan`. Those changes require a new
qualified release; the published procedure below remains for preview.8.1.

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

A matching checksum shows the bytes are the published ones; it does not make
them safe. The next two sections say what the script does and how to confirm
that without trusting this page. If you would rather not run a script, follow
[Without the script](#without-the-script).

## What install.sh does

`sh install.sh --credit`, in order:

1. Refuses, before downloading anything, if any argument follows `--credit`,
   if the script does not pin all four public files, if `HOME` is not an
   absolute path, if the host is not Linux x86_64, if you are root, if any of
   `node`, `curl`, `tar`, `sha256sum`, `bash` or `flock` is missing, or if
   `node -v` is not 24.x.
2. Refuses if `~/.abalone-app`, `~/.abalone-app/REV`, its `abalone` or
   `public-credit` directory, the bundle directory or the lock file
   `~/.abalone-app/.credit-install.lock` is a symlink. Creates
   `~/.abalone-app/REV/public-credit/` and `~/.local/bin/` if missing, then
   refuses if another `install.sh --credit` holds the lock.
3. Downloads one archive, `abalone-REV.tar.gz`, into a staging directory
   `~/.abalone-app/.credit-stage.XXXXXX`, which is deleted when the script
   exits, and refuses unless its SHA256 equals the one pinned in the script.
4. Extracts it in staging with `tar -xzf` and refuses unless it contains
   `abalone/bin/abalone`, `abalone/lib/credit.mjs` and
   `abalone/lib/credit-store.mjs`. Nothing from the archive is run.
5. Downloads `trial.json`, `issuer-pin.json`, `staging-approval.json` and
   `readiness.json` (each at most 2 MiB) and refuses unless each SHA256 equals
   the one pinned in the script.
6. Writes `receipt.json` beside them: the two URLs, the five pinned digests and
   a digest of the extracted tree's file listing.
7. Refuses, leaving everything untouched, if `~/.abalone-app/REV/abalone`
   exists and differs from the extracted tree in any file, mode or symlink, if
   the bundle directory exists and any of its five files differs, or if
   `~/.local/bin/abalone` exists and is not a symlink.
8. Moves the tree to `~/.abalone-app/REV/abalone` and the five files to
   `~/.abalone-app/REV/public-credit/BUNDLE_ID/`, each only if not already
   there. `BUNDLE_ID` is the first 16 hex characters of the SHA256 of the four
   pinned file hashes.
9. Points `~/.local/bin/abalone` at `~/.abalone-app/REV/abalone/bin/abalone`,
   replacing a symlink already there.
10. Prints the runtime, launcher, `trial.json` and receipt paths and the next
    command, and exits.

It contacts no host other than the two release URLs in the script. It does not
use sudo, edit shell startup files or `PATH`, or write under `~/.abalone`;
`abalone credit` creates `~/.abalone/credit` later. It redeems nothing, claims
nothing and starts no session. Rerunning it rechecks an existing install
against the same pins. The lines after the first `exit 0` are the plain
install (`sh install.sh` with no argument), which `--credit` never reaches.

## How to confirm it

None of these checks relies on this page.

1. **The hash.** `sha256sum install.sh` must print the `install.sh SHA256:`
   line in the [release notes](https://github.com/amiller/abalone/releases/tag/v0.1.0-preview.8.1).
2. **The script.** It is 123 lines of `sh`; the `--credit` path runs from the
   top to the first `exit 0` (line 99). Line 20 must hold exactly the four
   hashes that `FRIEND-SHA256SUMS` lists for `trial.json`, `issuer-pin.json`,
   `staging-approval.json` and `readiness.json`. Line 2 names the archive's
   SHA256, which must match the release notes. `grep -n https install.sh`
   must show only two URL bases: the archive at
   `https://github.com/amiller/abalone/releases/download/v0.1.0-preview.8/abalone-ca6a250.tar.gz`
   and the four files under
   `https://github.com/amiller/abalone/releases/download/v0.1.0-preview.8.1`.
   `grep -nE 'sudo|bashrc|zshrc|\.profile|PATH|eval' install.sh` prints
   nothing.
3. **The receipt.** Afterwards,
   `cat ~/.abalone-app/REV/public-credit/*/receipt.json` shows the archive URL
   and SHA256, the public base URL and the four file digests the script
   checked; they must match the two checks above.
   `sha256sum ~/.abalone-app/REV/public-credit/*/*.json` rechecks the files.
   The receipt records install time only; rerun `sh install.sh --credit` to
   recheck the runtime tree.

An agent setting this up for you runs the same three checks and tells you what
the script will do before running it.

## Without the script

Do by hand what the script does. In a directory you choose:

```sh
mkdir -m 700 ~/abalone-manual && cd ~/abalone-manual
curl -fLO https://github.com/amiller/abalone/releases/download/v0.1.0-preview.8/abalone-ca6a250.tar.gz
for f in FRIEND-SHA256SUMS trial.json issuer-pin.json staging-approval.json; do
  curl -fLO "https://github.com/amiller/abalone/releases/download/v0.1.0-preview.8.1/$f"
done
echo "f4ff14b6ebba56f891ca7547fc5e6c51676438850661cfa4fcabb36bedf85043  abalone-ca6a250.tar.gz" | sha256sum -c
sha256sum -c --ignore-missing FRIEND-SHA256SUMS
tar -xzf abalone-ca6a250.tar.gz
```

`FRIEND-SHA256SUMS` does not list the archive; its SHA256 is in the
[release notes](https://github.com/amiller/abalone/releases/tag/v0.1.0-preview.8.1).

The gift route needs three of the four public files: `trial.json` names
`issuer-pin.json` and `staging-approval.json`, and they must sit in the same
directory as it. `readiness.json` is an unsigned availability observation that
`abalone` does not read. Then run:

```sh
~/abalone-manual/abalone/bin/abalone --trial ~/abalone-manual/trial.json
```

`--trial` takes an absolute path. To run plain `abalone` instead, move the
three files into one directory under `public-credit/` beside the runtime, for
example `~/abalone-manual/public-credit/manual/`; `abalone` uses the
`trial.json` there when there is exactly one. Nothing is put on your `PATH`;
link `~/abalone-manual/abalone/bin/abalone` into it yourself if you want.
In the commands below, use this path wherever they say `abalone`.

## Inspect, redeem and save access

Check for access you already have first:

```sh
abalone credit status
```

If a saved credit exists, open a session with it below; do not redeem another
coupon. A provider key saved with `abalone key add` is used only by
`abalone sandbox`, not by this session.

The short way is plain `abalone` at your own terminal. With nothing saved it
asks for the gift: paste the link, the code, or the path of a 0600 file holding
it, starting with `/`, `~/`, `./` or `../` (the input is not echoed). It prints the same offer as
`credit inspect` below and asks you to type the first 8 characters of its
`offerHash`. Typing them redeems that offer and opens the session; anything else
stops without claiming and saves nothing. Any further lines of a multi-line paste
are discarded, so they answer no prompt. An interrupted redemption ends with the
recover message below and the exact `abalone credit recover --credit CREDIT_ID`
command. Without a terminal, plain `abalone` prints the two ways in, with the
step-by-step commands below, and exits with status 2. It uses the `trial.json`
installed with it; `abalone --trial /ABS/trial.json` selects another.

The steps one at a time: put the gift link or code in a 0600 file in a private directory, or
pass it on standard input with `--stdin`. Never put it in a command argument,
URL query, environment variable or public log. Use the `trial.json` path the
installer printed:

```sh
abalone credit inspect --trial /ABS/trial.json --input-file /private/gift.txt
```

Read the returned offer: provider, cap, expiry and restrictions. Inspecting
claims nothing and saves nothing on this computer. The offer's `claimWindow` line says when the gift must be
redeemed. If that time has passed, the state is `expired` and the line says
"Claim window closed; the deadline was ... This gift can no longer be redeemed:
ask the sponsor for a new gift." Redeeming an expired offer is refused before
anything is sent to the issuer. If your computer's clock is wrong, correct it
first.

To accept that exact offer:

```sh
abalone credit redeem --trial /ABS/trial.json --input-file /private/gift.txt --accept-offer OFFER_HASH
abalone credit status
```

Redeem saves the gift code and its recovery keys, then reads the issuer's
status for the gift before it sends the first claim, and stops without claiming
if the issuer reports the window closed.
Saved access lives in `~/.abalone/credit/` (or `$ABALONE_DIR/credit/`), in a
0700 directory with 0600 files owned by your account. These files hold the
credential and its recovery keys, never conversations. Concurrent commands are
serialized with a file lock, and one session at a time uses a credit.

Keep the returned credit ID. If redemption is interrupted or uncertain, do not
redeem again; resume the same claim:

```sh
abalone credit recover --credit CREDIT_ID
```

A nominal cap is not a spent amount, an owned wallet or a verified remaining
balance. The operator or provider can revoke access; caps can overshoot.
`abalone credit status` shows the token counts the provider reported for this
credit, totalled on this computer, or "not reported". They are not priced.

Each request is bounded to the trial's per-request output limit, 4096 tokens in
this trial. A credit keeps the limits it was saved with: a credit saved under an
earlier trial file (512 tokens) keeps 512, and inspecting that gift again with a
newer `trial.json` is refused with `credit_admission_changed` and changes
nothing.

## Open a session

Open a fresh terminal of your own, change to the folder you want to work in,
and run:

```sh
abalone
```

With exactly one saved credit ready, plain `abalone` opens it. With several it
lists them with the command to open each; with none ready it says why (for
example an expired offer) and asks for a gift, as above. The explicit form, also for
automation, is `abalone credit session --credit CREDIT_ID [--mode rpc]`.

No password, tmux or new coupon is needed. The session adds no files to the
folder. Before it starts, it prints the saved credit's terms, which for this
trial include its OutOfDate notice. With the current NEAR route it then prints
one firmware line when the provider is first admitted:
`⚠ NEAR firmware out of date (N Intel advisories); synthetic input only`.
`/coupon` lists the advisory IDs.
Inside the session, `/status` shows usage, what is kept and what was verified;
`/coupon` shows the credit's state and limits.

The conversation is held in memory only and is not saved. The gift code, model
credential and recovery keys stay in `~/.abalone/credit` until you run
`abalone credit forget --credit CREDIT_ID`, which removes the record and its
lock file. Forgetting does not revoke the credential; see
[what is kept](security.md#local-host-and-retention).
Next time, run `abalone` again (or `abalone credit status` to find the credit ID
for the explicit form). Each session uses the same credit with fresh provider
admission and never redeems again. Continue with
[getting started](getting-started.md).

[Releases](https://github.com/amiller/abalone/releases) ·
[Source](https://github.com/amiller/abalone) ·
[Dsmack source](https://github.com/amiller/dsmack)
