# Post-Tor clock observation

This Linux source prototype reuses independently reviewed Tails helper logic. It
is **not claimed to be source from an authenticated Tails release**. See [NOTICE](NOTICE),
[COPYING](COPYING) and [Go's license](GO-LICENSE). The observer has no external Go modules, privileged setter or default time
providers. A separate [fixed command candidate](cmd/portable-clock/README.md)
adds a root-only setter and inactive unit; neither is installed in the image.
The Perl poller's three-observation/median approach is adapted without copying its
root/effective-UID switching or shell invocation.

A trusted host constructs `New(Config)` with three fixed HTTPS hostnames, an
explicit literal-loopback `socks5h` endpoint, image date bounds, correction/spread
limits, maximum uncertainty, overall timeout (at most30s), and decision lifetime
(at most5s). Worker/UI requests cannot choose these values in any future adapter.
Roots default to the system certificate pool; an explicit pool is cloned. No
proxy environment discovery, direct fallback, redirects, HTTP URL or expired
certificate bypass exists. Certificate verification uses the supplied initial
wall time advanced by elapsed boot time; a future leaf permits verifying its
entire chain at its NotBefore+1s, preserving hostname and issuer checks.

`Poll(ctx, initialUTC)` performs one HEAD per source through SOCKS. It bounds
headers to8KiB, requires one parseable Date and HTTP200, and requires all three
observations. It records request start/end on CLOCK_BOOTTIME (including suspend).
Each second-resolution Date is projected to common completion time as an interval:
`[Date + elapsed-since-response, Date + 1s + elapsed-since-request]`. The median
interval midpoint is selected; the uncertainty covers the union of all three
intervals and must fit explicit policy. The full symmetric interval
`UTC ± uncertainty` must fit both absolute date bounds and the maximum correction
around the initial reference advanced by CLOCK_BOOTTIME, at poll completion and
again at consumption. A decision can expire through an absolute-date bound before
its nominal lifetime ends. This assumes each honest source generated
a fresh Date during its request. TLS does not prove a server's time is true;
distinct names do not establish independent operators. No financial-time accuracy
claim follows solely from successful polling.

The resulting opaque `Decision` exposes `Consume()` once. It checks boot-time
expiry, advances the estimate to consumption time, and returns UTC, uncertainty
and remaining lifetime. It cannot be serialized and restored as authority. The
trusted host must apply immediately inside the same bounded transaction, then
read back; returned values are not permission to apply later. A future actual
setter must exclude active financial work, close admission before correction,
invalidate earlier wall-clock decisions and enforce the remaining deadline.
A setter failure leaves time unknown. This package never calls a time-setting
syscall, executes a command, opens an output file or grants clock privileges.

Keep desktop/terminal independent of this work. Start observation after actual
Tor readiness; keep time-sensitive financial admission closed until the eventual
trusted setter/readback policy succeeds. Do not give the agent, browser, Sway or
the native terminal CAP_SYS_TIME or setter access. No NTP/clearnet exception is
introduced. This source does not integrate the earlier manual `Setup` prototype.

## Offline acceptance

Compile with a pinned installed Go toolchain on the build host and disabled
module networking, then run the test executable in a fresh Linux user/network
namespace with only loopback enabled. Tests use actual local TLS servers and a
SOCKS5 relay that records domain-name requests for all three `.invalid` hosts;
OS DNS is forbidden in the positive test. The setter is only an in-memory record.

Coverage includes future-leaf stale-time recovery, wrong hostname/root, expired
certificate, TLS1.1, redirects, oversized/duplicate/invalid headers, large steps,
disagreeing sources, stalled replies, unavailable proxy, cancellation, delayed
three-source projection, uncertainty refusal, boot-time expiry and replay refusal.
No test changes host/guest time or contacts a public server. The Linux clock read
is real; no physical suspend/resume or deployed privileged setter is qualified.
