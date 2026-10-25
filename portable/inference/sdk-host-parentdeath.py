#!/usr/bin/python3
"""Fixed child bootstrap: same financial UID, inherited private FDs, no secrets in argv."""
import ctypes,os,signal,sys
if os.getuid()!=972 or len(sys.argv)!=4:raise SystemExit(70)
expected=int(sys.argv[1]);libc=ctypes.CDLL(None,use_errno=True)
if libc.prctl(1,signal.SIGKILL,0,0,0)!=0:raise SystemExit(71)
if os.getppid()!=expected:raise SystemExit(72)
os.execve(sys.argv[2],[sys.argv[2],sys.argv[3]],{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
