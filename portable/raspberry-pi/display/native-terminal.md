# Native terminal authority prototype

These new files provide a dedicated agent daemon and UI client, for foot 1.13.
They do not change the existing Sway config or deploy accounts/services.

Stage root-owned Python files under `/opt/portable/portable/raspberry-pi/display`. The unit
expects existing `portable-agent` UID/GID 970, UI UID971, and `/run/portable-workspace` owned
by agent970. Review actual account/group memberships and mount visibility first.
Financial UID972 is not an authorized caller. No supplemental operator, UI, or
credit groups may be assigned to the agent account. The staged unit removes
capabilities; the daemon cannot switch users or gain financial privileges.

Start the dedicated daemon through the reviewed unit, then as UI971 launch:

```sh
foot --fullscreen /usr/bin/python3 /opt/portable/portable/raspberry-pi/display/native-terminal-client.py --socket /run/portable-native-terminal/control.sock --agent-uid 970
```

The daemon itself creates its Unix listener. **Do not substitute systemd socket
activation:** inherited listener credentials differ from the service identity.
The socket is mode0666 inside an agent-owned mode0755 runtime directory, allowing
connections without shared supplementary groups. Kernel `SO_PEERCRED` rejects
all UIDs except971 before fork. The client requires peer970. This authenticates
local processes by UID, not a particular window or human action.

Protocol: client sends exactly byte `1`; daemon returns byte `P` with exactly
one PTY master FD via SCM_RIGHTS. No command/path/environment/requested UID is
accepted. No more data is valid on the lifetime control connection. Capacity
(default8, CLI maximum32) includes pending clients; handshake timeout is2s.
Caller descriptors are closed and rejected. Client validates the received FD
using Linux TIOCGPTN, not merely isatty. Socket paths must not already exist;
operator-controlled stale socket recovery is separate, never arbitrary deletion.

The unit requires tor-guest-firewall.service and portable-agent.service; the
latter owns the shared runtime workspace directory. This is staged integration,
not a new firewall or service deployment.

The fixed shell is `/bin/bash --noprofile --norc -i`, with an explicit workspace,
PATH (/opt/portable/bin:/usr/bin:/bin), HOME, UTF-8 locale, and TERM=foot. Install matching foot-terminfo. Account
login shells stay nologin. The workspace is a cwd, **not a filesystem sandbox**.
The shell inherits service restrictions and network policy; this module does
not create Tor routing, a vault, credit authority, or an agent CLI.

The client raw-modes its local terminal, relays bytes with two64KiB queue limits,
handles partial writes, and forwards initial size and SIGWINCH via TIOCSWINSZ.
Ctrl-C travels as a terminal byte to the shell foreground group. Terminal state
and descriptor flags are restored on normal errors and catchable termination;
SIGKILL or destruction of the terminal cannot execute cleanup. Control closure
allows at most0.5s of remaining output drain before client exit.

Normal session closure enumerates processes in the shell session, including
foreground jobs with their own process groups. It uses Linux pidfds to signal
exact processes, escalates to SIGKILL after250ms, and waits for observed process
exit before reaping the leader and freeing capacity. The unreaped leader keeps
the session ID reserved during repeated scans. Linux pidfd support is required. A process that
creates a separate session can escape per-terminal cancellation. **Only whole
service stop with KillMode=control-group addresses all service descendants.**
This prototype does not promise adversarial per-terminal process containment.
Root must verify staged unit behavior on the actual deployment. Shell startup
never depends on SDK readiness or a provider call.

Tests require an explicitly isolated root controller with private mount/PID/net
namespaces, readable source and no persistent account changes:

```sh
sudo unshare --mount --pid --net --fork --mount-proc env DSMACK_PRIVATE_NAMESPACE_TEST=1 python3 /path/to/native-terminal.test.py -v
```

Tests use ephemeral numeric identities970/971/972 and temporary directories.
They exercise the actual daemon/client with native PTYs, UID/descriptor denial,
handshake capacity recovery, binary output, resize, Ctrl-C, slow output, stubborn
same-session foreground job cancellation, and terminal restoration. They do not launch
foot/Sway or prove physical keyboard/display behavior. Native graphical launch
and whole-service cgroup shutdown remain separate approval/qualification gates.
