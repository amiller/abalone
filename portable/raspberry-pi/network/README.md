# Tor guest egress policy generator and guest boot installer

This directory holds two layers for a disposable Debian-family guest:

- `generate-policy.mjs` emits configuration **text**: an nftables ruleset plus
  a torrc. The module itself installs nothing and applies nothing.
- `guest-install.sh` is the guest boot **installer** for an expendable cloned
  ARM guest (QEMU bookworm with systemd-networkd, or the pinned Raspberry Pi
  OS Legacy Lite Bookworm image that ships NetworkManager). It resolves the
  guest's real identities, generates the root-owned nft/torrc/hash files at
  install time, and installs the loader (`tor-guest-load-nft.sh`) and the
  systemd units (`units/`). The supervisor runs it inside an isolated clone;
  nothing in this repository applies it to any live host or guest.

## Policy zero (exact claim scope — read before relying on this)

The policy enforces, and this slice claims, exactly this:

- From the moment `tor-guest-firewall.service`'s single nft transaction
  commits at boot (ordered `Before=network-pre.target`, with every networking
  consumer `Requires=`+`After=` it), inet-family egress is constrained to:
  the DHCP owner's uid doing IPv4 DHCP (68→67), the Tor uid opening IPv4 TCP
  to non-loopback addresses, and the two post-DNAT redirected cases. Input
  and forward drop except loopback, DHCP replies and established IPv4 TCP
  replies. IPv6 is dropped except loopback.
- Everything **before** that commit point is outside this policy: board
  firmware, bootloader, and any initramfs can bring up networking ungated.
  The shipped unit does not and cannot guard pre-systemd traffic. No claim
  is made about it here, and none may be inferred.
- The initial DHCP exchange (discover/offer/request/ack) leaves over
  networkd's `AF_PACKET` raw socket and bypasses inet uid filtering by
  construction (details below); it is bounded only by capture, not by the
  rules.
- Enforcement is only as strong as guest root, the kernel, nftables and
  Tor; the host operator and guest root are in the trusted computing base.

The **only** evidence that could support a "no unexpected egress for the
whole boot" statement is a full-frame capture from power-on, reconciled
frame-by-frame against the Tor uid's connections, together with an
inventory of the actual image (what first-boot tooling, firmware network
stacks and initramfs it carries). A captured generic Debian ARM QEMU rehearsal is recorded below. It establishes
observed behavior for that prepared guest, rather than a guarantee for other
images or Raspberry Pi firmware. The automated tests remain structural and
offline; untested acceptance scenarios below remain gates. When a
statement below says the guest "stays offline", it means the
systemd-managed stack (networkd, resolved, Tor, the workspace unit) is held
down by `Requires=` after a failed firewall load — nothing more.

Policy shape (all identifiers are configuration text, not live state):

- `table ip tor_guest_nat` (nat output): Tor's uid is exempt (no redirect
  loops); loopback destinations stay local; all non-Tor IPv4 UDP/53 is
  redirected to Tor's DNSPort `127.0.0.1:5353`; all remaining non-Tor IPv4 TCP
  is redirected to Tor's TransPort `127.0.0.1:9040`.
- `table inet tor_guest_filter`: input allows loopback, IPv4 DHCP replies
  (67→68) and established **IPv4 TCP** replies — the return half of
  connections the Tor user opened outbound (relay answers), scoped with
  `meta nfproto ipv4 ct state established meta l4proto tcp` so there are no
  new inbound connections, no UDP/ICMP replies and no IPv6; forward drops;
  output allows loopback, IPv4 DHCP requests (68→67) for `dhcpUid` only,
  IPv4 TCP for `torUid` only, and — because `redirect to` rewrites the
  destination after the output routing decision — exactly the two post-DNAT
  cases explained below; default drop. There is deliberately **no**
  established exception in the output chain (that would let flows opened
  before the policy load keep leaking), and no LAN exemptions — LAN TCP from
  non-Tor users is proxied through Tor like everything else. IPv6 is dropped
  everywhere except loopback: `iifname/oifname "lo" accept` also covers IPv6
  loopback (`::1`) for local guest services, while all off-box IPv6 and all
  other direct application traffic (UDP beyond DHCP/DNS, ICMP, QUIC) is
  blocked, not proxied.
