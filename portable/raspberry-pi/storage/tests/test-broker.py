#!/usr/bin/env python3
"""test-broker.py — offline unit tests for vault-broker.py (stdlib only).

Run inside the test namespace by run-tests.sh (needs root-owned fixture files
for the trust-acceptance cases); every case prints ok/FAIL and the script
exits nonzero on any failure. No sockets, no privileges, no host devices.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "vault_broker", os.path.join(HERE, "..", "guest", "vault-broker.py"))
vb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vb)

FAILURES = []
PASSES = []


def check(name, cond, detail=""):
    if cond:
        PASSES.append(name)
        print(f"ok   {name}")
    else:
        FAILURES.append(name)
        print(f"FAIL {name} {detail}")


def raises(name, fn, exc=ValueError, contains=""):
    try:
        fn()
    except exc as e:
        if contains and contains not in str(e):
            check(name, False, f"message lacks {contains!r}: {e}")
        else:
            check(name, True)
        return
    except Exception as e:  # noqa: BLE001
        check(name, False, f"wrong exception {type(e).__name__}: {e}")
        return
    check(name, False, "no exception raised")


def write_config(path, extra=""):
    with open(path, "w") as fh:
        fh.write("VAULT_LUKS_UUID=12345678-1234-1234-1234-123456789abc\n"
                 "BROKER_ALLOWED_UIDS=nobody\n" + extra)
    os.chmod(path, 0o600)
    return path


# --- parse_request ------------------------------------------------------------

cmd, pw = vb.parse_request(b"unlock\n74657374\n")
check("parse_request: valid unlock decodes hex", cmd == "unlock" and pw == b"test")

cmd, pw = vb.parse_request(b"lock\n")
check("parse_request: lock", cmd == "lock" and pw is None)
cmd, pw = vb.parse_request(b"status\n")
check("parse_request: status", cmd == "status" and pw is None)

raises("parse_request: unknown command refused", lambda: vb.parse_request(b"reboot\n"))
try:
    vb.parse_request(b"some-injected-command\n")
except ValueError as e:
    check("parse_request: payload NOT echoed in reason", "some-injected" not in str(e))

raises("parse_request: missing trailing newline", lambda: vb.parse_request(b"lock"))
raises("parse_request: empty passphrase", lambda: vb.parse_request(b"unlock\n\n"))
raises("parse_request: non-hex passphrase", lambda: vb.parse_request(b"unlock\nzz\n"))
raises("parse_request: oversize passphrase",
       lambda: vb.parse_request(b"unlock\n" + b"41" * 513 + b"\n"))
raises("parse_request: NUL passphrase refused", lambda: vb.parse_request(b"unlock\nab00cd\n"))
raises("parse_request: lock takes no parameters", lambda: vb.parse_request(b"lock\nextra\n"))
raises("parse_request: empty line refused", lambda: vb.parse_request(b"\nlock\n"))
raises("parse_request: non-ascii refused", lambda: vb.parse_request(b"lock\xff\n"))

# --- parse_config ---------------------------------------------------------------

# Fixtures must live in a fully trusted chain (root-owned 0755 ancestors). The
# real /tmp is world-writable, so run-tests.sh provides a private root-owned
# directory under the namespace /run via PORTABLE_TEST_TRUSTED_DIR. Without
# it (plain non-root run) only the refusal cases are meaningful.
TRUSTED_BASE = os.environ.get("PORTABLE_TEST_TRUSTED_DIR")
CAN_ACCEPT = TRUSTED_BASE is not None and os.geteuid() == 0
tmp = TRUSTED_BASE or tempfile.mkdtemp(prefix="vbtest-")
os.makedirs(tmp, exist_ok=True)
try:
    good = write_config(os.path.join(tmp, "good.conf"))
    cfg = vb.parse_config(good)
    check("parse_config: valid config", cfg["VAULT_MAPPER_NAME"] == "portable-vault")

    base = ("VAULT_LUKS_UUID=12345678-1234-1234-1234-123456789abc\n"
            "BROKER_ALLOWED_UIDS=nobody\n")

    def conf_with(body):
        p = os.path.join(tmp, "c.conf")
        with open(p, "w") as fh:
            fh.write(body)
        os.chmod(p, 0o600)
        return p

    raises("parse_config: unknown key refused", lambda: vb.parse_config(conf_with(base + "SOMETHING=1\n")), vb.ConfigError)
    raises("parse_config: duplicate key refused",
           lambda: vb.parse_config(conf_with(base + "BROKER_ALLOWED_UIDS=nobody\n")), vb.ConfigError)
    raises("parse_config: subdir duplicate refused",
           lambda: vb.parse_config(conf_with(base + "VAULT_MOUNT_SUBDIR_AGENT=credit\n")), vb.ConfigError)
    raises("parse_config: socket dir inside mountpoint refused",
           lambda: vb.parse_config(conf_with(base + "BROKER_SOCKET_DIR=/run/portable-vault\n")), vb.ConfigError)
    raises("parse_config: socket dir under mountpoint refused",
           lambda: vb.parse_config(conf_with(base + "BROKER_SOCKET_DIR=/run/portable-vault/sub\n")), vb.ConfigError)
    raises("parse_config: bad uuid refused",
           lambda: vb.parse_config(conf_with("VAULT_LUKS_UUID=NOT-A-UUID\nBROKER_ALLOWED_UIDS=nobody\n")), vb.ConfigError)
    raises("parse_config: options missing nosuid refused",
           lambda: vb.parse_config(conf_with(base + "VAULT_MOUNT_OPTIONS=nodev,noexec\n")), vb.ConfigError)
    for denied in ('portable-ui', 'portable-agent', 'portable-ui,portable-credit'):
        raises("parse_config: workspace authority refused " + denied,
               lambda denied=denied: vb.parse_config(conf_with("VAULT_LUKS_UUID=12345678-1234-1234-1234-123456789abc\nBROKER_ALLOWED_UIDS=" + denied + "\n")), vb.ConfigError)
    raises("parse_config: root in allowed uids refused",
           lambda: vb.parse_config(conf_with("VAULT_LUKS_UUID=12345678-1234-1234-1234-123456789abc\nBROKER_ALLOWED_UIDS=root\n")), vb.ConfigError)

    # Whitespace/CR handling aligned with the bash parser: NO stripping in
    # either parser; such lines are refused by BOTH.
    raises("parse_config: leading whitespace key refused",
           lambda: vb.parse_config(conf_with(" VAULT_FSTYPE=ext4\n")), vb.ConfigError)
    raises("parse_config: trailing whitespace value refused",
           lambda: vb.parse_config(conf_with("BROKER_GROUP=portable-operators \n")), vb.ConfigError)
    raises("parse_config: CR/LF line refused",
           lambda: vb.parse_config(conf_with("VAULT_MOUNT_SUBDIR_CREDIT=credit\r\n")), vb.ConfigError)

    # --- trust chain ----------------------------------------------------------
    trusted = os.path.join(tmp, "trusted")
    os.makedirs(trusted, exist_ok=True)
    os.chmod(trusted, 0o755)
    tconf = write_config(os.path.join(trusted, "vault.conf"))
    if CAN_ACCEPT:
        try:
            vb.require_trusted_file(tconf, 0o600)
            check("trust: root-owned 0600 config in trusted chain accepted", True)
        except vb.ConfigError as e:
            check("trust: root-owned 0600 config in trusted chain accepted", False, str(e))
    else:
        print("skip trust-acceptance (no trusted root available as this uid)")

    wrongmode = os.path.join(trusted, "wrong.conf")
    shutil.copy(tconf, wrongmode)
    os.chmod(wrongmode, 0o644)
    raises("trust: mode 0644 config refused", lambda: vb.require_trusted_file(wrongmode, 0o600), vb.ConfigError)

    link = os.path.join(trusted, "link.conf")
    if os.path.lexists(link):
        os.unlink(link)
    os.symlink(tconf, link)
    raises("trust: symlinked config refused", lambda: vb.require_trusted_file(link, 0o600), vb.ConfigError)

    gwd = os.path.join(tmp, "groupwritable")
    os.makedirs(gwd, exist_ok=True)
    os.chmod(gwd, 0o770)
    gwconf = write_config(os.path.join(gwd, "vault.conf"))
    raises("trust: group-writable ancestor refused", lambda: vb.require_trusted_file(gwconf, 0o600), vb.ConfigError)

    # --- scripts dir trust ------------------------------------------------------
    sdir = os.path.join(tmp, "bin")
    os.makedirs(sdir, exist_ok=True)
    for name in vb.TRUSTED_SCRIPT_FILES:
        p = os.path.join(sdir, name)
        with open(p, "w") as fh:
            fh.write("#!/bin/sh\ntrue\n")
        os.chmod(p, 0o755)
    try:
        vb.require_trusted_scripts_dir(sdir)
        check("trust: root-owned 0755 scripts dir accepted (as root)", CAN_ACCEPT)
    except vb.ConfigError:
        check("trust: root-owned 0755 scripts dir accepted (as root)", not CAN_ACCEPT)

    # common.sh is SOURCED by the dispatchable scripts: the broker must
    # validate it like the scripts themselves (a writable shared leaf is a
    # pre-source code-execution hole, not a helper-internal detail).
    common = os.path.join(sdir, "common.sh")
    os.chmod(common, 0o777)  # writable shared code
    raises("trust: world-writable common.sh refused",
           lambda: vb.require_trusted_scripts_dir(sdir), vb.ConfigError)
    os.chmod(common, 0o755)
    comlink = os.path.join(sdir, "common-link.sh")
    if os.path.lexists(comlink):
        os.unlink(comlink)
    os.symlink(common, comlink)
    os.rename(comlink, common)
    raises("trust: symlinked common.sh refused",
           lambda: vb.require_trusted_scripts_dir(sdir), vb.ConfigError)
    os.unlink(common)
    with open(common, "w") as fh:
        fh.write("#!/bin/sh\ntrue\n")
    os.chmod(common, 0o755)

    victim = os.path.join(sdir, "unlock-vault.sh")
    os.chmod(victim, 0o775)  # group-writable privileged helper
    raises("trust: group-writable helper script refused", lambda: vb.require_trusted_scripts_dir(sdir), vb.ConfigError)
    os.chmod(victim, 0o755)
    if CAN_ACCEPT:
        # NOTE: a single-entry user namespace cannot create files owned by an
        # unmapped uid, so the non-root-OWNER refusal is exercised by the
        # non-namespace run (files owned by the real unprivileged uid).
        pass
    else:
        if os.geteuid() != 0:
            raises("trust: non-root-owned helper script refused",
                   lambda: vb.require_trusted_scripts_dir(sdir), vb.ConfigError)
            raises("trust: non-root-owned common.sh refused",
                   lambda: vb.require_trusted_scripts_dir(sdir), vb.ConfigError)

    # --- dispatch: --config passed, output handling ------------------------------
    if CAN_ACCEPT:
        # needs root-owned, trusted-chain script files (namespace mode)
        argfile = os.path.join(tmp, "argv.out")
        fake = os.path.join(sdir, "unlock-vault.sh")
        with open(fake, "w") as fh:
            fh.write(f'#!/bin/sh\nprintf "%s\\n" "$@" > {argfile}\n'
                     'echo "unlocked: fake"\n')
        os.chmod(fake, 0o755)
        os.chown(fake, 0, 0)
        broker = vb.Broker(vb.parse_config(tconf), sdir, config_path=tconf)
        status, detail = broker.dispatch("unlock", b"test-pass")
        check("dispatch: ok status", status == "ok", detail)
        argv = open(argfile).read().split("\n")
        check("dispatch: --config passed to helper",
              argv[0] == "--config" and argv[1] == tconf, repr(argv))

        # error detail = LAST stderr line, not the first progress log
        with open(fake, "w") as fh:
            fh.write('#!/bin/sh\n'
                     'echo "progress: opening device" >&2\n'
                     'echo "unlock-vault.sh: refused: wrong key" >&2\n'
                     'exit 4\n')
        os.chmod(fake, 0o755)
        os.chown(fake, 0, 0)
        status, detail = broker.dispatch("unlock", None)
        check("dispatch: error detail is the LAST stderr line",
              status == "error" and "wrong key" in detail and "progress" not in detail, detail)

        # timeout kills the WHOLE process group (helper + child)
        pidfile = os.path.join(tmp, "child.pid")
        with open(fake, "w") as fh:
            fh.write('#!/bin/sh\n'
                     'sleep 30 &\n'
                     f'echo $! > {pidfile}\n'
                     'sleep 30\n')
        os.chmod(fake, 0o755)
        os.chown(fake, 0, 0)
        old_timeout = vb.SCRIPT_TIMEOUT_S
        vb.SCRIPT_TIMEOUT_S = 1
        try:
            t0 = time.time()
            status, detail = broker.dispatch("unlock", None)
            elapsed = time.time() - t0
        finally:
            vb.SCRIPT_TIMEOUT_S = old_timeout
        child = int(open(pidfile).read().strip())
        # A killed-but-not-yet-reaped child shows up as a ZOMBIE (kill(pid,0)
        # succeeds, cmdline empty). Only a POSITIVELY observed non-zombie
        # state counts as "survived"; transient stat failures keep polling
        # within the bounded deadline instead of failing the check.
        deadline = time.time() + 3
        gone = False
        alive = False
        while time.time() < deadline:
            try:
                os.kill(child, 0)
            except ProcessLookupError:
                gone = True
                break
            state = "?"
            try:
                with open(f"/proc/{child}/stat") as fh:
                    state = fh.read().rsplit(")", 1)[1].split()[0]
            except OSError:
                time.sleep(0.05)  # process is dying; re-observe before judging
                continue
            if state == "Z":
                time.sleep(0.05)  # killed; reaping in progress
                continue
            alive = True
            break
        detail_cmd = ""
        if alive:
            try:
                with open(f"/proc/{child}/cmdline", "rb") as fh:
                    detail_cmd = fh.read().replace(b"\0", b" ").decode(errors="replace")[:80]
            except OSError:
                detail_cmd = "<no cmdline>"
        check("dispatch: timeout kills and reaps the process group",
              status == "error" and "timeout" in detail and not alive and elapsed < 15,
              f"status={status} survived={alive} elapsed={elapsed:.1f} child={child} cmd={detail_cmd!r}")
        check("dispatch: timeout reply does not claim any vault state",
              "unknown/partial" in detail, detail)

        # --- bounded shutdown + socket cleanup (service-stop rehearsal) ---------
        if CAN_ACCEPT:
            sockdir = os.path.join(tmp, "sock")
            os.makedirs(sockdir, exist_ok=True)
            os.chmod(sockdir, 0o755)
            sockpath = os.path.join(sockdir, "broker.sock")
            if os.path.lexists(sockpath):
                os.unlink(sockpath)
            # BROKER_GROUP must resolve in THIS environment (the namespace has
            # the host's group database, not the deployed guest's).
            serve_conf = os.path.join(tmp, "serve.conf")
            with open(serve_conf, "w") as fh:
                fh.write("VAULT_LUKS_UUID=12345678-1234-1234-1234-123456789abc\n"
                         "BROKER_ALLOWED_UIDS=nobody\nBROKER_GROUP=root\n")
            os.chmod(serve_conf, 0o600)
            broker_py = os.path.join(HERE, "..", "guest", "vault-broker.py")
            proc = subprocess.Popen(
                [sys.executable, broker_py, "--config", serve_conf,
                 "--scripts-dir", sdir, "--socket-override", sockpath],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            # bounded wait for the listening socket (never wait forever)
            deadline = time.time() + 5
            listening = False
            while time.time() < deadline:
                if os.path.exists(sockpath):
                    listening = True
                    break
                if proc.poll() is not None:
                    break
                time.sleep(0.05)
            check("serve: broker binds its socket within a bound", listening)
            if listening:
                proc.terminate()  # SIGTERM: the stop event must unblock accept
                try:
                    _out, err = proc.communicate(timeout=10)
                    check("serve: SIGTERM stops the broker within a bound", proc.returncode == 0,
                          f"rc={proc.returncode} err={err[-200:]!r}")
                    check("serve: graceful stop message logged", b"stopped" in err)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.communicate(timeout=5)
                    check("serve: SIGTERM stops the broker within a bound", False,
                          "broker did not exit within 10s of SIGTERM")
                deadline = time.time() + 2
                while time.time() < deadline and os.path.exists(sockpath):
                    time.sleep(0.05)
                check("serve: socket path removed at shutdown", not os.path.exists(sockpath))
                # a stale socket path is never silently reused
                if os.path.lexists(sockpath):
                    os.unlink(sockpath)
                with open(sockpath, "w") as fh:
                    fh.write("stale")
                rc = subprocess.run(
                    [sys.executable, broker_py, "--config", serve_conf,
                     "--scripts-dir", sdir, "--socket-override", sockpath],
                    capture_output=True, timeout=10).returncode
                check("serve: existing socket path refused (stale never reused)", rc != 0, f"rc={rc}")
                if os.path.lexists(sockpath) and not os.path.isdir(sockpath):
                    os.unlink(sockpath)
            else:
                proc.kill()
                proc.communicate(timeout=5)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\nbroker tests: {len(PASSES)} passed, {len(FAILURES)} failed")
sys.exit(1 if FAILURES else 0)
