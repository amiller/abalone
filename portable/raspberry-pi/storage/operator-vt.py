#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""operator-vt.py — trusted vault-unlock VT operator (SOURCE PROPOSAL, not deployed).

Runs ONLY as the fixed financial operator identity (portable-credit, UID 972,
primary GID 972, supplementary portable-operators GID 973, no capabilities,
NoNewPrivileges) on the real /dev/tty2 (character device major 4 minor 2)
that PID1 opened for it via the candidate systemd unit's
TTYPath/StandardInput=tty/StandardOutput=tty. It speaks the EXISTING root
vault-broker protocol (see inputs/portable/raspberry-pi/storage/guest/vault-broker.py):
one request per connection,

    "unlock\\n<hex passphrase>\\n"  -> "ok ..." | "error ..."
    "status\\n"                     -> "ok <one line>" | "error ..."
    "lock\\n"                       -> "ok ..." | "error ..."

Three fixed operations only. No new architecture, RPC, command, path, socket,
device or environment is selectable by any caller: every target is a fixed
constant below. There is no CLI option (argv is refused), no configuration
file, and no test/runtime flag.

Trust checks before any passphrase is read or the broker socket is touched:
  1. Identity: real+effective+saved uid/gid 972, supplementary group 973,
     zero effective/permitted/ambient capabilities, no_new_privs=1.
  2. Terminal: fds 0/1/2 are character devices with kernel rdev exactly
     (4,2); a PTY is explicitly rejected (TIOCGPTN success => refuse); the
     ACTIVE VT (kernel VT_GETSTATE ioctl) must be 2. The active VT is
     re-checked before the passphrase is accepted AND again before the
     passphrase is sent to the broker.
  3. Broker socket: /run/portable-control/broker.sock must be a socket,
     root-owned, exactly mode 0660, group portable-operators, inside a
     root-owned non-group/world-writable ancestor chain; after connect,
     SO_PEERCRED must show the accepting broker process runs as uid 0.

