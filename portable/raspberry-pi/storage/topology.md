# Single-medium vault topology policy — pure first slice

`topology.py` parses a bounded UTF-8 JSON manifest and validates normalized
observations of a three-partition DOS/MBR medium. It performs **no device IO**,
formatting, mount, unlock, account operation or filesystem write. Existing
storage helpers and broker are unchanged. There is no production CLI accepting
observations, and no runtime integration or provisioner in this slice.

```python
manifest = parse_manifest(trusted_manifest_bytes)
identity = validate_observations(manifest, trusted_collector_observations)
```

The manifest authority is a per-medium offline-personalized file in the
immutable lower, not JSON supplied by a worker or desktop. `imageProfileId` is a
bounded identifier only; it cannot select a weaker policy. Only schema1, DOS/MBR,
512-byte logical sectors, boot/root/vault partitions1/2/3 and their fixed types
are supported. Starts/lengths are512-byte sectors and MiB aligned; ranges cannot
overlap or exceed the exact parent size. PARTUUIDs must bind to the declared
MBR disk ID and partition number. UUIDs identify data; they do not authenticate it.

The exact keys are defined in `validate_manifest`; unknown or duplicate JSON
keys, floats, booleans in integer fields, oversized JSON and unbounded geometry
are refused. A fresh synthetic manifest/observation example is in `fixture()`
in the tests. It is not an admitted production image profile.

`validate_observations` accepts an internal, trusted collector structure only:

- `mountinfo`: actual mountinfo text, including unique root overlay, moved ext4
  lower at `/run/portable-volatile-lower`, tmpfs backing at
  `/run/portable-volatile-root`, and read-only `/boot/firmware` FAT sibling.
- `parent`: canonical kernel major:minor plus table type/ID, sector size, size.
- `partitions`: normalized partition-table entries with canonical major:minor.
- `sysfs`: independently observed partition numbers, parents, starts and lengths.
- `vaultProbe`: direct probe result for the selected sibling, LUKS2 type/UUID,
  device identity and holders; this slice checks **locked, unheld** admission.
- `uuidMatches`: negative duplicate guard; it must identify only the already
  selected vault. It is never a source for selecting another device.
- `probeErrors`: empty only if every required collector operation succeeded.

The observation order and device names are not authority. The lower and boot
mount devices must match the declared sibling partitions, all sysfs parents
must match, and geometry must agree independently. Both the FAT mount and its
filesystem superblock must be read-only; a read-only bind of a writable FAT
filesystem is refused, including contradictory ro/rw superblock options.

Mount IDs and parent IDs must connect each protected mount through its nearest
observed ancestor. Stacked /run or /boot ancestors and disconnected/covered child
records refuse rather than relying on record order or numeric ID ordering. One
ordinary /run tmpfs (and a single /boot mount) is allowed when parent attachments
agree. Unexpected subordinate mounts
under the lower or upper backing are refused. A missing/error probe is not
blank media. An already active mapper requires a later explicit lifecycle
integration with checked mapped-device backing identity after open. Do not rerun
this locked validator after open, or weaken its holder check to handle that state
implicitly. The production collector must explicitly distinguish these phases.

Success returns `state=topology-identified` and `authenticatedMedium=False`.
It does not admit a payment, unlock a key, authenticate untouched bootcode,
prove a physical serial, or distinguish an exact replacement clone. A deployment
registry can help avoid accidental personalization reuse but is an operational
safeguard, not an authentication authority or a requirement of this pure API.

## Separate production collector contract — not implemented here

A later reviewed root-only collector must live outside the pure module. It must
accept no browser/worker profile, observation blob, device or filesystem-root
override. Its fixed trusted service configuration selects the immutable manifest
path; inspect root ownership, file type, symlink-free ancestors and mode before
reading a bounded regular file. Verify the actual lower mount and absence of
covering submounts before trusting a file reached through that lower.

Read `/proc/self/mountinfo` in the broker's verified PID1 mount namespace. Resolve
the lower major:minor through `/sys/dev/block`, require a partition with one
supported whole-disk parent, and enumerate only that parent's partition siblings.
Independently read sysfs partition/start/size, parent logical block size and
size. Kernel `size` and `start` use512-byte sectors; normalize explicitly.
Invoke fixed trusted `sfdisk --json` on that exact parent with bounded time/output
and no shell. Strictly parse its JSON, normalize DOS IDs/types (e.g. `0x12345678`
to `12345678`, `c` to `0c`) and convert units explicitly. Unsupported fields or
ambiguous units must not silently become zero/default values. Do not use guessed
`/dev/sda`, first lsblk match, or a caller's symlink to pick the candidate.

Probe only the selected declared vault directly using bounded blkid/cryptsetup
calls; separately inspect holders. A global UUID inventory, if retained, may only
reject duplicates; failure must refuse rather than select an alternate device.
Every subprocess failure is carried as a refusal. Revalidate under the existing
lifecycle lock and verify DM backing after an eventual open; a successful pure
check is a snapshot, not an atomic hotplug guarantee. The collector must be
qualified against real kernel observations before lifecycle integration.

## Offline tests

```sh
PYTHONDONTWRITEBYTECODE=1 python3 portable/raspberry-pi/storage/test_topology.py -v
```

Tests use only synthetic observations. They cover strict parsing, bounded MBR
geometry, role and parent binding, independent kernel/table disagreement,
mount shadowing, root/boot identity, renumbering/order changes, probe failures,
duplicates and explicit clone non-authentication. They do not prove actual block
collector behavior, image assembly, persistent UUID survival, reboot or hardware
boot. Those remain the separately reviewed synthetic MBR experiment.
