#!/usr/bin/env python3
"""Offline-only policy staging. Never builds, mounts, modifies boot args or services."""
import argparse,hashlib,json,os,pathlib,re,stat
P=pathlib.Path;HERE=P(__file__).resolve().parent
# These are the supported image's consumers; adding a new early networking or
# interactive unit requires admission here (not an implicit Before= assumption).
CONSUMERS=(
 'network-pre.target','systemd-networkd.service','systemd-networkd.socket',
 'tor-guest-firewall.service','tor-guest.service',
 'portable-workspace.service','portable-agent.service','portable-workspace-ui.service',
 'portable-native-terminal.service','portable-display.service',
 'systemd-user-sessions.service','getty.target','getty@.service',
 'serial-getty@.service','console-getty.service','container-getty@.service',
 'display-manager.service','graphical.target')
GATE=b'[Unit]\nRequires=portable-persistent-api.service\nAfter=portable-persistent-api.service\n'
class Refusal(ValueError):pass
def need(value,message):
 if not value:raise Refusal(message)
def kernel_mode(text):
 values={}
 for line in text.splitlines():
  match=re.fullmatch(r'(CONFIG_[A-Z0-9_]+)=(.*)',line)
  off=re.fullmatch(r'# (CONFIG_[A-Z0-9_]+) is not set',line)
  if match or off:
   key,value=match.groups() if match else (off[1],'n')
   need(key not in values,'duplicate kernel option');values[key]=value
 need(values.get('CONFIG_PSTORE') in ('y','n'),'pstore absent/unrecognized or loadable: unsupported')
 need(values.get('CONFIG_EFI') in ('y','n'),'EFI configuration unknown')
 need(values.get('CONFIG_TMPFS')=='y' and values.get('CONFIG_SYSFS')=='y','required builtin filesystems missing')
 return 'builtin-disabled' if values['CONFIG_PSTORE']=='y' else 'absent'
def cmdline(text):
 need(len(text.encode())<=16384 and len(text.splitlines())==1,'literal single cmdline required')
 tokens=text.split()
 need([x for x in tokens if x.startswith('efi=') or x=='noefi']==['efi=noruntime'],'EFI parameter missing/duplicate/conflict')
 need([x for x in tokens if x.startswith('pstore.backend=')]==['pstore.backend=none'],'pstore parameter missing/duplicate/conflict')
 need('--' not in tokens and not any(x.startswith('init=') or x.startswith('systemd.run=') or x=='portable-volatile-root=off' for x in tokens),'unsupported init/recovery override')
def safe(root,target,allow_mask=False):
 need(target.is_relative_to(root),'target escaped tree')
 for p in (target,*target.parents):
  if p==root.parent:break
  if p.is_symlink():
   need(allow_mask and p==target and os.readlink(p)=='/dev/null','linked authority/output path '+str(p))
  elif p.exists():
   st=p.stat();need(stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode),'special output path')
   if stat.S_ISREG(st.st_mode):need(st.st_nlink==1,'hardlinked output file')
