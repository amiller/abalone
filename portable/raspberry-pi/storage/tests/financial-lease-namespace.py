#!/usr/bin/python3
"""Actual mount/FD/UID tests only, in a supervisor-admitted private namespace.
No LUKS or provider claim. This file is not installed or called by production.
"""
import atexit
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import time

assert os.getuid() == 0
assert [line.split(':')[0].strip() for line in Path('/proc/net/dev').read_text().splitlines()[2:]] == ['lo']
subprocess.run(['/bin/mount','--make-rprivate','/'],check=True)
source=Path(__file__).resolve().parents[3]
# Preserve the inherited runtime subtree privately, without stacking /run.
original_run=[line.split() for line in Path('/proc/self/mountinfo').read_text().splitlines() if line.split()[4]=='/run']
assert len(original_run)<=1, 'preexisting stacked /run'
if original_run:
 preserved=source.parent/'preserved-run';preserved.mkdir(mode=0o700)
 subprocess.run(['/bin/mount','-n','--move','/run',str(preserved)],check=True)
 assert not any(line.split()[4]=='/run' for line in Path('/proc/self/mountinfo').read_text().splitlines())
subprocess.run(['/bin/mount','-t','tmpfs','-o','size=256m,mode=0755','tmpfs','/run'],check=True)
assert sum(line.split()[4]=='/run' for line in Path('/proc/self/mountinfo').read_text().splitlines())==1
sys.path.insert(0,str(source/'raspberry-pi/storage'))
import financial_lease as m
root=Path('/run/financial-lease-proof');root.mkdir(mode=0o755)
node=root/'node';shutil.copyfile('/home/rehearsal/.local/opt/node-v24.22.0-linux-arm64/bin/node',node);node.chmod(0o755)
for origin, target in ((source/'funding/inherited-lease.mjs',root/'inherited-lease.mjs'),(source.parent/'lib/provider-credit-projection.mjs',root/'lib/provider-credit-projection.mjs')):
 target.parent.mkdir(parents=True,exist_ok=True,mode=0o755);shutil.copyfile(origin,target);target.chmod(0o644)
results=root/'results';results.mkdir(mode=0o700);os.chown(results,972,972)
# Synthetic-only diagnostic shim: production keeps generic errors/DEVNULL.
original_supervise=m._supervise
def diagnostic_supervise(*args,**kwargs):
 try:
  outcome=original_supervise(*args,**kwargs)
  (root/'keeper-result').write_text(repr(outcome))
  return outcome
 except BaseException as error:
  (root/'keeper-error').write_text((type(error).__name__+': '+str(error))[:4096])
  raise
m._supervise=diagnostic_supervise
def report_diagnostics():
 for p in (root/'keeper-error',root/'keeper-result',results/'node-error',results/'node-phase'):
  if p.exists():print('SYNTHETIC_DIAGNOSTIC '+p.name+': '+p.read_text()[:4096],file=sys.stderr,flush=True)
atexit.register(report_diagnostics)
print('FIXTURE_MODES '+json.dumps({str(p):oct(p.stat().st_mode&0o777) for p in (root,node,results)}),flush=True)

vault=Path(m.MOUNT);vault.mkdir(mode=0o755)
subprocess.run(['/bin/mount','-t','tmpfs','-o','size=8m,nodev,nosuid,noexec,mode=0755','tmpfs',str(vault)],check=True)
credit=vault/'credit';credit.mkdir(mode=0o700);os.chown(credit,972,972)
record=credit/m.RECORD;record.write_text('{"synthetic":true}\n');record.chmod(0o600);os.chown(record,972,972)
passed=[]
def check():return m.view('tmpfs')
def fixture():return m.HeldLease(m.lifecycle_lock(),check,{'fixture':'tmpfs-not-LUKS'})
def lock_available():
 fd=os.open(m.LOCK,os.O_RDWR)
 try:
  try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);return True
  except BlockingIOError:return False
 finally:os.close(fd)
def refuse(call):
 try:call()
 except Exception:return
 raise AssertionError('refusal missing')

