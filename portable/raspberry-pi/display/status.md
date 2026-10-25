# Desktop status projection

The Dsmack desktop bar combines a public Tor observation with an authenticated,
read-only credit projection. It never makes a provider request, controls Tor,
unlocks the vault or authorizes spending.

`project-status.py` is a root oneshot. It reads `tor-guest.service`'s ActiveState,
MainPID, InvocationID and monotonic process start through `systemctl show`. It
reads at most 64 current-boot journal entries for that PID and invocation, accepts
only bootstrap messages with matching boot/unit/PID/invocation and timestamps
after process start, and rechecks the service identity afterward. A restart,
missing information, malformed journal or command error yields unknown; a
stopped unit yields stopped. It does not retain an earlier ready state.

The plain-text label **Tor bootstrap 100%** means the current process reported
completed bootstrap. It is not a continuous connectivity test, a claim that
individual requests use Tor, or proof that remote inference is available. If
bootstrap records are unavailable or fall outside the bounded journal tail,
the honest fallback is unknown. The service does not need to wait for Tor.

The publisher replaces `/run/portable-status/status.json` atomically in a
root-owned directory. The public file contains only a schema version, boot ID,
monotonic observation time, Tor bootstrap state/percentage, and credit unknown.
It contains no logs, addresses, PID, credential, funding destination or control
cookie. Each command has a 1.5-second deadline and an output cap (2 KiB unit
properties; 64 KiB journal). Output is at most 1 KiB. The proposed oneshot has
no capabilities, a read-only system, only its runtime directory writable, only
AF_UNIX sockets, and a fifteen-second start timeout. The timer refreshes about every
three seconds after the preceding collection completes.

The retained `status-line.py` fallback is an unprivileged text consumer. It checks the
root ownership, file type, size and permissions of the directory/file, refuses
symlinks, validates boot identity and a maximum 15-second observation age, and
prints only fixed text plus a validated integer percentage. It never reflects
arbitrary source text. Credit always says unknown, including if a caller adds
a fabricated balance to JSON.

The source Sway configuration now selects `status-line.mjs`. It reuses the same
Tor reader and the existing UID971 credit client, which authenticates the UID972
projection service. Only a fresh, validated USD account balance becomes an
amount; it is labelled **Account USD**, not a local spend allowance. Stale,
missing and malformed observations never become an available balance. An
independent expiry timer clears old values even while a later request stalls.
This does not admit financial values supplied in the public Tor JSON file.

Runtime code belongs under `/opt/portable/portable/raspberry-pi/display/`; the service/timer
belong in `/etc/systemd/system/`. The bar also advertises Ctrl+Alt+F2 for vault
control only when launched with `--vault-shortcut`. That opt-in requires the
separately composed trusted VT operator;
the bar itself has no vault authority. The new bar and that complete keyboard
journey still require installed ARM qualification.

Run `python3 -B portable/raspberry-pi/display/test-status.py`. Tests cover current, old and
restarted processes; journal ambiguity; stopped/unknown states; command timeout
and output bounds; stale public observations; and refusal to render fabricated
credit or arbitrary text. Actual guest collection, where recorded separately,
is read-only evidence, not proof this unit has been installed or sandbox-tested.
Run `node --test portable/raspberry-pi/display/status-line.test.mjs` for account-label,
malformed-balance and expiry-during-stalled-request checks.
