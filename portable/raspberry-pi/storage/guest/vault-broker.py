#!/usr/bin/env python3
"""vault-broker.py — root-side vault lifecycle broker (fixed commands only).

The broker exists so that the separately trusted journal owner
(portable-credit) can request vault unlock/lock without sudo, while the agent
account (portable-agent) has NO path to vault lifecycle control. It accepts
exactly three commands — unlock, lock, status — with no parameters at all:
the LUKS UUID and mountpoint come from a root-owned, trust-chain-verified
vault.conf, never from the client. There is deliberately no command that
takes a path, a device, a script or any free-form input.

MOUNT AUTHORITY MODEL (see portable/raspberry-pi/storage/README.md): this service runs in
the HOST mount namespace on purpose. The vault mount it creates must be
visible to every other unit; its systemd unit therefore carries NO
mount-namespace-inducing directives (no PrivateTmp/ProtectSystem/ProtectHome/
PrivateMounts/...). Authority is bounded by the fixed command set, the
validated root-owned config/scripts tree, and SO_PEERCRED instead.

Access control, three independent layers:
  1. Filesystem: socket dir 0750 root:<BROKER_GROUP>, socket 0660
     root:<BROKER_GROUP> — portable-agent is not in that group.
  2. SO_PEERCRED: the effective uid of every connecting process must be one
     of BROKER_ALLOWED_UIDS (account names resolved to uids at startup).
  3. Protocol: fixed one-word commands, bounded request size, hex-encoded
     passphrase (binary-safe except NUL, which the helpers refuse), no
     shell — scripts are exec'd by exact path with the broker's OWN
     validated --config argument, so a client can never select a different
     vault policy than the one the broker validated.

Passphrase channel: the client sends the passphrase hex-encoded on the second
line; the broker writes the DECODED raw bytes to unlock-vault.sh's stdin pipe
and nothing else. The passphrase is never an argument, environment variable,
log line or key file; it does not appear in responses or the journal. Malformed
requests are refused WITHOUT echoing request material back or into logs.

Socket protocol (one request per connection, ASCII, max 2048 bytes total,
30s idle timeout):
    "unlock\\n<hex passphrase, 2..1024 hex chars>\\n"   -> "ok ..." | "error ..."
    "lock\\n"                                           -> "ok ..." | "error ..."
    "status\\n"                                         -> "ok <one status line>" | ...
Responses are a single line. Errors carry a code, the script's exit code and
the LAST non-empty stderr line (the helpers print their final refusal/state
line last; progress logs precede it). Dispatched scripts run in their own
process group; a timeout kills and reaps the WHOLE group, so a cryptsetup
child cannot outlive its helper script.

CREDIT-SESSION COMPOSITION (explicit ROOT CLI opt-in; default OFF). With
--credit-session on the ROOT command line ONLY — never a request field, never
a vault.conf key — the SAME three commands additionally compose the fixed
portable-credit.service unit around the existing lifecycle:
  unlock: existing unlock helper, then a VERIFIED structured "state: unlocked"
          from the existing status helper, then ONE fixed
          /usr/bin/systemctl start of the fixed unit; a start failure or
          systemctl-exit-0 condition-skip is reported as
          "vault unlocked; credit unavailable ..." with NO rollback, retry or
          pretending the vault is locked,
  lock:   ONE fixed systemctl stop of the fixed unit, then verified
          ActiveState inactive or failed AND MainPID=0 AND an empty-or-gone unit
          cgroup, and ONLY then the existing ordinary lock helper; any stop
          timeout/failure/unknown state MUST NOT run the lock helper,
  status: existing status helper plus the fixed unit's read-only state
          (never mutates anything).
Without the flag the broker behavior is byte-for-byte the old lifecycle.
The supervisor surface is FIXED: exactly /usr/bin/systemctl, verbs
start/stop/show, unit exactly portable-credit.service, fixed clean
environment, no shell, no arbitrary units/commands/paths. Composed
transactions serialize on a broker-local threading lock with a BOUNDED wait
followed by refusal (queued clients would retain passphrases); the lifecycle
flock stays owned by the helper scripts (it is never held across the credit
start, so the verification's SH lock and trusted-root CLI operations cannot
deadlock against a broker-held EX). The threading lock serializes BROKER
CLIENTS only — it does not and cannot serialize a trusted root CLI running
the helpers directly; that boundary is documented, not hidden.
"""

import argparse
import grp
import os
import pwd
import re
import signal
import socket
import stat
import subprocess
import sys
import threading
import selectors
import time

MAX_REQUEST_BYTES = 2048
MAX_PASSPHRASE_BYTES = 512
IDLE_TIMEOUT_S = 30
SCRIPT_TIMEOUT_S = 180
MAX_CAPTURE_BYTES = 4096
ACCEPT_POLL_S = 1.0        # bound accept() so termination is never stuck behind it
SHUTDOWN_DEADLINE_S = 5.0  # bound socket close/unlink retries at shutdown

