# Portable clock recovery prototype

The desktop and terminal start independently of network readiness. Tor starts
asynchronously using the image's explicit clock baseline. Successful Tor
bootstrap does not establish sufficiently accurate time for attestation,
quote expiry or financial admission.

The intended automatic path is Tor bootstrap followed by bounded time correction
through Tor, before time-sensitive financial work starts. Evaluate the existing
Tails component and its complete, pinned dependency closure before selecting an
implementation. Its documented sequence includes correction after Tor connects
and manual correction after connection failure; see
[Tails time synchronization](https://tails.net/contribute/design/Time_syncing/).
This image has no clearnet time-bootstrap exception. The Pi demo now has a small
optional automatic setter, described below; the manual-input prototype remains
separate.

`tor-date.py` fetches the existing provider's HTTPS Date through Tor with normal
certificate validation and no account credential. `tor-date.service` runs it
independently of the terminal. The demo installs it as
`portable-tor-date.service`; `credit-clock.conf` makes financial startup depend
on successful synchronization. Each attempt uses its own Tor circuit (distinct
SOCKS credentials), so a slow or broken circuit is not retried for the whole
180-second budget, and each failed attempt is logged with its reason. It accepts only a bounded, forward correction
from the image's `fake-hwclock` floor and verifies readback. This is
provider-reported time, not a financial time oracle. Very stale image time can
prevent TLS validation; there is no TLS bypass. A cold Tor start can also exceed
the existing financial service-start observation timeout while startup continues.
Refresh the image floor during trusted maintenance. Native installation and
reboot acceptance must be recorded separately from the parser tests and live
read-only Date probe.

`admission.py` is an **unintegrated manual-input prototype**, not a mandatory
first-boot screen and not the implementation of post-Tor synchronization. Its
current lifecycle deliberately refuses correction after `network_started()`;
using it as a later recovery surface would require a separately reviewed
lifecycle adapter. Do not insert it ahead of the terminal or require manual
confirmation on every boot.

If a trusted manual recovery surface is needed, show **Clock not confirmed**
rather than claiming to detect how stale the clock is. Let the person continue
working offline. Ask them to copy the current UTC date and time from a clock
they trust, display the full date and `UTC` before confirmation, and reject
invalid calendar dates. Local-zone conversion is not implemented.

The confirmation expires after 60 seconds, including suspend. A successful
correction reads back the clock, shows **Time supplied by you**, and then permits
an independently controlled network-start decision. It does not assert verified
time, successful Tor bootstrap or valid provider attestation. Connection status
continues to use actual observations. The UTC-only initial form is a prototype;
local-zone conversion needs an explicit offset/ambiguity design before adding it.

The image baseline is an explicit lower bound. Trusted image configuration must
also specify a maximum supported date; there is no default admission range. The
ten-year range in tests is synthetic, not a shipping policy. A date outside those
bounds requires a separately reviewed operator path, not a hidden override.

## Authority and integration contract

`admission.py` is a pure in-process prototype. It does not call a clock syscall,
open a socket, run a command, contact a service, or read/write clock persistence.
All tests inject a synthetic setter and readback. It is **not a deployed time
broker**, and its opaque Python object is not an authentication credential.

For this manual-input prototype, the trusted host constructs `Setup` with image date bounds, a suspend-aware
elapsed clock, and bounded setter/readback operations. `propose({'utc': ...})`
returns an in-process ticket and the exact confirmation text. `confirm(ticket,
displayed_utc)` consumes the ticket before its sole setter invocation. Changes,
expiry and incorrect tickets invalidate the old confirmation. Setter failures or
readback mismatch become `unknown`, with no automatic retry. An elapsed-clock
regression also closes setup. A syscall-adapter error cannot be assumed to mean
that the time was unchanged.

`network_started()` must be called by the trusted lifecycle owner **before** any
network or financial consumer can start, under that owner's exclusion lock. It
permanently closes time changes for this setup instance. The method itself does
not authorize or start anything. Recreating this object is not a legitimate way
to bypass that lifecycle lock. `work_offline()` never authorizes network access
or reopens a locked setup. Concurrent calls are serialized; callback operations
must be bounded by the future adapter, since this pure prototype cannot interrupt
a blocking callback.

A future manual-input OS adapter needs a trusted local input path separate from the browser,
agent tools, native shell and compositor account. Giving UID970 or UID971 access
to `SetTime`, CAP_SYS_TIME, an unprotected local endpoint, or an unrestricted
polkit rule would grant the agent/browser clock authority. Do not run Sway or
Chromium as root to obtain this path. A dedicated root-owned setup VT is a
candidate, but its seat/VT acquisition, input isolation, invocation authorization
and return to the normal desktop remain unimplemented and unqualified.

This prototype does not alter the existing asynchronous Tor unit graph. Its
pre-network lifecycle cannot be reused as the post-Tor automatic setter. A
production adapter must keep time-sensitive financial admission closed until
correction succeeds. A later correction must exclude in-flight financial work,
close admission, invalidate earlier time-based decisions and revalidate affected
sessions. Tor connectivity is not itself a reason to grant UI/agent clock
privileges or to open financial admission.

Keep timesyncd masked and add no NTP, DNS, HTTPS, or other time-service exception.
Correction is session-only with the RAM overlay; there is no RTC write, financial
identity association, or persistent clock store here. Reboot loses the user's
correction. Root/firmware clock changes remain outside this process's authority.

## Evidence and limits

Linux documents that CLOCK_REALTIME changes affect absolute timers and require
privilege. CLOCK_BOOTTIME includes suspend and is not a settable wall clock:
[Linux clock_gettime/clock_settime manual](https://man7.org/linux/man-pages/man2/clock_settime.2.html).
Those properties motivate a suspend-aware confirmation timer and keeping clock
changes outside active financial sessions; they do not prove a selected date is
correct. A successful bootstrap for one stale baseline does not establish an
arbitrary-age guarantee. Automatic correction, its privileged boundary and
financial admission still need implementation and runtime qualification.

Run the offline suite with:

```sh
python3 -B portable/raspberry-pi/clock/tests/test_admission.py
```

It checks real calendar validation, strict request shape, expiry, invalidation,
network lockout, single consumption, reentrant callbacks, unknown outcomes and
offline terminal availability. No test sets any host or guest clock.

## Bounded post-Tor source prototype

[posttor](posttor/README.md) implements the reviewed Tails-derived certificate-time
rule and a three-source observation decision using actual TLS/SOCKS fixtures.
Its mirror-source pin is an explicit independent-review trust choice, not a
claim of signed-release source equivalence. It has no external source defaults,
privileged setter or image deployment. Offline acceptance uses network isolation,
delayed responses and a recording setter; actual time application and financial
admission remain separate integration work. Retain its GPL and Go BSD notices.

A separate [fixed command candidate](posttor/cmd/portable-clock/README.md) now
connects Poll/Consume to one root-only Linux setter under the financial lifecycle
lock, with readback and finite boot-bound readiness. Its tests record setters
only; the candidate unit is inactive and no actual clock step is qualified.
