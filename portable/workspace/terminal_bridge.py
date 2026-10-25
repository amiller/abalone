#!/usr/bin/env python3
"""One PTY per helper; JSON lines in, raw terminal bytes out. No sandbox."""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

pid, master = pty.fork()
if pid == 0:
    os.chdir(sys.argv[1])
    os.execve('/bin/bash', ['bash', '--noprofile', '--norc', '-i'], {
        'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': sys.argv[1],
        'TERM': 'dumb', 'PS1': 'workspace $ ', 'LANG': 'C.UTF-8',
    })

# TERM enters cleanup instead of abandoning the PTY session.
signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))

fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
pending = b''
try:
    while True:
        readable, _, _ = select.select([master, sys.stdin.buffer], [], [])
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if sys.stdin.buffer in readable:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            pending += data
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                command = json.loads(line)
                data = command['input'].encode('utf-8')
                while data:
                    count = os.write(master, data)
                    data = data[count:]
finally:
    # The unreaped shell retains this session id throughout cleanup. Signal
    # only groups whose current members belong to that PTY session; never
    # the helper's inherited group or unrelated system processes.
    def session_groups():
        groups = set()
        for name in os.listdir('/proc'):
            if not name.isdigit():
                continue
            try:
                proc = int(name)
                if os.getsid(proc) == pid:
                    groups.add(os.getpgid(proc))
            except (ProcessLookupError, PermissionError):
                pass
        return groups

    def signal_groups(sig):
        for group in session_groups():
            try:
                os.killpg(group, sig)
            except ProcessLookupError:
                pass

    signal_groups(signal.SIGTERM)
    # Do not reap the session leader until after escalation: its reserved
    # PID prevents session-id reuse while discovering surviving job groups.
    time.sleep(0.25)
    signal_groups(signal.SIGKILL)
    os.close(master)
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
