# Portable storage slice: accounts + vault lifecycle

Status: **accounts+vault milestone, source only.** Nothing here is deployed,
enabled or guest-qualified by this repository; applying units and guest tests
are separate supervisor steps (see *Deferred work*). The earlier writer
snapshot was rejected by independent review; this tree is the bounded repair
of the accounts+vault items. The volatile-root overhaul is a separate
follow-up and is explicitly **unqualified/deferred** here.

Components:

- `guest/` — scripts deployed to `/opt/portable` by `deploy.sh` (accounts,
  root-owned tree, config, lifecycle scripts, broker, verifier).
- `units/` — systemd units: the root vault broker (deployed) and hardened
  *templates* owned by the workspace/funding slices.
- `tests/` — offline tests with injected fake executors (no host block
  devices are touched, nothing is really mounted or formatted).

## Mount authority model (explicit decision)

The vault lifecycle helper (broker + `unlock-vault.sh`/`lock-vault.sh`)
performs privileged `cryptsetup`/`mount`/`umount`/`chown` operations **in the
host mount namespace**, deliberately, so the late vault mount at
`/run/portable-vault` is created where every other unit can see it.

systemd sandboxing directives such as `PrivateTmp=`, `ProtectSystem=strict`,
`ProtectHome=`, `PrivateDevices=`, `ProtectKernelTunables=`,
`ProtectControlGroups=` or `PrivateMounts=` each implicitly create a private
mount namespace for the unit (even without a `PrivateMounts=` line), whose
propagation *outward* to the host is disabled; a vault mounted inside it is
invisible to the host and to every other service, and `MountFlags=shared`
does not repair that initial slave transition. The broker unit therefore
carries **none** of those directives. Its authority is bounded instead by:

- a fixed three-command protocol (`unlock`/`lock`/`status`, no parameters),
- a root-owned trust-chain-verified config (`/opt/portable/etc/vault.conf`,
  mode 0600) and script tree (`/opt/portable/bin`, root 0755),
- SO_PEERCRED allow-listing,
- `CapabilityBoundingSet=CAP_SYS_ADMIN CAP_CHOWN` — enumerated against the
  actual operations: device-mapper ioctls and mount/umount (SYS_ADMIN), and
  chown of the broker socket group plus freshly created per-account vault
  directories (CHOWN). No device-allow list is used: the vault is a removable
  block device whose node name is not statically known and systemd device
  allow rules have no "all block devices" wildcard (`DeviceAllow=block rw` is
  invalid syntax and matches nothing).

Consumer units (`portable-ui`, `portable-agent`, `portable-credit`) may keep
full sandboxing including `PrivateTmp=`/`ProtectSystem=`: their namespaces
are *slaves* of the host namespace, so the late host-namespace vault mount
propagates in. They must not set `PrivateMounts=` or private `MountFlags=`
(the verifier rejects those). The **UI is vault-independent**: it starts and
serves its locked-state interface with no `ReadWritePaths` under
`/run/portable-vault` (that directory does not exist while locked) and no
mount condition; persistent vault state is exposed only after a successful
unlock. `verify-fs-boundary.sh` statically enforces this model on the
effective units, including `systemd-analyze verify` when available
(otherwise that check is a labelled unqualified WARN, never a pass).

## Accounts and authority

Created by `deploy.sh` (system accounts, nologin, no sudo anywhere):

| account | role | vault lifecycle authority |
| --- | --- | --- |
| `portable-agent` | agent session | **none** — not in `portable-operators`, refused by socket permissions and SO_PEERCRED |
| `portable-ui` | unprivileged workspace UI | **none** — not in `portable-operators`, forbidden by broker configuration |
| `portable-credit` | credit journal owner | unlock/lock/status via broker |

The lifecycle helper has no account: it runs as root (the broker service).

## Configuration trust chain

