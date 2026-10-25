# Portable terminal interfaces

## Plain Bash demo

The selected demo profile boots into an automatically logged-in **root operator
Bash shell**. This is a trusted demo console, not an unprivileged account or a
claim that physical access is restricted. The same home scripts work over the
configured key-only root SSH connection:

- `~/unlock` asks for the vault passphrase without echoing it. The demo accepts
  the configured short practice passphrase; do not put it on the command line.
- `~/agent` opens the terminal agent. Its frontend runs as UID971; the root
  operator shell does not give the model root or wallet authority.
- `~/credit` shows the current public account-balance observation. Unknown or
  expired observations remain unknown; balance is not the inference-key limit.
- `~/fund` starts the funding journey, or resumes the same saved attempt. Follow
  the displayed ZEC amount and deadline. An uncertain payment is not silently
  replaced or sent again.
- `~/fund --new` explicitly starts a fresh demo only after the previous cycle
  completed. It preserves the active inference credential until the next
  funded credential is ready, and reuses the saved Base transit wallet.
- `~/status` checks storage; `~/lock` closes it through the trusted vault broker.

No special menu key sequence is required. The top two console rows are a live
status written by `console-status.py` (UID971) whenever the shell is at its
prompt: Tor bootstrap, then the exit IP from check.torproject.org and its
country from Onionoo (both fetched through Tor), vault state, provider account
credit, the boot medium (read-only USB lower layer, RAM overlay) and Wi-Fi
SSID/addresses. Failures are shown as errors, never replaced by a value.
The shell scrolls below those rows; commands get the full screen back.
`portable-operator-shell.service` sets the Terminus 16x32 console font
(120x33 at 1080p).

## Optional graphical desktop

`~/desktop` starts `portable-display.service`, which replaces the console shell;
Super+Shift+E exits Sway and the console shell starts again (OnSuccess/OnFailure).
Super+A opens the native Pi agent (the same program as `~/agent`, launched by the
native terminal daemon as UID970), Super+Enter a native shell, Super+W the wallet,
Super+B Chromium. The top bar repeats the console status; the bottom bar lists
every binding.

`agent-terminal.py` is a dependency-free Python curses client of the existing
workspace service at `http://127.0.0.1:8765`. It runs as UID971 and keeps the
service's Origin/CSRF checks; it never loads an SDK, provider key, or shell.
Enter sends one prompt; Ctrl+X requests stop; Ctrl+R reconnects and lists active
runs; Ctrl+Q closes the frontend without claiming to stop an active run.
An uncertain start or stop is never automatically resent. Reconnecting attaches
to the single active run, or offers numbered selection when several exist.
Only the manager's terminal state concludes a run, not a worker's completion event.
The optional display-only `--funding-shortcut` advertises Ctrl+Alt+F4 only in a
profile that installs and enables the trusted funding console. The frontend
receives no funding RPC or financial authority.

Tor and provider account observations expire against monotonic request time.
The header distinguishes connection, SDK warming, and storage-unlock states.
A provider account balance is not a local spending allowance. The direct-NEAR
profile notes in the fullscreen frontend that GPU revocation is not checked; the
Sway bar shows the latest NEAR admission as recorded by the inference service. Model/tool text is bounded and stripped of terminal
control characters before rendering. Streaming chunks join within messages.

Focused host tests exercise the actual workspace HTTP router with a synthetic
backend and a real curses PTY, including resize, disconnect, uncertain starts,
CSRF/Origin refusal, and stop. Complete ARM desktop boot and real inference
qualification belong to the combined image test; these host checks do not
establish those outcomes.

The compositor/browser run as portable-ui (UID971); the
[native terminal channel](native-terminal.md) supplies shells as portable-agent
(UID970), authenticated using kernel peer credentials and a transferred PTY.
The [status consumer](status.md) reads a bounded public projection. Missing or
stale observations become unknown; Tor bootstrap progress does not prove that
an individual request can connect. Neither interface receives vault or payment
approval authority.

`portable-display.service` establishes the login seat through PAM/logind and
uses `sway-runtime.py` to select the private runtime directory after PAM.
The browser launcher keeps configuration, cache, data and profile under that
runtime directory. The target must verify it is RAM-backed. The UI is optional
to the display; native terminals require the firewall and the independent RAM
workspace, rather than the SDK backend. Account provisioning, packages, fonts,
logind access, firewall ordering and the complete image remain assembly work.

These files are source prototypes, not an image installer or a qualified Pi
image. Validate the complete staged unit graph and Sway configuration on the
actual ARM packages, then verify keyboard, browser sandbox, status expiry,
backend/UI failure, KMS and cold boot. Existing diagnostic overrides may select
a different wrapper or configuration; check the effective unit before migration.
`diagnostics/qemu-pixman.conf` is only a QEMU renderer override and must not be
installed as a Raspberry Pi default. Never run the desktop as root or a financial
account.
