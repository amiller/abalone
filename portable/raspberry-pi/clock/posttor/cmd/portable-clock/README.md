# Fixed clock command — inactive candidate

This command connects the accepted post-Tor observer to one Linux wall-clock
setter. It is source only: no installation, automatic startup, time provider
selection or real-clock qualification is implied. The tests replace the setter
with an in-memory recording function; they never invoke the production setter.

The command accepts no arguments. Its only policy input is
`/opt/portable/etc/clock.json`, a root:root0600 single-link regular file beneath
trusted root-owned directories. JSON is bounded to8KiB; duplicate and unknown
fields are refused. There are no defaults. Required keys:

- `sources`: three distinct trusted HTTPS source URLs; no user/browser inputs.
- `socks`: explicit literal-loopback socks5h endpoint.
- `earliest`, `latest`: RFC3339 clock bounds.
- `maxStepNs`, `maxSpreadNs`, `timeoutNs`, `maxUncertaintyNs`, `decisionTTLNs`:
  observer policy, subject to the observer's existing bounds.
- `applyBudgetNs`: positive and at most1s, further limited by ConsumeRemaining.
- `readbackToleranceNs`: positive and at most1s.
- `validityNs`: positive and at most1h; a finite readiness lease, not permanent
  evidence of accurate time.

The command checks `/run` is tmpfs, prepares root:root0755
`/run/portable-clock`, and revokes only an owned root:root0644 single-link regular
`ready.json`. Symlinks and unexpected ownership/modes are refused. Before any
poll or correction it takes **exclusive, nonblocking** flock on the same
root:root0600 `/run/.portable-vault-lifecycle.lock` used by financial leases.
A held shared financial lease prevents correction. Readiness is revoked first,
so a failed/busy attempt cannot leave an earlier readiness promise in place.

With the lock held, it brackets the initial wall-clock sample with CLOCK_BOOTTIME
and rejects a sample window longer than either apply budget or readback tolerance.
It repeats that bracket immediately before setting, checking correction bounds
against both possible endpoints of both initial and fresh wall references. A
pause or independent wall-clock change cannot silently become a stale reference.
It calls Poll and Consume directly, advances the proposed
UTC only after Consume returns (charging Consume duration as uncertainty), checks
the entire application-budget uncertainty interval before setting, rechecks lock
identity, and makes exactly
one CLOCK_REALTIME clock_settime syscall. No retry follows an ambiguous error.
It immediately reads back wall time and elapsed boot time, checks the application
budget and mismatch tolerance, includes application timing/mismatch in uncertainty,
and checks the resulting full uncertainty interval against absolute and relative
policy. Any failure leaves readiness absent, including a failure after an actual
step. The operation cannot promise that a failed syscall left time unchanged.

Only verified success publishes an atomic root:root0644 JSON receipt:
`version`, `state` (`qualified`), `bootId`, `appliedUTC`, `appliedBootNs`,
`uncertaintyNs`, `validUntilBootNs`. This contains no credential or account data.
Future financial admission must check current boot, deadline, acceptable
uncertainty and wall-clock continuity; this patch does not implement that consumer.
Readiness expiry is clipped to the remaining absolute Latest margin of the full
readback uncertainty interval; nonpositive margin publishes nothing. An expired
receipt must never be treated as a permanently valid clock. The lock
is held through publication and released when the command exits.

The inactive [candidate unit](../../../portable-clock.service) has only
CAP_SYS_TIME, no ambient capabilities, and no public RPC or file capabilities.
It orders after/requires Tor and the firewall without delaying the desktop.
No timer, install target or restart loop is supplied. It intentionally has no
mount-namespace-inducing hardening directives: the shared lifecycle lock must
remain in the same host mount view as the financial service. This is a trusted
unit-profile predicate, **not a runtime PID1 namespace comparison**. Root callers
and CAP_SYS_TIME holders already belong to the trusted computing base. Do not
add CAP_SYS_PTRACE merely to inspect PID1, or grant UI/agent clock authority.

The eventual installation must use a root-owned fixed binary, this exact mount
profile and a reviewed source pool/configuration. No untrusted EnvironmentFile;
the unit clears TLS-root/proxy/debug environment overrides. A dedicated disposable
QEMU rehearsal is still required for actual setter, expiry, reboot and financial
exclusion behavior. Neither the build host nor the existing ARM guest clock may be changed
by the current source tests.
