#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""One boot-time, Tor-only provider Date correction; not a financial time oracle."""
import datetime as dt
import email.utils
import itertools
import os
import re
import resource
import subprocess
import tempfile
import time

URL = 'https://cloud-api.near.ai'
MAX_FORWARD = 366 * 86400


def parse_headers(raw):
    if len(raw) > 8192:
        raise ValueError('headers-bound')
    text = raw.decode('ascii', 'strict')
    lines = text.splitlines()
    if not lines or not re.fullmatch(r'HTTP/(?:1\.[01]|2|3) (?:200|404)(?: .*)?', lines[0]):
        raise ValueError('http-status')
    dates = [line[5:].strip() for line in lines[1:] if line.lower().startswith('date:')]
    if len(dates) != 1 or not re.fullmatch(r'[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT', dates[0]):
        raise ValueError('date-header')
    date = email.utils.parsedate_to_datetime(dates[0])
    if email.utils.format_datetime(date, usegmt=True) != dates[0]:
        raise ValueError('date-canonical')
    return date.timestamp()


def correction(remote, local):
    delta = remote - local
    if delta < -5 or delta > MAX_FORWARD:
        raise ValueError('clock-range')
    return remote if delta > 0 else None


def fetch(attempt):
    # Regular bounded output files avoid unbounded pipe capture; they are RAM-only.
    def limit():
        resource.setrlimit(resource.RLIMIT_FSIZE, (8192, 8192))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    with tempfile.TemporaryFile(dir='/run') as headers, tempfile.TemporaryFile(dir='/run') as errors:
        done = subprocess.run(['/usr/bin/curl', '--disable', '--silent', '--show-error', '--head',
                               '--proto', '=https', '--proxy', 'socks5h://127.0.0.1:9050',
                               '--proxy-user', f'tor-date-{os.getpid()}-{attempt}:x',
                               '--connect-timeout', '10', '--max-time', '15', URL],
                              env={'PATH': '/usr/bin:/bin'}, stdout=headers,
                              stderr=errors, timeout=17, preexec_fn=limit)
        if done.returncode:
            errors.seek(0)
            raise ValueError(errors.read(200).decode('ascii', 'replace').strip() or f'curl exit {done.returncode}')
        headers.seek(0)
        return parse_headers(headers.read(8193))


def main():
    if os.geteuid() != 0:
        raise ValueError('root-required')
    # fake-hwclock supplies the maintenance UTC floor before Tor/TLS starts.
    deadline = time.monotonic() + 180
    for attempt in itertools.count(1):
        try:
            remote = fetch(attempt)
            target = correction(remote, time.time())
            if target is not None:
                time.clock_settime(time.CLOCK_REALTIME, target)
                if abs(time.time() - target) > 2:
                    raise ValueError('readback')
            print('tor-date: provider-date-applied' if target is not None else 'tor-date: already-current', flush=True)
            return
        except (subprocess.SubprocessError, OSError, ValueError, UnicodeError) as error:
            print(f'tor-date: attempt {attempt} failed: {type(error).__name__}: {error}'[:300], flush=True)
            if time.monotonic() + 20 >= deadline:
                raise RuntimeError('tor-date: unavailable') from None
            time.sleep(2)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('tor-date: unavailable', flush=True)
        raise SystemExit(1)