# --- credit-session composition (explicit root CLI opt-in only) -------------
#
# Fixed supervisor surface: nothing a client can send reaches these. The
# module-level constants exist so the OFFLINE suite can inject a fake
# executor path and small budgets — the same seam pattern as HELPER_ENV and
# SCRIPT_TIMEOUT_S; there is no runtime flag for any of this.
SYSTEMCTL_PATH = "/usr/bin/systemctl"   # fixed executor; tests inject a fake
SYSTEMCTL_ENV = {"PATH": "/usr/bin:/bin", "LC_ALL": "C"}  # clean, fixed
SYSTEMCTL_VERBS = ("start", "stop", "show")
SHOW_PROPERTIES = ("ActiveState", "MainPID", "ConditionResult", "ControlGroup")
CREDIT_UNIT = "portable-credit.service"  # the ONLY composable unit
CGROUP_ROOT = "/sys/fs/cgroup"           # read-only, bounded probe
CGROUP_PROCS_LIMIT = 4096                # bounded cgroup.procs read
#
# FULL-COMMAND BUDGET CONTRACT (chosen explicitly): the operator's
# REQUEST_DEADLINE_S is 190s and one helper alone may run up to
# SCRIPT_TIMEOUT_S=180s, so every composed transaction gets ONE absolute
# work budget of 175s. Failure cleanup may add at most 5s; the remaining
# margin is reserved for the reply before the operator's 190s deadline.
# Each step uses the remaining work budget; failures are never retried.
# An unreaped process or elapsed deadline means unknown, never clean success.
COMPOSED_BUDGET_S = 175.0
# Refuse concurrent composition immediately: never queue a secret-bearing job.
COMPOSE_LOCK_WAIT_S = 0.0
STATUS_VERIFY_TIMEOUT_S = 30.0  # cap for the post-unlock verification
SYSTEMCTL_TIMEOUT_S = 25.0      # > credit unit TimeoutStopSec=20s (stop)

STATE_WORD_RE = re.compile(r"^state: (unlocked|locked|partial|unsafe)(?:$|[ ;(].*)$")

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
ACCOUNT_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
RUN_PATH_RE = re.compile(r"^/run/[a-zA-Z0-9/_-]{0,60}$")
MAPPER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,30}$")
SUBDIR_RE = re.compile(r"^[a-z][a-z0-9_-]{0,15}$")

# Defaults mirror guest/common.sh; every key is validated before use.
DEFAULTS = {
    "VAULT_LUKS_UUID": "",
    "VAULT_MAPPER_NAME": "portable-vault",
    "VAULT_FSTYPE": "ext4",
    "VAULT_MOUNTPOINT": "/run/portable-vault",
    "VAULT_MOUNT_OPTIONS": "nodev,nosuid,noexec",
    "VAULT_MOUNT_SUBDIR_CREDIT": "credit",
    "VAULT_MOUNT_SUBDIR_AGENT": "agent",
    "VAULT_MOUNT_SUBDIR_UI": "ui",
    "BROKER_SOCKET_DIR": "/run/portable-control",
    "BROKER_SOCKET_NAME": "broker.sock",
    "BROKER_GROUP": "portable-operators",
    "BROKER_ALLOWED_UIDS": "portable-credit",
}

SCRIPT_NAMES = {"unlock": "unlock-vault.sh", "lock": "lock-vault.sh", "status": "vault-status.sh"}
# The dispatchable scripts source common.sh, so the trust check covers it too:
# validating only unlock/lock/status would leave the shared code unaudited.
TRUSTED_SCRIPT_FILES = ("common.sh", "unlock-vault.sh", "lock-vault.sh", "vault-status.sh")

# Environment for dispatched helpers (fixed in production). Kept at module
# level so the offline suite can point helpers at injected fake executors —
# the same pattern as SCRIPT_TIMEOUT_S; there is no runtime flag for this.
HELPER_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}


class ConfigError(Exception):
    pass


def mount_options_ok(opts: str) -> bool:
    words = opts.split(",")
    return (
        bool(words)
        and all(w in ("nodev", "nosuid", "noexec", "rw") for w in words)
        and {"nodev", "nosuid", "noexec"}.issubset(set(words))
    )


# --- trust chain (mirror of guest/common.sh; no test-mode escape exists) ------

def _dir_trusted(path: str) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    return (
        stat.S_ISDIR(st.st_mode)
        and st.st_uid == 0
        and (st.st_mode & 0o022) == 0
    )


def _ancestors_trusted(path: str) -> bool:
    acc = "/"
    rest = path.lstrip("/")
    for comp in rest.split("/"):
        if not comp:
            continue
        acc = acc + comp
        if not _dir_trusted(acc):
            return False
        acc += "/"
    return True


def require_trusted_file(path: str, exact_mode: int) -> None:
    """Refuse anything but a root-owned regular non-symlink file of exactly
    `exact_mode` inside a trusted ancestor chain."""
    try:
        st = os.lstat(path)
    except OSError as exc:
        raise ConfigError(f"trust: cannot stat {path}: {exc}") from exc
    if stat.S_ISLNK(st.st_mode):
        raise ConfigError(f"trust: refusing symlinked file: {path}")
    if not stat.S_ISREG(st.st_mode):
        raise ConfigError(f"trust: not a regular file: {path}")
    if st.st_uid != 0:
        raise ConfigError(f"trust: {path} owned by uid {st.st_uid}, not root")
    if stat.S_IMODE(st.st_mode) != exact_mode:
        raise ConfigError(
            f"trust: {path} mode is {oct(stat.S_IMODE(st.st_mode))} (must be {oct(exact_mode)})"
        )
    if not _ancestors_trusted(os.path.dirname(os.path.abspath(path))):
        raise ConfigError(f"trust: untrusted ancestor chain for {path}")