- Hook routing metadata (why redirected traffic needs its own output
  accepts): the nat output chain runs at `priority -100` (dstnat) and
  rewrites application TCP/DNS to `127.0.0.1:9040` / `127.0.0.1:5353`, but
  the routing lookup that selects the output interface happens **before**
  that rewrite. When the filter output hook (`priority filter`) evaluates a
  redirected packet, its `oifname` therefore still reports the interface
  from the original, pre-rewrite route — a live trace shows app TCP DNAT'd
  to `127.0.0.1:9040` still carrying the old veth `oif`, so
  `oifname "lo" accept` cannot match it and the default drop would discard
  the redirected traffic before Tor ever sees it (UDP DNS to 5353 alike).
  The output chain instead accepts redirected traffic by rewrite metadata,
  not interface name:
  `ct status dnat ip daddr 127.0.0.1 tcp dport 9040 accept` and
  `ct status dnat ip daddr 127.0.0.1 udp dport 5353 accept`, placed right
  before the final drop. The `ct status dnat` guard matches only flows the
  nat chain actually destination-rewrote, and the exact address plus the
  two Tor listener ports accept nothing else — no other loopback port, no
  non-loopback destination, no LAN bypass, and still no blanket conntrack
  exception in the output chain. Traffic an application sends directly to
  `127.0.0.1:9040`/`5353` was never DNAT'd (the nat chain returns early for
  loopback destinations), routes through `lo` for real, and is already
  covered by `oifname "lo" accept`.
- torrc: loopback-only `SocksPort 9050`, `TransPort 9040`, `DNSPort 5353`;
  `AutomapHostsOnResolve 1` with `VirtualAddrNetworkIPv4 10.192.0.0/10`
  (private, non-loopback, so automapped addresses are transparently proxied);
  `ExitPolicy reject *:*`.

## Commands (from repository root)

Run the tests (text-structure checks only — see limits):

```sh
node --test portable/raspberry-pi/network/policy.test.mjs portable/raspberry-pi/network/guest-install.test.mjs
```

The second file additionally proves that the nft/torrc templates embedded in
`guest-install.sh` are byte-identical (modulo uid substitution) to
`generate-policy.mjs` output, so the installer cannot have weakened the
validated generator, and it exercises the loader against a fake `nft`
executor (atomic reload, invalid-rules retention, no stop-flush, guarded-boot
interface/owner checks) and the installer against offline fake guest trees —
including a mounted-image-style tree with no sysfs, network-config conflict
refusal/retirement, drop-in-aware effective-owner resolution, the resolver
paths, and offline `systemd-analyze verify`. The default verify scope is a
stub unit graph; set `TOR_GUEST_VERIFY_ROOT=<staged guest root>` to check the
shipped units against a real staged image's actual unit graph (read-only;
skipped with an explicit message when unset). Nothing is started, applied or
mutated by these tests, and none of them establishes live enforcement.