`vault.conf` is untrusted *text*, parsed by a strict no-`eval` parser: every
key must be an exact literal member of the known-key set (full case match,
not a first-character check) before it is used in any way, including
associative-array subscripts; unknown or duplicate keys are refused. The
Python broker implements the same schema (subdir distinctness and
socket-outside-mountpoint included) and passes its **own validated
`--config` to every dispatched helper**, so a dispatched operation can never
silently use a different policy than the validated one.

Production authority additionally requires the whole trust chain:
config root-owned mode 0600, regular file, no symlinks, and every ancestor
root-owned and not group/world-writable; the same for the helper script tree
(0755) the broker execs. Every lifecycle entrypoint additionally carries an
INLINE trust bootstrap that validates its own script and `common.sh` (root
ownership, exact 0755 mode, symlink-free file and ancestor chain) BEFORE the
`source` line — a writable, replaced or symlinked shared leaf can never
execute, and the verifier deliberately does not live in the file it
validates. The broker validates `common.sh` alongside the three dispatchable
scripts for the same reason. There is no flag, environment variable or "test
mode" that relaxes these checks in production; offline/staged trees simply
fail them until deployed as root.

The Python broker parses `vault.conf` with the same strictness INCLUDING the
no-whitespace-stripping rule: a line is `KEY=VALUE` exactly as written, so
leading/trailing whitespace or CR makes a configuration invalid in BOTH
parsers — the shell and the broker can never disagree about what is
acceptable.

## Lifecycle serialization and identity

- **One exclusive root-owned flock at ONE FIXED PATH**
  (`/run/.portable-vault-lifecycle.lock`, root:root 0600; `/run` itself must
  be a trusted directory) is held by ALL `provision`/`unlock`/`lock`
  interactions for the entire operation (`status` takes a shared lock). The
  path is deliberately NOT derived from the config path: two root-owned
  configs in different directories can name the same mapper, and a per-config
  lock would let lifecycle operations through those aliases race each other.
  Check-before-act races between concurrent lifecycle requests are therefore
  impossible; concurrent CLI/broker operations serialize or fail with
  `EX_BUSY` without touching state.
- **Exact identity before altering anything**: the configured LUKS UUID must
  resolve to exactly one device (duplicates are refused) cross-checked by
  `blkid` (`crypto_LUKS`, same UUID). An already-active mapper is used only
  after its backing device major:minor matches that device; the mount must be
  EXACTLY ONE entry at the exact mountpoint whose mounted device identity
  (kernel major:minor, not the SOURCE string) IS the mapper block device,
  with the configured fstype and mandatory options — same-string, same-label
  and stacked/overmounted states are rejected by device identity. An
  unexpected mapper or mount is **refused and never closed/unmounted** by
  these scripts.
- **Truthful cleanup**: every fallible post-open step is guarded and an
  EXIT/ERR-trap safety net catches anything unguarded; cleanup then
  closes/unmounts only resources the operation itself created (tracked,
  identity re-verified at cleanup time, ownership flags set before the
  fallible step and re-checked against OBSERVED state), reports the actual
  remaining kernel state (`mapping=… mounted=…`) after any failure, and
  preserves busy-but-unlocked state visibly. The success path disarms the
  failure cleanup: a completed unlock is the intended state. `lock-vault.sh`
  keeps plain `umount` only (no `-l`/`-f`/`-R`); a busy vault exits `EX_BUSY`
  and stays mounted, and an interrupted lock reports the state it reached
  without forcing anything. Broker timeouts kill and reap the whole helper
  **process group** and reply `state unknown/partial — query status
  separately`: a killed group cannot claim cleanup.
- **Structured status**: `vault-status.sh` ends with one final `state:` line
  (`unlocked` / `locked` / `partial` / `unsafe`) computed from device
  resolution + mapping identity + exact mount identity/options. A mismatch
  (foreign backing device, unexpected/stacked/wrong mount, mount without an
  active mapping) is `state: unsafe` and exits `EX_PRECOND` (6) with the
  state line last — the broker-visible reply can never hide a mismatch
  behind "unlocked".
