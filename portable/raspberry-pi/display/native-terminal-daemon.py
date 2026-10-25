#!/usr/bin/python3
"""Local native PTY prototype. Dedicated agent UID, never socket activation."""
import argparse
import array
import fcntl
import importlib.util
import os
from pathlib import Path
import selectors
import select
import signal
import socket
import stat
import struct
import tempfile
import termios
import time

LOCKED = b'Private inference is locked. Super+Shift+E returns to the console: run ~/unlock, then ~/desktop.\n'


def load_home():
    spec = importlib.util.spec_from_file_location('home_command', Path(__file__).resolve().parent/'home-command.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket', required=True)
    parser.add_argument('--workspace', required=True)
    parser.add_argument('--ui-uid', required=True, type=int)
    parser.add_argument('--max-sessions', type=int, default=8)
    args = parser.parse_args()
    if os.getuid() == 0 or args.ui_uid == os.getuid() or args.ui_uid <= 0:
        parser.error('distinct nonroot agent and UI identities required')
    if not 1 <= args.max_sessions <= 32:
        parser.error('max sessions must be 1..32')
    home = load_home()
    root = os.stat(args.workspace)
    if not stat.S_ISDIR(root.st_mode) or root.st_uid != os.getuid():
        parser.error('workspace must be an existing directory owned by agent')
    stopped = False
    def stop(*_):
        nonlocal stopped
        stopped = True
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop)
    selector = selectors.DefaultSelector()
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sessions = {}
    bound = None
    def exited_fd(fd):
        poll = select.poll()
        poll.register(fd, select.POLLIN)
        return bool(poll.poll(0))

    def signal_session(item, sig):
        # Keep the shell leader unreaped, so its session ID cannot be recycled.
        # pidfds bind signals to exact processes even if numeric PIDs are reused.
        handles = item['handles']
        for pid, fd in list(handles.items()):
            if exited_fd(fd):
                os.close(fd)
                del handles[pid]
        sid = item['pid']
        if sid is None:
            return
        for name in os.listdir('/proc'):
            if not name.isdigit():
                continue
            pid = int(name)
            if pid in handles:
                continue
            fd = None
            try:
                if os.getsid(pid) != sid:
                    continue
                fd = os.pidfd_open(pid)
                if os.getsid(pid) != sid or exited_fd(fd):
                    os.close(fd)
                    continue
                handles[pid] = fd
            except ProcessLookupError:
                if fd is not None: os.close(fd)
        for fd in handles.values():
            try: signal.pidfd_send_signal(fd, sig)
            except ProcessLookupError: pass

    def cancel(item):
        if item['closing'] is not None:
            return
        item['closing'] = time.monotonic()
        signal_session(item, signal.SIGTERM)
    def remove(conn, item):
        selector.unregister(conn)
        conn.close()
        del sessions[conn]
    try:
        # Refuse existing paths; no arbitrary stale-path deletion.
        listener.bind(args.socket)
        bound = os.lstat(args.socket).st_ino
        os.chmod(args.socket, 0o666)
        listener.listen(args.max_sessions)
        listener.setblocking(False)
        selector.register(listener, selectors.EVENT_READ)
        while not stopped or sessions:
            for key, _ in selector.select(.025):
                conn = key.fileobj
                if conn is listener:
                    conn, _ = listener.accept()
                    conn.setblocking(False)
                    uid = struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]
                    if stopped or uid != args.ui_uid or len(sessions) >= args.max_sessions:
                        conn.close()
                        continue
                    sessions[conn] = {'pid': None, 'deadline': time.monotonic()+2, 'closing': None, 'handles': {}}
                    selector.register(conn, selectors.EVENT_READ)
                    continue
                item = sessions[conn]
                if item['closing'] is not None:
                    continue
                try:
                    data, ancillary, flags, _ = conn.recvmsg(2, socket.CMSG_SPACE(4*16))
                    # No caller descriptors, command, path or environment accepted.
                    for level, kind, payload in ancillary:
                        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                            descriptors = array.array('i')
                            descriptors.frombytes(payload[:len(payload)//4*4])
                            for fd in descriptors:
                                os.close(fd)
                    # Byte 1 is the fixed shell, byte 2 the fixed native Pi agent.
                    if item['pid'] or data not in (b'1', b'2') or ancillary or flags:
                        cancel(item)
                        continue
                    master, slave = os.openpty()
                    try:
                        pid = os.fork()
                        if pid == 0:
                            try:
                                for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                                    signal.signal(sig, signal.SIG_DFL)
                                os.setsid()
                                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
                                for fd in (0, 1, 2):
                                    os.dup2(slave, fd)
                                for entry in os.listdir('/proc/self/fd'):
                                    fd = int(entry)
                                    if fd > 2:
                                        try: os.close(fd)
                                        except OSError: pass
                                os.chdir(args.workspace)
                                if data == b'2':
                                    if not home.PI_SOCKET.is_socket():
                                        os.write(1, LOCKED)
                                        os._exit(1)
                                    state = Path(tempfile.mkdtemp(prefix='pi-', dir=os.path.dirname(args.socket)))
                                    os.execve('/opt/portable/bin/node', home.pi_argv(state), home.pi_env(state, 'foot'))
                                os.execve('/bin/bash', ['bash', '--noprofile', '--norc', '-i'], {
                                    'PATH': '/opt/portable/bin:/usr/bin:/bin', 'TERM': 'foot',
                                    'HOME': args.workspace, 'LC_ALL': 'C.UTF-8',
                                })
                            except BaseException as error:
                                os.write(2, ('terminal start failed: %r\r\n' % error).encode())
                            finally:
                                os._exit(127)
                        item['pid'] = pid
                        # Bind the owned leader immediately, including before child setsid.
                        item['handles'][pid] = os.pidfd_open(pid)
                        assert conn.sendmsg([b'P'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [master]))]) == 1
                    finally:
                        os.close(master)
                        os.close(slave)
                except (OSError, AssertionError):
                    cancel(item)
            now = time.monotonic()
            for conn, item in list(sessions.items()):
                pid = item['pid']
                exited = pid and os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                if stopped or exited or (not pid and now >= item['deadline']):
                    cancel(item)
                if item['closing'] is None:
                    continue
                if not pid:
                    remove(conn, item)
                elif now-item['closing'] >= .25:
                    signal_session(item, signal.SIGKILL)
                    # A later scan confirms all observed processes have exited and
                    # catches children forked during the preceding signal scan.
                    if not item['handles']:
                        os.waitpid(pid, 0)
                        remove(conn, item)
    finally:
        listener.close()
        selector.close()
        for conn, item in sessions.items():
            if item['pid']:
                signal_session(item, signal.SIGKILL)
                os.waitpid(item['pid'], 0)
                for fd in item['handles'].values(): os.close(fd)
            conn.close()
        if bound is not None:
            try:
                if os.lstat(args.socket).st_ino == bound:
                    os.unlink(args.socket)
            except FileNotFoundError:
                pass


if __name__ == '__main__':
    main()
