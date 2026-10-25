#!/usr/bin/python3
"""Read-only Tor bootstrap projection. No financial or Tor control access."""
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import time

UNIT = 'tor-guest.service'
DIRECTORY = '/run/portable-status'
LIMIT = 65536
PROPERTIES = ('ActiveState', 'MainPID', 'InvocationID', 'ExecMainStartTimestampMonotonic')


def bounded_run(args, timeout=1.5, limit=LIMIT):
    """Do not let journal volume or an unresponsive command grow memory/work."""
    proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})
    chunks, size = [], 0
    deadline = time.monotonic() + timeout
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ)
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError('command timeout')
            if not selector.select(remaining):
                raise ValueError('command timeout')
            chunk = os.read(proc.stdout.fileno(), min(8192, limit + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise ValueError('command output limit')
            chunks.append(chunk)
        if proc.wait(timeout=max(.001, deadline - time.monotonic())) != 0:
            raise ValueError('command failed')
        return b''.join(chunks).decode('utf-8', errors='strict')
    finally:
        selector.close()
        proc.stdout.close()
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=1)


def unit_snapshot(run):
    text = run(['/usr/bin/systemctl', 'show', UNIT, '--no-pager',
                '--property=' + ','.join(PROPERTIES)], limit=2048)
    values = {}
    for line in text.splitlines():
        key, sep, value = line.partition('=')
        if not sep or key not in PROPERTIES or key in values:
            raise ValueError('invalid unit snapshot')
        values[key] = value
    if set(values) != set(PROPERTIES):
        raise ValueError('missing unit properties')
    return values


def project(run, boot_id):
    unknown = {'state': 'unknown', 'progress': None}
    try:
        before = unit_snapshot(run)
        if before['ActiveState'] in ('inactive', 'failed', 'deactivating'):
            return {'state': 'stopped', 'progress': None}
        if before['ActiveState'] not in ('active', 'activating'):
            return unknown
        pid, invocation, started = (before[k] for k in PROPERTIES[1:])
        if not re.fullmatch(r'[1-9][0-9]{0,9}', pid) or not re.fullmatch(r'[0-9a-f]{32}', invocation):
            return unknown
        if not started.isdigit() or int(started) <= 0:
            return unknown
        raw = run(['/usr/bin/journalctl', '--boot=0', '--no-pager', '--output=json',
                   '--lines=64', '--unit=' + UNIT, '_PID=' + pid,
                   '_SYSTEMD_INVOCATION_ID=' + invocation])
        progress, latest = None, -1
        for line in raw.splitlines():
            entry = json.loads(line)
            if not isinstance(entry, dict):
                raise ValueError('invalid journal entry')
            if (entry.get('_PID') != pid or entry.get('_BOOT_ID') != boot_id.replace('-', '')
                    or entry.get('_SYSTEMD_UNIT') != UNIT
                    or entry.get('_SYSTEMD_INVOCATION_ID') != invocation):
                continue
            when = entry.get('__MONOTONIC_TIMESTAMP')
            if not isinstance(when, str) or not when.isdigit() or int(when) < int(started):
                continue
            message = entry.get('MESSAGE')
            if not isinstance(message, str):
                continue
            match = re.search(r'\bBootstrapped ([0-9]{1,3})%(?:\s|$)', message)
            if match and 0 <= int(match[1]) <= 100 and int(when) >= latest:
                progress, latest = int(match[1]), int(when)
        if unit_snapshot(run) != before:
            return unknown
        if progress is None:
            return unknown
        return {'state': 'bootstrapped' if progress == 100 else 'starting', 'progress': progress}
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        return unknown


def publish(directory, data):
    """Root-owned directory, exclusive temporary file, atomic public replacement."""
    if os.geteuid() != 0:
        raise PermissionError('root publisher required')
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    name = '.status-' + str(os.getpid())
    try:
        metadata = os.fstat(fd)
        if metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) & 0o022:
            raise PermissionError('unsafe status directory')
        payload = (json.dumps(data, separators=(',', ':')) + '\n').encode()
        if len(payload) > 1024:
            raise ValueError('projection too large')
        output = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
        try:
            if os.write(output, payload) != len(payload):
                raise OSError('short projection write')
            os.fchmod(output, 0o644)
            os.fsync(output)
        finally:
            os.close(output)
        os.replace(name, 'status.json', src_dir_fd=fd, dst_dir_fd=fd)
    finally:
        try:
            os.unlink(name, dir_fd=fd)
        except FileNotFoundError:
            pass
        os.close(fd)


def main():
    boot_id = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    # Timestamp completed collection; bootstrap is historical for this Tor invocation.
    tor = project(bounded_run, boot_id)
    publish(DIRECTORY, {'version': 1, 'boot_id': boot_id,
                       'observed_boottime': time.clock_gettime(time.CLOCK_BOOTTIME),
                       'tor': tor, 'credit': {'state': 'unknown'}})


if __name__ == '__main__':
    main()
