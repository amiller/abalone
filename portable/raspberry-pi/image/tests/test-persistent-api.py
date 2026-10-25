"""Offline fake mounts + real source staging checks. Never mount or change host policy."""
import importlib.util,os,pathlib,subprocess,tempfile,unittest,json
P=pathlib.Path;HERE=P(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('stager',HERE/'stage-persistent-api.py');stager=importlib.util.module_from_spec(spec);spec.loader.exec_module(stager)
CONFIG='CONFIG_PSTORE=y\nCONFIG_EFI=y\nCONFIG_TMPFS=y\nCONFIG_SYSFS=y\n'
CMD='root=PARTUUID=00000001-02 ro efi=noruntime pstore.backend=none\n'
class Policy(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=P(self.tmp.name);self.sys=self.root/'sys';self.sys.mkdir();self.mi=self.root/'mountinfo';self.mi.write_text(f'1 0 0:1 / {self.sys} rw,nosuid,nodev,noexec - sysfs sysfs rw\n')
  self.cmd=self.root/'cmdline';self.cmd.write_text(CMD);self.cfg=self.root/'cfg';self.cfg.write_text('KERNEL_RELEASE=fixture\nPSTORE_MODE=builtin-disabled\n')
  backend=self.sys/'module/pstore/parameters/backend';backend.parent.mkdir(parents=True);backend.write_text('none\n');(self.sys/'fs/pstore').mkdir(parents=True);(self.sys/'firmware/efi/efivars').mkdir(parents=True)
  self.bin=self.root/'bin';self.bin.mkdir();(self.bin/'uname').write_text('#!/bin/sh\necho fixture\n');(self.bin/'uname').chmod(0o755)
  mount=self.bin/'mount';mount.write_text('''#!/usr/bin/python3
import os,sys
p=os.environ['PPA_MOUNTINFO'];target=sys.argv[-1]
assert sys.argv[1:5]==['-t','tmpfs','-o','ro,nosuid,nodev,noexec,size=4k,mode=000']
with open(p,'a') as f:f.write('9 1 0:9 / '+target+' ro,nosuid,nodev,noexec - tmpfs portable-persistent-api ro,size=4k\\n')
''');mount.chmod(0o755)
  self.env={**os.environ,'PATH':str(self.bin)+':/usr/bin:/bin','PPA_SYS':str(self.sys),'PPA_MOUNTINFO':str(self.mi),'PPA_CMDLINE':str(self.cmd),'PPA_CONFIG':str(self.cfg)}
 def run_guard(self,mode='establish'):return subprocess.run(['dash',str(HERE/'lib/portable-persistent-api'),mode],env=self.env,text=True,capture_output=True,timeout=3)
 def test_initial_ro_barriers_and_check(self):
  self.assertEqual(self.run_guard().returncode,0);before=self.mi.read_text();self.assertEqual(self.run_guard('check').returncode,0);self.assertEqual(self.mi.read_text(),before)
 def test_non_efi_builtin_and_no_pstore_kernel(self):
  (self.sys/'firmware/efi/efivars').rmdir();self.assertEqual(self.run_guard().returncode,0)
  # New absent-kernel fixture has no registered pstore module or API directory.
  self.mi.write_text(f'1 0 0:1 / {self.sys} rw - sysfs sysfs rw\n')
  import shutil
  shutil.rmtree(self.sys/'module/pstore');(self.sys/'fs/pstore').rmdir();self.cfg.write_text('KERNEL_RELEASE=fixture\nPSTORE_MODE=absent\n');self.assertEqual(self.run_guard().returncode,0)
 def test_no_late_repair_or_backend_acceptance(self):
  self.assertNotEqual(self.run_guard('check').returncode,0)
  (self.sys/'module/pstore/parameters/backend').write_text('efi\n');self.assertNotEqual(self.run_guard().returncode,0)
 def test_preexisting_real_fs_refused_even_ro(self):
  for kind in ('pstore','efivarfs'):
   for options in ('rw','ro'):
    old=self.mi.read_text();self.mi.write_text(old+f'8 1 0:8 / /elsewhere {options} - {kind} {kind} {options}\n')
    self.assertNotEqual(self.run_guard().returncode,0);self.mi.write_text(old)
 def test_writable_stacked_or_hidden_mount_refused(self):
  self.assertEqual(self.run_guard().returncode,0);valid=self.mi.read_text()
  for invalid in [valid.replace('ro,nosuid','rw,nosuid',1),valid+valid.splitlines()[-1]+'\n',valid+f'22 1 0:22 / {self.sys}/firmware rw - tmpfs fake rw\n']:
   self.mi.write_text(invalid);self.assertNotEqual(self.run_guard('check').returncode,0)
 def test_missing_duplicate_and_conflicting_cmdline(self):
  for bad in [CMD.replace('efi=noruntime',''),CMD+'efi=noruntime',CMD+'efi=runtime',CMD+'efi=noruntime,runtime',CMD+'pstore.backend=ramoops',CMD+'pstore.backend=none',CMD+'--']:
   self.cmd.write_text(bad);self.assertNotEqual(self.run_guard().returncode,0)
 def test_kernel_release_and_mode_mismatch(self):
  self.cfg.write_text('KERNEL_RELEASE=other\nPSTORE_MODE=builtin-disabled\n');self.assertNotEqual(self.run_guard().returncode,0)
  self.cfg.write_text('KERNEL_RELEASE=fixture\nPSTORE_MODE=absent\n');self.assertNotEqual(self.run_guard().returncode,0)
 def test_unknown_mountinfo_refused(self):
  self.mi.write_text('malformed\n');self.assertNotEqual(self.run_guard().returncode,0)
 def test_offline_plan_and_loadable_pstore_refusal(self):
  files,links,evidence=stager.plan(self.root,'fixture',CONFIG,CMD);self.assertEqual(evidence['pstoreMode'],'builtin-disabled');self.assertEqual(links['etc/systemd/system/systemd-pstore.service'],'/dev/null');self.assertIn('etc/systemd/system/sysinit.target.requires/portable-persistent-api.service',links)
  with self.assertRaises(stager.Refusal):stager.plan(self.root,'fixture',CONFIG.replace('CONFIG_PSTORE=y','CONFIG_PSTORE=m'),CMD)
  with self.assertRaises(stager.Refusal):stager.plan(self.root,'fixture',CONFIG.replace('CONFIG_PSTORE=y',''),CMD)
 def test_stager_conflicting_dropin_link_hardlink_and_alias_refusal(self):
  drop=self.root/'etc/systemd/system/systemd-pstore.service.d';drop.mkdir(parents=True)
  with self.assertRaises(stager.Refusal):stager.plan(self.root,'fixture',CONFIG,CMD)
  drop.rmdir();out=self.root/'etc/portable-persistent-api.conf';out.symlink_to(self.cfg)
  with self.assertRaises(stager.Refusal):stager.plan(self.root,'fixture',CONFIG,CMD)
  out.unlink();os.link(self.cfg,out)
  with self.assertRaises(stager.Refusal):stager.plan(self.root,'fixture',CONFIG,CMD)
  with self.assertRaises(stager.Refusal):stager.plan(self.root/'..','fixture',CONFIG,CMD)
 def test_actual_offline_apply_with_restrictive_umask_and_idempotence(self):
  import shutil
  if not shutil.which('unshare'):self.skipTest('user namespace unavailable')
  config=self.root/'kernel-config';config.write_text(CONFIG)
  target=self.root/'offline';target.mkdir()
  args=['python3',str(HERE/'stage-persistent-api.py'),'--sysroot',str(target),'--kernel-release','fixture','--kernel-config',str(config),'--cmdline-file',str(self.cmd),'--apply','--confirm','PERSISTENT-API-IMAGE']
  probe=subprocess.run(['unshare','-Ur','true'],capture_output=True)
  if probe.returncode:self.skipTest('mapped root namespace unavailable')
  for iteration in range(2):
   result=subprocess.run(['unshare','-Ur','sh','-c','umask 077; exec "$@"','sh',*args],text=True,capture_output=True,timeout=5)
   self.assertEqual(result.returncode,0,result.stderr)
  self.assertEqual((target/'usr/lib/portable-persistent-api').stat().st_mode&0o777,0o755)
  self.assertEqual((target/'etc/portable-persistent-api.conf').stat().st_mode&0o777,0o644)
  self.assertEqual(os.readlink(target/'etc/systemd/system/systemd-pstore.service'),'/dev/null')
if __name__=='__main__':unittest.main(verbosity=2)
