# SPDX-License-Identifier: MIT
import importlib.util,sys,os,json,tempfile,unittest,subprocess,io,contextlib
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import enrollment as e
import enrollment_native as n
A={'blankBytes':e.VAULT_BYTES,'manifestSha256':'a'*64,'vaultMajorMinor':'8:3','manifest':{'expectedLuksUuid':'12345678-1234-4234-8234-123456789abc'}}
class Tests(unittest.TestCase):
 def test_actual_custody_fixed_proc_swaps_reader(self):
  # Exercise the real method and actual bounded /proc read, without changing
  # this host's identity, namespaces, resource limits or dump policy.
  from types import SimpleNamespace
  raw=n.bounded('/proc/swaps',16384);has_swap=any(x.strip() for x in raw.decode('ascii').splitlines()[1:])
  with patch.object(n.os,'getuid',return_value=0),patch.object(n.os,'geteuid',return_value=0),patch.object(n.SystemIO,'namespace',return_value=(1,2)),patch.object(n.resource,'setrlimit'),patch.object(n.ctypes,'CDLL',return_value=SimpleNamespace(prctl=lambda *args:0)),patch.object(n,'bounded',wraps=n.bounded) as read:
   if has_swap:
    with self.assertRaises(e.Refused):n.Native().require_local_custody()
   else:n.Native().require_local_custody()
   read.assert_called_once_with('/proc/swaps',16384)
 def test_custody_empty_swap_positive_and_active_swap_negative(self):
  from types import SimpleNamespace
  header=b'Filename Type Size Used Priority\n'
  with patch.object(n.os,'getuid',return_value=0),patch.object(n.os,'geteuid',return_value=0),patch.object(n.SystemIO,'namespace',return_value=(1,2)),patch.object(n.resource,'setrlimit') as limits,patch.object(n.ctypes,'CDLL',return_value=SimpleNamespace(prctl=lambda *args:0)):
   with patch.object(n,'bounded',return_value=header):n.Native().require_local_custody()
   limits.assert_called_once_with(n.resource.RLIMIT_CORE,(0,0))
   with patch.object(n,'bounded',return_value=header+b'/synthetic file 1024 0 -2\n'):
    with self.assertRaises(e.Refused):n.Native().require_local_custody()

 def test_actual_bounded_executor_no_stdout_or_stderr_disclosure(self):
  native=n.Native();real=subprocess.Popen
  def spawn(argv,**kw):return real([sys.executable,'-c',"import sys;print('public-result');print('synthetic-private-error',file=sys.stderr)"],**kw)
  captured=io.StringIO()
  with patch.object(native,'require_local_custody'),patch.object(n.SystemIO,'_trusted'),patch.object(n.subprocess,'Popen',side_effect=spawn),contextlib.redirect_stdout(captured),contextlib.redirect_stderr(captured):
   self.assertEqual(native.command(['/usr/sbin/cryptsetup','--version'],()),b'public-result\n')
  self.assertEqual(captured.getvalue(),'')
 def test_actual_nonzero_refuses_generic(self):
  native=n.Native();real=subprocess.Popen
  with patch.object(native,'require_local_custody'),patch.object(n.SystemIO,'_trusted'),patch.object(n.subprocess,'Popen',side_effect=lambda argv,**kw:real([sys.executable,'-c',"import sys;print('never-disclose',file=sys.stderr);sys.exit(9)"],**kw)):
   with self.assertRaises(e.Refused) as caught:native.command(['/usr/sbin/cryptsetup','--version'],())
  self.assertNotIn('never-disclose',str(caught.exception))
 def test_header_metadata_uuid_kdf_tail_all_required(self):
  meta={'keyslots':{'0':{'kdf':{'type':'argon2id','memory':262144,'cpus':2,'time':4}}},'segments':{'0':{'type':'crypt','offset':'16777216'}}}
  with tempfile.TemporaryFile() as f:
   os.ftruncate(f.fileno(),e.VAULT_BYTES);os.pwrite(f.fileno(),e.marker(A),e.VAULT_BYTES-e.MARKER_BYTES)
   native=n.Native();calls=[]
   def command(argv,fds):
    calls.append(argv[1]);return (A['manifest']['expectedLuksUuid']+'\n').encode() if argv[1]=='luksUUID' else json.dumps(meta).encode() if argv[1]=='luksDump' else b''
   with patch.object(native,'check_fd'),patch.object(native,'command',side_effect=command):
    native.sync_and_verify_header(f.fileno(),A,e.KDF);self.assertEqual(calls,['isLuks','luksUUID','luksDump'])
    meta['keyslots']['0']['kdf']['time']=1
    with self.assertRaises(e.Refused):native.sync_and_verify_header(f.fileno(),A,e.KDF)
    meta['keyslots']['0']['kdf']['time']=4;os.pwrite(f.fileno(),bytes(e.MARKER_BYTES),e.VAULT_BYTES-e.MARKER_BYTES)
    calls.clear()
    with self.assertRaises(e.Refused):native.sync_and_verify_header(f.fileno(),A,e.KDF)
    self.assertEqual(calls,[])
 def test_actual_secret_descriptor_rewound_for_each_command(self):
  native=n.Native();real=subprocess.Popen;secret=bytearray(b'synthetic-passphrase')
  fd=native.retain_secret(secret)
  def spawn(argv,**kw):
   return real([sys.executable,'-c',f"import os;assert os.read({fd},512)=={bytes(secret)!r}"],**kw)
  try:
   with patch.object(native,'require_local_custody'),patch.object(n.SystemIO,'_trusted'),patch.object(n.subprocess,'Popen',side_effect=spawn):
    for operation in ('luksFormat','open','open'):
     native.command(['/usr/sbin/cryptsetup',operation,'--key-file',f'/proc/self/fd/{fd}','--test-passphrase'],(fd,))
  finally:os.close(fd)
 def test_record_mode_before_ownership_and_directory_last(self):
  native=n.Native();events=[];real_chmod=os.fchmod
  def chmod(fd,mode):
   events.append(('mode',os.fstat(fd).st_ino));real_chmod(fd,mode)
  with tempfile.TemporaryDirectory() as tmp:
   with patch.object(e,'MOUNT',tmp),patch.object(native,'assert_mounted'),patch.object(n.os,'fchown',side_effect=lambda fd,u,g:events.append(('owner',os.fstat(fd).st_ino))),patch.object(n.os,'fchmod',side_effect=chmod):
    native.install_record(b'synthetic-record')
    file_ino=os.stat(Path(tmp)/'credit/provider.json').st_ino
    dir_ino=os.stat(Path(tmp)/'credit').st_ino
    self.assertEqual(events,[('mode',dir_ino),('mode',file_ino),('owner',file_ino),('owner',dir_ino)])
    self.assertEqual((Path(tmp)/'credit/provider.json').read_bytes(),b'synthetic-record')
 def test_no_arbitrary_tool(self):
  native=n.Native()
  with patch.object(native,'require_local_custody'):
   with self.assertRaises(e.Refused):native.command(['/bin/sh','-c','true'],())
if __name__=='__main__':unittest.main()