Honest limits (do not paper over these): the passphrase exists in Python
process memory and is NOT securely zeroized; termios cannot be restored if
this process is SIGKILLed; host root can do anything including reading the
tty; being on /dev/tty2 is operator CONVENIENCE and identity-by-physical-
console, NOT a cryptographic identity for the broker (SO_PEERCRED uid 972 is
the only credential the broker sees); actual /dev/tty2 custody by PID1 and
physical keyboard exposure are NOT tested here (NEW-VM gate). Credit-service
activation is composed ONLY by the root broker when trusted root started it
with the --credit-session opt-in; this operator starts nothing itself and
reports the broker's actual composed result verbatim (for example
"vault unlocked; credit started ..." or "vault unlocked; credit
unavailable ..."), with no readiness or deployment claim. No VT-switching
ioctl is used: the operator reaches tty2 with Ctrl+Alt+F2 and returns with
Ctrl+Alt+F1, both printed on screen. When ANOTHER VT is active at startup
(or at any later menu read or passphrase prompt), this operator WAITS for
tty2 to become active with a small bounded-interval, signal-interruptible
poll: it reads NO input, touches NO socket and requests NO secret before
tty2 is active, never switches focus itself, and flushes queued tty input
when tty2 becomes active so input typed while another VT had focus can
never become a menu choice or passphrase.
"""

import contextlib
import errno
import fcntl
import os
import re
import signal
import socket
import stat
import struct
import sys
import termios
import time

# --- fixed policy constants (module-level so the OFFLINE test suite can
# --- exercise the code against fake fixtures; there is no runtime flag) ------
EXPECTED_UID = 972                 # portable-credit (image policy)
EXPECTED_GID = 973                 # portable-operators (supplementary)
OPERATOR_PRIMARY_GID = 972         # portable-credit primary group
TTY_MAJOR = 4                      # real console /dev/ttyN
TTY_MINOR = 2                      # the trusted unlock VT
EXPECTED_VT = 2
SOCKET_PATH = "/run/portable-control/broker.sock"
MAX_PASSPHRASE_BYTES = 512         # one contract with the broker/helpers
MAX_RESPONSE_BYTES = 1024          # broker replies are a single line
DETAIL_LIMIT = 200
REQUEST_DEADLINE_S = 190.0         # > broker SCRIPT_TIMEOUT_S(180) so a broker
#                                   side timeout line is normally received
#                                   before the client deadline; earlier expiry
#                                   yields UNKNOWN (never a silent resend).
VT_GETSTATE = 0x5603               # linux/vt.h, struct vt_state {3x ushort}
VT_WAIT_POLL_S = 0.25              # small bounded poll interval while waiting
#                                   for tty2 to become the active VT; no input,
#                                   socket or secret activity happens while
#                                   another VT is active, and no VT is switched.
TIOCGPTN = 0x80045430              # Linux asm-generic: _IOR('T', 0x30, unsigned int)
# 0x80045440 is TIOCGEXCL (exclusive state), which also succeeds on real VTs.
SO_PEERCRED = 17                   # struct ucred {pid,uid,gid} = 3 x u32
ABORT_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT)

OPERATIONS = ("unlock", "status", "lock")


class OperatorError(Exception):
    """Refusal whose message is SAFE TO PRINT: it never contains the
    passphrase, the hex request, or raw broker bytes."""


class TerminalAborted(OperatorError):
    """A handleable signal arrived while the terminal was in noecho mode."""


# --- identity ---------------------------------------------------------------

def parse_capability_lines(status_text: str) -> dict:
    """Pure helper: pull the Cap* sets out of /proc/self/status text."""
    caps = {}
    for line in status_text.splitlines():
        m = re.match(r"^(Cap[A-Za-z]+):\s*([0-9a-fA-F]+)\s*$", line)
        if m:
            caps[m.group(1)] = int(m.group(2), 16)
    return caps


def validate_identity(uid: int = None) -> None:
    """Refuse to run as anyone but the fixed financial operator with no
    capability sets and no_new_privs set. Fail closed on unreadable /proc."""
    uid = os.getuid() if uid is None else uid
    ruid, euid, suid = os.getresuid()
    rgid, egid, sgid = os.getresgid()
    if not (ruid == euid == suid == egid == rgid == sgid == EXPECTED_UID):
        raise OperatorError(
            f"refused: identity: process must be exactly uid/gid {EXPECTED_UID} "
            f"(real/effective/saved), got uid={ruid}/{euid}/{suid} gid={rgid}/{egid}/{sgid}")
    if set(os.getgroups()) - {OPERATOR_PRIMARY_GID, EXPECTED_GID} or EXPECTED_GID not in os.getgroups():
        raise OperatorError(
            f"refused: identity: supplementary group {EXPECTED_GID} "
            "(portable-operators) missing; the broker socket is not reachable")
    try:
        with open("/proc/self/status", "r") as fh:
            status_text = fh.read(16385)
            if len(status_text) > 16384:
                raise OperatorError("refused: oversized process status")
            caps = parse_capability_lines(status_text)
    except OSError as exc:
        raise OperatorError(f"refused: identity: cannot read /proc/self/status: {exc.errno}") from exc
    for key in ("CapInh", "CapPrm", "CapEff", "CapAmb", "CapBnd"):
        if caps.get(key, -1) != 0:
            raise OperatorError(
                f"refused: identity: {key} must be empty (no capabilities)")
    nnp = re.findall(r"^NoNewPrivs:\s*([01])\s*$", status_text, re.MULTILINE)
    if nnp != ["1"]:
        raise OperatorError("refused: identity: no_new_privs must be 1")



# --- terminal / VT validation ----------------------------------------------

def vt_active(fd: int) -> int:
    """Ask the KERNEL which VT is currently active (VT_GETSTATE)."""
    buf = bytearray(6)  # struct vt_state { v_active, v_signal, v_state }
    try:
        fcntl.ioctl(fd, VT_GETSTATE, buf, True)
    except OSError as exc:
        raise OperatorError(
            f"refused: terminal: not a virtual console (VT_GETSTATE failed: {exc.errno})") from exc
    v_active = struct.unpack("=3H", bytes(buf))[0]
    if v_active == 0:
        raise OperatorError("refused: terminal: kernel reports no active VT")
    return v_active


def require_active_vt(fd: int, expected: int = EXPECTED_VT) -> None:
    active = vt_active(fd)
    if active != expected:
        raise OperatorError(
            f"refused: active VT is {active}, not {expected} "
            "(switch with Ctrl+Alt+F2; the operator never switches VTs itself)")


def fd_is_pty(fd: int) -> bool:
    try:
        fcntl.ioctl(fd, TIOCGPTN, struct.pack("=I", 0))
    except OSError:
        return False
    return True


def validate_terminal_fd(fd: int) -> None:
    try:
        st = os.fstat(fd)
    except OSError as exc:
        raise OperatorError(f"refused: fd {fd} unusable: {exc.errno}") from exc
    if not stat.S_ISCHR(st.st_mode):
        raise OperatorError(f"refused: fd {fd} is not a character device")
    major = os.major(st.st_rdev)
    minor = os.minor(st.st_rdev)
    if (major, minor) != (TTY_MAJOR, TTY_MINOR):
        raise OperatorError(
            f"refused: fd {fd} is character device {major}:{minor}, "
            f"not the fixed /dev/tty2 ({TTY_MAJOR}:{TTY_MINOR})")
    if fd_is_pty(fd):
        raise OperatorError(f"refused: fd {fd} is a PTY, not the real console")


def validate_terminal(fds=(0, 1, 2)) -> None:
    """Validate fd 0/1/2 are the REAL /dev/tty2 character device (device
    identity only — major/minor (4,2), not a PTY). The ACTIVE-VT state is
    deliberately handled SEPARATELY by wait_for_active_vt(): startup waits
    for tty2 instead of refusing when another VT (e.g. VT1) is active, and
    every menu read and passphrase prompt re-waits first, so waiting can
    never be confused with a weakened device-identity check."""
    for fd in fds:
        validate_terminal_fd(fd)


def wait_for_active_vt(fd: int, expected: int = EXPECTED_VT,
                       poll_s: float = VT_WAIT_POLL_S) -> None:
    """Wait until the kernel reports `expected` (tty2) as the ACTIVE VT.

    Small bounded-interval, signal-interruptible poll (time.sleep is
    interrupted by the abort handlers, so `finally` blocks still run). While
    another VT is active this reads NO input, touches NO socket, requests NO
    secret and switches NO VT. When tty2 becomes active, QUEUED tty input
    typed while another VT had focus is flushed so it can never become a
    menu choice or passphrase line. A terminal that stops answering
    VT_GETSTATE raises (fail closed) instead of spinning silently."""
    with abort_on_signals():
        while True:
            active = vt_active(fd)
            if active == expected:
                try:
                    termios.tcflush(fd, termios.TCIFLUSH)
                except termios.error as exc:
                    raise OperatorError("terminal input flush failed") from exc
                return
            time.sleep(poll_s)


# --- passphrase entry (standard termios noecho, bounded reads) ---------------

@contextlib.contextmanager
def noecho(fd: int):
    """Standard-library termios noecho with restoration on any exit path
    (normal, exception, or a handleable signal converted to an exception).
    SIGKILL cannot restore anything; that limit is documented, not hidden."""
    try:
        saved = termios.tcgetattr(fd)
    except termios.error as exc:
        raise OperatorError(f"refused: terminal: tcgetattr failed on fd {fd}") from exc
    new = termios.tcgetattr(fd)
    new[3] &= ~(termios.ECHO | termios.ECHONL)
    prior = signal.pthread_sigmask(signal.SIG_BLOCK, ABORT_SIGNALS)
    try:
        termios.tcsetattr(fd, termios.TCSAFLUSH, new)
        signal.pthread_sigmask(signal.SIG_SETMASK, prior)
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_BLOCK, ABORT_SIGNALS)
        try:
            # Discard rejected/pending secret input before echo is restored.
            try:
                termios.tcflush(fd, termios.TCIFLUSH)
            finally:
                termios.tcsetattr(fd, termios.TCSANOW, saved)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, prior)


@contextlib.contextmanager
def abort_on_signals():
    """Convert handleable signals into TerminalAborted so `finally` blocks
    (termios restoration) still run. The previous handlers are restored."""
    old = {}

    def handler(signum, frame):
        raise TerminalAborted(f"aborted by signal {signum}")

    try:
        for sig in ABORT_SIGNALS:
            old[sig] = signal.signal(sig, handler)
        yield
    finally:
        for sig, h in old.items():
            try:
                signal.signal(sig, h)
            except (ValueError, OSError):
                pass


def read_passphrase_noecho(fd: int, max_bytes: int = MAX_PASSPHRASE_BYTES) -> bytes:
    """Read ONE line from the tty with echo disabled. Standard bounded
    os.read loop in canonical mode — no hand-built echo emulation. Refuses
    empty input, NUL bytes and overflow (>max_bytes without newline).
    Exceptions never carry the secret: they are converted to safe messages."""
    data = bytearray()
    try:
        with abort_on_signals(), noecho(fd):
            while True:
                chunk = os.read(fd, 64)
                if not chunk:
                    raise OperatorError("refused: terminal closed before a full line")
                data += chunk
                if b"\x00" in chunk:
                    raise OperatorError("refused: passphrase contains a NUL byte")
                if b"\n" in data:
                    line = bytes(data)
                    line = line[: line.index(b"\n")]
                    if len(line) > max_bytes:
                        raise OperatorError("refused: passphrase too long")
                    if not line:
                        raise OperatorError("refused: empty passphrase")
                    return line
                if len(data) > max_bytes:
                    raise OperatorError("refused: passphrase too long")
    except OperatorError:
        raise
    except Exception as exc:  # never let raw bytes reach the message
        raise OperatorError(
            f"refused: terminal read failed ({type(exc).__name__})") from exc


def read_line_echo(fd: int, max_bytes: int = 64) -> bytes:
    """Bounded canonical read for NON-secret input (menu choice)."""
    data = bytearray()
    while True:
        chunk = os.read(fd, 64)
        if not chunk:
            raise OperatorError("terminal closed")
        data += chunk
        if b"\n" in data:
            return bytes(data[: data.index(b"\n")])[:max_bytes]
        if len(data) > max_bytes:
            raise OperatorError("input too long")


# --- broker client (existing protocol, fixed socket, absolute deadline) ------

def build_request(operation: str, passphrase: bytes = None) -> bytes:
    """Exactly the broker's wire format. Pure function, no I/O."""
    if operation not in OPERATIONS:
        raise OperatorError("refused: unknown operation (unlock, status, lock only)")
    if operation == "unlock":
        if passphrase is None:
            raise OperatorError("refused: unlock requires a passphrase")
        if not isinstance(passphrase, (bytes, bytearray)):
            raise OperatorError("refused: passphrase must be raw bytes")
        passphrase = bytes(passphrase)
        if not (1 <= len(passphrase) <= MAX_PASSPHRASE_BYTES):
            raise OperatorError("refused: passphrase length out of range")
        if b"\x00" in passphrase:
            raise OperatorError("refused: passphrase contains a NUL byte")
        return b"unlock\n" + passphrase.hex().encode("ascii") + b"\n"
    if passphrase is not None:
        raise OperatorError(f"refused: {operation} takes no parameters")
    return operation.encode("ascii") + b"\n"