Generate the two files (uids are examples; pick your guest's real uids):

```sh
node --input-type=module -e '
import { writeFileSync } from "node:fs";
import { generatePolicy } from "./portable/raspberry-pi/network/generate-policy.mjs";
const p = generatePolicy({ torUid: 143, dhcpUid: 106 });
writeFileSync("tor-guest.nft", p.nftables);
writeFileSync("torrc", p.torrc);
'
```

Apply inside the guest (root, after the two uids actually belong to the
dedicated Tor and DHCP service accounts). uids must be integers in
`1..4294967294`; `4294967295` (UINT32_MAX, the `(uid_t)-1` sentinel) is
refused.

Applying this policy cuts off SSH-based diagnostics: the SSH daemon's
replies are root-owned TCP, which the output chain drops, and there is
deliberately no established output exception. Apply and test from the guest
console, or rehearse in a disposable network namespace first — do not assume
an SSH session survives the load.

```sh
nft -f tor-guest.nft      # first load: nothing to delete yet
tor -f torrc              # run as the Tor user; no unit is shipped in this slice
```

### Atomic reload (no fail-open interval)

Never replace the tables with separate commands — running `nft delete
table ...` and only then reloading leaves a window with no policy at all.
`nft -f` applies an entire file as one transaction, so:

1. Detect which dedicated tables currently exist:
   ```sh
   nft list table ip tor_guest_nat       # exists?
   nft list table inet tor_guest_filter  # exists?
   ```
2. For each table that exists, prepend a matching `delete table ...` line to
   the generated file, above the new definitions. (Deleting a nonexistent
   table aborts the batch, so only include the ones actually found.)
3. Run `nft -f` on that single file once. The deletes and the new table
   definitions commit together: there is no interval in which the tables are
   absent.

This touches only the two dedicated tables; never `nft flush ruleset`.

The installed guest does this automatically at boot: `tor-guest-load-nft`
(the loader below) builds exactly this single transaction file on every
load, including reloads.

## Guest boot installer (guest-install.sh)

The installer is an **explicitly disposable-guest operation**: it refuses to
run without `--yes-disposable`, because it masks stock services and rewires
networking. It takes the uplink as a parameter, detects and verifies it, and
never assumes a private interface name:

```sh
./guest-install.sh --interface <uplink> --yes-disposable \
    [--workspace-unit <name.service>]      # optional gating for the agent unit
# offline into a mounted/staged tree instead of the live root — the usual
# case. A mounted image has an EMPTY /sys, so the interface can only be
# attested with explicit reviewed metadata; the loader re-validates the
# real device on every guarded boot before any networking:
./guest-install.sh --root /mnt/clone --interface eth0 --yes-disposable \
    --interface-type 1
```

Interface verification, live vs offline:

- **Live target** (`--root /` omitted): the interface must exist under
  `/sys/class/net` and be a plain ethernet device (`type == 1`), checked
  against the live sysfs at install time.
- **Offline tree** (the mounted-image case): the tree usually carries no
  sysfs. The installer accepts `--interface-type 1` as **explicit reviewed
  interface metadata** (ARPHRD_ETHER; the only value this stack takes). It
  never bind-mounts host sysfs into the tree to fake validation — that
  would prove nothing about the guest's actual device. The attested name and
  type are recorded in `/etc/tor-guest/uids`, and the loader re-validates
  the real `/sys/class/net/<iface>` on every guarded boot, before any
  networking (below). A staged tree that does carry sysfs info is verified
  against it and any disagreement refuses the install.

The installer is offline (no downloads, no Node at install or runtime) and
fails on anything it cannot verify. It refuses: a missing/unconfirmed
disposable flag, `lo` or a non-ethernet or (live/staged) unverified
interface, an offline tree without sysfs and without `--interface-type`, a
first-boot customization script still present (`boot/firstrun.sh`), a
missing tor binary, any unresolvable identity, any target networkd config
that would win the uplink (below), and an active `nftables.service` on a
live target.

### Identities resolved, never assumed

The two uids the ruleset pins are **resolved at install time from the
target's own `/etc/passwd`** (never the install host's `getent`): `debian-tor`
for Tor, and the **effective** owner of systemd-networkd — the `User=` the
manager would actually apply, computed from the unit file **plus every
drop-in** (`systemd-networkd.service.d/*.conf` across `/etc`, `/run`,
`/usr/lib`, `/lib`; per drop-in filename the highest-priority directory's
copy counts, drop-ins apply in filename order, the last `User=` winning).
A networkd that would run DHCP as **root** (no `User=` anywhere, or a
drop-in setting it) is refused outright. `--dhcp-account` is a cross-check,
not an override: it must equal the computed effective owner or the install
refuses. The resolved account names and uids are written to
`/etc/tor-guest/uids`, and on every guarded boot the loader re-verifies
both mappings against `getent passwd` **and** re-checks the live effective
owner via `systemctl show systemd-networkd.service --property=User` — a
drop-in added after install cannot silently move DHCP to another uid (or
root) without failing the firewall load first. The values observed in one
bookworm guest (tor 104 / networkd 998) differ from image to image, so
nothing defaults to them.

