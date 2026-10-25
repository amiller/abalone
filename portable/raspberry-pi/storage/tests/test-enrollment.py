# SPDX-License-Identifier: MIT
import contextlib,importlib.util,sys,unittest,os,stat,tempfile,types
from unittest.mock import patch
from pathlib import Path
spec=importlib.util.spec_from_file_location('enrollment',Path(__file__).resolve().parents[1]/'enrollment.py');e=importlib.util.module_from_spec(spec);spec.loader.exec_module(e)
ADMISSION={'blankBytes':e.VAULT_BYTES,'manifestSha256':'a'*64,'vaultMajorMinor':'8:3','manifest':{'expectedLuksUuid':'12345678-1234-4234-8234-123456789abc'}}
class IO:
 def __init__(self,fail=None):self.events=[];self.fail=fail;self.nonblank=False;self.argv=[]
 def step(self,name):
  self.events.append(name)
  if self.fail==name:raise OSError('private-error-must-not-escape')
 @contextlib.contextmanager
 def lifecycle(self):
  self.step('lock')
  try:yield
  finally:self.events.append('release-after-cleanup')
 def require_local_custody(self):self.step('custody')
 def admit_blank(self):
  self.step('blank')
  if self.nonblank:raise e.Refused('Enrollment refused')
  return ADMISSION
 def admit_format_write_bound(self):self.step('tool-bound')
 def retain_target(self,a):self.step('target');return 7
 def retain_secret(self,key):self.step('secret');return 8
 def revalidate(self,a,fd):self.step('revalidate')
 def persist_intent(self,fd,a):self.nonblank=True;self.step('intent-fsync-readback')
 def command(self,argv,fds):
  self.argv.append((argv,fds))
  phase='format' if 'luksFormat' in argv else 'test-key' if '--test-passphrase' in argv else 'filesystem' if argv[0].endswith('mke2fs') else 'open'
  self.step(phase)
 def sync_and_verify_header(self,*args):self.step('header-fsync-uuid-kdf-readback')
 def verify_mapper(self,a):self.step('mapper')
 def mount_verified(self,a):self.step('mount')
 def install_record(self,raw):self.step('record-fsync')
 def verify_record(self,raw):self.step('record-readback')
 def unmount_verified(self,a):self.step('unmount')
 def close_verified(self,a):self.step('close')
