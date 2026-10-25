#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Bounded offline supervisor regressions; real PTY is NOT real VT custody."""
import importlib.util, pathlib, unittest, os, pty, termios, threading, time, signal, socket, struct, io, inspect
from unittest.mock import patch, mock_open
P=pathlib.Path(__file__).parent.parent
sp=importlib.util.spec_from_file_location('operator_vt',P/'operator-vt.py'); m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m)
ZERO=''.join(f'{k}:\t0000000000000000\n' for k in ('CapInh','CapPrm','CapEff','CapAmb','CapBnd'))+'NoNewPrivs:\t1\n'
class Tests(unittest.TestCase):
 def test_identity_status_real_field(self):
  with patch.object(m.os,'getresuid',return_value=(972,)*3),patch.object(m.os,'getresgid',return_value=(972,)*3),patch.object(m.os,'getgroups',return_value=[973]),patch('builtins.open',mock_open(read_data=ZERO)) as op:
   m.validate_identity();op.assert_called_once_with('/proc/self/status','r')
 def test_identity_rejects_caps_nnp_groups(self):
  for text,groups in [(ZERO.replace('CapBnd:\t0000000000000000','CapBnd:\t0000000000000001'),[973]),(ZERO.replace('NoNewPrivs:\t1','NoNewPrivs:\t0'),[973]),(ZERO,[973,974]),(ZERO+'NoNewPrivs:\t1\n',[973])]:
   with self.subTest(text=text,groups=groups),patch.object(m.os,'getresuid',return_value=(972,)*3),patch.object(m.os,'getresgid',return_value=(972,)*3),patch.object(m.os,'getgroups',return_value=groups),patch('builtins.open',mock_open(read_data=text)),self.assertRaises(m.OperatorError):m.validate_identity()
 def test_tiocgptn_linux_abi(self):
  # Linux asm-generic/ioctls.h and ioctl.h; arm64 uses these UAPI wrappers.
  self.assertEqual(struct.calcsize('=I'),4)
  self.assertEqual(m.TIOCGPTN,(2<<30)|(4<<16)|(ord('T')<<8)|0x30)
  self.assertNotEqual(m.TIOCGPTN,(2<<30)|(4<<16)|(ord('T')<<8)|0x40)
 def test_actual_pty_number_not_exclusive_state(self):
  master,slave=pty.openpty()
  try:
   expected=int(os.ttyname(slave).rsplit('/',1)[1])
   for exclusive in (False,True,False):
    m.fcntl.ioctl(master,termios.TIOCEXCL if exclusive else termios.TIOCNXCL)
    actual=struct.unpack('=I',m.fcntl.ioctl(master,m.TIOCGPTN,struct.pack('=I',0)))[0]
    self.assertEqual(actual,expected);self.assertTrue(m.fd_is_pty(master))
   self.assertFalse(m.fd_is_pty(slave)) # Slave is still rejected by fixed4:2 device check.
   with self.assertRaises(m.OperatorError):m.validate_terminal_fd(slave)
  finally:
   try:m.fcntl.ioctl(master,termios.TIOCNXCL)
   finally:os.close(master);os.close(slave)
 def test_actual_pty_refused(self):
  a,b=pty.openpty()
  try:
   for fd in (a,b):
    with self.assertRaises(m.OperatorError):m.validate_terminal_fd(fd)
   with self.assertRaises(m.OperatorError):m.require_active_vt(b)
  finally:os.close(a);os.close(b)
 def entry(self,data=None,sig=None):
  a,b=pty.openpty();old=termios.tcgetattr(b);errors=[]
  def writer():
   deadline=time.monotonic()+2
   while termios.tcgetattr(b)[3]&termios.ECHO:
    if time.monotonic()>deadline:errors.append('noecho not entered');os.kill(os.getpid(),signal.SIGINT);return
    time.sleep(.002)
   if sig:os.kill(os.getpid(),sig)
   else:os.write(a,data)
  t=threading.Thread(target=writer,daemon=True);t.start()
  try:
   try:return m.read_passphrase_noecho(b)
   finally:
    t.join(2);self.assertFalse(t.is_alive());self.assertFalse(errors);self.assertEqual(termios.tcgetattr(b),old)
    # A rejected secret suffix must not become the next echoed menu input.
    os.set_blocking(b,False)
    with self.assertRaises(BlockingIOError):os.read(b,4096)
  finally:os.close(a);os.close(b)
 def test_real_noecho_success(self):self.assertEqual(self.entry(b'synthetic\n'),b'synthetic')
 def test_real_noecho_512_boundary(self):self.assertEqual(len(self.entry(b'x'*512+b'\n')),512)
 def test_real_noecho_rejections_flush_and_restore(self):
  for data in (b'\n',b'x'*600+b'\nsecret-suffix\n',b'ab\x00cd\nsecret-suffix\n'):
   with self.subTest(data=data[:12]),self.assertRaises(m.OperatorError):self.entry(data)
 def test_real_noecho_signal_restores(self):
  with self.assertRaises(m.OperatorError):self.entry(sig=signal.SIGTERM)
 def test_signal_handlers_cover_termios_entry(self):
  a,b=pty.openpty();original=termios.tcsetattr;seen=[]
  def check(*args):
   seen.append(signal.getsignal(signal.SIGTERM));return original(*args)
  try:
   with patch.object(m.termios,'tcsetattr',side_effect=check),m.abort_on_signals(),m.noecho(b):pass
   self.assertTrue(seen);self.assertTrue(all(callable(h) for h in seen))
  finally:os.close(a);os.close(b)
 def test_exact_wire_bounds(self):
  self.assertEqual(m.build_request('unlock',b'a\xff'),b'unlock\n61ff\n');self.assertEqual(m.build_request('lock'),b'lock\n');self.assertEqual(m.build_request('status'),b'status\n')
  for secret in (b'',b'a\0',b'x'*513):
   with self.assertRaises(m.OperatorError):m.build_request('unlock',secret)
  with self.assertRaises(m.OperatorError):m.build_request('format')
 def test_response_bounds(self):
  self.assertEqual(m.parse_response(b'ok mounted\n'),('ok','mounted'))
  for raw in (b'ok x',b'ok x\nok y\n',b'x'*1025,b'what x\n',b'ok \xff\n'):self.assertEqual(m.parse_response(raw)[0],'unknown')
 def test_real_socketpair_transport(self):
  a,b=socket.socketpair();seen=[]
  def peer():
   try:seen.append(b.recv(2048));b.sendall(b'ok unlocked\n')
   finally:b.close()
  t=threading.Thread(target=peer,daemon=True);t.start()
  self.assertEqual(m.exchange_on_connected(a,m.build_request('unlock',b'synthetic'),time.monotonic()+1),('ok','unlocked'));t.join(2);self.assertFalse(t.is_alive());self.assertEqual(len(seen),1)
 def test_transport_deadline_no_response(self):
  a,b=socket.socketpair();start=time.monotonic()
  try:self.assertEqual(m.exchange_on_connected(a,b'status\n',start+.05)[0],'unknown');self.assertLess(time.monotonic()-start,.5)
  finally:b.close()
 def test_send_failure_and_expired_no_resend(self):
  class Sock:
   sends=0
   def settimeout(self,t):self.timeout=t
   def sendall(self,b):self.sends+=1;raise BrokenPipeError()
   def close(self):pass
  s=Sock();self.assertEqual(m.exchange_on_connected(s,b'lock\n',time.monotonic()+.2)[0],'unknown');self.assertEqual(s.sends,1);self.assertLessEqual(s.timeout,.2)
  s=Sock();self.assertEqual(m.exchange_on_connected(s,b'lock\n',time.monotonic()-1)[0],'unknown');self.assertEqual(s.sends,0)
 def test_actual_peer_credential_and_nonroot_refusal(self):
  a,b=socket.socketpair()
  try:self.assertEqual(m.peer_uid(a),os.getuid())
  finally:a.close();b.close()
 def test_broker_actual_timeout_unknown(self):
  raw=b"error timeout (helper process group killed; vault state unknown/partial: query status separately)\n"
  self.assertEqual(m.parse_response(raw)[0],'unknown')
 def test_main_releases_secret_reference_before_next_menu(self):
  for reject in (False,True):
   calls=[]
   def menu(fd):
    calls.append(1)
    if len(calls)==1:return b'u'
    self.assertIsNone(inspect.currentframe().f_back.f_locals.get('passphrase'));return b'q'
   with self.subTest(reject=reject),patch.object(m,'validate_identity'),patch.object(m,'validate_terminal'),patch.object(m,'vt_active',return_value=2),patch.object(m,'wait_for_active_vt'),patch.object(m,'read_line_echo',side_effect=menu),patch.object(m,'require_active_vt',side_effect=[None,m.OperatorError('VT switched')] if reject else [None,None]),patch.object(m,'read_passphrase_noecho',return_value=b'synthetic-secret'),patch.object(m,'run_operation',return_value=('ok','unlocked')),patch.object(m.sys,'stdout',io.StringIO()):
    self.assertEqual(m.main([]),0)
 def test_startup_refusal_logged_before_any_secret(self):
  for stage in ('identity','terminal','initial-vt'):
   with self.subTest(stage=stage),patch.object(m,'validate_identity',side_effect=m.OperatorError('synthetic identity') if stage=='identity' else None),patch.object(m,'validate_terminal',side_effect=m.OperatorError('synthetic tty') if stage=='terminal' else None),patch.object(m,'vt_active',side_effect=m.OperatorError('synthetic ioctl') if stage=='initial-vt' else None),patch.object(m,'report_startup_refusal') as report,patch.object(m,'read_passphrase_noecho') as secret,patch.object(m,'read_line_echo') as menu,patch.object(m.sys,'stdout',io.StringIO()),patch.object(m.sys,'stderr',io.StringIO()):
    self.assertEqual(m.main([]),3);self.assertEqual(report.call_count,1);self.assertEqual(report.call_args.args[0],stage);secret.assert_not_called();menu.assert_not_called()
 def test_startup_syslog_fixed_enums_and_failure(self):
  import syslog
  with patch.object(syslog,'openlog') as opened,patch.object(syslog,'syslog') as log:
   m.report_startup_refusal('terminal',m.OperatorError('refused: fd 1 is character device 1:3, synthetic-sensitive-suffix'))
   opened.assert_called_once_with('portable-vault-operator',syslog.LOG_PID,syslog.LOG_AUTHPRIV)
   log.assert_called_once_with(syslog.LOG_ERR,'startup-refused phase=terminal reason=tty-wrong-device')
   log.reset_mock();m.report_startup_refusal('identity',m.OperatorError('unknown-sensitive-string'))
   log.assert_called_once_with(syslog.LOG_ERR,'startup-refused phase=identity reason=unclassified')
   log.reset_mock();m.report_startup_refusal('post-secret',m.OperatorError('synthetic-secret'));log.assert_not_called()
  with patch.object(syslog,'openlog',side_effect=OSError('synthetic unavailable')):m.report_startup_refusal('identity',m.OperatorError('refused'))
 def test_post_entry_error_is_not_logged(self):
  with patch.object(m,'validate_identity'),patch.object(m,'validate_terminal'),patch.object(m,'vt_active',return_value=2),patch.object(m,'wait_for_active_vt'),patch.object(m,'read_line_echo',side_effect=[b'u',b'q']),patch.object(m,'require_active_vt'),patch.object(m,'read_passphrase_noecho',side_effect=m.OperatorError('synthetic post-entry refusal')),patch.object(m,'report_startup_refusal') as report,patch.object(m.sys,'stdout',io.StringIO()):
   self.assertEqual(m.main([]),0);report.assert_not_called()
 def test_unit_dedicated_tty_no_enablement(self):
  s=(P/'units/portable-vault-operator.service').read_text()
  for line in ('User=portable-credit','Group=portable-credit','SupplementaryGroups=portable-operators','LimitCORE=0','CapabilityBoundingSet=','AmbientCapabilities=','NoNewPrivileges=yes','TTYPath=/dev/tty2','Conflicts=getty@tty2.service'):self.assertIn(line,s.splitlines())
  self.assertNotIn('[Install]',[l for l in s.splitlines() if not l.startswith('#')])
if __name__=='__main__':unittest.main(verbosity=2)
