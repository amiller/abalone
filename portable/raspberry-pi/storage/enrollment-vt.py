#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Trusted local first-use setup on tty3; no device or credential CLI options.

This root console is separate from the unprivileged tty2 unlock operator. It
never accepts a browser/agent request. Image installation and native-adapter
qualification are separate from these source-level console checks.
"""
import importlib.util
import os
from pathlib import Path
import resource
import stat
import sys

HERE = Path(__file__).resolve().parent

def sibling(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

def trusted_sources():
    for name in ('enrollment-vt.py', 'operator-vt.py', 'enrollment.py', 'enrollment_native.py'):
        path = HERE / name
        for parent in (path.parent, *path.parent.parents):
            s = parent.lstat()
            if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
                raise ValueError('source trust')
        s = path.lstat()
        if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_nlink != 1 or stat.S_IMODE(s.st_mode) != 0o644:
            raise ValueError('source trust')

def root_custody():
    if os.getresuid() != (0,0,0) or os.getresgid() != (0,0,0):
        raise ValueError('identity')
    rows = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
    # Mount/device-mapper, ownership and private-record readback. As in the
    # financial lease unit, PID1 namespace comparison needs CAP_SYS_PTRACE.
    allowed = (1 << 21) | (1 << 19) | (1 << 2) | 1
    if rows.get('NoNewPrivs', '').strip() != '1':
        raise ValueError('privilege profile')
    if any(int(rows.get(name, '-1').strip(),16) & ~allowed for name in ('CapEff','CapPrm','CapBnd')):
        raise ValueError('capability profile')
    if any(int(rows.get(name, '-1').strip(),16) != 0 for name in ('CapInh','CapAmb')):
        raise ValueError('capability profile')
    if resource.getrlimit(resource.RLIMIT_CORE) != (0,0):
        raise ValueError('core policy')

def tty_helpers():
    op = sibling('portable_setup_terminal', 'operator-vt.py')
    op.TTY_MINOR = 3
    op.EXPECTED_VT = 3
    return op

def collect(op, out, fd=0, provider='zai'):
    """No secret is read before deliberate first-use confirmation on tty3."""
    op.wait_for_active_vt(fd, expected=3)
    out.write('\nDsmack storage setup\n'
              'Choose a passphrase to keep your API key encrypted on this USB.\n'
              'Keep the passphrase: it is required after every restart.\n'
              'Existing or interrupted storage will never be formatted here.\n'
              'Ctrl+Alt+F1: desktop. Ctrl+Alt+F2: unlock existing storage.\n'
              'Type CREATE to initialize unused storage, or press Enter to leave: ')
    out.flush()
    if op.read_line_echo(fd) != b'CREATE':
        return None
    secrets = []
    try:
        for prompt in ('New passphrase (at least 8 bytes): ', 'Confirm passphrase: ', ('NEAR API key: ' if provider == 'near' else 'Zai API key: ')):
            op.require_active_vt(fd, expected=3)
            out.write(prompt); out.flush()
            value = bytearray(op.read_passphrase_noecho(fd))
            secrets.append(value)
            out.write('\n'); out.flush()
            op.require_active_vt(fd, expected=3)
            if len(secrets) == 1 and not (8 <= len(value) <= 512):
                raise ValueError('passphrase length')
            if len(secrets) == 2 and secrets[0] != value:
                raise ValueError('passphrase mismatch')
        return secrets
    except BaseException:
        for value in secrets:
            value[:] = bytes(len(value))
        raise

def setup(op, native, transaction, out, provider='zai'):
    values = None
    try:
        values = collect(op, out, provider=provider)
        if values is None:
            out.write('\nSetup left unchanged. Use Ctrl+Alt+F1 to return.\n')
            return 0
        op.require_active_vt(0, expected=3)
        result = transaction(native, *values)
        if result.get('state') != 'enrolled-locked':
            raise ValueError('unexpected result')
        out.write('\nStorage is ready and locked.\n'
                  'Press Ctrl+Alt+F2 and unlock with your new passphrase.\n')
        return 0
    except Exception:
        out.write('\nSetup did not complete. Existing or interrupted storage was not reset.\n'
                  'Do not repeat setup to repair storage. Use the unlock console or inspect the USB.\n')
        return 1
    finally:
        if values:
            for value in values:
                value[:] = bytes(len(value))
        out.flush()
        # This clears owned mutable buffers only. Python/library/kernel copies
        # are not securely zeroized; no whole-process amnesia claim is made.

def main():
    if sys.argv[1:] not in ([], ['--profile', 'near']):
        return 2
    try:
        trusted_sources()
        root_custody()
        # -I excludes the script directory; this fixed, validated root-owned
        # directory supplies the native adapter's sibling imports.
        sys.path.insert(0, str(HERE))
        op = tty_helpers()
        op.validate_terminal()
        transaction = sibling('portable_local_enrollment', 'enrollment.py')
        adapter = sibling('portable_local_enrollment_native', 'enrollment_native.py')
        native = adapter.Native()
        native.require_local_custody()  # no swap/dumps BEFORE any console secret
        provider = 'near' if sys.argv[1:] else 'zai'
        return setup(op, native, lambda *args: transaction.enroll(*args, provider=provider), sys.stdout, provider=provider)
    except Exception:
        sys.stderr.write('Dsmack setup unavailable on this console.\n')
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