def plan(root,release,config,command):
 need(root.is_absolute() and root!=P('/') and root.resolve()==root and root.is_dir() and not os.path.samefile(root,'/'),'canonical offline tree required')
 for part in (root,*root.parents):need(not part.is_symlink(),'linked sysroot ancestor')
 need(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]{0,127}',release),'invalid kernel release')
 mode=kernel_mode(config);cmdline(command)
 config_bytes=('KERNEL_RELEASE='+release+'\nPSTORE_MODE='+mode+'\n').encode()
 files={
  'etc/portable-persistent-api.conf':(config_bytes,0o644),
  'usr/lib/portable-persistent-api':((HERE/'lib/portable-persistent-api').read_bytes(),0o755),
  'etc/initramfs-tools/hooks/portable-persistent-api':((HERE/'hooks/portable-persistent-api').read_bytes(),0o755),
  'etc/initramfs-tools/scripts/init-top/00-portable-persistent-api':((HERE/'scripts/init-top/00-portable-persistent-api').read_bytes(),0o755),
  'etc/initramfs-tools/scripts/init-bottom/zz-portable-persistent-api':((HERE/'scripts/init-bottom/zz-portable-persistent-api').read_bytes(),0o755),
  'etc/systemd/system/portable-persistent-api.service':((HERE/'units/portable-persistent-api.service').read_bytes(),0o644)}
 for consumer in CONSUMERS:
  files['etc/systemd/system/'+consumer+'.d/50-portable-persistent-api.conf']=(GATE,0o644)
 links={name:'/dev/null' for name in ('etc/systemd/system/systemd-pstore.service','etc/systemd/system/sys-fs-pstore.mount','etc/systemd/system/sys-fs-pstore.automount','etc/systemd/system/sys-firmware-efi-efivars.mount','etc/systemd/system/sys-firmware-efi-efivars.automount')}
 links['etc/systemd/system/sysinit.target.requires/portable-persistent-api.service']='../portable-persistent-api.service'
 for name,(data,modebits) in files.items():
  target=root/name;safe(root,target)
  need(not target.exists() or target.is_file() and target.read_bytes()==data,'different existing policy '+name)
 for name,value in links.items():
  target=root/name
  # Validate ancestors separately, then accept only our exact idempotent link.
  safe(root,target.parent)
  need(not target.exists() and not target.is_symlink() or target.is_symlink() and os.readlink(target)==value,'existing policy link conflict '+name)
 for unit in ['portable-persistent-api.service','systemd-pstore.service','sys-fs-pstore.mount','sys-fs-pstore.automount','sys-firmware-efi-efivars.mount','sys-firmware-efi-efivars.automount']:
  for directory in ('etc/systemd/system','run/systemd/system','usr/lib/systemd/system','lib/systemd/system'):
   path=root/directory/(unit+'.d')
   need(not path.exists() and not path.is_symlink(),'unreviewed persistent API drop-ins '+str(path))
 return files,links,{'kernelRelease':release,'kernelConfigSha256':hashlib.sha256(config.encode()).hexdigest(),'cmdlineSha256':hashlib.sha256(command.encode()).hexdigest(),'pstoreMode':mode,'qualification':'SOURCE ONLY; kernel/config/image pairing and boot still require review'}
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--sysroot',type=P,required=True);ap.add_argument('--kernel-release',required=True);ap.add_argument('--kernel-config',type=P,required=True);ap.add_argument('--cmdline-file',type=P,required=True);ap.add_argument('--apply',action='store_true');ap.add_argument('--confirm');a=ap.parse_args()
 for path,limit in [(a.kernel_config,1048576),(a.cmdline_file,16384)]:
  need(path.is_file() and not path.is_symlink() and path.stat().st_size<=limit,'unsafe/big input')
 files,links,evidence=plan(a.sysroot,a.kernel_release,a.kernel_config.read_text(),a.cmdline_file.read_text())
 if a.apply:
  need(os.getuid()==0 and a.confirm=='PERSISTENT-API-IMAGE','root + explicit offline confirmation required')
  for name,(data,mode) in files.items():
   target=a.sysroot/name;target.parent.mkdir(parents=True,exist_ok=True);safe(a.sysroot,target)
   fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,mode)
   with os.fdopen(fd,'wb') as out:out.write(data)
   os.chown(target,0,0);os.chmod(target,mode)
  for name,value in links.items():
   target=a.sysroot/name;target.parent.mkdir(parents=True,exist_ok=True)
   if not target.is_symlink():target.symlink_to(value)
 evidence.update({'applied':a.apply,'files':{n:hashlib.sha256(data).hexdigest() for n,(data,_) in files.items()},'links':links})
 print(json.dumps(evidence,indent=2))
if __name__=='__main__':
 try:main()
 except (Refusal,OSError,UnicodeError) as e:raise SystemExit('REFUSED: '+str(e))
