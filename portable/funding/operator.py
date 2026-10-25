#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Fixed root operator entry; funding child has no agent-accessible RPC."""
import ctypes,importlib.util,json,os,re,resource,selectors,signal,stat,subprocess,sys,time
from pathlib import Path
BASE=Path('/run/portable-vault/funding')
ENTRY='/opt/portable/portable/funding/operator-session.py'
COMMANDS=('new-demo','fund','fresh','credit','new','status','resume','prepare-payment','send-reviewed','activate','key-limit')

def require(value):
 if not value:raise ValueError('operator refused')
def validate(command,sha):
 require(command in COMMANDS)
 if command=='fund' and sha is not None:return require(isinstance(sha,str) and re.fullmatch('[1-9]|10',sha))
 require((command in ('send-reviewed','key-limit'))==(sha is not None))
 if sha is not None:require(isinstance(sha,str) and re.fullmatch('[0-9a-f]{64}' if command=='send-reviewed' else '[1-9][0-9]{0,9}',sha))
def directories():
 for path in (BASE,BASE/'attempts'):
  try:os.mkdir(path,0o700);os.chown(path,972,972)
  except FileExistsError:pass
  s=path.lstat();require(stat.S_ISDIR(s.st_mode) and (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(972,972,0o700))
def child_identity():
 os.setgroups([]);os.setgid(972);os.setuid(972)
 libc=ctypes.CDLL(None,use_errno=True);require(libc.prctl(38,1,0,0,0)==0)
 # The child has its own session: a dropped terminal never reaches it, so it ends with this operator.
 require(libc.prctl(1,signal.SIGTERM,0,0,0)==0)
def drain(child,terminate=False):
 """Leader must remain unreaped until its process group has been terminated."""
 if terminate:
  try:os.killpg(child.pid,signal.SIGTERM)
  except ProcessLookupError:pass
  end=time.monotonic()+5
  while time.monotonic()<end:
   if os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is not None:break
   time.sleep(.05)
 try:os.killpg(child.pid,signal.SIGKILL)
 except ProcessLookupError:pass
 return child.wait(timeout=5)
def collect(child,check,timeout=240,emit=None):
 sel=selectors.DefaultSelector();out=bytearray();pending=bytearray();last=None;err=0;deadline=time.monotonic()+timeout;next_check=0;done=False
 for f in (child.stdout,child.stderr):os.set_blocking(f.fileno(),False);sel.register(f,selectors.EVENT_READ)
 try:
  while sel.get_map():
   now=time.monotonic();require(now<deadline)
   if now>=next_check:check();next_check=now+1
   for key,_ in sel.select(.1):
    data=os.read(key.fd,4096)
    if not data:sel.unregister(key.fileobj);continue
    if key.fileobj is child.stdout:
     out.extend(data);pending.extend(data);require(len(out)<=65536)
     while b'\n' in pending:
      line,_,tail=pending.partition(b'\n');pending=bytearray(tail)
      value=json.loads(line.decode('utf-8'));require(isinstance(value,dict));last=value
      if emit:emit(value)
    else:err+=len(data);require(err<=16384)
  while os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is None:
   require(time.monotonic()<deadline);time.sleep(.01)
  code=drain(child);done=True;require(code==0)
  require(not pending and last is not None);return last
 finally:
  if not done:drain(child,True)
  sel.close();child.stdout.close();child.stderr.close()
def show(value):
 if not sys.stdout.isatty():return json.dumps(value)
 sys.path.insert(0,str(Path(__file__).resolve().parent));import fund_view
 return fund_view.render(value)
SHOWN=[]
def say(value):SHOWN.append(value);print(show(value),flush=True)
def run(command,sha=None):
 require(os.getuid()==os.geteuid()==0);validate(command,sha)
 resource.setrlimit(resource.RLIMIT_CORE,(0,0));require(ctypes.CDLL(None).prctl(4,0,0,0,0)==0)
 storage=Path(__file__).resolve().parent.parent/'raspberry-pi/storage';sys.path.insert(0,str(storage))
 import financial_lease
 lock=financial_lease.lifecycle_lock()
 try:
  check,_=financial_lease.production_admission();check();directories()
  if command in ('fund','new-demo') and sys.stdout.isatty():print('Checking funding status over Tor...',flush=True)
  args=['/usr/bin/python3','-I',ENTRY,command]+([] if sha is None else [sha])
  child=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},preexec_fn=child_identity,start_new_session=True,close_fds=True)
  result=collect(child,check,7500 if command in ('fund','new-demo') else 240,say);check()
  if command in ('fund','new-demo','activate') and result.get('inferenceCredentialPrepared') is True:
   spec=importlib.util.spec_from_file_location('funding_activate',Path(__file__).with_name('activate.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
   return module.switch(check)
  return result
 finally:os.close(lock)
def main():
 def interrupted(*_):raise KeyboardInterrupt()
 for signum in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):signal.signal(signum,interrupted)
 try:
  require(2<=len(sys.argv)<=3);result=run(sys.argv[1],sys.argv[2] if len(sys.argv)==3 else None);code=0
 except BaseException:result={'state':'unknown','reason':'operator-refused-or-interrupted','retryPerformed':False};code=1
 # The child's own last line (its result, or its failure report) is already on screen.
 if not (SHOWN and (SHOWN[-1]==result or code and SHOWN[-1].get('state','').startswith('unknown'))):say(result)
 return code
if __name__=='__main__':sys.exit(main())