### What gets installed

- `/etc/tor-guest/`: root-owned `tor-guest.nft` and `torrc` generated from
  the embedded templates (proven equal to the validated generator by the
  test suite), `uids`, and sha256 sidecars — all produced **at install
  time**, never by runtime Node. The torrc gains only `DataDirectory
  /var/lib/tor-guest` and `Log notice stdout`; no listener, port, address
  or exit-policy directive is repeated or overridden.
- `/usr/local/sbin/tor-guest-load-nft`: the loader (below).
- `tor-guest-firewall.service` (early, fail-closed) and `tor-guest.service`
  (Tor as the resolved account, `StateDirectory=tor-guest`, empty
  `CapabilityBoundingSet=`, no `AF_PACKET`, loopback listeners only).
- `Requires=`+`After=` gating drop-ins for `systemd-networkd.service`, for
  `systemd-resolved.service` when present, and for the optional
  `--workspace-unit` (which must already exist in the target — agent and
  storage accounts are owned by the storage slice; this installer grants
  no account anything and adds no sudo, capabilities or setuid bits).
- `/etc/systemd/network/10-tor-guest-uplink.network`: deterministic
  single-interface networkd config — `Name=<uplink>` (verified or attested),
  `DHCP=ipv4`, `IPv6AcceptRA=no`, `LinkLocalAddressing=no`, `LLDP=no`,
  `LLMNR=no`, `MulticastDNS=no`. Its precedence is **enforced**, not hoped
  for: every conflicting target config was refused (or explicitly retired),
  see below.
- A resolver path (below) and, when anything was retired,
  `/etc/tor-guest/retired-network.txt` plus the moved files under
  `/var/lib/tor-guest/retired-network/`.

### Migration and gating: NetworkManager image vs systemd-networkd guest

Both supported images end on systemd-networkd:

- QEMU bookworm guest: networkd already present; it is enabled and gated.
- The pinned Raspberry Pi OS Legacy Lite Bookworm image ships
  **NetworkManager**. The installer disables and masks
  `NetworkManager.service` (plus wait-online/dispatcher), and `dhcpcd`,
  `networking` and any other present competitors from the same set.
- cloud-init network regeneration is disabled via
  `/etc/cloud/cloud.cfg.d/99-tor-guest-disable-network-config.cfg`
  (`network: {config: disabled}`) when `/etc/cloud` exists.
- Stock `tor.service` is masked: the guest runs the custom `tor-guest.service`
  instead (dedicated state dir, loopback listeners, no capabilities).
- Stock `nftables.service` is masked: its stop/reload action runs
  `nft flush ruleset` and would delete the owned tables. A live target with
  `nftables.service` currently active is refused (stopping it would flush
  the ruleset); install into a freshly booted clone.
- First-boot regeneration: an image still carrying `boot/firstrun.sh` is
  refused; install into a clone of an image that has completed its first
  boot. This is a gate on the observed mechanisms, not a proof that no
  first-boot tooling exists (see limits below).

### Network config precedence: refused or retired, never outranked

The installer supports a deliberately restricted networkd configuration subset.
Before changing the target it refuses existing `.network.d`, `.link.d`, and
`.netdev.d` configuration drop-ins in all searched network directories, including
`/usr/local/lib/systemd/network`. It also refuses name negation, quoted or escaped
names, empty name resets, and continued lines. These require manual image review
and simplification; `--retire-network-conflicts` does not bypass this refusal.
This conservative scanner is not a complete systemd configuration evaluator.
Review the target's actual interface names (including alternative names), udev
naming policy and runtime-generated configuration before clone qualification.


