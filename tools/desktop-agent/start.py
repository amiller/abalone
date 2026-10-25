#!/usr/bin/env python3
"""Own one bounded local broker + tmux/Pi session. Credential record: inherited FD4."""
import argparse, json, os, pathlib, resource, signal, subprocess, time
HERE=pathlib.Path(__file__).resolve().parent

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--sdk',required=True,type=pathlib.Path)
 p.add_argument('--node',required=True,type=pathlib.Path)
 p.add_argument('--runtime',required=True,type=pathlib.Path)
 p.add_argument('--workspace',required=True,type=pathlib.Path)
 p.add_argument('--session',default='dsmack-desktop')
 a=p.parse_args()
 if not a.session.replace('-','').isalnum():raise ValueError()
 env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'}
 tmux=['tmux','-L',a.session,'-f','/dev/null']
 if subprocess.run(tmux+['list-sessions'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:raise ValueError()
 sdk=a.sdk.resolve(strict=True);node=a.node.resolve(strict=True);workspace=a.workspace.resolve(strict=True)
 if sdk.name!='index.js' or sdk.parent.name!='dist' or not workspace.is_dir():raise ValueError()
 runtime=a.runtime.absolute();runtime.mkdir(mode=0o700,parents=False,exist_ok=False)
 resource.setrlimit(resource.RLIMIT_CORE,(0,0));os.umask(0o077)
 home=runtime/'home';home.mkdir(mode=0o700);config=home/'agent';config.mkdir(mode=0o700)
 (config/'settings.json').write_text(json.dumps({'retry':{'enabled':False,'maxRetries':0,'provider':{'maxRetries':0}},'compaction':{'enabled':False},'cacheWarming':'off'}))
 profile=runtime/'profile.json';profile.write_text(json.dumps({'sdk':str(sdk),'socket':str(runtime/'inference.sock')}))
 broker=None;created=False;stopped=False;server_pid=None
 def stop(*_):
  nonlocal stopped
  stopped=True
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
 env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'}
 try:
  with (runtime/'broker.stderr').open('xb') as err:
   broker=subprocess.Popen([str(node),str(HERE/'broker.mjs'),str(runtime)],env=env,pass_fds=(4,),stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=err)
  os.close(4)
  # Startup line contains only a fixed readiness marker; no credential output.
  import selectors
  selector=selectors.DefaultSelector();selector.register(broker.stdout,selectors.EVENT_READ)
  if not selector.select(10) or broker.stdout.readline()!=b'desktop-broker-ready\n':raise ValueError()
  selector.close();broker.stdout.close()
  argv=[str(node),str(sdk.parent/'cli.js'),'--offline','--no-session','--no-extensions','-e',str(HERE/'extension.mjs'),'--no-mcp','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-approve','--provider','desktop-broker','--model','glm-5.3','--thinking','low']
  tmuxenv={**env,'HOME':str(home),'PI_CODING_AGENT_DIR':str(config),'PI_TELEMETRY':'0','DSMACK_DESKTOP_PROFILE':str(profile),'TERM':'xterm-256color'}
  # Explicit -e overrides daemon environment, which may predate this launch.
  command=tmux+['new-session','-d','-s',a.session,'-c',str(workspace),'-x','120','-y','36']
  for key,value in tmuxenv.items():command+=['-e',key+'='+value]
  subprocess.run(command+argv,check=True,env=env);created=True
  server_pid=subprocess.check_output(tmux+['display-message','-p','#{pid}'],env=env,text=True).strip()
  if not server_pid.isdigit():raise ValueError()
  print(json.dumps({'ready':True,'session':a.session,'attach':'tmux -L '+a.session+' attach -t '+a.session,'developmentOnly':True,'maxRequests':8,'maxLifetimeSeconds':1800}),flush=True)
  deadline=time.monotonic()+1800
  while not stopped and time.monotonic()<deadline and broker.poll() is None:
   if subprocess.run(tmux+['has-session','-t',a.session],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:break
   time.sleep(.5)
 finally:
  if created and server_pid is not None:
   current=subprocess.run(tmux+['display-message','-p','#{pid}'],env=env,capture_output=True,text=True)
   if current.returncode==0 and current.stdout.strip()==server_pid:
    subprocess.run(tmux+['kill-server'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  if broker and broker.poll() is None:
   broker.terminate()
   try:broker.wait(timeout=5)
   except subprocess.TimeoutExpired:broker.kill();broker.wait()
  # Settings/profile are public launch metadata, not credential records.
  (runtime/'closed.json').write_text(json.dumps({'closed':True,'brokerReaped':broker is None or broker.poll() is not None})+'\n')
if __name__=='__main__':
 try:main()
 except BaseException:
  print('Desktop session unavailable; no automatic retry.',flush=True);raise SystemExit(1)
