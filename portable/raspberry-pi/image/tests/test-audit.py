#!/usr/bin/env python3
"""Synthetic archive trees only; no archive generation, mounts or execution."""
import hashlib,json,pathlib,subprocess,tempfile,unittest
AUDIT=pathlib.Path(__file__).resolve().parents[1]/'audit-initramfs.py'
class Audit(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(); self.root=pathlib.Path(self.tmp.name); self.addCleanup(self.tmp.cleanup)
  files={'init':'run_scripts /scripts/init-top\nmountroot\nrun_scripts /scripts/init-bottom\nmount -n -o move /sys ${rootmnt}/sys\nmount -n -o move /run ${rootmnt}/run\nexec run-init ',
   'scripts/functions':'. "${initdir}/ORDER"\nif [ "${fastboot?}" = "y" ]; then return; fi',
   'scripts/local':'mount ${roflag} ${ROOTFLAGS}', 'scripts/nfs':'reviewed nfs', 'conf/initramfs.conf':'BOOT=local', 'conf/arch.conf':'DPKG_ARCH=arm64', 'etc/portable-volatile-root.conf':'fixture','etc/portable-persistent-api.conf':'fixture','lib/portable-persistent-api':'fixture'}
  for phase,names in {'init-top':['00-portable-persistent-api','00-portable-volatile-guard','udev'],'init-bottom':['portable-volatile-root','udev','zz-portable-persistent-api'],'local-premount':['firstboot','resume'],'local-bottom':['firstboot_fstrim','imager_fixup']}.items():
   files['scripts/'+phase+'/ORDER']=''.join('/scripts/'+phase+'/'+name+' "$@"\n[ -e /conf/param.conf ] && . /conf/param.conf\n' for name in names)
   for name in names: files['scripts/'+phase+'/'+name]='#!/bin/sh\n# reviewed fixture\n'
  for name,text in files.items():
   p=self.root/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(text)
   if text.startswith('#!/bin/sh') or name=='lib/portable-persistent-api':p.chmod(0o755)
  for applet in ('mount','awk','cat','wc','uname','sleep','poweroff','halt','mktemp','chmod','mv'):
   target=self.root/'bin'/applet;target.parent.mkdir(exist_ok=True);target.write_text('#!/bin/sh\nexit 0\n');target.chmod(0o755)
  self.manifest=self.root/'review.json'; self.approve()
 def approve(self):
  self.manifest.write_text(json.dumps({str(p.relative_to(self.root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob('*') if p.is_file() and p!=self.manifest}))
 def run_audit(self,extra=()): return subprocess.run(['python3',str(AUDIT),str(self.root),'--reviewed-sha256',str(self.manifest),*extra],capture_output=True,text=True)
 def test_positive(self): self.assertEqual(self.run_audit().returncode,0)
 def test_missing_reload(self):
  p=self.root/'scripts/init-top/ORDER';p.write_text(p.read_text().replace('[ -e /conf/param.conf ] && . /conf/param.conf\n','',1));self.assertNotEqual(self.run_audit().returncode,0)
 def test_guard_not_first(self):
  p=self.root/'scripts/init-top/ORDER';lines=p.read_text().splitlines(True);p.write_text(''.join(lines[2:]+lines[:2]));self.assertNotEqual(self.run_audit().returncode,0)
 def test_overlay_after_udev(self):
  p=self.root/'scripts/init-bottom/ORDER';lines=p.read_text().splitlines(True);p.write_text(''.join(lines[2:]+lines[:2]));self.assertNotEqual(self.run_audit().returncode,0)
 def test_changed_vendor(self):
  (self.root/'scripts/local-premount/firstboot').write_text('unreviewed');self.assertNotEqual(self.run_audit().returncode,0)
 def test_unknown_network_script(self):
  p=self.root/'scripts/init-top/ORDER';p.write_text(p.read_text()+'/scripts/init-top/network "$@"\n[ -e /conf/param.conf ] && . /conf/param.conf\n');(p.parent/'network').write_text('network');self.assertNotEqual(self.run_audit().returncode,0)
 def test_unordered_executable(self):
  p=self.root/'scripts/init-top/unlisted';p.write_text('bad');p.chmod(0o755);self.assertNotEqual(self.run_audit().returncode,0)
 def test_unknown_init(self):
  p=self.root/'init';p.write_text('mountroot\n'+p.read_text());self.assertNotEqual(self.run_audit().returncode,0)
 def test_sysfs_move_missing(self):
  p=self.root/'init';p.write_text(p.read_text().replace('mount -n -o move /sys ${rootmnt}/sys\n',''));self.approve();self.assertNotEqual(self.run_audit().returncode,0)
 def test_prior_pstore_mount_even_if_reviewed(self):
  p=self.root/'init';p.write_text('mount -t pstore pstore /sys/fs/pstore\n'+p.read_text());self.approve();self.assertNotEqual(self.run_audit().returncode,0)
 def test_missing_policy_helper(self):
  (self.root/'lib/portable-persistent-api').unlink();self.approve();self.assertNotEqual(self.run_audit().returncode,0)
 def test_missing_applet(self):
  (self.root/'bin/awk').unlink();self.assertNotEqual(self.run_audit().returncode,0)
 def test_absolute_applet_link_does_not_use_host_binary(self):
  p=self.root/'bin/awk';p.unlink();p.symlink_to('/usr/bin/awk');self.assertNotEqual(self.run_audit().returncode,0)
 def test_changed_applet_binary(self):
  (self.root/'bin/awk').write_text('#!/bin/sh\nexit 1\n');self.assertNotEqual(self.run_audit().returncode,0)
 def test_nonexecutable_order_guard(self):
  (self.root/'scripts/init-top/00-portable-persistent-api').chmod(0o644);self.assertNotEqual(self.run_audit().returncode,0)
 def test_changed_source_configs_and_nfs_refused(self):
  for name in ['scripts/nfs','conf/initramfs.conf','conf/arch.conf']:
   p=self.root/name;before=p.read_text();p.write_text(before+'\n# changed')
   self.assertNotEqual(self.run_audit().returncode,0);p.write_text(before)
 def test_unknown_conf_and_modules_refused(self):
  for name in ['conf/conf.d/unreviewed','conf/modules']:
   p=self.root/name;p.parent.mkdir(exist_ok=True);p.write_text('unreviewed')
   self.assertNotEqual(self.run_audit().returncode,0);p.unlink()
 def test_valid_but_changed_order_hash_refused(self):
  p=self.root/'scripts/local-premount/ORDER';lines=p.read_text().splitlines(True);p.write_text(''.join(lines[2:]+lines[:2]));self.assertNotEqual(self.run_audit().returncode,0)
 def test_growroot_requires_actual_safe_lower_marker(self):
  p=self.root/'scripts/local-bottom/growroot';p.write_text('#!/bin/sh\n[ -e /root/etc/growroot-disabled ] && exit 0\n');p.chmod(0o755)
  order=p.parent/'ORDER';order.write_text(order.read_text()+'/scripts/local-bottom/growroot "$@"\n[ -e /conf/param.conf ] && . /conf/param.conf\n');self.approve()
  with tempfile.TemporaryDirectory() as d:
   lower=pathlib.Path(d);(lower/'etc').mkdir();marker=lower/'etc/growroot-disabled';args=['--lower-sysroot',str(lower)]
   self.assertNotEqual(self.run_audit().returncode,0);self.assertNotEqual(self.run_audit(args).returncode,0)
   marker.symlink_to('/dev/null');self.assertNotEqual(self.run_audit(args).returncode,0);marker.unlink()
   marker.write_text('');marker.chmod(0o666);self.assertNotEqual(self.run_audit(args).returncode,0)
   marker.chmod(0o644)
   import os
   if os.getuid()==0:self.assertEqual(self.run_audit(args).returncode,0)
   else:self.assertNotEqual(self.run_audit(args).returncode,0)
if __name__=='__main__': unittest.main()