Writing a `10-` file is not precedence — per `systemd.network(5)` the first
lexically matching `.network` file wins, so an existing `05-`/`01-`/`00-`
file matching the uplink (or a `.link` that renames it, or a `.netdev` that
declares its name) takes the interface no matter what we write. The
installer therefore **scans every search dir** (`/etc`, `/run`, `/usr/lib`,
`/lib` under `systemd/network`, deduplicated) before writing anything and:

- **refuses** by default, naming each conflicting file; or
- with `--retire-network-conflicts` **moves** each conflict (never deletes)
  into `/var/lib/tor-guest/retired-network/`, preserving its path, and
  records sha256 (or symlink target), reason and original path in
  `/etc/tor-guest/retired-network.txt`.

A file is a conflict when it can win or rename the uplink:

- `.network` sorting **before** `10-tor-guest-uplink.network` whose `[Match]`
  has no `Name=` key (matches every interface) or a `Name=` glob matching
  the uplink (`Name=` is a hard AND condition, so a non-matching `Name=`
  list rules the file out even if other keys are unevaluable offline).
  Later-sorting files can never win and are left in place.
- `.link` that can match the uplink (no `OriginalName=`/`Name=` match keys =
  matches all, or a glob matches) **and** can rename it: a `[Link] Name=`
  different from the uplink, or a `NamePolicy=` whose first token is not
  `keep`. The stock Debian `99-default.link` (`NamePolicy=keep kernel
database onboard slot path`) keeps the name and is not a conflict;
  Raspbian's `73-usb-net-by-mac.link` (`NamePolicy=mac`) is.
- `.netdev` whose `[NetDev] Name=` equals the uplink (device-name collision).

This detection is conservative and offline-evaluable; it is not a full
reimplementation of networkd's matcher (match keys like `Driver=`/`MAC=` on
files that also carry a non-matching `Name=` are correctly excluded, but a
`Name=`-less file with `Driver=` is treated as match-all). When in doubt the
installer refuses and the operator decides.

### Resolver after migration (explicit, working, gated)

Masking NetworkManager and dhcpcd kills whatever was managing
`/etc/resolv.conf`; an unmanaged stub or stale file is not an acceptable
end state. The installer establishes exactly one reviewed resolver path,
recording any replaced `/etc/resolv.conf` in the retirement manifest:

- **systemd-resolved present in the image**: it is **enabled** and gated with
  the same `Requires=`+`After=` firewall drop-in as networkd, and
  `/etc/resolv.conf` becomes a symlink to `/run/systemd/resolve/stub-resolv.conf`
  (the `127.0.0.53` stub). Applications reach the stub over loopback (never
  redirected, by design); resolved's own **upstream** queries are non-Tor,
  non-loopback UDP/53 and are redirected by the nat output chain to Tor's
  DNSPort — resolution still goes through Tor. Tor bootstrap DNS uses Tor's
  own loopback DNSPort and tor-uid TCP egress, both already inside the
  policy; no rule is added for any of this.
- **no systemd-resolved in the image** (an offline installer cannot add
  packages): a static **fail-closed sentinel** `nameserver 192.0.2.1`
  (RFC 5737, unroutable). It resolves *only because* the firewall redirects
  all non-Tor, non-loopback UDP/53 (and TCP/53) to Tor's DNSPort/TransPort;
  without the policy loaded it resolves nothing. Replacing it with a real
  resolver address would create exactly the unguarded-UDP path the policy
  exists to close; the file says so.

A structural test pins the nat-chain ordering this depends on (Tor-uid
exempt first, loopback returned, then the udp/53 and TCP redirects); live
DNS success (Tor bootstrap and application DNS) remains a clone-boot
acceptance scenario.

### Boot ordering contract (fail closed)

