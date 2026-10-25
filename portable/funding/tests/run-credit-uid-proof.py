#!/usr/bin/python3
"""Offline private user/mount/network namespace; no installs or host mounts changed."""
import os,pathlib,pwd,subprocess,tempfile,time,shutil,signal
base=pathlib.Path(__file__).resolve().parent
user=pwd.getpwuid(os.getuid()).pw_name
ranges={}
for kind in ('uid','gid'):
    lines=pathlib.Path('/etc/sub'+kind).read_text().splitlines()
    rows=[x.split(':') for x in lines if x.split(':')[0] in (user,str(os.getuid()))]
    if not rows or int(rows[0][2])<65535:raise SystemExit('SKIP: subordinate IDs unavailable')
    ranges[kind]=int(rows[0][1])
node=shutil.which('node')
assert node and shutil.which('newuidmap') and shutil.which('newgidmap')
with tempfile.TemporaryDirectory(prefix='credit-map-') as d:
    marker=pathlib.Path(d)/'go'
    # Wait outside Node until mapping gives namespace root capabilities.
    child=subprocess.Popen(['unshare','--user','--mount','--net','bash','-c','while [ ! -f "$1" ]; do sleep 0.02; done; exec "$2" "$3"','_',str(marker),node,str(base/'credit-service-namespace.mjs')],start_new_session=True)
    try:
        deadline=time.monotonic()+3
        while pathlib.Path('/proc/'+str(child.pid)+'/uid_map').read_text().strip():
            assert time.monotonic()<deadline and child.poll() is None, 'namespace setup failed'
            time.sleep(0.01)
        subprocess.run(['newuidmap',str(child.pid),'0',str(os.getuid()),'1','1',str(ranges['uid']),'65535'],check=True)
        subprocess.run(['newgidmap',str(child.pid),'0',str(os.getgid()),'1','1',str(ranges['gid']),'65535'],check=True)
        marker.touch()
        raise SystemExit(child.wait(timeout=40))
    finally:
        if child.poll() is None:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=5)
