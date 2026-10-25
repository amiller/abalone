# Dsmack candidate image identities

`stage-pi-personalization.py` binds a prepared offline Pi root to one reviewed
`portable/raspberry-pi/storage/topology.py` manifest. It does not format, resize, mount, build
an initramfs, change filesystem UUIDs, or operate on a physical device.

Run after vendor normalization, before network/volatile/persistent policies.
The profile pins exact normalized `boot/firmware/cmdline.txt` and pristine
`etc/fstab` bytes and their original MBR disk ID. Unknown inputs refuse; a
package update requires a new independent profile review. The only admitted
fstab mounts are the original root and boot plus optional standard proc.
The topology parser supplies all new PARTUUIDs and expected vault identity.
The exact topology bytes become `/opt/portable/etc/vault-topology.json` in the
immutable lower. An expected LUKS UUID does not mean the vault is provisioned.

```sh
python3 portable/raspberry-pi/image/stage-pi-personalization.py --root /offline/root \
  --profile /reviewed/personalization-profile.json --profile-sha256 PROFILE_SHA \
  --topology /reviewed/vault-topology.json --topology-sha256 TOPOLOGY_SHA
```

Default is read-only planning. Apply requires root, `--apply` and
`--plan-sha256` matching that actual tree's plan. The plan binds root dev/inode,
input bytes/modes, profile/topology bytes, this helper and its fixed sibling
normalizer and topology dependencies. Those sources must all be included in the
reviewed worker payload; none is loaded from the candidate filesystem.
The offline root must be exclusively controlled throughout. Concurrent hostile
mutation is outside this staging helper's contract.

Apply creates a durable intent and original-file backup under
`/var/lib/portable-image/personalization`, then atomically replaces cmdline and
fstab and installs the new topology manifest. File and directory writes are
fsynced before the completed marker. New public policy files are root:root0644;
new ancestor directories are explicitly0755 even under umask077. Backups are
0600. This is not a multi-file transaction: interruption leaves the intent and
refuses replay. Inspect the failure and prepare a separately reviewed fresh
candidate instead of deleting the intent or retrying altered input.

Root and boot become read-only (ext4 root also `noload`); fstab fsck fields become
zero. Cmdline gains `efi=noruntime pstore.backend=none`; subsequent policy helpers
and the actual generated archive audit remain mandatory. No vault mount or
financial permission is introduced. Final firmware selection, kernel/DT policy,
whole-image geometry, boot behavior, network enforcement and hardware capacity
remain separate gates.

Offline tests: `unshare -Ur python3 portable/raspberry-pi/image/tests/test-pi-personalization.py`.
They exercise temporary directories and synthetic manifests, not an image.
