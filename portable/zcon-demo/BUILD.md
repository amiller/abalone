# Building a ZCon demo stick

This is the order of work for a stick like the one shown at ZCon, with the
public script for each step. No stick has yet been built end to end from these
scripts. The demo stick's image was assembled and flashed with private one-off
scripts, and later components were added to it with
[pi-deploy](../raspberry-pi/tools/README.md) payloads. A reproducible build is
follow-up work, so treat this as a map of the parts rather than a recipe.

## Hardware

- Raspberry Pi 4 with its USB-C power supply. No SD card.
- USB stick, 16 GB or more. The Pi boots from it.
- Micro-HDMI to HDMI cable and a screen.
- A keyboard. The demo used a Bluetooth keyboard with a touchpad.
- Optional: a USB HDMI capture device, to show or record the Pi's screen on a
  laptop with [pi-view and demo-record](../raspberry-pi/tools/README.md).

## Base image

Raspberry Pi OS Lite, bookworm, arm64:

```
2026-10-06-raspios-bookworm-arm64-lite.img.xz
sha256 9e938c5a6981c3f498b3b564c527f3e1fd58ef20bbf703be0eea748384a6c1af
```

Work on an offline copy of its root and boot partitions on a build host, never
on a running system.

## Install layout

[stage-runtime.py](../raspberry-pi/image/stage-runtime.py) installs each file
at `/opt/portable/portable/` plus its path below `portable/` in this
repository, so `portable/raspberry-pi/display/sway.config` becomes
`/opt/portable/portable/raspberry-pi/display/sway.config`. Shared files from
`lib/` go to `/opt/portable/lib/`. The units and scripts in this repository
use those paths.

The demo stick does not match. Its payloads rewrote the paths so that
`raspberry-pi/display`, `raspberry-pi/clock` and `raspberry-pi/storage` sat at
`/opt/portable/portable/display`, `clock` and `storage`. A stick staged from
this repository uses the `raspberry-pi/` paths throughout.

stage-runtime.py stages the terminal workspace, vault broker, clock, credit
service and display. Its source map does not yet cover the NEAR funding route
(`portable/funding/near-fund.py`, `operator.py` and `near_fund/`), the agent
wallet (`portable/wallet/`), the wallet launcher, the operator's home commands
or ZECpublish. On the demo stick those were installed by the private scripts.

## Steps

1. **Stage the image.** On the offline root, in the order the stagers require:
   [stage-runtime.py](../raspberry-pi/image/RUNTIME-STAGING.md) with
   `--profile direct-near --local-enrollment`, then account creation with
   `systemd-sysusers` and `stage-runtime.py --verify-accounts`;
   [vendor normalization](../raspberry-pi/image/PI-NORMALIZATION.md);
   [partition identities](../raspberry-pi/image/PI-PERSONALIZATION.md) from a
   [vault topology](../raspberry-pi/storage/topology.md) manifest;
   the [coarse clock](../raspberry-pi/image/PI-CLOCK.md);
   the [Tor-only network policy](../raspberry-pi/network/README.md);
   the [persistent-API guard](../raspberry-pi/image/PERSISTENT-API.md);
   the [volatile root](../raspberry-pi/image/README.md), then a new initramfs
   checked with `audit-initramfs.py`. Add the third-party binaries from
   [binaries/](../raspberry-pi/binaries/README.md): Zkool, teep and
   zkool_graphql.
2. **Personalize.** [admin/personalize.py](../raspberry-pi/admin/README.md)
   writes the Wi-Fi network (SSID, password and country) and the SSH keys that
   may log in as root, and generates the stick's SSH host key. Keep the host
   public key; [pi-ssh](../raspberry-pi/tools/README.md) needs it.
3. **Flash.** Write the image to the stick. The stick has three partitions:
   boot, root and a 2 GiB vault partition left as zeros, matching the topology
   manifest from step 1. Boot the Pi from it.
4. **Enroll the vault.** The tty3 setup console
   ([enrollment-vt.py](../raspberry-pi/storage/ENROLLMENT.md), started by
   `portable-vault-enrollment.service`) formats the vault partition with LUKS2
   under a passphrase you choose. `~/unlock` opens it after that.
5. **Pair the keyboard.** Over `pi-ssh`, pair it with `bluetoothctl` (`agent
   KeyboardDisplay`, `default-agent`, `scan on`, `pair`, `trust`, `connect`).
   The running system is in RAM, so the pairing is lost at reboot until
   `/var/lib/bluetooth` is written to the stick, for example by copying it into
   a directory and running `pi-deploy persist` on that directory.
6. **Create the wallet account.** Unlock the vault, run `~/desktop` and open
   the wallet with Super+W. Zkool shows its disclaimer on first use. Create or
   restore an account named `agent`; the agent wallet copies that account's
   seed into its own database. The name is `source.account` in
   [agent-wallet.json](../wallet/agent-wallet.json).
7. **Set up the NEAR account.** Funding pays through a Base wallet that the
   stick holds. Write its record to
   `/run/portable-vault/funding/transit-private.json` (owner UID 972, mode
   0600) with the fields shown in the
   [funding CLI README](../funding/near_fund/README.md): Base address and
   private key, a Zcash refund address, and `refundBackupVerified: true`. The
   repository has no command that creates this record. Fund the Base address
   with a little ETH for gas. The first `~/fund` then creates the stick's NEAR
   account, activates it with 0.01 NEAR bought from that Base wallet through
   NEAR Intents, and signs in to NEAR AI Cloud with it.
8. **Fund.** `~/fund` shows a ZEC quote as a QR code. Pay it from any Zcash
   wallet and leave `~/fund` running. After the first funding it creates the
   agent's inference key and installs it in the vault; later fundings raise the
   key's spending limit.

## Costs

A $2 top-up costs about $2.28 of ZEC, including the swap's slippage allowance.
One agent answer costs about half a cent.

## Limits

- No stick has been built end to end from the public scripts (see above).
- Free2Z pseudonyms ([zcash/pseudonym](../zcash/pseudonym/pseudonym.mjs)) are
  not in the image. The stick has no Nym client, no Free2Z account and no
  egress rules for them.
- Agent answers stop at about 1,000 tokens and are marked incomplete.
- If a NEAR session refresh is interrupted, `~/credit` and `~/fund` report the
  account as unavailable until the refresh is recovered by hand
  ([#82](https://github.com/amiller/abalone/issues/82)).
- The Wi-Fi password and the SSH host key are stored outside the vault so they
  work before unlock. Anyone holding the stick can read them.
