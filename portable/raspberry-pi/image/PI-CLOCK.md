# Dsmack Pi coarse clock baseline

`stage-pi-clock.py` prepares an exclusively owned offline image. It never sets
the running clock, contacts a time service, starts/stops a service or changes a
firewall rule. Use it after vendor normalization and before final unit enablement.

The reviewed profile pins the original fake-hwclock data, script/defaults,
package units, timesyncd configuration and DBus activation file. It supplies an
explicit `baselineUtc` taken from the trusted packaging clock. This is a coarse
public lower bound, not authenticated current time. The helper neither infers a
timestamp from file metadata nor silently refreshes it when applying a plan.

```sh
python3 portable/raspberry-pi/image/stage-pi-clock.py --root /offline/root \
  --profile /reviewed/clock-profile.json --profile-sha256 PROFILE_SHA
```

The default prints a read-only plan. Apply requires root and `--apply
--plan-sha256` matching the actual tree's plan. Unknown bytes, clock overrides,
drop-ins, additional activation aliases, unexpected link targets, stale intent,
and a backwards baseline refuse. The profile's package bytes remain unchanged.
The package's DBus activation file is preserved; the canonical timesyncd unit and
its declared DBus unit alias are both masked with `/dev/null`. Only the exact
reviewed timesyncd enable link is retired. Fake-hwclock's enable link, load
service, script and defaults remain intact.

Apply records a durable intent/profile/original data/link description under
`/var/lib/portable-image/clock-policy`, disables those activation paths, then
atomically replaces the baseline file with root:root0644 bytes. It fsyncs the
changed parent directories before the completed marker. This is not a multi-file
transaction: any interrupted attempt remains visible and refuses replay. There
is no forced retry or broad deletion. The root must remain exclusively controlled
throughout planning and application.

With the volatile root active, fake-hwclock's later saves modify the RAM overlay;
they do not update the immutable lower. The final unit graph must still confirm
that the preserved load executes before time-sensitive consumers. This helper
does not install a persistent clock state, configure an RTC, admit network NTP,
or guarantee Tor/HTTPS/attestation bootstrap when an image has been stored long
enough for its fixed timestamp to become stale. User clock setup or a separately
reviewed Tor-aware mechanism remains necessary for that case.

Offline tests: `unshare -Ur python3 portable/raspberry-pi/image/tests/test-pi-clock.py`.
These use temporary files only; they do not call `date`, `systemctl`, mount tools
or any network API.
