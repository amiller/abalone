#!/usr/bin/env python3
"""Audit an already extracted archive. Does not build, mount, or execute it.
Every script must match an independently reviewed SHA256 manifest (JSON mapping
archive-relative path -> digest), including vendor and early network scripts.
"""
import argparse,hashlib,json,re,os,stat
from pathlib import Path
ap=argparse.ArgumentParser(); ap.add_argument('tree',type=Path); ap.add_argument('--reviewed-sha256',required=True,type=Path)
ap.add_argument('--lower-sysroot',type=Path,help='Read-only actual lower tree inspection required when growroot is present')
a=ap.parse_args(); root=a.tree; approved=json.loads(a.reviewed_sha256.read_text()); evidence={}
def fail(msg): raise SystemExit('REFUSED: '+msg)
def read(name):
 p=root/name
 if not p.is_file() or any(q.is_symlink() for q in (p,*p.parents) if q != root.parent): fail('missing/linked '+name)
 content=p.read_bytes(); digest=hashlib.sha256(content).hexdigest()
 if approved.get(name)!=digest: fail('not independently reviewed: '+name)
 evidence[name]=digest
 return content.decode()
init=read('init'); functions=read('scripts/functions'); local=read('scripts/local'); read('scripts/nfs')
read('conf/initramfs.conf'); read('conf/arch.conf')
config_dir=root/'conf/conf.d'
if config_dir.is_symlink(): fail('linked conf/conf.d')
if config_dir.exists():
 if not config_dir.is_dir(): fail('non-directory conf/conf.d')
 for config in sorted(config_dir.iterdir()): read(str(config.relative_to(root)))
if (root/'conf/modules').exists() or (root/'conf/modules').is_symlink(): read('conf/modules')
sequence=['run_scripts /scripts/init-top','\nmountroot\n','run_scripts /scripts/init-bottom','mount -n -o move /run ${rootmnt}/run','exec run-init ']
positions=[init.find(x) for x in sequence]
if min(positions)<0 or positions!=sorted(set(positions)): fail('unsupported /init order')
if '. "${initdir}/ORDER"' not in functions: fail('unknown ORDER execution')
if '"${fastboot?}" = "y"' not in functions: fail('unverified checkfs skip')
if 'mount ${roflag}' not in local or '${ROOTFLAGS}' not in local: fail('unverified initial mount flags')
orders={}
for order in sorted((root/'scripts').glob('*/ORDER')):
 phase=order.parent.name
 text=read(str(order.relative_to(root))); lines=text.splitlines(); scripts=[]
 if len(lines)%2: fail('unknown ORDER syntax '+phase)
 for i in range(0,len(lines),2):
  m=re.fullmatch(r'/scripts/'+re.escape(phase)+r'/([\w.-]+) "\$@"',lines[i])
  if not m or lines[i+1]!='[ -e /conf/param.conf ] && . /conf/param.conf': fail('unknown ORDER syntax '+phase)
  name='scripts/'+phase+'/'+m[1]; read(name)
  if not (root/name).stat().st_mode&0o111:fail('ORDER script not executable: '+name)
  scripts.append(m[1])
 orders[phase]=scripts
if orders.get('init-top',[])[:2]!=['00-portable-persistent-api','00-portable-volatile-guard']: fail('persistent API then volatile guard must run first')
if not orders.get('init-bottom') or orders['init-bottom'][-1]!='zz-portable-persistent-api': fail('persistent API check must run last before root switch')
read('lib/portable-persistent-api')
if not (root/'lib/portable-persistent-api').stat().st_mode&0o111:fail('persistent API helper not executable')
read('etc/portable-persistent-api.conf')
# Reviewed /init must move the SAME sysfs tree, preserving its child barriers.
if 'mount -n -o move /sys ${rootmnt}/sys' not in init: fail('sysfs move preserving barriers missing')
if init.find('mount -n -o move /sys ${rootmnt}/sys') < positions[2]: fail('sysfs moved before final barrier check')
if any(x in init[:positions[0]] for x in ('efivarfs','pstore')): fail('persistent API use before first guard')
def executable_in_archive(name):
 # Resolve absolute symlinks against the archive, never against the audit host.
 pending=name.split('/');resolved=[];hops=0
 while pending:
  part=pending.pop(0)
  if part in ('','.'):continue
  if part=='..':
   if not resolved:fail('applet escapes archive')
   resolved.pop();continue
  candidate=root.joinpath(*resolved,part)
  if candidate.is_symlink():
   hops+=1
   if hops>40:fail('applet link cycle')
   link=os.readlink(candidate)
   if link.startswith('/'):resolved=[]
   pending=link.split('/')+pending
  else:resolved.append(part)
 target=root.joinpath(*resolved)
 if not target.is_file() or not target.stat().st_mode&0o111:fail('guard applet target missing/nonexecutable: '+name)
 key='/'.join(resolved);digest=hashlib.sha256(target.read_bytes()).hexdigest()
 if approved.get(key)!=digest:fail('unreviewed guard applet executable: '+key)
 evidence[key]=digest
for applet in ('mount','awk','cat','wc','uname','sleep','poweroff','halt','mktemp','chmod','mv'):
 candidates=[directory+'/'+applet for directory in ('bin','sbin','usr/bin','usr/sbin') if (root/directory/applet).exists() or (root/directory/applet).is_symlink()]
 if not candidates:fail('required guard applet missing: '+applet)
 executable_in_archive(candidates[0])

bottom=orders.get('init-bottom',[])
if 'portable-volatile-root' not in bottom or 'udev' not in bottom or bottom.index('portable-volatile-root')>=bottom.index('udev'): fail('overlay must precede udev')
for script in (root/'scripts').glob('*/*'):
 if script.is_file() and script.name!='ORDER' and script.stat().st_mode & 0o111:
  if script.name not in orders.get(script.parent.name,[]): fail('executable absent from ORDER: '+str(script))
read('etc/portable-volatile-root.conf')
marker_evidence=None
if 'growroot' in orders.get('local-bottom',[]):
 if a.lower_sysroot is None: fail('growroot requires actual lower marker inspection')
 marker=a.lower_sysroot/'etc/growroot-disabled'
 for component in (marker,*marker.parents):
  if component.is_symlink(): fail('linked lower marker path')
 try: metadata=marker.lstat()
 except FileNotFoundError: fail('growroot-disabled absent from physical lower')
 if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
  fail('growroot-disabled must be root-owned regular and non-writable by others')
 marker_evidence={'path':str(marker),'uid':metadata.st_uid,'mode':oct(stat.S_IMODE(metadata.st_mode)),
                  'sha256':hashlib.sha256(marker.read_bytes()).hexdigest(),
                  'growroot_sha256':evidence['scripts/local-bottom/growroot']}

print(json.dumps({'source_audit':'pass','orders':orders,'physical_lower_marker':marker_evidence,'sha256':evidence,'kernel_qualification':'NOT PERFORMED'},indent=2))