def require_trusted_scripts_dir(scripts_dir: str) -> None:
    """The fixed command set is only trustworthy when the script tree is a
    root-owned, non-group/world-writable, symlink-free tree — including the
    shared common.sh the dispatchable scripts source."""
    if not os.path.isabs(scripts_dir):
        raise ConfigError(f"scripts dir must be absolute: {scripts_dir}")
    if not _ancestors_trusted(scripts_dir):
        raise ConfigError(f"trust: untrusted ancestor chain for {scripts_dir}")
    for name in TRUSTED_SCRIPT_FILES:
        require_trusted_file(os.path.join(scripts_dir, name), 0o755)


def parse_config(path: str) -> dict:
    """Strict vault.conf parser (kept schema-compatible with common.sh,
    including its NO-whitespace-stripping behavior: a line is KEY=VALUE
    exactly as written; leading/trailing whitespace or CR makes the line
    invalid in BOTH parsers, so the shell and the broker can never disagree
    about which configurations are acceptable). Lines are handled as BYTES
    like bash `read`: comment/blank lines may contain any bytes (bash skips
    them untouched); every ACTIVE line must be pure ASCII."""
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except OSError as exc:
        raise ConfigError(f"cannot read {path}: {exc}") from exc
    if len(data) > 4096:
        raise ConfigError(f"{path} larger than 4096 bytes")
    cfg = dict(DEFAULTS)
    seen = set()
    lines = data.split(b"\n")
    if lines and lines[-1] == b"":
        lines = lines[:-1]  # exactly one trailing newline, like bash `read`
    for lineno, rawline in enumerate(lines, 1):
        if rawline == b"" or rawline.startswith(b"#"):
            continue
        try:
            line = rawline.decode("ascii")
        except UnicodeDecodeError as exc:
            raise ConfigError(
                f"{path}:{lineno}: non-ASCII byte in configuration line") from exc
        if "=" not in line:
            raise ConfigError(f"{path}:{lineno}: expected KEY=VALUE")
        key, value = line.split("=", 1)
        if key not in DEFAULTS:
            raise ConfigError(f"{path}:{lineno}: unknown key: {key[:64]}")
        if key in seen:
            raise ConfigError(f"{path}:{lineno}: duplicate key: {key}")
        seen.add(key)
        cfg[key] = value

    if cfg["VAULT_LUKS_UUID"] and not UUID_RE.match(cfg["VAULT_LUKS_UUID"]):
        raise ConfigError("VAULT_LUKS_UUID must be empty or a lowercase canonical UUID")
    if not MAPPER_RE.match(cfg["VAULT_MAPPER_NAME"]) or cfg["VAULT_MAPPER_NAME"] == "control":
        raise ConfigError("invalid VAULT_MAPPER_NAME")
    if cfg["VAULT_FSTYPE"] != "ext4":
        raise ConfigError("VAULT_FSTYPE must be ext4")
    for pathkey in ("VAULT_MOUNTPOINT", "BROKER_SOCKET_DIR"):
        if not RUN_PATH_RE.match(cfg[pathkey]) or ".." in cfg[pathkey]:
            raise ConfigError(f"{pathkey} must be an absolute /run/... path without '..'")
    if not mount_options_ok(cfg["VAULT_MOUNT_OPTIONS"]):
        raise ConfigError("VAULT_MOUNT_OPTIONS must be nodev,nosuid,noexec (optionally rw)")
    subdirs = []
    for key in ("VAULT_MOUNT_SUBDIR_CREDIT", "VAULT_MOUNT_SUBDIR_AGENT", "VAULT_MOUNT_SUBDIR_UI"):
        if not SUBDIR_RE.match(cfg[key]):
            raise ConfigError(f"{key} must be a simple directory name")
        subdirs.append(cfg[key])
    if len(set(subdirs)) != 3:
        raise ConfigError("vault subdirectories must be distinct")
    if not re.match(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$", cfg["BROKER_SOCKET_NAME"]):
        raise ConfigError("invalid BROKER_SOCKET_NAME")
    if not ACCOUNT_RE.match(cfg["BROKER_GROUP"]):
        raise ConfigError("invalid BROKER_GROUP")
    mp = cfg["VAULT_MOUNTPOINT"]
    sd = cfg["BROKER_SOCKET_DIR"]
    if sd == mp or sd.startswith(mp + "/"):
        raise ConfigError("BROKER_SOCKET_DIR must be outside the vault mountpoint")
    uids = cfg["BROKER_ALLOWED_UIDS"].split(",")
    if not uids or any(not ACCOUNT_RE.match(u) or u in ("root", "portable-ui", "portable-agent") for u in uids):
        raise ConfigError("BROKER_ALLOWED_UIDS must exclude root, portable-ui and portable-agent")
    return cfg


def resolve_uids(names_csv: str) -> dict:
    """Account names -> uid. Raises ConfigError for unknown accounts."""
    table = {}
    for name in names_csv.split(","):
        try:
            table[name] = pwd.getpwnam(name).pw_uid
        except KeyError as exc:
            raise ConfigError(f"BROKER_ALLOWED_UIDS: account not found: {name}") from exc
    if 0 in table.values():
        raise ConfigError("root must not appear in BROKER_ALLOWED_UIDS")
    return table


def parse_request(data: bytes):
    """Parse one request. Returns (command, passphrase_bytes_or_None).

    Raises ValueError with a refusal reason on anything unexpected. Reasons
    never include request material (no payload echo into logs or responses).
    This function is pure (no I/O) so it can be tested directly.
    """
    if len(data) > MAX_REQUEST_BYTES:
        raise ValueError("request too large")
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError as exc:
        raise ValueError("request must be ASCII") from exc
    lines = text.split("\n")
    # Allow exactly one trailing newline; nothing after it.
    if lines and lines[-1] == "":
        lines = lines[:-1]
    else:
        raise ValueError("request must end with a newline")
    if not lines or any(line == "" for line in lines):
        raise ValueError("empty line in request")
    command = lines[0]
    if command not in ("unlock", "lock", "status"):
        raise ValueError("unknown command (must be exactly unlock, lock or status)")
    if command == "unlock":
        if len(lines) != 2:
            raise ValueError("unlock needs exactly one passphrase line")
        hexpass = lines[1]
        if len(hexpass) < 2 or len(hexpass) > MAX_PASSPHRASE_BYTES * 2:
            raise ValueError("passphrase length out of range")
        if not re.fullmatch(r"[0-9a-fA-F]+", hexpass):
            raise ValueError("passphrase must be hex-encoded")
        passphrase = bytes.fromhex(hexpass)
        if not (1 <= len(passphrase) <= MAX_PASSPHRASE_BYTES):
            raise ValueError("passphrase length out of range")
        if b"\x00" in passphrase:
            # The helpers refuse NUL too; refuse here so the client gets a
            # precise reason and the passphrase contract stays one contract.
            raise ValueError("passphrase contains a NUL byte (valid text only)")
        return command, passphrase
    if len(lines) != 1:
        raise ValueError("command takes no parameters")
    return command, None


def last_line(text: str, limit: int = 200) -> str:
    """Bounded LAST non-empty line: helpers print their final refusal or
    state line last, after any progress logs."""
    lines = [ln for ln in text.strip().splitlines() if ln.strip()]
    if not lines:
        return ""
    line = lines[-1].strip()
    return re.sub(r"[\r\n\t]", " ", line)[:limit]


def parse_state_word(text: str):
    """The structured vault-state word from vault-status.sh's final
    `state: <word>` line, or None when absent."""
    found = STATE_WORD_RE.fullmatch(text or "")
    return found.group(1) if found else None


def bounded_process(argv, env, timeout, data=b""):
    """Fixed callers only. Bound live pipe capture; never log input or stderr."""
    if timeout is None or timeout <= 0:
        return None, b"", b"", True
    proc = None
    selector = selectors.DefaultSelector()
    buffers = [bytearray(), bytearray()]
    failed = False
    deadline = time.monotonic() + timeout
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE if data else subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=env, start_new_session=True)
        if data:
            # Fixed vault request <=512 bytes fits the initially empty pipe.
            if len(data)>512: raise ValueError("input bound")
            proc.stdin.write(data); proc.stdin.close()
        for i, stream in enumerate((proc.stdout, proc.stderr)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, i)
        while selector.get_map():
            remaining = deadline-time.monotonic()
            if remaining<=0: raise TimeoutError()
            events=selector.select(remaining)
            if not events: raise TimeoutError()
            for key,_ in events:
                chunk=os.read(key.fileobj.fileno(),4096)
                if not chunk: selector.unregister(key.fileobj);continue
                buffers[key.data].extend(chunk)
                if len(buffers[key.data])>MAX_CAPTURE_BYTES: raise ValueError("output bound")
        proc.wait(timeout=max(.001,deadline-time.monotonic()))
    except (OSError, ValueError, TimeoutError, subprocess.TimeoutExpired):
        failed=True
    finally:
        selector.close()
        if proc is not None:
            if failed or proc.poll() is None:
                try: os.killpg(proc.pid,signal.SIGKILL)
                except ProcessLookupError: pass
                try: proc.wait(timeout=5)
                except subprocess.TimeoutExpired: failed=True
            for stream in (proc.stdin,proc.stdout,proc.stderr):
                if stream is not None: stream.close()
    return (None if proc is None else proc.returncode,
            bytes(buffers[0][:MAX_CAPTURE_BYTES]), bytes(buffers[1][:MAX_CAPTURE_BYTES]), failed)