- **Provision preflights before any dangerous step**: mapper-name collision,
  whole-disk identity, declared size match, mounted descendants, holders and
  partitions (the lsblk subtree must be exactly the bare disk; an lsblk probe
  FAILURE is a refusal, never "no mounts"/"bare"), and signature probes all
  run before `cryptsetup luksFormat`; a *probe failure* (wipefs, blkid or
  lsblk error) is a refusal, never "blank". Provision only touches the
  explicitly declared fresh device; there is no default device and no wipe.
  After a successful verification open, failures and interruptions close only
  the mapping this operation opened (identity re-verified) and report the
  observed mapping state.

## Passphrase contract

One contract, enforced identically on provision and unlock: the passphrase
is **NUL-free text, 1..512 bytes**, read once from the helper's stdin, held
briefly as hex text in shell memory, and fed byte-exactly to
`cryptsetup --key-file=-`. NUL bytes are refused up front on both paths (and
by the broker), eliminating the bash-cannot-hold-NUL ambiguity between
provision-time and unlock-time keys. The passphrase is never an argument,
environment variable, log line or key file. Newlines, Unicode and any other
NUL-free byte sequences travel verbatim (a 512-byte maximum, with an
oversize probe byte, is enforced on a single bounded read).

## Exit codes

`0` ok · `2` usage/passphrase-channel · `3` busy (state left visible) ·
`4` vault operation failure (wrong key, missing filesystem…) · `5` config
missing/untrusted/invalid · `6` precondition failure (not root, missing
tool, wrong/unresolvable device, unexpected mapper/mount).

## Testing

`tests/run-tests.sh` runs the offline suite standalone. It uses **injected
fake executors** (cryptsetup/lsblk/blkid/findmnt/mount/umount/fuser/…) and a
user+mount namespace (`unshare --user --map-root-user --mount` with a private
tmpfs on `/run`) so the production code paths — including `require_root`,
the trust chain and the lifecycle lock — execute for real without touching
any host block device, mount or service. Covered: config injection refusal
(no `eval`, no side effects), trust-chain refusals, lifecycle serialization
under concurrency, wrong-existing-mapper refusal (never closed), wrong-key
cleanup touching only own leftovers, same-string/unrelated-mount refusals
(by device identity), per-account mkdir/chmod/stat/chown and mount failures
with state-aware cleanup, umount/close failures leaving visible truthful
state, signal interruption during open/mount/lock/provision-verification
(bounded waits), busy refusal (stays visibly unlocked),
all-preflights-before-format ordering (including holders and probe
failures), the passphrase byte contract (NUL/empty/oversize/byte-exact),
broker protocol/config/dispatch/timeout semantics, the broker dispatch
contract against the real helpers (foreign mapping, same-string mount,
duplicate/absent UUID never reported as unlocked; full unlock/lock/status
round trip), bounded broker shutdown and socket cleanup, and static
`systemd-analyze verify` of the units. When user
namespaces are unavailable, root-mode tests are labelled SKIPPED, never
faked.

## Deferred work (explicit)

- **Volatile root (milestone B) is UNQUALIFIED/DEFERRED.** `volatile-root.sh`
  exists but live volatile-root qualification (findmnt/mountinfo root
  upperdir/workdir tmpfs-backing audit, read-only lower root and boot, all
  real block-backed mounts, active swap, reboot canaries, lower-image hashes)
  is not implemented, and `verify-fs-boundary.sh --milestone volatile-root`
  deliberately reports configuration-level checks only. Do not treat any
  guest as volatile-root based on this tree.
- Guest deployment, service enablement, real-disk provisioning, real USB
  partition initialization (this whole-disk provisioner cannot create
  partitions), unlock UI flow (passphrase entry UX), and credential/inference
  integration are separate reviewed steps/slices.

