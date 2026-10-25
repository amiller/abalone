"""Temporary offline roots only. No real clock, image, service or network use."""
import importlib.util,json,os,stat,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('clock_stage',Path(__file__).resolve().parents[1]/'stage-pi-clock.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Clock(unittest.TestCase):
 def setUp(self):
  self.mask=os.umask(0o022);self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)/'root';self.root.mkdir();records={}
  for name in m.FILES:
   p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True);body=b'2026-10-06 00:14:25\n' if name==m.DATA else ('reviewed synthetic '+name+'\n').encode();p.write_bytes(body);p.chmod(0o755 if name=='usr/sbin/fake-hwclock' else 0o644);records[name]={'sha256':m.sha(body),'mode':p.stat().st_mode&0o777}
  for name,target in [(m.ENABLE,m.TARGET),(m.KEEP,'/lib/systemd/system/fake-hwclock.service'),('etc/systemd/system/dbus-org.freedesktop.timesync1.service',m.TARGET)]:
   p=self.root/name;p.parent.mkdir(parents=True,exist_ok=True);p.symlink_to(target)
  self.profile={'version':1,'files':records,'unitOverrides':{'systemd-timesyncd.service':None,'dbus-org.freedesktop.timesync1.service':m.TARGET},'baselineUtc':'2026-10-15T00:40:53Z','provenance':{'fixture':True}};self.raw=m.encode(self.profile)
 def tearDown(self):self.tmp.cleanup();os.umask(self.mask)
 def build(self):return m.build(self.root,self.profile,self.raw)
 def test_dry_plan_exact_baseline_no_write(self):
  p,inputs,updated=self.build();self.assertEqual(updated,b'2026-10-15 00:40:53\n');self.assertEqual((self.root/m.DATA).read_bytes(),inputs[m.DATA]);self.assertFalse((self.root/m.BACKUP).exists())
 def test_unknown_data_or_unit_refused(self):
  for name in (m.DATA,'usr/lib/systemd/system/systemd-timesyncd.service'):
   p=self.root/name;old=p.read_bytes();p.write_bytes(old+b'unknown')
   with self.assertRaises(ValueError):self.build()
   p.write_bytes(old)
 def test_unknown_override_or_dropin_refused(self):
  p=self.root/'etc/systemd/system/systemd-timesyncd.service';p.write_text('unknown')
  with self.assertRaises(ValueError):self.build()
  p.unlink();p=self.root/'etc/systemd/system/systemd-timesyncd.service.d/override.conf';p.parent.mkdir();p.write_text('[Service]\nExecStart=/bin/true')
  with self.assertRaises(ValueError):self.build()
 def test_fake_override_and_extra_activation_refused(self):
  p=self.root/'etc/systemd/system/fake-hwclock.service';p.write_text('unknown')
  with self.assertRaises(ValueError):self.build()
  p.unlink();p=self.root/'etc/systemd/system/another-clock.service';p.symlink_to(m.TARGET)
  with self.assertRaises(ValueError):self.build()
 def test_alias_unknown_and_data_symlink_refused(self):
  p=self.root/'etc/systemd/system/dbus-org.freedesktop.timesync1.service';p.unlink();p.symlink_to('/other')
  with self.assertRaises(ValueError):self.build()
  p.unlink();p.symlink_to(m.TARGET);p=self.root/m.DATA;p.unlink();p.symlink_to('/etc/passwd')
  with self.assertRaises(ValueError):self.build()
 def test_invalid_or_backwards_baseline_refused(self):
  for stamp in ('2026-02-30T00:00:00Z','2025-10-06T00:00:00Z'):
   self.profile['baselineUtc']=stamp
   with self.assertRaises(ValueError):self.build()
 @unittest.skipUnless(os.getuid()==0,'mapped root apply separate')
 def test_apply_077_package_preservation_and_no_replay(self):
  p,inputs,updated=self.build();os.umask(0o077);m.apply(self.root,p,inputs,updated,self.raw)
  self.assertEqual((self.root/m.DATA).read_bytes(),updated);self.assertEqual((self.root/m.DATA).stat().st_mode&0o777,0o644)
  for name,body in inputs.items():
   if name!=m.DATA:self.assertEqual((self.root/name).read_bytes(),body)
  for unit in m.UNITS:self.assertEqual(os.readlink(self.root/'etc/systemd/system'/unit),'/dev/null')
  self.assertFalse((self.root/m.ENABLE).is_symlink());self.assertEqual(os.readlink(self.root/m.KEEP),'/lib/systemd/system/fake-hwclock.service')
  with self.assertRaises(ValueError):self.build()
 @unittest.skipUnless(os.getuid()==0,'mapped root fault separate')
 def test_publication_failure_preserves_old_data_and_blocks_replay(self):
  p,inputs,updated=self.build()
  with patch.object(m.os,'replace',side_effect=OSError('fixture')):
   with self.assertRaises(OSError):m.apply(self.root,p,inputs,updated,self.raw)
  self.assertEqual((self.root/m.DATA).read_bytes(),inputs[m.DATA]);self.assertTrue((self.root/m.BACKUP/'intent.json').exists());self.assertFalse((self.root/m.BACKUP/'completed.json').exists())
  with self.assertRaises(ValueError):self.build()
if __name__=='__main__':unittest.main()
