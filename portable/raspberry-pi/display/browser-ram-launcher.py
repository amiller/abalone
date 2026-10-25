#!/usr/bin/python3
"""UI-only browser launcher: private RAM paths, unchanged Chromium sandbox."""
import os,pathlib,stat
assert os.getuid()==971
runtime=pathlib.Path('/run/portable-display')
assert os.environ.get('XDG_RUNTIME_DIR')==str(runtime)
st=runtime.lstat()
assert stat.S_ISDIR(st.st_mode) and st.st_uid==971 and stat.S_IMODE(st.st_mode)==0o700
os.umask(0o077)
for key,name in (('XDG_CONFIG_HOME','browser-config'),('XDG_CACHE_HOME','browser-cache'),('XDG_DATA_HOME','browser-data')):
 p=runtime/name;p.mkdir(mode=0o700,exist_ok=True)
 st=p.lstat();assert stat.S_ISDIR(st.st_mode) and st.st_uid==971 and stat.S_IMODE(st.st_mode)==0o700
 os.environ[key]=str(p)
p=runtime/'portable-chromium';p.mkdir(mode=0o700,exist_ok=True)
st=p.lstat();assert stat.S_ISDIR(st.st_mode) and st.st_uid==971 and stat.S_IMODE(st.st_mode)==0o700
os.execv('/usr/bin/chromium',['chromium','--ozone-platform=wayland','--user-data-dir='+str(p),'http://127.0.0.1:8765/'])