`tor-guest-firewall.service` is the documented early-firewall shape:
`DefaultDependencies=no`, `Wants=network-pre.target`,
`After=systemd-sysusers.service systemd-modules-load.service`,
`Before=network-pre.target shutdown.target`, `Conflicts=shutdown.target`,
`Type=oneshot`, `RemainAfterExit=yes`. It has **no ExecStop** and no stop
path — stopping (including at shutdown) must not delete the tables.

Ordering alone is not protection: every unit that must not run without the
firewall carries an explicit `Requires=tor-guest-firewall.service` **and**
`After=tor-guest-firewall.service` (`Before=` on the firewall does not
propagate failure). If the loader fails — missing or tampered config, hash
mismatch, uid mismatch, missing or wrong-type uplink at boot, effective-owner
drift, syntax error, failed transaction — the firewall unit fails, and
`Requires=` keeps networkd, resolved, Tor and the workspace unit down:
within the systemd-managed stack the guest stays **offline**, never egress
without policy (pre-systemd traffic remains outside this contract — policy
zero). The local workspace deliberately has **no** `network-online.target`
and no Tor bootstrap wait; it requires only the firewall.

### Runtime loader (tor-guest-load-nft)

On every load the loader checks, in order, failing closed at each step:

1. config presence (ruleset, sha256 sidecar, identities file);
2. sha256 of the ruleset against the install-time sidecar;
3. ruleset/identities agreement (both recorded uids appear in their exact
   rules) **and** live `getent passwd` agreement for both accounts, **and**
   the guarded-boot re-validation of install-time offline facts: the
   recorded uplink exists in the real `/sys/class/net` with `type == 1`
   (plain ethernet — this is where offline-attested interface metadata is
   finally checked against the actual device), and `systemctl show` reports
   the same **effective** networkd `User=` that was recorded (unit file plus
   drop-ins);
4. `nft -c -f` syntax validation (no apply);
5. one `nft -f` transaction containing, for each of the two owned tables
   that already exists, a `delete table` line prepended in the same file as
   the new definitions — deletes and re-definitions commit atomically, so
   there is no interval without tables and no global flush. A failed
   transaction aborts whole and the previously loaded tables are retained.

The loader never flushes, never deletes anything but the two owned tables,
and only ever runs `nft list table` (probe), `nft -c -f` and one `nft -f`.

## AF_PACKET and the initial DHCP exchange