Status probe failures are not a locked vault. Helpers accept an active mapper only
when `cryptsetup status` succeeds. Inactivity requires cryptsetup exit 4 plus a
successful independent `lsblk -arn -o KNAME,NAME` kernel inventory showing no mapper
with the configured name. Other exits, failed/empty inventories and contradictory
mapper evidence abort with `state: unknown` before lifecycle changes. This is a
fail-closed error requiring diagnosis; it is never permission to reformat a disk.

The public workspace UI is not a trusted financial operator: local agent processes
can access its loopback API and CSRF token. Only the separate `portable-credit`
account is authorized by default to reach the lifecycle broker. Both `portable-ui`
and `portable-agent` are forbidden in `BROKER_ALLOWED_UIDS`, including old configs.
UI still owns its isolated `ui/` vault subdirectory; ownership grants no lifecycle
control. A future trusted operator interface must have its own reviewed authority.

Image deployment reserves UID/GID 970 (`portable-agent`), 971 (`portable-ui`),
972 (`portable-credit`), GID 973 (`portable-operators`), and GID 974 (`portable-ipc`). Collisions refuse.
Existing accounts must exactly match UID, primary GID, canonical home,
`/usr/sbin/nologin` shell and expected groups. Only credit has supplementary
operator membership. Agent and UI have exactly the shared unprivileged
`portable-ipc` supplementary group for workspace transport. Deployment checks the entire identity graph before creation;
it does not adopt arbitrary same-named accounts or silently remove unsafe access.
An image already using these IDs needs an explicitly reviewed identity plan.

These IDs are image policy, not globally reserved Linux IDs. Before applying to
any image, inspect its actual passwd/group databases (including the pinned Pi
image) for collisions. Workspace sysusers templates must use the same identities;
do not let a separate first-boot allocator create differently numbered accounts.

## Trusted VT operator prototype

`operator-vt.py` and the inactive `units/portable-vault-operator.service` provide
a fixed tty2 interface for status, unlock and lock through the existing broker.
The unit uses UID972, empty capabilities and no core dumps; it excludes tty2 getty
while active. The image stager includes its static unit and source without
enabling it. On an explicitly selected test VM, it waits for tty2 to become
active before reading input; actual keyboard custody still needs qualification.

Focused offline tests exercise real PTY rejection, noecho and signal restoration,
queued-input disposal, bounded socket transport and uncertain-outcome handling.
They do not establish actual tty2/PID1 or keyboard custody. The console does not
start the credit service after unlock, enroll credentials or grant agent/UI
access. Unknown results require an explicit status check; no operation is retried
automatically. Python passphrase copies are not securely zeroized.

Run `python3 -B portable/raspberry-pi/storage/tests/test-operator-vt.py` and
`python3 -B portable/raspberry-pi/storage/tests/test-console-composition.py` from the repository.

### Optional console credit session

The static operator unit waits for Ctrl+Alt+F2 without switching focus. Its
Unlock/Status/Lock protocol and UID972 authority are unchanged; Ctrl+Alt+F1
returns to the desktop. Neither the graphical UI nor agent can authorize these
operations. Real tty2 custody remains a disposable-VM qualification gate.

Root may explicitly select the example
`units/portable-vault-broker-credit-session.conf` as a broker drop-in. The base
broker unit remains lifecycle-only. Opt-in verifies unlock before starting only
`portable-credit.service`, and stops/drains that fixed unit before ordinary lock.
A busy composed transaction is refused immediately. Partial/unknown outcomes
require status reconciliation; no automatic retry or rollback occurs. The mutex
serializes broker clients, not independent trusted-root helper invocations.
Service activation is not evidence of credit freshness or accurate financial time.

The image caller must supply reviewed vault configuration, optional drop-in and
explicit unit activation. The runtime stager copies executable helpers and static
units but does not fabricate vault UUIDs, enable units, or format storage.
