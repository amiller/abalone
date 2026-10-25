# Read-only topology collector prototype

`topology_collector.py` adds a standalone `collect()` with no parameters and no
CLI arguments. It has no lifecycle, broker, formatting, mounting or provisioning
integration. Run only from a reviewed, root-owned code installation; the adjacent
`topology.py` is trusted code, not a plugin loaded from the vault.

The fixed manifest path is
`/run/portable-volatile-lower/opt/portable/etc/vault-topology.json`.
Before reading it, collection requires root, the same mount namespace as PID1,
verified read-only/noload moved lower, active overlay backing, and no covering
mounts below the lower. The file and its ancestors must be root-owned, not
symlinks and not group/world writable. The regular file read is bounded and
checks opened inode identity. No HOME, environment, worker JSON or profile path
can override the production entrypoint.

The collector derives the parent through `/sys/dev/block/<major>:<minor>` from
the actual lower mount, then reads the parent's partition siblings. Supported
parent names cover sd, vd, mmcblk and nvme namespace disks; dm, md, loop, zram
and arbitrary device stacks refuse. This explicit prototype supports DOS/MBR
and512-byte logical sectors only. A GPT or4Kn system does not fall back.

Every canonical `/dev` node is root-owned and its actual `st_rdev` must match.
Standard Debian root:disk(GID6) or root:root0660 block nodes are permitted; other
group writers and every world writer refuse. Directory ancestors remain
root-owned/nonwritable by groups. GID6 is an explicit prototype platform policy,
not a user-configurable authorization route; UI/agent must not be in disk group.

Fixed binaries `/usr/sbin/sfdisk`, `/usr/sbin/blkid`,
`/usr/sbin/cryptsetup`, `/usr/bin/lsblk` must be regular root-owned executables
under trusted ancestors, without symlinks or group/world write permissions.
Commands use argument arrays, no shell, a fixed minimal environment and cwd `/`.
Each command has3s wall timeout,1MiB stdout/4KiB stderr limits, and bounded kill/
reap cleanup. Probe failure errors never include raw stderr. Kernel-uninterruptible
IO cannot be made killable by Python; failed cleanup refuses and requires the
supervisor to terminate/reap the collector's service scope. This module supplies
no such service or background retry.

`sfdisk --json` output must be an exact supported schema. DOS ID/type spelling
is normalized explicitly; `unit=sectors` and `sectorsize=512` are mandatory.
Kernel start/size counters and table values are compared in512-byte units;
4Kn/unknown units are rejected, not guessed. Every table node must be a canonical
kernel sibling. Kernel/table disagreement, mismatched role mounts, declared
geometry changes, or held parent/vault refuse before LUKS probes.

Only the selected vault sibling is passed to direct `blkid -p` and
`cryptsetup isLuks --type luks2`. The lsblk UUID inventory is a negative duplicate
guard only: it never supplies a candidate path or fallback. Inventory may depend
on udev/device metadata freshness; it is not independent authentication or proof
that an unattached clone does not exist. Direct selected-device verification
remains mandatory. Mount/namespace and kernel geometry are rechecked before
return, but this is not atomic with hotplug or an eventual unlock operation.

Collection is **locked/unheld admission only**. It returns the existing pure
identity projection, explicitly `authenticatedMedium=False`. Post-open mapped
identity needs a separately reviewed state-aware collector/lifecycle branch;
no active-holder exceptions are introduced here.

## Tests and qualification

```sh
PYTHONDONTWRITEBYTECODE=1 python3 portable/raspberry-pi/storage/test_topology_collector.py -v
```

The private `_collect(trusted_io)` API is an explicit in-process offline test
seam. It is not a production CLI, IPC method, profile override or dependency
chosen from request data. Tests inject synthetic mountinfo/sysfs/probe responses,
plus execute bounded synthetic Python subprocesses to prove timeout, overflow
and nonzero-exit handling. They do not exercise cryptsetup or actual disks.

A read-only inventory of the existing ARM guest reports plain ext4 `/` and no
moved lower. It is therefore unsuitable for a positive collector qualification;
no actual vault was probed or accepted. The separate fresh synthetic MBR image
experiment, root-owned installation and runtime review remain required.

The collector relies on the kernel block interface and rejects ambiguous sector
semantics; see the [kernel block ABI](https://www.kernel.org/doc/html/latest/admin-guide/abi-stable.html)
and [sfdisk manual](https://man7.org/linux/man-pages/man8/sfdisk.8.html).
