# Offline Pi vendor startup normalization

`stage-pi-normalization.py` prepares an exclusively controlled offline Pi root
for the separate runtime, network, volatile-root and persistent-API stages.
It never mounts an image, runs a vendor script, installs packages, builds an
initramfs, or starts a service. Do not point it at the running root filesystem.

Supply an independently reviewed profile and its literal SHA256. The profile
must contain exactly `version: 1`, `files`, `links`, and `provenance`. `files`
binds every fixed path in the helper's `FILES` set to `{sha256, mode}`; `links`
must match its four fixed enabled-unit links and the observed
`etc/rc3.d/S01resize2fs_once -> ../init.d/resize2fs_once` activation link. Modes are integer 420 or 493.
`provenance` should identify the base image and installed package versions.
Include `etc/init.d/resize2fs_once` in `files`, using its reviewed bytes and
mode0755. Record its provenance separately if no package owns it. Profiles made
for the earlier four-script scope must be reviewed and extended before reuse;
the exact schema rejects incomplete profiles. Do not invent a vendor
`usr/lib/systemd/system/resize2fs_once.service`: systemd generates this service
from the SysV script at boot.
The helper verifies hashes, not the legitimacy of a newly generated profile.
Keep the profile outside the target and review the actual bytes first.

```sh
python3 portable/raspberry-pi/image/stage-pi-normalization.py \
  --root /exclusive/offline-root \
  --profile /reviewed/pi-vendor-profile.json \
  --profile-sha256 REVIEWED-PROFILE-SHA256
```

This prints the exact plan without writing. To apply the reviewed plan, add
`--apply --plan-sha256 PRINTED-PLAN-SHA256` as root. The plan binds this helper's
source hash, target root device/inode, profile and all selected original bytes.
Changing those inputs requires another review. Unknown startup markers, changed
vendor files/modes, unit overrides/drop-ins, extra vendor activation links,
conflicting cmdline options and unsafe links/hardlinks refuse before writes.

The fixed operation is deliberately narrow:

- Remove the exact `init=/usr/lib/raspberrypi-sys-mods/firstboot` and
  `fsck.repair=yes` cmdline tokens, preserving the existing root identifier.
  Final partition personalization and read-only root policy are separate stages.
- Retire that firstboot executable and the installed initramfs scripts
  `local-premount/firstboot`, `local-bottom/firstboot_fstrim`, and
  `local-bottom/imager_fixup` under `/usr/share/initramfs-tools/scripts`.
- Retire `/etc/init.d/resize2fs_once` and its exact `rc3.d` activation link,
  and mask the generated `resize2fs_once.service`. Refuse additional activation
  names or aliases across `rcS.d` and `rc0.d` through `rc6.d`.
- Retire the four exact `multi-user.target.wants` links and mask
  `userconfig.service`, `sshswitch.service`, `regenerate_ssh_host_keys.service`,
  and `rpi-eeprom-update.service`. Preserve their package unit files. Disabling
  automatic EEPROM updates does not modify EEPROM or firmware payloads.
- Preserve selected original bytes, original modes/hashes, link targets and
  package `.list`/`.md5sums` records outside every active startup search path,
  under `/var/lib/portable-image/retired-vendor-firstboot`. Saved files are
  non-executable and mode0600; an intent records the complete plan.

The enabled script and unit inventories must still be reviewed for the selected
base. This helper does not discover every privileged writer or interpret arbitrary
shell scripts. It inspects relevant executable hook names and actual unit paths,
not unrelated documentation mentioning firstboot. It refuses nonempty netplan
search paths without reading or copying their possible secrets. The separate
network installer owns NetworkManager migration; this helper does not repeat it.

A completed marker follows file synchronization and synchronization of changed
parent directories. Application is **not transactional**. Any interrupted or
completed attempt leaves the backup directory and refuses replay; preserve and
inspect the partial tree rather than deleting the marker and running again.
Concurrent writers, package reinstalls/upgrades after normalization, and foreign
mount namespaces are outside this offline contract.

Kernel files, firmware files, `config.txt`, device trees, package ownership records
and package unit sources remain intact. The old generated initramfs is not edited:
build a new Pi-native archive and audit its actual executable ORDER before boot.
Stage runtime before network/persistent-API policies because its strict drop-in
checks intentionally refuse those later policies. Normalization does not itself
enable network services or select the boot target.

Fresh machine identity and any SSH host-key residue need their own explicit image
policy and inventory; this helper does not silently delete keys or identity files.
Likewise this is not a credential provisioning, amnesia, hardware boot or retention
qualification. Confirm the final assembled image after every package/source change.

`python3 portable/raspberry-pi/image/tests/test-pi-normalization.py` checks synthetic roots,
including mapped-root application under umask077, original-byte preservation,
firmware preservation, exact masks, malformed/unknown input refusal and no replay.
It executes no ARM code or vendor script and does not apply changes to an image.