class Tests(unittest.TestCase):
 def invoke(self,io):return e.enroll(io,bytearray(b'human passphrase'),bytearray(b'human passphrase'),bytearray(b'synthetic-api-key'))
 def test_near_is_explicit_and_bad_profile_never_formats(self):
  import json
  io=IO(); records=[];io.install_record=lambda raw:records.append(json.loads(raw))
  result=e.enroll(io,bytearray(b'human passphrase'),bytearray(b'human passphrase'),bytearray(b'synthetic-api-key'),provider='near')
  self.assertEqual(records[0]['provider'],'near');self.assertEqual(records[0]['model'],'z-ai/glm-5.3-flash')
  bad=IO()
  with self.assertRaises(e.Refused):e.enroll(bad,bytearray(b'human passphrase'),bytearray(b'human passphrase'),bytearray(b'synthetic-api-key'),provider='arbitrary')
  self.assertEqual(bad.argv,[])
 def test_eight_byte_practice_passphrase_and_seven_refusal(self):
  io=IO()
  self.assertEqual(e.enroll(io,bytearray(b'practice'),bytearray(b'practice'),bytearray(b'synthetic-key'))['state'],'enrolled-locked')
  for value in (b'1234567',b'x'*513,b'1234567\0'):
   refused=IO()
   with self.assertRaises(e.Refused):e.enroll(refused,bytearray(value),bytearray(value),bytearray(b'synthetic-key'))
   self.assertEqual(refused.events,[])
 def test_success_order_and_no_secret_argv(self):
  io=IO();self.assertEqual(self.invoke(io)['state'],'enrolled-locked')
  names=io.events
  for a,b in [('intent-fsync-readback','format'),('format','header-fsync-uuid-kdf-readback'),('header-fsync-uuid-kdf-readback','test-key'),('test-key','filesystem'),('record-readback','unmount'),('close','release-after-cleanup')]:self.assertLess(names.index(a),names.index(b))
  argv=io.argv[0][0];self.assertIn('argon2id',argv);self.assertNotIn('pbkdf2',argv);self.assertIn('262144',argv);self.assertIn('32768',argv)
  self.assertNotIn('human passphrase',str(io.argv));self.assertNotIn('synthetic-api-key',str(io.argv))
 def test_all_postintent_failures_are_partial_and_never_reformat(self):
  for phase in ['intent-fsync-readback','format','header-fsync-uuid-kdf-readback','test-key','open','mapper','filesystem','mount','record-fsync','record-readback','unmount','close']:
   io=IO(phase)
   with self.assertRaises(e.Partial) as caught:self.invoke(io)
   self.assertNotIn('private-error',str(caught.exception));self.assertTrue(io.nonblank)
   formats=sum('luksFormat' in argv for argv,_ in io.argv)
   io.fail=None
   with self.assertRaises(e.Refused):self.invoke(io)
   self.assertEqual(sum('luksFormat' in argv for argv,_ in io.argv),formats)
 def test_preflight_failure_does_not_write(self):
  for phase in ['custody','blank','tool-bound','target','secret','revalidate']:
   io=IO(phase)
   with self.assertRaises(e.Refused):self.invoke(io)
   self.assertFalse(io.nonblank);self.assertEqual(io.argv,[])
 def test_bad_confirmation_key_and_passphrase_before_lock(self):
  for key,confirm,api in [(b'short',b'short',b'ok'),(b'long passphrase',b'wrong',b'ok'),(b'long\0passphrase',b'long\0passphrase',b'ok'),(b'long passphrase',b'long passphrase',b'bad\nkey')]:
   io=IO()
   with self.assertRaises(e.Refused):e.enroll(io,bytearray(key),bytearray(confirm),bytearray(api))
   self.assertEqual(io.events,[])
 def test_real_sparse_file_tail_intent_and_no_clear(self):
  # Actual pwrite/fsync/readback on disposable sparse regular file; only the
  # block fstat metadata is projected, never a real device or ioctl.
  with tempfile.TemporaryFile() as f:
   os.ftruncate(f.fileno(),e.VAULT_BYTES)
   block=types.SimpleNamespace(st_mode=stat.S_IFBLK|0o600,st_rdev=os.makedev(8,3))
   with patch.object(e.os,'fstat',return_value=block):
    e.write_tail_intent(f.fileno(),ADMISSION)
    self.assertEqual(os.pread(f.fileno(),4096,e.VAULT_BYTES-4096),e.marker(ADMISSION))
    self.assertEqual(os.pread(f.fileno(),4096,0),bytes(4096))
    with self.assertRaises(e.Refused):e.write_tail_intent(f.fileno(),ADMISSION)
 def test_marker_public_bound_no_secret(self):
  raw=e.marker(ADMISSION);self.assertEqual(len(raw),4096);self.assertNotEqual(raw,bytes(4096));self.assertNotIn(b'apiKey',raw)

class AccountRecordTests(unittest.TestCase):
 def test_optional_near_account_exact_schema(self):
  import json
  account={'organizationId':'12345678-1234-4234-8234-123456789abc','accessToken':'SYNTHETIC_ACCOUNT_TOKEN'}
  p=bytearray(b'public-passphrase')
  self.assertNotIn('account',json.loads(e.credentials(p,p,bytearray(b'API_KEY'),'near')))
  self.assertEqual(json.loads(e.credentials(p,p,bytearray(b'API_KEY'),'near',account))['account'],account)
  for bad in [dict(account,refreshToken='NO'),dict(account,organizationId='wrong'),dict(account,accessToken='bad\nheader'),dict(account,accessToken='x'*8193)]:
   with self.assertRaises(e.Refused):e.credentials(p,p,bytearray(b'API_KEY'),'near',bad)
  with self.assertRaises(e.Refused):e.credentials(p,p,bytearray(b'API_KEY'),'zai',account)

if __name__=='__main__':unittest.main()