def sanitise(text: str, limit: int = DETAIL_LIMIT) -> str:
    """One line, printable, bounded. Applied to every broker byte we print."""
    cleaned = re.sub(r"[\x00-\x1f\x7f]", " ", text.strip())
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:limit]


def parse_response(data: bytes) -> tuple:
    """'ok ...'/'error ...' single line -> (status, detail); anything else —
    including no newline, oversize, or an unknown first word — is UNKNOWN."""
    if not data or len(data) > MAX_RESPONSE_BYTES:
        return ("unknown", "response missing or oversized")
    if not data.endswith(b"\n") or data.count(b"\n") != 1:
        return ("unknown", "response is not exactly one terminated line")
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError:
        return ("unknown", "response is not ASCII")
    text = text[:-1]
    if not text or " " not in text:
        return ("unknown", "response has no status word + detail")
    word, detail = text.split(" ", 1)
    if word not in ("ok", "error"):
        return ("unknown", "unrecognised response status word")
    if word == "error" and detail.startswith("timeout "):
        return ("unknown", sanitise(detail))
    return (word, sanitise(detail))


def _dir_trusted(path: str) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and (st.st_mode & 0o022) == 0


def _ancestors_trusted(path: str) -> bool:
    acc = "/"
    for comp in path.lstrip("/").split("/"):
        if not comp:
            continue
        acc += comp
        if not _dir_trusted(acc):
            return False
        acc += "/"
    return True


