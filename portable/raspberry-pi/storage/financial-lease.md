# Financial vault lease (integration slice)

`financial_lease.acquire()` is a root-only embedding API, with no command-line
or broker RPC. It acquires the existing root-owned lifecycle flock in shared mode
before examining the already-unlocked fixed vault. It never opens/formats a
container or reads a credential's contents. Configuration, unique container UUID,
LUKS2 mapper UUID/backing device, PID1 mount view, unique visible ext4 mount and
mount options must match. Fixed `credit/provider.json` is opened relative to
pinned directory FDs, read-only/no-follow/nonblocking, UID/GID972 mode0600,
regular/single-link/1..16384 bytes. Directory identity allows journal activity;
record identity includes size, timestamps and links, so rotation requires a new
lease. Nonce and boot/mount identity distinguish acquisitions, not disk authenticity.

`supervise()` admits only root-owned fixed Node and
`/opt/portable/portable/funding/credit-lease-entry.mjs`. The optional consumer
is provided as source; missing deployed entry fails closed. A small root
keeper inherits the shared flock and monitors the caller with a pidfd. The caller
closes its duplicate. Caller death causes keeper cleanup; the keeper runs as a
subreaper, kills the owned consumer process group, and waits for all descendants
before closing the lease. Unreapable/detached descendants retain the keeper/lock
rather than pretending cleanup succeeded. Deployment needs cgroup lifecycle
containment; this library is not a general hostile-process sandbox.

The UID972 consumer receives only a private socketpair FD3 and read-only record
FD4, with no supplementary groups, explicitly cleared permitted/effective/inheritable/ambient capabilities and no-new-privileges. Socketpair credentials
identify their root creator; they do NOT authenticate each subsequent message as
UID972. Inherited FD possession is the private authority. Neither UI nor agent is
passed these descriptors. A malicious authorized financial consumer could transfer
its capabilities or copy a credential; lease revocation cannot erase copied secrets.

`funding/inherited-lease.mjs` implements the existing `{fd, signal,
assertCurrent(signal), release()}` contract. The private bounded protocol permits
only assertions and release, nonce-bound with sequential IDs; no paths, operations,
credentials or refresh authority are accepted. The keeper also revalidates
identity while idle. Consumer release acknowledges a drain request: the actual
root flock stays held until process cleanup. Supervisor success additionally requires
the consumer leader to exit zero; release followed by a hang or nonzero exit fails. Credit projection must drain its
monitor before release, and SDK hosts must reap their children before release.
Do not share one releasing lease among independent consumers without ownership
coordination.

Killing the keeper itself bypasses orderly lock-release guarantees. Linux still
pins a normally mounted filesystem while surviving record FDs are held, and
existing lifecycle code refuses busy/nonforced unmount; this is not equivalent to
retaining the flock. PDEATHSIG helps terminate the consumer but is not a claim
that keeper SIGKILL waits for reap. These limits are explicit; no forced unmount,
privilege broadening or financial readiness is introduced.

The private namespace fixture uses an explicitly injected internal mount verifier
for a fresh tmpfs only. Production `acquire()` has no bypass flag. It tests real
mount/FD identity, UID access, ordinary flock exclusion, replacement/overmount,
actual Node lease-to-credit-projection consumption, descendant cleanup and caller
SIGKILL. It does not qualify LUKS provisioning, existing vault images, real keys,
provider traffic or a production credit daemon. The fixed production ext4
requirement is tested to reject this tmpfs. No image/service changes are implicit.

This supervisor requires root SETUID/SETGID and private record access; existing
vault-broker service capabilities do not imply it can run there unchanged. A
future reviewed deployment unit must supply the actual supervisor privileges.

## Optional PPQ balance consumer

`financial-lease-run.py` is the fixed root bootstrap (no arguments). It calls
`acquire()` and `supervise()` for the fixed `funding/credit-lease-entry.mjs`.
The current supervisor lifetime remains bounded to 300 seconds. This is a
bounded session entry, not an installed continuously running credit daemon;
any future service restart must reacquire and revalidate the vault, not carry
an old lease across restart. The optional static credit unit is staged, but
never enabled or started by staging.

