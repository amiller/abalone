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

pid, master = pty.fork()
if pid == 0:
    os.chdir(sys.argv[1])
    os.execve('/bin/bash', ['bash', '--noprofile', '--norc', '-i'], {
        'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': sys.argv[1],
        'TERM': 'dumb', 'PS1': 'workspace $ ', 'LANG': 'C.UTF-8',
    })

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
    try:
        foreground = os.tcgetpgrp(master)
        if foreground != pid:
            os.killpg(foreground, signal.SIGHUP)
    except (OSError, ProcessLookupError):
        pass
    os.close(master)
    try:
        os.killpg(pid, signal.SIGHUP)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