def validate_socket(path: str = SOCKET_PATH) -> None:
    """The client-side mirror of the broker's own trust chain: nothing but
    the real root-owned broker socket is contacted. Fails closed."""
    try:
        st = os.lstat(path)
    except OSError as exc:
        raise OperatorError(
            f"refused: broker socket unavailable: {path} ({exc.errno})") from exc
    if not stat.S_ISSOCK(st.st_mode):
        raise OperatorError(f"refused: not a socket: {path}")
    if st.st_uid != 0:
        raise OperatorError(f"refused: broker socket not owned by root: {path}")
    if stat.S_IMODE(st.st_mode) != 0o660:
        raise OperatorError(
            f"refused: broker socket mode is {oct(stat.S_IMODE(st.st_mode))}, must be 0660")
    expected_gid = EXPECTED_GID
    if st.st_gid != expected_gid:
        raise OperatorError(
            f"refused: broker socket group is gid {st.st_gid}, expected "
            f"portable-operators ({expected_gid})")
    if not _ancestors_trusted(os.path.dirname(os.path.abspath(path))):
        raise OperatorError(f"refused: untrusted ancestor chain for {path}")


def peer_uid(sock: socket.socket):
    """SO_PEERCRED (works from the client side too on Linux): the uid of the
    process that accepted our connection — the broker must run as root."""
    try:
        creds = sock.getsockopt(socket.SOL_SOCKET, SO_PEERCRED, 12)
    except OSError:
        return None
    if len(creds) != 12:
        return None
    return int.from_bytes(creds[4:8], sys.byteorder)