The optional consumer accepts only an explicit record
`{"version":1,"provider":"ppq","creditId":"<opaque credit ID>"}` in the
existing fixed `credit/provider.json`. It does not reinterpret an SDK
authorization/cache-secret record. JSON bytes are read by explicit FD offset,
bounded to 16 KiB, with lease assertions before and after reading; the credit ID
is 1..512 characters without whitespace/control characters. It creates no
account, payment, funding address or inference request. Runtime staging includes
the consumer closure. The default UI unit retains unconfigured credit; a future
reviewed deployment must enable the actual daemon together with the UI argument
`--credit-socket /run/portable-credit/credit.sock`. Missing service/vault
continues to display unknown credit and does not gate terminal/browser use.

The fixed read-only balance POST uses `/usr/bin/curl` with configuration files
disabled, minimal environment, remote DNS through SOCKS5 at 127.0.0.1:9050,
verified HTTPS and minimum TLS1.2. Redirects are never followed. The credit ID
travels on stdin, never argv/environment/logs. Output is bounded to 64 KiB plus
four status bytes; stderr is discarded and bounded to 8 KiB; curl and host
deadlines bound I/O. Abort/overflow terminates and reaps curl before rejection.
The target curl7.88.1 has no configured header-allocation bound here: headers
are not collected by this process, but libcurl's own parsing/memory limits still
apply. These output bounds are not a claim about all internal curl allocation.

`startLeasedCredit()` connects the real record reader, balance monitor and
read-only UID972 service, refreshing once at startup then every 60 seconds.
Neither agent nor UI can request refresh. Shutdown drains the monitor and
service before lease release. Synthetic transport injection is constructor-only
fixture authority; the deployed entry always selects the fixed curl operation.
Record bytes and JavaScript strings are not claimed to be securely zeroized.

## Explicit activation and unit authority

`units/portable-credit.service` is a real, disabled-by-default static unit with
no install target. After a separately authorized unlock, trusted root may start
`portable-credit.service`. Neither unlock helpers nor the vault broker start it,
and no polkit or sudo authority is granted to UID970 or UID971. Missing config,
mount or socket directory skips activation. Invalid or missing provider records
fail admission before requests. The desktop remains independently usable.

The root bootstrap must remain in PID1's mount namespace. The unit deliberately
omits filesystem namespace hardening such as `PrivateTmp`, `ProtectSystem`,
`ProtectHome`, `ReadWritePaths` and `PrivateDevices`; adding those would violate
the production namespace check. Its root capability set is limited to
`DAC_READ_SEARCH` for the UID972 private directory/record, `SETUID`/`SETGID` for
dropping the consumer's IDs, `KILL` for terminating its process group, and
`SYS_PTRACE` for inspecting PID1's protected mount-namespace link when PID1 has
more permitted capabilities than the bounded root process. It has no mount,
format, chown, clock-setting or packet capability. The consumer still receives
no capabilities or supplementary groups. This enumerated closure requires an
actual disposable-unit check before deployment; syntax checks alone cannot
prove it. Do not add capabilities merely to make a fixture pass.

Existing sysusers/tmpfiles staging creates `/run/portable-credit` UID/GID972
mode0755. The service does not run a generic root chown or select runtime paths.
Its sockets admit only authenticated UI UID971. Root must stop the credit
service before ordinary vault locking; otherwise its lease intentionally keeps
the lifecycle flock busy.

Each explicit start runs one 300-second session with `Restart=no`; expiry ends
the session as unavailable, and an explicit restart obtains a new lease. The
unit has a 330-second runtime backstop. Normal stop uses `KillMode=mixed`:
SIGTERM first reaches the root caller, whose surviving keeper reaps consumers
and releases the lease. After 20 seconds, systemd may SIGKILL the whole cgroup;
this forced fallback does not establish orderly lease release or recovery.

The default UI unit has no credit socket argument. The optional
`units/portable-workspace-ui.credit.conf.example` shows the exact UI override
for a reviewed daemon activation. It is not staged as an active drop-in. An
operator enables that UI connection together with the credit daemon, and
removes it when returning to deliberately unconfigured credit. No unit or
drop-in activation, provider call or existing guest mutation is performed by
the source/stager checks.
