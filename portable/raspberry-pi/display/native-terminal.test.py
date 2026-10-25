#!/usr/bin/python3
"""Actual native relay tests. Run as root ONLY in private mount/PID/net namespace."""
import array
import fcntl
import os
from pathlib import Path
import select
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unittest

SOURCE = Path(__file__).resolve().parent


def as_uid(uid):
    def enter():
        os.setgroups([])
        os.setgid(uid)
        os.setuid(uid)
    return enter


class NativeTerminal(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dsmack-native-test.')
        self.root = Path(self.temp.name)
        self.root.chmod(0o755)
        self.agent = self.root/'agent'
        self.agent.mkdir(mode=0o755)
        os.chown(self.agent, 970, 970)
        self.socket = str(self.agent/'control')
        self.daemon = subprocess.Popen([sys.executable, str(SOURCE/'native-terminal-daemon.py'),
            '--socket', self.socket, '--workspace', str(self.agent), '--ui-uid', '971',
            '--max-sessions', '1'], preexec_fn=as_uid(970), cwd='/',
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        deadline = time.monotonic()+5
        while not os.path.exists(self.socket):
            self.assertIsNone(self.daemon.poll())
            self.assertLess(time.monotonic(), deadline)
            time.sleep(.02)
        self.client = None
        self.sentinel = None
        self.master = self.slave = None

    def tearDown(self):
        if self.sentinel is not None:
            self.sentinel.terminate()
            self.sentinel.wait(timeout=3)
        if self.client and self.client.poll() is None:
            self.client.terminate()
            self.client.wait(timeout=3)
        for fd in (self.master, self.slave):
            if fd is not None: os.close(fd)
        self.daemon.terminate()
        self.daemon.wait(timeout=3)
        stderr = self.daemon.stderr.read()
        self.daemon.stderr.close()
        self.assertEqual(self.daemon.returncode, 0, stderr)
        self.temp.cleanup()

    def launch(self, *extra, ready=True):
        self.master, self.slave = os.openpty()
        self.original = termios.tcgetattr(self.slave)
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack('HHHH',25,91,0,0))
        def child():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            as_uid(971)()
        self.client = subprocess.Popen([sys.executable, str(SOURCE/'native-terminal-client.py'),
            '--socket',self.socket,'--agent-uid','970',*extra], stdin=self.slave,
            stdout=self.slave, stderr=self.slave, preexec_fn=child, cwd='/')
        self.buffer = bytearray()
        if not ready: return
        self.until(b'$ ')
        self.write(b'stty -echo\n')
        self.until(b'$ ')
        self.write(b"PS1='READY> '\n")
        self.until(b'READY> ')

    def write(self, data):
        while data:
            self.assertTrue(select.select([],[self.master],[],2)[1])
            count=os.write(self.master,data)
            data=data[count:]

    def until(self, marker):
        deadline=time.monotonic()+5
        while marker not in self.buffer:
            self.assertLess(time.monotonic(),deadline,bytes(self.buffer[-1024:]))
            if select.select([self.master],[],[],.1)[0]:
                self.buffer.extend(os.read(self.master,4096))
        data=bytes(self.buffer)
        self.buffer.clear()
        return data

    def test_native_relay_resize_binary_ctrl_c_restore(self):
        self.launch()
        self.write(b'id -u; stty size; printf "TERM=%s\\n" "$TERM"\n')
        data=self.until(b'READY> ')
        self.assertIn(b'970\r\n25 91\r\nTERM=foot\r\n',data)
        fcntl.ioctl(self.master,termios.TIOCSWINSZ,struct.pack('HHHH',47,133,0,0))
        os.kill(self.client.pid,signal.SIGWINCH)
        time.sleep(.1)
        self.write(b'stty size\n')
        self.assertIn(b'47 133\r\n',self.until(b'READY> '))
        self.write(b"python3 -c 'import os; os.write(1,bytes([0,255,27,91,51,49,109,10]))'\n")
        self.assertIn(b'\0\xff\x1b[31m\r\n',self.until(b'READY> '))
        self.write(b"printf 'SLEEPING\\n'; sleep 20\n")
        self.until(b'SLEEPING\r\n')
        time.sleep(.2)  # Allow foreground sleep to take the terminal before Ctrl-C.
        self.write(b'\x03')
        self.until(b'READY> ')
        self.write(b"printf 'AFTER_INTERRUPT\\n'\n")
        self.assertIn(b'AFTER_INTERRUPT\r\n',self.until(b'READY> '))
        self.client.terminate()
        self.assertEqual(self.client.wait(timeout=3),0)
        self.assertEqual(termios.tcgetattr(self.slave),self.original)

    def test_agent_selector_reports_locked_inference(self):
        # No inference socket exists in the test namespace; byte 2 never falls back to a shell.
        self.launch('--agent', ready=False)
        self.assertIn(b'Private inference is locked.', self.until(b'~/desktop.\r\n'))
        self.assertEqual(self.client.wait(timeout=3), 0)

    def test_slow_output_and_stubborn_group_cleanup(self):
        self.launch()
        self.write(b"python3 -c 'import os; os.write(1,b\"Z\"*262144)'\n")
        time.sleep(.2)  # Stop consuming outer PTY; both relay queues remain bounded.
        data=self.until(b'READY> ')
        self.assertEqual(data.count(b'Z'),262144)
        self.write(b"trap '' TERM HUP; printf 'STUBBORN\\n'\n")
        self.assertIn(b'STUBBORN\r\n',self.until(b'READY> '))
        children_path=Path('/proc')/str(self.daemon.pid)/'task'/str(self.daemon.pid)/'children'
        children=children_path.read_text().split()
        self.assertTrue(children)
        self.client.terminate()
        self.assertEqual(self.client.wait(timeout=3),0)
        deadline=time.monotonic()+3
        while children_path.read_text().strip():
            self.assertLess(time.monotonic(),deadline)
            time.sleep(.02)
        for pid in children:
            self.assertFalse(Path('/proc',pid).exists())
        self.assertEqual(termios.tcgetattr(self.slave),self.original)

    def test_foreground_different_group_ignoring_hup_term_is_reaped(self):
        def unrelated_session():
            os.setsid()
            as_uid(970)()
        self.sentinel=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],
            preexec_fn=unrelated_session,cwd='/')
        self.launch()
        self.write(b"python3 -c 'import os,signal,time; signal.signal(signal.SIGHUP,signal.SIG_IGN); signal.signal(signal.SIGTERM,signal.SIG_IGN); print(\"FOREGROUND\",os.getpid(),os.getpgrp(),os.getsid(0),flush=True); time.sleep(60)'\n")
        data=self.until(b'FOREGROUND ')
        while b'\r\n' not in data:
            if select.select([self.master],[],[],2)[0]: data+=os.read(self.master,4096)
            else: self.fail('foreground identity missing')
        line=data.split(b'FOREGROUND ')[1].split(b'\r\n')[0]
        pid, group, session=map(int,line.split())
        self.assertEqual(pid,group)
        self.assertNotEqual(group,session)
        self.client.terminate()
        self.assertEqual(self.client.wait(timeout=3),0)
        deadline=time.monotonic()+3
        while Path('/proc',str(pid)).exists():
            # An orphan zombie can await namespace PID1; it is no longer running.
            state=Path('/proc',str(pid),'stat').read_text().split(') ')[1][0]
            if state=='Z': break
            self.assertLess(time.monotonic(),deadline)
            time.sleep(.02)
        self.assertIsNone(self.sentinel.poll(), 'unrelated same-UID session was killed')
        children=Path('/proc')/str(self.daemon.pid)/'task'/str(self.daemon.pid)/'children'
        while children.read_text().strip():
            self.assertLess(time.monotonic(),deadline)
            time.sleep(.02)
        self.assertEqual(termios.tcgetattr(self.slave),self.original)

    def test_wrong_uid_and_pending_capacity_timeout(self):
        program = r'''
import socket,sys,time
s=socket.socket(socket.AF_UNIX);s.settimeout(3);s.connect(sys.argv[1])
if sys.argv[2]=='deny':
 assert s.recv(1)==b''
else:
 t=socket.socket(socket.AF_UNIX);t.settimeout(3);t.connect(sys.argv[1]);assert t.recv(1)==b''
 assert s.recv(1)==b''
s.close()
'''
        for uid, mode in ((972,'deny'),(971,'pending')):
            result=subprocess.run([sys.executable,'-c',program,self.socket,mode],
                preexec_fn=as_uid(uid),cwd='/',capture_output=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
        self.launch()  # Pending slot was released, usable session remains.

    def test_client_rejects_nonmaster_and_multiple_descriptors(self):
        server_code = r"""
import socket,os,array,sys
s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1]);os.chmod(sys.argv[1],0o666);s.listen(1)
c,_=s.accept();assert c.recv(1)==b'1'
if sys.argv[2]=='null': fds=[os.open('/dev/null',os.O_RDONLY)]
else: fds=list(os.openpty())
c.sendmsg([b'P'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',fds))])
c.close();s.close()
for fd in fds: os.close(fd)
"""
        client_code = r"""
import runpy,sys
connect=runpy.run_path(sys.argv[1])['connect']
try: connect(sys.argv[2],970)
except (OSError,ValueError): pass
else: raise AssertionError('accepted invalid descriptors')
"""
        for mode in ('null','multiple'):
            path=str(self.agent/mode)
            server=subprocess.Popen([sys.executable,'-c',server_code,path,mode],
                preexec_fn=as_uid(970),cwd='/')
            try:
                deadline=time.monotonic()+3
                while not os.path.exists(path):
                    self.assertLess(time.monotonic(),deadline)
                    time.sleep(.01)
                result=subprocess.run([sys.executable,'-c',client_code,
                    str(SOURCE/'native-terminal-client.py'),path],preexec_fn=as_uid(971),
                    cwd='/',capture_output=True,timeout=4)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual(server.wait(timeout=3),0)
            finally:
                if server.poll() is None:
                    server.kill();server.wait()

    def test_reject_caller_fd_before_fork(self):
        program = r'''
import socket,sys,array,os
s=socket.socket(socket.AF_UNIX);s.settimeout(3);s.connect(sys.argv[1]);f=os.open('/dev/null',os.O_RDONLY)
s.sendmsg([b'1'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[f]))]);assert s.recv(1)==b''
os.close(f);s.close()
'''
        result=subprocess.run([sys.executable,'-c',program,self.socket],preexec_fn=as_uid(971),
            cwd='/',capture_output=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        self.launch()


if __name__=='__main__':
    if os.getuid()!=0 or os.environ.get('DSMACK_PRIVATE_NAMESPACE_TEST')!='1':
        raise SystemExit('requires explicit private namespace test controller')
    unittest.main()