def exchange_on_connected(sock: socket.socket, request: bytes, deadline: float) -> tuple:
    """Send ONE already-built request on a CONNECTED socket and read ONE
    bounded line with an ABSOLUTE deadline. Internal seam (no connect, no
    peer-credential validation — those happen in exchange())."""
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return ("unknown", "deadline expired before send")
        sock.settimeout(remaining)
        try:
            sock.sendall(request)
        except OSError:
            # sendall may already have sent a prefix. Never resend.
            return ("unknown", "send failed; request outcome unknown")
        buf = bytearray()
        while b"\n" not in buf and len(buf) <= MAX_RESPONSE_BYTES:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return ("unknown", "timeout waiting for broker response")
            sock.settimeout(remaining)
            try:
                chunk = sock.recv(256)
            except socket.timeout:
                return ("unknown", "timeout waiting for broker response")
            except OSError as exc:
                return ("unknown", f"connection error ({exc.errno})")
            if not chunk:
                return ("unknown", "broker closed before a complete response")
            buf += chunk
        return parse_response(bytes(buf))
    finally:
        try:
            sock.close()
        except OSError:
            pass


def exchange(sock_path: str, request: bytes, deadline: float) -> tuple:
    """Connect to the fixed broker socket, verify the ACCEPTING peer is
    root via SO_PEERCRED (before anything sensitive is sent), then run ONE
    bounded request/response round trip with an ABSOLUTE deadline."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return ("unknown", "deadline expired before connect")
        sock.settimeout(remaining)
        try:
            sock.connect(sock_path)
        except OSError as exc:
            if exc.errno in (errno.EACCES, errno.EPERM, errno.ENOENT):
                return ("error", f"local refusal: broker socket unreachable ({exc.errno})")
            return ("unknown", f"connect failed ({exc.errno})")
        uid = peer_uid(sock)
        if uid != 0:
            # Nothing sensitive has been sent yet.
            return ("error", "local refusal: broker peer is not uid 0")
        if request.startswith(b"unlock\n"):
            require_active_vt(0)  # connect may have waited; check again before secret send
        return exchange_on_connected(sock, request, deadline)
    finally:
        try:
            sock.close()
        except OSError:
            pass


def run_operation(operation: str, passphrase: bytes = None,
                  deadline_at: float = None,
                  sock_path: str = SOCKET_PATH) -> tuple:
    """Validate the broker socket, then perform ONE fixed operation.
    Pre-send local refusals are 'error' (nothing was sent); anything after
    the send that is not a clean one-line 'ok/error' reply is UNKNOWN —
    an uncertain unlock is NEVER automatically retried here; status
    reconciliation is a separate explicit operation."""
    if operation not in OPERATIONS:
        raise OperatorError("refused: unknown operation")
    request = build_request(operation, passphrase)
    validate_socket(sock_path)   # raises OperatorError BEFORE any connect
    if deadline_at is None:
        deadline_at = time.monotonic() + REQUEST_DEADLINE_S
    return exchange(sock_path, request, deadline_at)


# --- fixed interactive surface ----------------------------------------------

BANNER = "\nVault control\nUnlock / Status / Lock\nCtrl+Alt+F1: return to desktop\n"


def report_startup_refusal(stage: str, error: OperatorError) -> None:
    """Best-effort fixed pre-secret diagnostic; never export exception text.

    Call only before the menu/passphrase loop. Unknown errors map to a fixed
    enum. Logging failure does not change refusal or weaken any validation.
    """
    if stage not in ("identity", "terminal", "initial-vt"):
        return
    text = str(error)
    reason = "unclassified"
    patterns = (
        ("process must be exactly uid/gid", "identity-uid-gid"),
        ("supplementary group", "identity-groups"),
        ("oversized process status", "identity-status-size"),
        ("cannot read /proc/self/status", "identity-status-read"),
        ("no_new_privs must be 1", "identity-nnp"),
        ("not a character device", "tty-not-character"),
        ("is character device", "tty-wrong-device"),
        ("is a PTY", "tty-pty"),
        ("unusable:", "tty-fstat"),
        ("VT_GETSTATE failed", "vt-ioctl"),
        ("kernel reports no active VT", "vt-no-active"),
        ("terminal input flush failed", "vt-input-flush"),
    )
    for fragment, code in patterns:
        if fragment in text:
            reason = code
            break
    for capability in ("CapInh", "CapPrm", "CapEff", "CapAmb", "CapBnd"):
        if f"{capability} must be empty" in text:
            reason = "identity-" + capability.lower()
            break
    try:
        import syslog
        syslog.openlog("portable-vault-operator", syslog.LOG_PID, syslog.LOG_AUTHPRIV)
        syslog.syslog(syslog.LOG_ERR, f"startup-refused phase={stage} reason={reason}")
    except Exception:
        pass


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv:
        sys.stderr.write("operator-vt: refused: no options are accepted\n")
        return 2
    startup_stage = "identity"
    try:
        validate_identity()
        startup_stage = "terminal"
        validate_terminal()
    except OperatorError as exc:
        report_startup_refusal(startup_stage, exc)
        # Identity/terminal refusals happen before any secret exists.
        sys.stderr.write(f"operator-vt: {exc}\n")
        return 3
    out = sys.stdout
    # Startup while ANOTHER VT (e.g. VT1) is active: wait for tty2 WITHOUT
    # switching focus, reading input, touching the broker socket or asking
    # for any secret. A handleable signal during the wait exits cleanly
    # (no termios state has been entered yet, so there is nothing to
    # restore beyond the restored signal handlers).
    try:
        if vt_active(0) != EXPECTED_VT:
            out.write("waiting for tty2 to become the active VT "
                      "(switch with Ctrl+Alt+F2; no input is read until then)...\n")
            out.flush()
        wait_for_active_vt(0)
    except OperatorError as exc:
        report_startup_refusal("initial-vt", exc)
        out.write(f"operator-vt: {exc}\n")
        return 3
    out.write(BANNER)
    out.flush()
    while True:
        try:
            # Wait (and flush queued input on activation) before EVERY menu
            # read: input typed while another VT was active never becomes a
            # menu choice, and no input is read at all while tty2 is inactive.
            wait_for_active_vt(0)
        except OperatorError as exc:
            out.write(f"\noperator-vt: {exc}\n")
            return 0
        out.write("operation> ")
        out.flush()
        try:
            choice = read_line_echo(0).decode("utf-8", "replace").strip().lower()
        except OperatorError as exc:
            out.write(f"\noperator-vt: {exc}\n")
            return 0
        op = {"u": "unlock", "unlock": "unlock",
              "s": "status", "status": "status",
              "l": "lock", "lock": "lock"}.get(choice)
        if choice in ("q", "quit"):
            out.write("operator-vt: exiting (vault state unchanged by exit)\n")
            return 0
        if op is None:
            out.write("operator-vt: unknown operation "
                      "(u=unlock s=status l=lock q=quit only)\n")
            continue
        passphrase = None
        if op == "unlock":
            # Wait for tty2 to be active before the passphrase prompt too...
            try:
                wait_for_active_vt(0)
            except OperatorError as exc:
                out.write(f"operator-vt: {exc}\n")
                continue
            # ...then re-check the ACTIVE VT before accepting the passphrase.
            try:
                require_active_vt(0)
            except OperatorError as exc:
                out.write(f"operator-vt: {exc}\n")
                continue
            out.write("passphrase (noecho, max 512 bytes, plain line): ")
            out.flush()
            try:
                passphrase = read_passphrase_noecho(0)
            except OperatorError as exc:
                out.write(f"\noperator-vt: {exc}\n")
                continue
            out.write("\n")
            # ...and again before the passphrase is SENT to the broker.
            try:
                require_active_vt(0)
            except OperatorError as exc:
                out.write(f"operator-vt: {exc} — passphrase discarded, "
                          "nothing was sent\n")
                passphrase = None
                continue
        try:
            status, detail = run_operation(op, passphrase)
        except OperatorError as exc:
            status, detail = "error", sanitise(str(exc))
        finally:
            passphrase = None  # release reference; NOT a secure-zeroization claim
        out.write(f"broker: {status}: {detail}\n")
        if op in ("unlock", "lock") and status == "unknown":
            out.write(
                "VAULT OPERATION RESULT UNKNOWN — do NOT retry automatically. Run "
                "'s' (status) to reconcile the actual vault state.\n")
        out.flush()


if __name__ == "__main__":
    sys.exit(main())