# Real borrowed FD + mount identity, no credential content read by root code.
lease=fixture();assert not lock_available();assert lease.assert_current();first=lease.nonce
refuse(lambda:m.view('ext4'))
code=subprocess.run(['/usr/bin/setpriv','--reuid=970','--regid=970','--clear-groups','/usr/bin/python3','-c',"open('/run/portable-vault/credit/provider.json','rb')"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode
assert code!=0
lease.close();assert lock_available();passed.append('real mount FD, lock exclusion, production ext4 gate and UID970 private-record denial')
lease=fixture();assert lease.nonce!=first
record.rename(credit/'old');record.write_text('{"synthetic":true}\n');record.chmod(0o600);os.chown(record,972,972)
refuse(lease.assert_current);lease.close();(credit/'old').unlink();passed.append('reopen nonce and pathname replacement refuse old lease')
lease=fixture()
with record.open('ab') as f:f.write(b' ')
refuse(lease.assert_current);lease.close();passed.append('in-place record mutation refused')
lease=fixture()
subprocess.run(['/bin/mount','-t','tmpfs','-o','size=1m,nodev,nosuid,noexec','tmpfs',str(vault)],check=True)
refuse(lease.assert_current)
subprocess.run(['/bin/umount',str(vault)],check=True);lease.close();passed.append('stacked mount generation refused')

child=root/'consumer.mjs'
child.write_text('''import fs from 'node:fs';import {spawn} from 'node:child_process';
process.on('uncaughtException',e=>{fs.writeFileSync('/run/financial-lease-proof/results/node-error',String(e?.stack??e).slice(0,4096));process.exit(1);});
process.on('unhandledRejection',e=>{fs.writeFileSync('/run/financial-lease-proof/results/node-error',String(e?.stack??e).slice(0,4096));process.exit(1);});
const phase=value=>fs.writeFileSync('/run/financial-lease-proof/results/node-phase',value);phase('entered synthetic consumer');
import {inheritedLease} from './inherited-lease.mjs';import {createCreditProjection} from './lib/provider-credit-projection.mjs';
if(process.getuid()!==972 || process.getgid()!==972 || fs.readFileSync('/proc/self/status','utf8').match(/^Groups:[ \t]*(.*)$/m)?.[1]?.trim())throw Error('UID/groups');
const capabilities=fs.readFileSync('/proc/self/status','utf8');for(const name of ['CapPrm','CapEff','CapInh','CapAmb'])if(!capabilities.split('\\n').some(line=>line.startsWith(name+':') && /^0{16}$/.test(line.slice(name.length+1).trim())))throw Error('caps');
const lease=await inheritedLease();phase('inherited lease received');
const record=fs.fstatSync(4),control=fs.fstatSync(3);let copies=[];for(const name of fs.readdirSync('/proc/self/fd')){try{const st=fs.fstatSync(Number(name));if((st.dev===record.dev&&st.ino===record.ino)||(st.dev===control.dev&&st.ino===control.ino))copies.push(Number(name));}catch{}}if(copies.sort((a,b)=>a-b).join(',')!=='3,4')throw Error('extra inherited capability FD');
if(!await lease.assertCurrent())throw Error('lease');phase('lease asserted');
const balance={refresh:async()=>{},snapshot:()=>({provider:'ppq',scope:'account',currency:'USD',amountDecimal:'2.5',observedAt:'2026-10-15T00:00:00.000Z',providerAsOf:null,freshness:'fresh',source:'provider-reported'}),close:async()=>{}};
const projection=createCreditProjection({lease,balance,timeoutMs:1500});await projection.refresh();
if((await projection.status()).accountBalance.amountDecimal!=='2.5')throw Error('projection');
const descendant=spawn('/usr/bin/python3',['-c','import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print("READY",flush=True);time.sleep(120)'],{stdio:['ignore','pipe','ignore']});
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('descendant readiness')),5000);descendant.stdout.once('data',b=>{clearTimeout(timer);b.toString()==='READY\\n'?resolve():reject(Error('readiness frame'));});descendant.once('error',reject);});
fs.writeFileSync('/run/financial-lease-proof/results/descendant',String(descendant.pid));descendant.unref();descendant.stdout.destroy();
phase('descendant ready');await projection.close();phase('projection closed');fs.writeFileSync('/run/financial-lease-proof/results/complete','drained');
''');child.chmod(0o644)
lease=fixture();assert m._keep(lease,[str(node),str(child)],15);assert lock_available();assert (results/'complete').read_text()=='drained'
pid=int((results/'descendant').read_text());assert not Path('/proc/'+str(pid)).exists();passed.append('actual UID972 inherited lease -> real projection, release and TERM-resistant descendant reaped before unlock')

# Release acknowledgement alone is not clean consumer success.
for ending in ("setInterval(()=>{},1000);", "process.exitCode=7;"):
 child.write_text("import {inheritedLease} from './inherited-lease.mjs';const lease=await inheritedLease();await lease.release();"+ending);child.chmod(0o644)
 assert not m._keep(fixture(),[str(node),str(child)],15);assert lock_available()
passed.append('release-then-hang and release-then-nonzero are failures after cleanup')

# Parent death: keeper survives caller and must reap financial child before unlock.
child.write_text('''import fs from 'node:fs';import {inheritedLease} from './inherited-lease.mjs';const lease=await inheritedLease();await lease.assertCurrent();fs.writeFileSync('/run/financial-lease-proof/results/waiting',String(process.pid));setInterval(()=>{},1000);''');child.chmod(0o644)
caller=os.fork()
if caller==0:
 try:m._keep(fixture(),[str(node),str(child)],30)
 finally:os._exit(0)
deadline=time.monotonic()+15
while not (results/'waiting').exists():assert time.monotonic()<deadline;time.sleep(.05)
financial=int((results/'waiting').read_text());assert not lock_available();os.kill(caller,signal.SIGKILL);os.waitpid(caller,0)
deadline=time.monotonic()+10
while not lock_available():assert time.monotonic()<deadline;time.sleep(.05)
assert not Path('/proc/'+str(financial)).exists();passed.append('caller SIGKILL: surviving root keeper reaps consumer before releasing flock')
subprocess.run(['/bin/umount',str(vault)],check=True)
print(json.dumps({'pass':True,'cases':passed,'scope':'synthetic tmpfs; not LUKS/real-credential/production deployment proof'}),flush=True)
