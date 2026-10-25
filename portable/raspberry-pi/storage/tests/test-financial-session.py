# SPDX-License-Identifier: MIT
"""Real child/socket lifetime test; UID/drop and filesystem admission projected."""
import os,sys,socket,tempfile,subprocess,time,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import financial_lease as m
class Lease:
 nonce='test'
 def __init__(self,fd):self.record_fd=fd;self.closed=False
 def assert_current(self):pass
 def metadata(self):return {'nonce':self.nonce}
 def close(self):self.closed=True
class Tests(unittest.TestCase):
 def trial(self,deadline,delay):
  real=subprocess.Popen;children=[]
  def launch(argv,**kw):
   fd=kw['pass_fds'][0]
   code="import socket,json,time; s=socket.socket(fileno=%d); s.recv(4096); time.sleep(%s); s.sendall(b'{\"op\":\"release\",\"rid\":1,\"nonce\":\"test\"}\\n'); s.recv(4096)"%(fd,delay)
   # Only privilege/admission is projected. Real control socket, process group,
   # deadline, release handshake, kill-before-reap and lease close execute.
   kw.pop('preexec_fn');kw['pass_fds']=(fd,)
   p=real([sys.executable,'-I','-S','-c',code],**kw);children.append(p);return p
  with tempfile.TemporaryFile() as f:
   lease=Lease(f.fileno());owner=os.pidfd_open(os.getpid())
   try:
    with patch.object(m.subprocess,'Popen',side_effect=launch):result=m._supervise(lease,[],deadline,owner)
   finally:os.close(owner)
   self.assertTrue(lease.closed);self.assertIsNotNone(children[0].returncode)
   self.assertFalse(Path('/proc',str(children[0].pid)).exists())
   return result
 def test_old_two_second_session_expires_before_release(self):self.assertFalse(self.trial(2,2.4))
 def test_until_lock_survives_same_boundary_then_releases_and_reaps(self):self.assertTrue(self.trial(None,2.4))
 def test_bounded_public_api_still_rejects_none(self):
  with self.assertRaises(Exception):m.supervise(None,deadline_seconds=None)
 def test_only_near_profile_selects_until_lock(self):
  root=Path(__file__).resolve().parents[4]
  self.assertIn('supervise_until_lock(financial_lease.acquire())',(root/'portable/inference/financial-near-run.py').read_text())
  self.assertIn('RuntimeMaxSec=infinity',(root/'portable/raspberry-pi/image/profiles/direct-near/consumer.conf').read_text())
  self.assertIn('RuntimeMaxSec=330s',(root/'portable/raspberry-pi/storage/units/portable-credit.service').read_text())
if __name__=='__main__':unittest.main()
