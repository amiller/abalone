#!/usr/bin/python3
"""Run under foot as UI UID; relay a kernel-authenticated agent PTY master."""
import argparse
import array
import errno
import fcntl
import os
import select
import signal
import socket
import struct
import termios
import tty
import time

LIMIT = 65536
TIOCGPTN = 0x80045430  # Linux UAPI, supported target architectures: arm64/x86_64.


def connect(path, agent_uid, program=b'1'):
    control = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    descriptors = []
    try:
        control.settimeout(2)
        control.connect(path)
        uid = struct.unpack('3i', control.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]
        if uid != agent_uid:
            raise ValueError('unexpected terminal service UID')
        control.sendall(program)
        data, anc, flags, _ = control.recvmsg(2, socket.CMSG_SPACE(4*16), socket.MSG_CMSG_CLOEXEC)
        for level, kind, payload in anc:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                found = array.array('i')
                found.frombytes(payload[:len(payload)//4*4])
                descriptors.extend(found)
        if data != b'P' or flags & (socket.MSG_CTRUNC | socket.MSG_TRUNC) or len(anc) != 1 or len(descriptors) != 1:
            raise ValueError('invalid terminal descriptor response')
        master = descriptors[0]
        if not os.isatty(master):
            raise ValueError('descriptor is not a PTY')
        fcntl.ioctl(master, TIOCGPTN, bytes(4))  # Reject slave tty and arbitrary descriptors.
        control.setblocking(False)
        return control, descriptors.pop()
    except BaseException:
        for fd in descriptors:
            os.close(fd)
        control.close()
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--socket', required=True)
    parser.add_argument('--agent-uid', required=True, type=int)
    parser.add_argument('--agent', action='store_true', help='open the native Pi agent instead of a shell')
    parser.add_argument('--fund', action='store_true', help='open root ~/fund from fund-terminal-daemon.py')
    args = parser.parse_args()
    if args.agent_uid <= 0 or args.agent_uid == os.getuid() or os.getuid() == 0:
        parser.error('distinct nonroot agent and UI identities required')
    if not os.isatty(0) or not os.isatty(1):
        parser.error('run inside a native terminal')
    control = None
    master = None
    original = termios.tcgetattr(0)
    old_flags = {fd: fcntl.fcntl(fd, fcntl.F_GETFL) for fd in (0, 1)}
    handlers = {}
    stopped = False
    resized = True
    def stop(*_):
        nonlocal stopped
        stopped = True
    def resize(*_):
        nonlocal resized
        resized = True
    try:
        for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT, signal.SIGQUIT):
            handlers[sig] = signal.signal(sig, stop)
        handlers[signal.SIGWINCH] = signal.signal(signal.SIGWINCH, resize)
        control, master = connect(args.socket, 0, b'3') if args.fund else connect(args.socket, args.agent_uid, b'2' if args.agent else b'1')
        tty.setraw(0)
        for fd in (0, 1, master):
            os.set_blocking(fd, False)
        outgoing = bytearray()
        incoming = bytearray()
        pty_ended = False
        control_ended_at = None
        while not stopped:
            if control_ended_at is not None and time.monotonic()-control_ended_at > .5:
                break
            if resized and not pty_ended:
                fcntl.ioctl(master, termios.TIOCSWINSZ, fcntl.ioctl(0, termios.TIOCGWINSZ, bytes(8)))
                resized = False
            if pty_ended and not incoming:
                break
            reads = []
            if not pty_ended:
                if len(outgoing) < LIMIT: reads.append(0)
                if len(incoming) < LIMIT: reads.append(master)
                if control is not None: reads.append(control)
            writes = ([master] if outgoing and not pty_ended else []) + ([1] if incoming else [])
            readable, writable, _ = select.select(reads, writes, [], .1)
            # Drain PTY output even when daemon closes its control connection.
            if master in readable:
                try:
                    chunk = os.read(master, min(4096, LIMIT-len(incoming)))
                    if chunk: incoming.extend(chunk)
                    else: pty_ended = True
                except OSError as error:
                    if error.errno == errno.EIO: pty_ended = True
                    elif error.errno not in (errno.EAGAIN, errno.EWOULDBLOCK): raise
            if control is not None and control in readable:
                if control.recv(1):
                    raise ValueError('unexpected control payload')
                control.close()
                control = None
                control_ended_at = time.monotonic()
            if 0 in readable:
                chunk = os.read(0, min(4096, LIMIT-len(outgoing)))
                if not chunk: break
                outgoing.extend(chunk)
            for fd, buffer in ((master, outgoing), (1, incoming)):
                if fd in writable:
                    try:
                        count = os.write(fd, buffer)
                        del buffer[:count]
                    except BlockingIOError:
                        pass
                    except OSError as error:
                        if fd == master and error.errno == errno.EIO:
                            pty_ended = True
                            outgoing.clear()
                        else: raise
        if args.fund:
            os.set_blocking(1, True)
            os.write(1, b'\r\n~/fund has ended; nothing is watching now. Super+Shift+Q closes this window, Super+Z opens a new one.\r\n')
    finally:
        # Restore before reporting an error; SIGKILL cannot run user-space cleanup.
        try: termios.tcsetattr(0, termios.TCSANOW, original)
        except OSError: pass  # Terminal may already have disappeared on hangup.
        for fd, value in old_flags.items():
            try: fcntl.fcntl(fd, fcntl.F_SETFL, value)
            except OSError: pass
        if master is not None: os.close(master)
        if control is not None: control.close()
        for sig, handler in handlers.items(): signal.signal(sig, handler)



if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        raise SystemExit('native terminal unavailable: '+str(error))
