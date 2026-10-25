#!/usr/bin/env python3
"""Offline coarse clock baseline and exact timesyncd disable; never set a clock."""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('clock_staging_io',HERE/'stage-pi-normalization.py')
n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n)
need,sha,encode=n.need,n.sha,n.encode
DATA='etc/fake-hwclock.data'
FILES={DATA,'usr/sbin/fake-hwclock','etc/default/fake-hwclock',
       'usr/lib/systemd/system/fake-hwclock.service',
       'usr/lib/systemd/system/systemd-timesyncd.service',
       'etc/systemd/timesyncd.conf',
       'usr/share/dbus-1/system-services/org.freedesktop.timesync1.service'}
UNITS=('systemd-timesyncd.service','dbus-org.freedesktop.timesync1.service')
TARGET='/lib/systemd/system/systemd-timesyncd.service'
ENABLE='etc/systemd/system/sysinit.target.wants/systemd-timesyncd.service'
KEEP='etc/systemd/system/sysinit.target.wants/fake-hwclock.service'
BACKUP='var/lib/portable-image/clock-policy'


def unique(pairs):
    result={}
    for key,value in pairs:
        need(key not in result,'duplicate profile key');result[key]=value
    return result


def load_profile(path,pin):
    raw=n.bounded(path);need(sha(raw)==pin,'profile digest mismatch')
    p=json.loads(raw,object_pairs_hook=unique)
    need(type(p) is dict and set(p)=={'version','files','unitOverrides','baselineUtc','provenance'} and
         type(p['version']) is int and p['version']==1,'profile schema')
    need(type(p['files']) is dict and set(p['files'])==FILES,'exact clock source paths required')
    for r in p['files'].values():
        need(type(r) is dict and set(r)=={'sha256','mode'} and type(r['sha256']) is str and
             re.fullmatch('[0-9a-f]{64}',r['sha256']) and type(r['mode']) is int and
             r['mode'] in (0o644,0o755),'invalid input record')
    need(type(p['unitOverrides']) is dict and set(p['unitOverrides'])==set(UNITS) and
         all(v in (None,TARGET) for v in p['unitOverrides'].values()),'unknown override/link state')
    need(type(p['provenance']) is dict and type(p['baselineUtc']) is str and
         re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ',p['baselineUtc']),'explicit UTC baseline required')
    datetime.strptime(p['baselineUtc'],'%Y-%m-%dT%H:%M:%SZ')
    return p,raw


def baseline(p,old):
    text=old.decode('ascii')
    need(re.fullmatch(r'\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\n',text),'unknown old clock data format')
    before=datetime.strptime(text.strip(),'%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
    after=datetime.strptime(p['baselineUtc'],'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    need(after>=before,'baseline must not move saved lower bound backwards')
    return (after.strftime('%Y-%m-%d %H:%M:%S')+'\n').encode()


def exact_link(root,name,target):
    path=n.safe(root,name,'link')
    need(path.is_symlink() and os.readlink(path)==target,'unexpected activation link: '+name)


def build(root,p,raw):
    need(root.is_absolute() and root.is_dir() and root.resolve()==root and not os.path.samefile(root,'/'),'canonical offline root required')
    for a in (root,*root.parents):need(not a.is_symlink(),'linked root ancestor')
    marker=n.safe(root,BACKUP,'directory');need(not marker.exists() and not marker.is_symlink(),'clock stage already attempted; no replay')
    inputs={}
    for name,record in p['files'].items():
        path=n.safe(root,name);data=n.bounded(path);s=path.stat()
        need(sha(data)==record['sha256'] and s.st_mode&0o777==record['mode'],'unreviewed clock source bytes/mode: '+name)
        inputs[name]=data
    exact_link(root,ENABLE,TARGET)
    exact_link(root,KEEP,'/lib/systemd/system/fake-hwclock.service')
    for unit,target in p['unitOverrides'].items():
        path=root/'etc/systemd/system'/unit
        if target is None:
            n.safe(root,'etc/systemd/system','directory')
            need(not path.exists() and not path.is_symlink(),'unexpected clock override')
        else:exact_link(root,'etc/systemd/system/'+unit,target)
    fake_override=root/'etc/systemd/system/fake-hwclock.service'
    need(not fake_override.exists() and not fake_override.is_symlink(),'unreviewed fake clock override')
    vendor_alias=root/'usr/lib/systemd/system/dbus-org.freedesktop.timesync1.service'
    need(not vendor_alias.exists() and not vendor_alias.is_symlink(),'unreviewed vendor DBus alias')
    allowed={ENABLE,KEEP}|{'etc/systemd/system/'+u for u,v in p['unitOverrides'].items() if v is not None}
    for parent,dirs,names in os.walk(root/'etc/systemd/system',followlinks=False):
        for leaf in dirs+names:
            path=Path(parent)/leaf
            if path.is_symlink() and Path(os.readlink(path)).name in (*UNITS,'fake-hwclock.service'):
                need(path.relative_to(root).as_posix() in allowed,'unreviewed clock activation alias')
    # Alias and canonical-unit drop-ins are both authority. Do not interpret or
    # delete unknown overrides. Package unit and DBus source bytes stay pinned.
    for base in ('etc/systemd/system','run/systemd/system','usr/lib/systemd/system'):
        for unit in (*UNITS,'fake-hwclock.service'):
            path=n.safe(root,base+'/'+unit+'.d','directory')
            need(not path.exists() or not list(path.iterdir()),'unreviewed clock drop-in')
            if base.startswith('run/'):
                path=root/base/unit;need(not path.exists() and not path.is_symlink(),'runtime clock override')
    tmp=n.safe(root,DATA+'.portable-clock-new');need(not tmp.exists() and not tmp.is_symlink(),'stale clock staging output')
    updated=baseline(p,inputs[DATA]);s=root.stat()
    plan={'version':1,'root':str(root),'rootDev':s.st_dev,'rootInode':s.st_ino,
          'sourceSha256':{x.name:sha(x.read_bytes()) for x in (Path(__file__).resolve(),HERE/'stage-pi-normalization.py')},
          'profileSha256':sha(raw),'inputs':p['files'],'unitOverrides':p['unitOverrides'],
          'retiredLink':{ENABLE:TARGET},'preservedLink':{KEEP:'/lib/systemd/system/fake-hwclock.service'},
          'maskUnits':list(UNITS),'baselineUtc':p['baselineUtc'],'dataAfterSha256':sha(updated),
          'qualification':'coarse packaging-time floor only; no authenticated/current time or stale-image bootstrap guarantee'}
    return plan,inputs,updated


def fsync_dir(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(fd)
    finally:os.close(fd)


def apply(root,plan,inputs,updated,raw):
    n.write_new(root,BACKUP+'/intent.json',encode(plan),0o600)
    n.write_new(root,BACKUP+'/profile.json',raw,0o600)
    n.write_new(root,BACKUP+'/original-fake-hwclock.data',inputs[DATA],0o600)
    n.write_new(root,BACKUP+'/retired-links.json',encode({'enabled':plan['retiredLink'],'overrides':plan['unitOverrides']}),0o600)
    # Disable network clock activation first. Partial failures never retry.
    n.safe(root,ENABLE,'link').unlink();fsync_dir((root/ENABLE).parent)
    for unit,old in plan['unitOverrides'].items():
        path=root/'etc/systemd/system'/unit
        if old is not None:n.safe(root,'etc/systemd/system/'+unit,'link').unlink()
        path.symlink_to('/dev/null');fsync_dir(path.parent)
    n.write_new(root,DATA+'.portable-clock-new',updated,0o644)
    os.replace(root/(DATA+'.portable-clock-new'),root/DATA);fsync_dir((root/DATA).parent)
    n.write_new(root,BACKUP+'/completed.json',encode({'planSha256':sha(encode(plan))}),0o600)


def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--root',type=Path,required=True)
    ap.add_argument('--profile',type=Path,required=True);ap.add_argument('--profile-sha256',required=True)
    ap.add_argument('--apply',action='store_true');ap.add_argument('--plan-sha256');a=ap.parse_args()
    p,raw=load_profile(a.profile,a.profile_sha256);plan,inputs,updated=build(a.root,p,raw);pin=sha(encode(plan))
    if a.apply:
        need(os.getuid()==0 and a.plan_sha256==pin,'root and exact actual-tree plan approval required')
        apply(a.root,plan,inputs,updated,raw)
    print(json.dumps({'plan':plan,'planSha256':pin,'applied':a.apply},indent=2))
if __name__=='__main__':
    try:main()
    except (ValueError,OSError,UnicodeError) as e:raise SystemExit('REFUSED: '+str(e))
