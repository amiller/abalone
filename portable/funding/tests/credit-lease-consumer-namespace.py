#!/usr/bin/python3
"""Supervisor-only fresh namespace fixture; synthetic credentials, no network.
NODE names the node binary to copy into the namespace."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

assert os.getuid()==0
assert [line.split(':')[0].strip() for line in Path('/proc/net/dev').read_text().splitlines()[2:]]==['lo']
subprocess.run(['/bin/mount','--make-rprivate','/'],check=True)
# Preserve inherited /run subtree at an owned private path; never stack /run.
previous=tempfile.mkdtemp(prefix='credit-old-run-',dir='/tmp')
Path(__file__).with_name('preserved-run.json').write_text(json.dumps({'path':previous,'scope':'owned private mount namespace only'}))
subprocess.run(['/bin/mount','-n','--move','/run',previous],check=True)
subprocess.run(['/bin/mount','-t','tmpfs','-o','size=256m,mode=0755','tmpfs','/run'],check=True)
source=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(source/'raspberry-pi/storage'))
import financial_lease as m
root=Path('/run/credit-consumer-proof');root.mkdir(mode=0o755)
node=root/'node';shutil.copyfile(os.environ['NODE'],node);node.chmod(0o755)
for relative in [*(('portable/funding/'+n) for n in ('credit-lease-entry.mjs','inherited-lease.mjs','ppq-record.mjs','ppq-balance-curl.mjs','credit-service.mjs')), 'lib/provider-balance.mjs','lib/provider-credit-projection.mjs','portable/workspace-service/syscred.mjs','portable/workspace/credit-client.mjs']:
    target=root/relative;target.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
    shutil.copyfile(source.parent/relative,target);target.chmod(0o644)
results=root/'results';results.mkdir(mode=0o700);os.chown(results,972,972)
socketdir=Path('/run/portable-credit');socketdir.mkdir(mode=0o755);os.chown(socketdir,972,972)
vault=Path(m.MOUNT);vault.mkdir(mode=0o755)
subprocess.run(['/bin/mount','-t','tmpfs','-o','size=8m,nodev,nosuid,noexec,mode=0755','tmpfs',str(vault)],check=True)
credit=vault/'credit';credit.mkdir(mode=0o700);os.chown(credit,972,972)
record=credit/m.RECORD
def write_record(value):
    record.write_text(json.dumps(value));record.chmod(0o600);os.chown(record,972,972)
def fixture():return m.HeldLease(m.lifecycle_lock(),lambda:m.view('tmpfs'),{'fixture':'tmpfs-not-LUKS'})
def lock_available():
    fd=os.open(m.LOCK,os.O_RDWR)
    try:
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);return True
        except BlockingIOError:return False
    finally:os.close(fd)
consumer=root/'consumer.mjs'
consumer.write_text('''import fs from 'node:fs';import {spawn} from 'node:child_process';
import {inheritedLease} from './portable/funding/inherited-lease.mjs';import {startLeasedCredit} from './portable/funding/credit-lease-entry.mjs';import {runBalanceCurl} from './portable/funding/ppq-balance-curl.mjs';
const transport=(request,options)=>runBalanceCurl(request,options,(file,args,opts)=>{
 if(file!=='/usr/bin/curl'||args[0]!=='-q'||!args.includes('socks5h://127.0.0.1:9050')||args.join(' ').includes('SYNTHETIC_CREDIT'))throw Error('command');
 const code=`import sys,json;v=json.load(sys.stdin);assert v=={"credit_id":"SYNTHETIC_CREDIT"};print(json.dumps({"balance":2.5}));print(200,end="")`;
 fs.writeFileSync('/run/credit-consumer-proof/results/transport','synthetic');return spawn('/usr/bin/python3',['-c',code],opts);
});
try{const service=await startLeasedCredit({lease:await inheritedLease(),transport});fs.writeFileSync('/run/credit-consumer-proof/results/ready',String(process.pid));process.on('SIGTERM',()=>service.stop().then(()=>process.exit(0),()=>process.exit(1)));}catch{process.exitCode=1;}
''');consumer.chmod(0o644)
client=root/'client.mjs';client.write_text("import {createCreditClient} from './portable/workspace/credit-client.mjs';const c=createCreditClient({socketPath:'/run/portable-credit/credit.sock'});console.log(JSON.stringify(await c.status()));await c.close();");client.chmod(0o644)
passed=[]
# Exact-schema failures must occur before the synthetic transport even starts.
for value in ({'authorization':'Bearer SYNTHETIC_CREDIT','userCacheSecret':'fixture'}, {'version':2,'provider':'ppq','creditId':'SYNTHETIC_CREDIT'}, {'version':1,'provider':'other','creditId':'SYNTHETIC_CREDIT'}, {'version':1,'provider':'ppq','creditId':''}, {'version':1,'provider':'ppq','creditId':'x'*513}, {'version':1,'provider':'ppq','creditId':'SYNTHETIC_CREDIT','extra':True}):
    write_record(value)
    started=time.monotonic()
    assert not m._keep(fixture(),[str(node),str(consumer)],15)
    assert time.monotonic()-started<8, 'schema refusal must not be supervisor timeout'
    assert lock_available() and not (results/'transport').exists()
    assert not (results/'ready').exists() and not (socketdir/'credit.sock').exists()
passed.append('wrong provider/versioned schema, SDK auth, empty/oversize/extra fields refuse before transport')
write_record({'version':1,'provider':'ppq','creditId':'SYNTHETIC_CREDIT'})
caller=os.fork()
if caller==0:
    try:ok=m._keep(fixture(),[str(node),str(consumer)],30)
    except BaseException:ok=False
    os._exit(0 if ok else 1)
deadline=time.monotonic()+15
while not (results/'ready').exists():assert time.monotonic()<deadline;time.sleep(.05)
financial=int((results/'ready').read_text());assert not lock_available()
def read(uid):
    result=subprocess.run(['/usr/bin/setpriv','--reuid='+str(uid),'--regid='+str(uid),'--clear-groups',str(node),str(client)],capture_output=True,text=True,timeout=5,check=True)
    assert 'SYNTHETIC_CREDIT' not in result.stdout+result.stderr
    return json.loads(result.stdout)
deadline=time.monotonic()+10
while True:
    value=read(971)
    if (value.get('accountBalance') or {}).get('amountDecimal')=='2.5':break
    assert time.monotonic()<deadline;time.sleep(.1)
assert value['state']=='configured' and value['allowance']['state']=='unknown' and value['funding']['state']=='not-configured'
assert read(970)['state']=='unavailable'
passed.append('real inherited lease -> strict record -> bounded synthetic curl child -> monitor -> UID972 credit service -> authenticated UID971 client; UID970 denied; no secret in projection')
os.kill(financial,signal.SIGTERM);_,status=os.waitpid(caller,0)
assert os.waitstatus_to_exitcode(status)==0 and lock_available()
assert not Path('/proc/'+str(financial)).exists() and read(971)['state']=='unavailable'
passed.append('SIGTERM drains service/monitor, releases lease, reaps consumer, unlocks and leaves client unavailable')
subprocess.run(['/bin/umount','-n',str(vault)],check=True)
subprocess.run(['/bin/umount','-n','/run'],check=True)
subprocess.run(['/bin/mount','-n','--move',previous,'/run'],check=True)
os.rmdir(previous)
print(json.dumps({'pass':True,'cases':passed,'scope':'fresh tmpfs, synthetic curl fixture; no provider call or installed unit'}),flush=True)
