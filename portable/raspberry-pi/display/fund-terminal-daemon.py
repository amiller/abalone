#!/usr/bin/python3
"""Root PTY running only ~/fund, for the desktop UI UID. One session at a time."""
import argparse
import array
import fcntl
import os
from pathlib import Path
import select
import signal
import socket
import struct
import termios

HOME_COMMAND = str(Path(__file__).resolve().parent/'home-command.py')


def serve(conn):
    data, ancillary, flags, _ = conn.recvmsg(2, socket.CMSG_SPACE(4*16))
    for level, kind, payload in ancillary:
        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
            descriptors = array.array('i')
            descriptors.frombytes(payload[:len(payload)//4*4])
            for fd in descriptors: os.close(fd)
    # No command, argument, path or environment accepted: byte 3 is the fixed ~/fund.
    if data != b'3' or ancillary or flags:
        return
    master, slave = os.openpty()
    pid = os.fork()
    if pid == 0:
        try:
            signal.signal(signal.SIGCHLD, signal.SIG_DFL)
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            for fd in (0, 1, 2): os.dup2(slave, fd)
            os.closerange(3, 1 << 16)
            os.chdir('/root')
            os.execve('/usr/bin/python3', ['python3', '-I', HOME_COMMAND, 'fund'],
                {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TERM': 'foot', 'HOME': '/root'})
        finally:
            os._exit(127)
    os.close(slave)
    try:
        conn.sendmsg([b'P'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [master]))])
    finally:
        os.close(master)
    # The client leaves when this connection closes; a closed window hangs up the fund session.
    pidfd = os.pidfd_open(pid)
    try:
        readable, _, _ = select.select([conn, pidfd], [], [])
        if conn in readable:
            try: os.killpg(pid, signal.SIGHUP)
            except ProcessLookupError: pass
        os.waitpid(pid, 0)
    finally:
        os.close(pidfd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket', required=True)
    parser.add_argument('--ui-uid', required=True, type=int)
    args = parser.parse_args()
    if os.getuid() != 0 or args.ui_uid <= 0:
        parser.error('root daemon and nonroot UI identity required')
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(args.socket)
    os.chmod(args.socket, 0o666)
    listener.listen(1)
    while True:
        conn, _ = listener.accept()
        with conn:
            uid = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]
            if uid != args.ui_uid:
                continue
            conn.settimeout(2)
            try: serve(conn)
            except OSError as error: print('fund session failed: %r' % error, flush=True)


if __name__ == '__main__':
    main()