class Broker:
    def __init__(self, cfg: dict, scripts_dir: str, socket_override: str = "",
                 config_path: str = "", credit_session: bool = False):
        self.cfg = cfg
        self.scripts_dir = scripts_dir
        self.config_path = config_path or "/opt/portable/etc/vault.conf"
        self.credit_session = bool(credit_session)
        # Broker-local serialization of FULL composed transactions against
        # concurrent broker clients ONLY (bounded wait, then refusal). This
        # is NOT the lifecycle flock — the helpers own that — and it does not
        # serialize a trusted root CLI running the helpers directly.
        self.compose_lock = threading.Lock()
        self.allowed = resolve_uids(cfg["BROKER_ALLOWED_UIDS"])
        if socket_override:
            # Test/staging hook: the config schema stays /run-strict; only the
            # process starter (root in production) may relocate the socket.
            if not socket_override.startswith("/") or ".." in socket_override:
                raise ConfigError("socket override must be an absolute path without '..'")
            self.socket_path = socket_override
        else:
            self.socket_path = os.path.join(cfg["BROKER_SOCKET_DIR"], cfg["BROKER_SOCKET_NAME"])
        self.socket_dir = os.path.dirname(self.socket_path) or "/run"
        self.server = None

    def peer_allowed(self, conn: socket.socket) -> bool:
        """SO_PEERCRED check: the connecting process uid must be allowed."""
        SO_PEERCRED = 17  # Linux; struct ucred { pid, uid, gid } = 3 x u32
        try:
            creds = conn.getsockopt(socket.SOL_SOCKET, SO_PEERCRED, 12)
        except OSError:
            return False
        if len(creds) != 12:
            return False
        uid = int.from_bytes(creds[4:8], sys.byteorder)
        return uid in self.allowed.values()

    def script_path(self, command: str) -> str:
        return os.path.join(self.scripts_dir, SCRIPT_NAMES[command])

    def dispatch(self, command: str, passphrase, timeout: float = None):
        """Run the fixed script for the command. Never uses a shell. The
        broker's own validated config path is passed explicitly to EVERY
        helper, so dispatched operations can never silently use a different
        vault policy than the one validated here. The helper runs in its own
        process group; timeout kills and reaps the whole group (default
        SCRIPT_TIMEOUT_S; composed transactions pass a remaining-budget
        cap)."""
        script = self.script_path(command)
        rc, out_b, err_b, failed = bounded_process(
            [script, "--config", self.config_path], dict(HELPER_ENV),
            SCRIPT_TIMEOUT_S if timeout is None else timeout,
            passphrase if passphrase is not None else b"")
        if failed:
            return "error", "timeout (helper outcome unknown; query status separately)"
        out = out_b[:MAX_CAPTURE_BYTES].decode("utf-8", "replace")
        err = err_b[:MAX_CAPTURE_BYTES].decode("utf-8", "replace")
        if rc == 0:
            detail = last_line(out) or "done"
            return "ok", detail
        detail = last_line(err) or last_line(out) or "no output"
        return "error", f"exit={rc} {detail}"

    # --- fixed supervisor commands (credit-session composition only) ------

    def supervisor_argv(self, verb: str, properties=()) -> list:
        """The ONLY supervisor argv this broker can build: the fixed executor
        with one fixed verb against exactly the fixed credit unit. No client
        input reaches here; anything else is refused."""
        if verb not in SYSTEMCTL_VERBS:
            raise ConfigError(f"supervisor verb not allowed: {verb!r}")
        if verb == "show":
            props = list(properties)
            if (not props or len(set(props)) != len(props)
                    or any(p not in SHOW_PROPERTIES for p in props)):
                raise ConfigError("supervisor show properties not allowed")
            return [SYSTEMCTL_PATH, "show", CREDIT_UNIT,
                    "--property=" + ",".join(props)]
        if properties:
            raise ConfigError("only show takes properties")
        return [SYSTEMCTL_PATH, verb, CREDIT_UNIT]

    def run_supervisor(self, verb: str, timeout: float, properties=()):
        """Run ONE fixed supervisor command: no shell, fixed clean
        environment, its own process group, bounded output capture, and
        kill+reap of the WHOLE group on timeout (the same discipline as
        helper dispatch). Returns (returncode_or_None, out_bytes,
        err_bytes, timed_out)."""
        return bounded_process(self.supervisor_argv(verb, properties),
                               dict(SYSTEMCTL_ENV), timeout)

    def show_credit(self, properties, timeout: float):
        """Read-only fixed unit properties. Returns (props dict, error str);
        the error string starts with 'timeout' exactly when the query was
        killed on its budget, so callers can keep uncertain outcomes
        UNKNOWN instead of guessing a state."""
        rc, out_b, err_b, timed_out = self.run_supervisor("show", timeout, properties)
        if timed_out:
            return None, "timeout (unit property query exceeded its budget)"
        if rc != 0:
            detail = last_line(err_b.decode("utf-8", "replace")) or "no output"
            return None, f"unit property query failed: exit={rc} {detail}"
        props = {}
        for line in out_b.decode("utf-8", "replace").splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                if key in SHOW_PROPERTIES and key not in props:
                    props[key] = value.strip()
        missing = [p for p in properties if p not in props]
        if missing:
            return None, "unit property query incomplete: " + ",".join(missing)
        return props, ""

    def credit_cgroup_empty(self, control_group: str):
        """Bounded, safe check that a stopped unit's cgroup is gone or has no
        processes. The path comes from systemd itself but is still validated
        (absolute, no '..', no whitespace) before ONE bounded read of
        cgroup.procs. Returns (empty_bool, reason)."""
        if not control_group:
            control_group = "/system.slice/portable-credit.service"
        if control_group != "/system.slice/portable-credit.service":
            return False, "unexpected credit cgroup"
        if (not control_group.startswith("/") or ".." in control_group
                or re.search(r"[\s\x00]", control_group)
                or not re.fullmatch(r"[/A-Za-z0-9._@-]+", control_group)):
            return False, "unparsable unit cgroup path reported"
        procs = os.path.join(CGROUP_ROOT, control_group.lstrip("/"), "cgroup.procs")
        try:
            with open(procs, "rb") as fh:
                data = fh.read(CGROUP_PROCS_LIMIT + 1)
        except FileNotFoundError:
            return True, "unit cgroup gone"
        except OSError as exc:
            return False, f"cgroup.procs read failed ({exc.errno})"
        if len(data) > CGROUP_PROCS_LIMIT:
            return False, "cgroup.procs oversized"
        try:
            with open(os.path.join(os.path.dirname(procs), "cgroup.events"), "rb") as fh:
                events = fh.read(1025)
            if len(events) > 1024 or b"populated 0" not in events.splitlines():
                return False, "credit cgroup still populated or unknown"
        except OSError:
            return False, "credit cgroup population unknown"
        tokens = data.split()
        if not tokens:
            return True, "unit cgroup empty"
        if not all(tok.isdigit() for tok in tokens):
            return False, "cgroup.procs unparsable"
        return False, f"{len(tokens)} process(es) remain in the unit cgroup"

    def composed_unlock(self, passphrase, deadline: float):
        """unlock helper -> VERIFIED structured state:unlocked -> ONE fixed
        credit start (opt-in path only). The vault lifecycle flock stays with
        the helpers; it is NOT held across the credit start (the verification
        helper takes its own SH lock and must never deadlock against an
        EX this broker would hold). A failed or condition-skipped start is
        reported as 'vault unlocked; credit unavailable ...' with no
        rollback, no retry, and never a claim that the vault is locked."""
        if not self.compose_lock.acquire(blocking=False):
            return ("error",
                    "busy: another credit-session transaction holds the broker; "
                    "refused before mutation; query status separately")
        try:
            timeout = min(SCRIPT_TIMEOUT_S, deadline - time.monotonic())
            if timeout <= 0:
                return ("error", "timeout (composed budget exhausted before unlock; "
                                 "vault state unchanged; query status separately)")
            status, detail = self.dispatch("unlock", passphrase, timeout=timeout)
            passphrase = None  # drop the reference; not a zeroization claim
            if status != "ok":
                return status, detail
            # Only a VERIFIED structured 'state: unlocked' starts credit.
            timeout = min(STATUS_VERIFY_TIMEOUT_S, deadline - time.monotonic())
            if timeout <= 0:
                return ("ok", "vault unlocked; credit unavailable (time budget exhausted "
                              "before state verification; query status separately)")
            vstatus, vdetail = self.dispatch("status", None, timeout=timeout)
            word = parse_state_word(vdetail)
            if not (vstatus == "ok" and word == "unlocked"):
                if vstatus == "ok" and word in ("locked", "partial"):
                    return ("error", f"unlock succeeded but verified state is {word} "
                                     f"({vdetail}); credit not started; no rollback "
                                     "(query status separately)")
                if vstatus == "error" and word == "unsafe":
                    return ("error", f"unlock succeeded but verified state is unsafe "
                                     f"({vdetail}); credit not started; no rollback")
                if vstatus == "error" and vdetail.startswith("timeout"):
                    return ("error", "timeout (unlock completed; current vault state unknown; credit not started)")
                return ("error", "unlock completed; current vault state unknown; credit not started; query status")
            # Start the FIXED credit unit — only now.
            timeout = min(SYSTEMCTL_TIMEOUT_S, deadline - time.monotonic())
            if timeout <= 0:
                return ("ok", "vault unlocked; credit unavailable (time budget exhausted "
                              "before credit start; query status separately)")
            rc, out_b, err_b, timed_out = self.run_supervisor("start", timeout)
            if timed_out:
                return ("ok", "vault unlocked; credit unavailable (credit start timed "
                              "out; unit state unknown; no retry — query status "
                              "separately)")
            if rc != 0:
                why = (last_line(err_b.decode("utf-8", "replace"))
                       or last_line(out_b.decode("utf-8", "replace")) or "no output")
                return ("ok", f"vault unlocked; credit unavailable (start failed: "
                              f"exit={rc} {why})")
            # systemctl start may exit 0 while the unit was SKIPPED because a
            # Condition failed: distinguish by observed unit facts only.
            props, err = self.show_credit(
                ("ActiveState", "MainPID", "ConditionResult"),
                min(SYSTEMCTL_TIMEOUT_S, deadline - time.monotonic()))
            if props is None:
                suffix = err if err.startswith("timeout") else f"{err}; query status separately"
                return ("ok", f"vault unlocked; credit unavailable (activation state "
                              f"unknown: {suffix})")
            active, mainpid = props["ActiveState"], props["MainPID"]
            if active == "active" and mainpid.isdigit() and int(mainpid) > 0 and props["ConditionResult"] == "yes":
                return ("ok", "vault unlocked; credit service started")
            if props["ConditionResult"] == "no" or active == "inactive":
                return ("ok", f"vault unlocked; credit unavailable (start skipped: unit "
                              f"conditions unmet, ConditionResult={props['ConditionResult']}, "
                              f"ActiveState={active}; unit not running)")
            return ("ok", f"vault unlocked; credit unavailable (unexpected unit state "
                          f"after start: ActiveState={active} MainPID={mainpid}; query "
                          "status separately)")
        finally:
            self.compose_lock.release()

    def composed_lock(self, deadline: float):
        """ONE fixed credit stop -> verified drained unit (MainPID 0 +
        empty-or-gone unit cgroup) -> existing ordinary lock helper. After a
        stop that SUCCEEDED within its budget, ActiveState=failed is accepted
        exactly like inactive (systemd may mark a stopped unit failed), but
        ONLY with MainPID exactly the string 0 AND the existing cgroup
        empty-or-gone proof — the state word alone never authorizes the lock.
        ANY stop timeout, failure, other/unknown ActiveState, nonzero
        MainPID or failed cgroup proof MUST NOT run the lock helper: the
        vault state is not changed by the lock helper and the refusal says
        exactly that."""
        if not self.compose_lock.acquire(blocking=False):
            return ("error",
                    "busy: another credit-session transaction holds the broker; "
                    "refused before mutation; query status separately")
        try:
            timeout = min(SYSTEMCTL_TIMEOUT_S, deadline - time.monotonic())
            if timeout <= 0:
                return ("error", "timeout (composed budget exhausted before credit "
                                 "stop; lock NOT run; vault state unchanged by lock; query status; query status "
                                 "separately)")
            rc, out_b, err_b, timed_out = self.run_supervisor("stop", timeout)
            if timed_out:
                return ("error", "timeout (credit stop outcome unknown; lock NOT run; "
                                 "vault state unchanged by lock; query status; query status separately)")
            if rc != 0:
                why = (last_line(err_b.decode("utf-8", "replace"))
                       or last_line(out_b.decode("utf-8", "replace")) or "no output")
                return ("error", f"exit={rc} credit stop failed ({why}); lock NOT run "
                                 "(vault state unchanged by lock; query status; query status)")
            props, err = self.show_credit(
                ("ActiveState", "MainPID", "ControlGroup"),
                min(SYSTEMCTL_TIMEOUT_S, deadline - time.monotonic()))
            if props is None:
                if err.startswith("timeout"):
                    return ("error", f"{err}; post-stop unit state unknown; lock NOT "
                                     "run; vault state unchanged by lock; query status")
                return ("error", f"exit=1 {err}; lock NOT run (vault state unchanged by lock; query status)")
            if props["ActiveState"] not in ("inactive", "failed"):
                return ("error", f"exit=1 credit unit ActiveState={props['ActiveState']} "
                                 "after stop; lock NOT run (vault state unchanged by lock; query status; query "
                                 "status)")
            if props["MainPID"] != "0":
                return ("error", f"exit=1 credit unit MainPID={props['MainPID']} after "
                                 "stop; lock NOT run (vault state unchanged by lock; query status)")
            empty, why = self.credit_cgroup_empty(props["ControlGroup"])
            if not empty:
                return ("error", f"exit=1 {why}; lock NOT run (vault state unchanged by lock; query status; "
                                 "query status)")
            timeout = min(SCRIPT_TIMEOUT_S, deadline - time.monotonic())
            if timeout <= 0:
                return ("error", "timeout (composed budget exhausted before lock; "
                                 "vault state unchanged by lock; query status; query status separately)")
            return self.dispatch("lock", None, timeout=timeout)
        finally:
            self.compose_lock.release()

    def composed_status(self, deadline: float):
        """Existing vault status helper plus the FIXED credit unit's read-only
        state. Never mutates anything: the only supervisor verb used is
        'show'; a query failure degrades the appended credit state to
        'unknown', never the vault facts."""
        timeout = min(SCRIPT_TIMEOUT_S, deadline - time.monotonic())
        if timeout <= 0:
            return ("error", "timeout (composed budget exhausted before status; "
                             "query status separately)")
        status, detail = self.dispatch("status", None, timeout=timeout)
        props, err = self.show_credit(
            ("ActiveState",), min(SYSTEMCTL_TIMEOUT_S, deadline - time.monotonic()))
        if props is None:
            return status, f"{detail} credit=unknown ({err})"
        return status, f"{detail} credit={props['ActiveState']}"

    def handle(self, conn: socket.socket, addr):
        try:
            conn.settimeout(IDLE_TIMEOUT_S)
            if not self.peer_allowed(conn):
                # Log and refuse; no information about allowed uids is leaked.
                sys.stderr.write("vault-broker: refused connection (peer uid not allowed)\n")
                conn.sendall(b"error not-authorized\n")
                return
            data = b""
            while b"\n" not in data and len(data) <= MAX_REQUEST_BYTES:
                chunk = conn.recv(256)
                if not chunk:
                    break
                data += chunk
            if b"\n" in data:
                head, _, rest = data.partition(b"\n")
                # For unlock keep reading the second line too.
                if head.strip() == b"unlock" and b"\n" not in rest:
                    while b"\n" not in rest and len(rest) <= MAX_REQUEST_BYTES:
                        chunk = conn.recv(256)
                        if not chunk:
                            break
                        rest += chunk
                data = head + b"\n" + rest
            try:
                command, passphrase = parse_request(data)
            except ValueError as exc:
                # The reason string never contains request material.
                sys.stderr.write(f"vault-broker: refused malformed request: {exc}\n")
                conn.sendall(f"error bad-request {last_line(str(exc), 80)}\n".encode())
                return
            sys.stderr.write(f"vault-broker: command={command} dispatched\n")
            if self.credit_session:
                # Opt-in composition path. One absolute budget per transaction
                # (see COMPOSED_BUDGET_S); the default path below is the
                # unchanged old lifecycle.
                deadline = time.monotonic() + COMPOSED_BUDGET_S
                if command == "unlock":
                    status, detail = self.composed_unlock(passphrase, deadline)
                elif command == "lock":
                    status, detail = self.composed_lock(deadline)
                else:
                    status, detail = self.composed_status(deadline)
            else:
                status, detail = self.dispatch(command, passphrase)
            conn.sendall(f"{status} {detail}\n".encode())
        except OSError:
            pass
        finally:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            conn.close()

    def setup_socket(self):
        sock_dir = self.socket_dir
        # Resolve the group BEFORE creating/binding anything: a failing lookup
        # must not leave a bound-but-dead socket file behind.
        gid = None
        if os.geteuid() == 0:
            try:
                gid = grp.getgrnam(self.cfg["BROKER_GROUP"]).gr_gid
            except KeyError as exc:
                raise ConfigError(f"BROKER_GROUP not found: {self.cfg['BROKER_GROUP']}") from exc
        os.makedirs(sock_dir, mode=0o750, exist_ok=True)
        if os.path.exists(self.socket_path):
            raise ConfigError(f"socket path already exists: {self.socket_path} (refusing; remove it if stale)")
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(self.socket_path)
        os.chmod(self.socket_path, 0o660)
        if gid is not None:
            os.chown(sock_dir, 0, gid)
            os.chmod(sock_dir, 0o750)
            os.chown(self.socket_path, 0, gid)
        else:
            sys.stderr.write(
                "vault-broker: not running as root: socket ownership/group NOT enforced "
                "(tests only; the systemd unit always runs as root)\n"
            )
        server.listen(4)
        self.server = server

    def serve(self, stop=None):
        """Serve until `stop` is set. accept() is bounded by ACCEPT_POLL_S so
        a termination request is never stuck behind a blocked (or EINTR-
        restarted) accept; shutdown closes the listener and removes the socket
        path within a bounded deadline."""
        stop = stop if stop is not None else threading.Event()

        def on_signal(signum, frame):
            stop.set()

        signal.signal(signal.SIGTERM, on_signal)
        signal.signal(signal.SIGINT, on_signal)
        sys.stderr.write(f"vault-broker: listening on {self.socket_path}\n")
        sys.stderr.flush()
        self.server.settimeout(ACCEPT_POLL_S)
        while not stop.is_set():
            try:
                conn, _ = self.server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self.handle, args=(conn, None), daemon=True).start()
        deadline = time.time() + SHUTDOWN_DEADLINE_S
        while True:
            try:
                self.server.close()
                break
            except OSError:
                if time.time() >= deadline:
                    break
                time.sleep(0.05)
        while True:
            try:
                os.unlink(self.socket_path)
                break
            except OSError:
                if time.time() >= deadline:
                    break
                time.sleep(0.05)
        sys.stderr.write("vault-broker: stopped\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description="portable vault lifecycle broker")
    parser.add_argument("--config", default="/opt/portable/etc/vault.conf")
    parser.add_argument("--scripts-dir", default="/opt/portable/bin")
    parser.add_argument("--socket-override", default="",
                        help="test/staging only: absolute socket path (config schema stays /run-strict)")
    parser.add_argument("--credit-session", action="store_true",
                        help="ROOT operator opt-in: compose the fixed "
                             "portable-credit.service (fixed /usr/bin/systemctl "
                             "start/stop/show only) around unlock/lock/status; "
                             "default OFF — the broker never touches the unit "
                             "without this flag, and no request or vault.conf key "
                             "can enable it")
    parser.add_argument("--check-config", action="store_true",
                        help="validate configuration and exit (no socket, no privileges)")
    args = parser.parse_args(argv)
    try:
        cfg = parse_config(args.config)
        resolve_uids(cfg["BROKER_ALLOWED_UIDS"])
    except ConfigError as exc:
        print(f"vault-broker: config refused: {exc}", file=sys.stderr)
        return 5
    if args.check_config:
        print("vault-broker: configuration valid "
              f"(mapper={cfg['VAULT_MAPPER_NAME']} mountpoint={cfg['VAULT_MOUNTPOINT']} "
              f"allowed={cfg['BROKER_ALLOWED_UIDS']})")
        return 0
    # Production authority: the config AND the fixed script tree must sit in
    # root-owned, non-writable-by-others, symlink-free chains.
    try:
        require_trusted_file(args.config, 0o600)
        require_trusted_scripts_dir(args.scripts_dir)
    except ConfigError as exc:
        print(f"vault-broker: trust refused: {exc}", file=sys.stderr)
        return 5
    broker = Broker(cfg, args.scripts_dir, args.socket_override,
                    config_path=args.config, credit_session=args.credit_session)
    try:
        broker.setup_socket()
    except (ConfigError, OSError) as exc:
        print(f"vault-broker: setup failed: {exc}", file=sys.stderr)
        return 6
    broker.serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
