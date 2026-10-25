#!/usr/bin/python3
"""Unprivileged plain-text consumer; no financial authority or external IO."""
import json
import math
import os
from pathlib import Path
import stat
import time

DIRECTORY = '/run/portable-status'
SHORTCUTS = 'Super+Enter terminal | Super+B browser'


def render(data, boot_id, now):
    label = 'Tor unknown'
    try:
        if data['version'] != 1 or data['boot_id'] != boot_id:
            raise ValueError('old boot')
        observed = data['observed_boottime']
        if isinstance(observed, bool) or not isinstance(observed, (int, float)) or not math.isfinite(observed) or not 0 <= now - observed <= 15:
            raise ValueError('stale observation')
        tor = data['tor']
        if tor['state'] == 'stopped' and tor['progress'] is None:
            label = 'Tor stopped'
        elif type(tor['progress']) is int and 0 <= tor['progress'] <= 100:
            if (tor['state'] == 'bootstrapped' and tor['progress'] == 100) or (tor['state'] == 'starting' and tor['progress'] < 100):
                label = 'Tor bootstrap ' + str(tor['progress']) + '%'
    except (KeyError, ValueError, TypeError):
        pass
    # No balance or funding address is accepted by this projection contract.
    return label + ' | Credit unknown | ' + SHORTCUTS


def read_public(directory):
    parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        st = os.fstat(parent)
        if st.st_uid != 0 or stat.S_IMODE(st.st_mode) & 0o022:
            raise ValueError('untrusted directory')
        fd = os.open('status.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or stat.S_IMODE(st.st_mode) & 0o022 or st.st_size > 1024:
                raise ValueError('untrusted projection')
            data = os.read(fd, 1025)
            if len(data) > 1024:
                raise ValueError('projection too large')
            return json.loads(data)
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def main():
    while True:
        try:
            data = read_public(DIRECTORY)
            boot_id = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
            text = render(data, boot_id, time.clock_gettime(time.CLOCK_BOOTTIME))
        except (OSError, ValueError, TypeError):
            text = render({}, '', 0)
        print(text, flush=True)
        time.sleep(2)


if __name__ == '__main__':
    main()
