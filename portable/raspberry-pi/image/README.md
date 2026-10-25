# Dsmack portable volatile-root prototype

The separate [runtime stager](RUNTIME-STAGING.md) prepares the terminal workspace,
account declarations and reviewed Node/SDK artifacts in an offline image tree.
It does not build or qualify a boot image.

Source and offline fixtures, with a separately rehearsed Debian ARM64 QEMU
overlay boot. That rehearsal established marker loss across reboot, bounded
root-upper ENOSPC, and unchanged root/EFI backing hashes after shutdown. It is
**not whole-system amnesia qualification** or a qualified Raspberry Pi image.
No builder in this directory mounts disks, formats devices, installs packages,
or runs update-initramfs.

`stage-volatile-root.sh --sysroot /absolute/offline/tree --boot-part /offline/boot`
prints a plan. `--apply --confirm VOLATILE-IMAGE` requires root (tests use a
mapped-root user namespace) and writes only the checked offline tree. The tree
must be exclusively controlled: concurrent untrusted modification is unsupported.
Host-root aliases, intermediate symlinks, dangling output links and unsupported
absolute usrmerge links are refused; relative `bin -> usr/bin` and `lib -> usr/lib`
are supported. Unknown authority-tree links are refused rather than followed.

The supported source layout is Debian initramfs-tools with init-top before
mountroot, init-bottom before the `/run` move, then run-init. The initial lower
must be a clean, offline-prepared ext4 filesystem. Read-only mounting alone does
not prevent journal replay or fsck writes. The early
`00-portable-volatile-guard` writes trusted `/conf/param.conf` assignments for
`readonly=y`, `ROOTFLAGS='-o noload'`, `ROOTFSTYPE=ext4`, `fastboot=y`, and
`noresume=y`. Generated ORDER must reload those parameters immediately afterward.
Conflicting cmdline flags, vendor `firstboot` substrings, `systemd.run`, and
`init=` overrides are refused. Dirty filesystems must be repaired offline before
freezing; skipping replay is not a repair mechanism.

The init-bottom script requires a unique ext4 mount record with ro and
noload/norecovery, refuses root child mounts, and moves the lower to
`/run/portable-volatile-lower`. A bounded tmpfs at `/run/portable-volatile-root`
holds upper/work; the overlay occupies the vacated root mountpoint. Both backing
mounts are intended to travel with `/run` through run-init. There is no claim
that first or last mountinfo records identify the visible mount. Move/run-init
survival was established for the rehearsed Debian guest; every assembled target
image still needs that kernel check. Refusal invokes console recovery,
then attempts shutdown repeatedly; it never returns to ORDER if shutdown fails.
Root/boot services and root users remain trusted.

After verifying the overlay and its read-only lower, init-bottom copies up only
the visible fstab into RAM and rewrites its unique root entry as
`portable-volatile-root / overlay rw 0 0`. The lower fstab retains its ext4
`ro,noload` entry; boot and other entries remain unchanged. This lets systemd's
root remount consume the overlay policy rather than the physical-root options.
Missing, symlinked or duplicate-root fstab inputs and publication failures refuse
boot. Recovery runs `panic` in a subshell so its `exit` cannot bypass the outer
shutdown loop. [systemd 252 remount implementation](https://github.com/systemd/systemd/blob/v252/src/remount-fs/remount-fs.c) reads the visible fstab.

Fstab root/boot entries retain options except rw becomes ro, ext4 adds noload,
automatic discard/growfs/makefs options are removed, and dump/fsck fields become
zero. The root row must be unique. The stager installs a root-owned
`/etc/growroot-disabled` marker; archives containing growroot also require that
actual lower marker during source audit. Swap is disabled. Only explicitly listed
RAM/kernel filesystem types are accepted elsewhere; network, auto, fuse, bind,
and arbitrary persistent mounts are refused. Journals are bounded and volatile,
core retention disabled, cloud-init disabled when installed, and dphys-swapfile
masked. Other privileged writers and non-fstab mount units require separate
whole-image review. The storage vault is a separate late unlock, not an initramfs
crypttab entry. An installed overlayroot mechanism is refused.

`VOLATILE_ROOT_MODE=overlay-tmpfs` requires positive `UPPER_SIZE` and
`JOURNAL_MAX_USE`. Sizes cannot have leading zeros. Explicit mode off or cmdline
`portable-volatile-root=off` is a non-volatile recovery path, not a private session.

After a separately authorized initramfs build, extract its archive to a directory
and run:

```sh
python3 portable/raspberry-pi/image/audit-initramfs.py /offline/extracted \
  --reviewed-sha256 /private/reviewed-script-hashes.json \
  --lower-sysroot /offline/physical-lower
```

The manifest is an independently reviewed JSON mapping of archive-relative paths
to SHA256: init, scripts/functions, scripts/local, scripts/nfs, each ORDER file
and referenced script, conf/initramfs.conf, conf/arch.conf, any conf/conf.d files
and conf/modules, both policy configuration files, lib/portable-persistent-api, and the
resolved executable targets of its required applets (usually busybox). Applet
symlinks resolve against the extracted archive, never the audit host. Do not approve hashes automatically
from an unreviewed archive. The audit rejects unknown ORDER syntax, missing
parameter reloads, the persistent-API guard not first or volatile guard not second, a missing
last persistent-API check/sysfs move, overlay after udev, missing
executable entries, and unreviewed vendor/network scripts. Its JSON output saves
actual ORDER sequences and hashes. Stage preflight is not this generated audit.
The pinned Pi vendor firstboot, firstboot_fstrim and imager_fixup scripts require
review despite their guarded triggers. Early network policy ordering must be
reviewed with its own installer; this directory does not implement Tor policy.

Run `bash portable/raspberry-pi/image/tests/run-tests.sh` for safe fake-mount and synthetic
staging tests. `python3 portable/raspberry-pi/image/tests/test-audit.py` checks archive-audit
negative fixtures. These do not execute a kernel boot.

Each assembled image's isolated QEMU gate must establish: clean lower hash before boot;
actual initial mount flags and skipped fsck; generated ORDER including firewall
before networking; root overlay and accessible ro lower after run-init; `/dev`
and upper tmpfs survival; bounded ENOSPC; no swap; late vault mount visibility;
markers disappearing after reboot; unchanged root and boot backing block hashes.
Verify root/boot UUID/PARTUUID against assembled partitions, EFI/Pi boot selection,
and absence of firstboot actions. Pi hardware boot and latency remain separate.

The rehearsed guest exposed writable efivarfs and pstore mounts after boot;
those were remounted read-only for the experiment. The source-only [early persistent API policy](PERSISTENT-API.md) is now a
mandatory additional staging and generated-archive audit gate; its kernel
behavior remains unqualified. Read-only root/boot backing
hashes alone do not prove that firmware or other non-filesystem storage received
no writes. Likewise, a separate-disk vault test does not qualify provisioning
and recovering a vault partition on the final boot USB.

Shared first-party capabilities from `lib/` are staged by the finite source map
in `stage-runtime.py`, with source digests and explicit destinations under
`/opt/portable/lib/`. They are not part of the prebuilt Pi SDK artifact bundle.