The `dhcpUid` output rule governs **inet-family** DHCP (unicast renewals
via networkd's UDP socket). The initial cold-boot DHCP exchange
(discover/offer/request/ack) is sent by systemd's DHCP client over an
`AF_PACKET` raw socket; raw-frame sends bypass the inet hooks, so that
exchange is outside uid-based inet filtering by construction. This is why:

- networkd is the only component trusted with raw-socket capability, and
  the shipped tor unit has an empty `CapabilityBoundingSet=` and no
  `AF_PACKET`;
- the `.network` file disables networkd's other L2 listeners (LLDP) and
  IPv6 RA/link-local, so its AF_PACKET use is limited to DHCP;
- acceptance requires a **full-frame capture from power-on** (harness
  below) reconciled frame-by-frame, not a uid- or TCP-filtered view.

## Before systemd: firmware and initramfs (not covered — see policy zero)

Everything that runs before `tor-guest-firewall.service` is outside this
policy's reach: board firmware, the bootloader, and any initramfs can bring
up networking ungated. The shipped unit does not guard that window, and no
amount of unit configuration makes "zero egress across the whole boot" a
truthful claim until a real power-on capture plus an image inventory of the
actual clone exist (policy zero above). Until then this section is a hard
limit, not a caveat: pre-systemd egress is **unbounded by this slice**. A
separate initramfs drop-guard (loading a default-drop table from the
initramfs before pivot) is tracked as its own piece of work; it is not
implemented here, and nothing here claims it is.

## Clone-boot harness and evidence collection (supervisor, later)

The cold-boot harness itself is supervisor work and is **not** implemented
in this slice; the procedure it should follow:

- Start the QEMU clone frozen (`-S`) with a `filter-dump` object attached to
  the uplink netdev **before** `QMP cont`, so the capture includes every
  frame from power-on (an attach-after-boot capture cannot see the initial
  DHCP exchange that bypasses inet filtering).
- Drive resume over QMP (`system_powerdown` etc.). QMP cannot execute
  commands inside the guest, so the private **serial console** is the
  diagnostic root channel; it is also how evidence (loader output, `nft
  list ruleset`, `ss -tnp` restricted to the Tor uid, Tor logs) is
  retrieved, together with offline inspection of the clone's disk. There is
  **no SSH exception**: once the policy loads, the output chain drops root
  SSH replies by design, and before it loads nothing should be trusted.

## Acceptance still needed (not performed here)

The automated tests above do **not** establish live enforcement. Because
SSH diagnostics are cut off once the policy is applied (see above), perform
acceptance from the guest console or inside a disposable network namespace.

Capture **all** guest uplink egress — a capture filtered to non-TCP or to
IPv6 only cannot detect a direct TCP leak, because legitimate Tor relay
traffic is itself TCP:

```sh
tcpdump -ni <uplink>    # capture everything, then reconcile (below)
```

Reconcile every TCP destination seen on the uplink against Tor's own
connections, observed independently of this generator (as root, `ss -tnp`
restricted to processes running as the Tor uid, or Tor's own connection
logs). Acceptance criteria:

- With Tor **running**: a non-Tor user browsing the web succeeds (through
  Tor), and every uplink TCP flow matches a connection Tor itself opened —
  any uplink TCP to a destination Tor did not open is a leak. Explicit
  non-Tor attempts at DNS (UDP *and* TCP 53), direct TCP, other UDP (e.g.
  QUIC/443) and IPv6 destinations fail and produce no unexplained uplink
  packets.
- With Tor **stopped**: the same DNS/TCP/UDP/IPv6 attempts all fail, and
  the only permitted uplink traffic is the DHCP user's IPv4 DHCP exchange.

Record the captures, the `ss`/Tor observation used for reconciliation, and
the results; together these are the acceptance criteria. For the installed
guest the supervisor scenarios are:

- **Positive**: Tor running — a non-Tor user's browsing and DNS work
  (through Tor; DNS over the DNSPort redirect), local terminals behave
  normally, and Tor bootstraps using only Tor-uid IPv4 TCP relay
  connections. Includes resolver-path success for the installed image
  (resolved stub or sentinel, whichever the installer established) and a
  check that `/etc/resolv.conf` is valid and pointing at it after boot.
- **Invalid/missing policy**: corrupt or remove the policy files and
  reboot — the loader fails, `Requires=` holds the stack down, and there is
  **no egress at all** (not an unfiltered boot).
- **Tor stopped**: proxied DNS/TCP/UDP/IPv6 attempts all fail; only the
  DHCP owner's IPv4 DHCP exchange appears on the uplink.
- **Link change / DHCP renewal**: interface down/up and lease renewal must
  not open any new egress class — the tables persist (they are not tied to
  interface state) and renewal traffic is still only DHCP.
- **Malformed reload**: replace the ruleset with a hash-consistent but
  syntactically invalid file and rerun the loader — the syntax check fails,
  the old tables are retained, and egress stays policy-conformant.
- **Reconcile all captured frames** from power-on: the only permitted
  uplink frames are the DHCP exchange (initial AF_PACKET DORA plus
  unicast renewals), ARP for the leased address, and TCP connections
  opened by the Tor uid. Anything else — any other protocol, any
  non-Tor-uid TCP, any IPv6 — is a leak.

## Limits and root trust

- The installer gates the network-regeneration mechanisms it can see
  (NetworkManager, dhcpcd, cloud-init, `boot/firstrun.sh`); it is not a
  proof that no other first-boot tooling exists in a given image. The
  full-frame power-on capture plus an image inventory are the checks that
  actually bound this.
- The interface parameter is verified, not discovered: live targets are
  checked against sysfs at install time; offline (mounted-image) targets
  take explicit reviewed metadata that the loader re-validates against the
  real device on every guarded boot before any networking. If the clone's
  actual uplink differs from the recorded name, the guarded boot fails
  closed (no networking) rather than guessing.
- Precedence detection is conservative and textual; it is not a full
  reimplementation of networkd's matcher. When detection cannot rule a file
  out, the installer refuses and the operator decides.
- The offline effective-`User=` computation mirrors systemd's drop-in
  semantics for `User=`; the authoritative check is the loader's `systemctl
  show` comparison on every boot.
- Radio interfaces: the QEMU guest has none. A Wi-Fi-equipped Pi clone must
  be brought up with its radio blocked or absent — nothing in this slice
  enables or configures wpa_supplicant, and the capture would surface any
  pre-policy probe, but the harness must not rely on that.
- Compatibility: the output NAT chain declares `priority -100` (the numeric
  equivalent of `dstnat`) because some nftables versions — notably 1.0.6 on
  Debian bookworm — reject the symbolic `dstnat` name in this position with
  `invalid priority expression value in this context`.
- Enforcement is kernel-side and only as strong as guest **root**: root can
  delete these tables, load different rules, or run processes under either
  uid. The host operator and guest root are in the trusted computing base.
- IPv6 is blocked, not proxied (local loopback `::1` excepted); Tor here is
  IPv4 TCP only.
- Redirected DNS goes to Tor's DNSPort (hostname resolution over Tor).
  Application-level DNS behavior (DoH over TCP is proxied; UDP DoH dropped)
  and traffic-analysis or timing side channels are out of scope.
- The policy is owner/port based; the two uids must be dedicated accounts
  created before applying. No protection against kernel, nftables or Tor
  bugs is claimed, and no full security guarantee is made or implied — the
  whole-boot scope statement is policy zero above.

Netplan image preparation: the installer refuses nonempty `*.yaml` inputs in
`/etc/netplan`, `/run/netplan`, and `/lib/netplan`, even with conflict retirement.
Its boot generator would recreate competing networkd files after retirement.
Preserve and move reviewed inputs outside these search paths as an explicit image
normalization step; then review generated networkd files and interface naming
before installation. Disabling future cloud-init networking alone does not remove
existing Netplan input. The installer does not parse or migrate Netplan YAML.


## Observed ARM QEMU rehearsal — 14 October 2026

One prepared Debian Bookworm ARM guest completed a captured cold boot, normal
probes, Tor interruption, atomic firewall reload and Tor recovery. Existing
netplan input was preserved and retired before installation. The real service
graph passed `systemd-analyze verify`; the workspace service became active
before Tor, and its terminal API stayed available during the interruption.
The guest used ordinary writable storage; this is not an amnesia qualification.

A request without an explicit proxy returned `IsTor: true`; UDP and TCP DNS
worked through the policy. With Tor stopped, application TCP and DNS failed
locally, while UDP/NTP remained denied. Inbound SSH did not receive a banner.
IPv6 had no usable route in this guest, so that probe does not establish an
IPv6 filtering result. Tor recovery returned `IsTor: true` again.

The complete power-on-to-shutdown capture contains 21,322 records with no
truncation or trailing bytes: 5,529 outbound and 15,793 inbound. Outbound traffic
consists of three DHCP frames, one ARP frame and 5,525 TCP packets across seven
relay tuples, each matched to captured Tor-owned sockets. Independent tcpdump
decoding agrees with the frame and protocol counts. The capture SHA-256 is
`7fac3a3b591be45faa57b72bf88ebcef21e0741624ef2b9c81c301c6c3b96e34`.
Raw evidence is retained privately by the rehearsal operator. QEMU's capture
clock differed from guest and host clocks; packet order and socket tuples,
rather than naive cross-clock timestamp comparisons, support reconciliation.

This result does not qualify another image, hardware USB boot, firewall-load
failure injection, a production account boundary, or persistent-credit recovery.
The kiosk also made background application requests through Tor; this was not
a zero-request browser session.
