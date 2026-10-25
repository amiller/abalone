#!/usr/bin/env python3
"""Actual deploy entrypoint against synthetic account DB, only in isolated user/mount namespace."""
import json, os, pathlib, shutil, subprocess, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
assert os.environ.get('PORTABLE_TESTS_IN_NS') == '1' and os.getuid()==0
work=pathlib.Path('/run/account-deployment-tests'); work.mkdir()
bin=work/'bin';bin.mkdir()
shim='''#!/usr/bin/python3
import os,sys,json,pathlib
p=pathlib.Path(os.environ['ACCOUNT_DB']);d=json.loads(p.read_text());a=sys.argv[1:];cmd=pathlib.Path(sys.argv[0]).name
if cmd=='getent':
 rows=d[a[0]];rows=[r for r in rows if r.split(':')[0]==a[1] or r.split(':')[2]==a[1]]
 if not rows:sys.exit(2)
 print('\\n'.join(rows));sys.exit()
if cmd=='id':
 if a==['-u']:print(0);sys.exit()
 name=a[-1];row=next(r.split(':') for r in d['passwd'] if r.split(':')[0]==name)
 groups=[r.split(':')[0] for r in d['group'] if r.split(':')[2]==row[3] or name in r.split(':')[3].split(',')]
 print(' '.join(groups));sys.exit()
if cmd=='chown':sys.exit()
with open(os.environ['ACCOUNT_LOG'],'a') as f:f.write(cmd+' '+str(a)+'\\n')
if cmd=='groupadd':d['group'].append(a[-1]+':x:'+a[a.index('--gid')+1]+':')
if cmd=='useradd':
 name=a[-1];gid=next(r.split(':')[2] for r in d['group'] if r.split(':')[0]==a[a.index('--gid')+1]);d['passwd'].append(':'.join([name,'x',a[a.index('--uid')+1],gid,'',a[a.index('--home-dir')+1],a[a.index('--shell')+1]]))
 if '--groups' in a:
  group=a[a.index('--groups')+1];d['group']=[r+(',' if r.split(':')[3] else '')+name if r.startswith(group+':') else r for r in d['group']]
p.write_text(json.dumps(d))
'''
for name in ('getent','id','chown','groupadd','useradd'):
 p=bin/name;p.write_text(shim);p.chmod(0o755)
count=0
def run(name,db,success=False, old_config=False):
 global count
 case=work/name;case.mkdir();database=case/'db';database.write_text(json.dumps(db));log=case/'calls'
 if old_config:
  (case/'opt/etc').mkdir(parents=True)
  config=case/'opt/etc/vault.conf';config.write_text('BROKER_ALLOWED_UIDS=portable-ui,portable-credit\n');config.chmod(0o600)
 env=dict(os.environ,PATH=str(bin)+':'+os.environ['PATH'],ACCOUNT_DB=str(database),ACCOUNT_LOG=str(log))
 r=subprocess.run(['bash',str(ROOT/'guest/deploy.sh'),'--prefix',str(case/'opt'),'--state-lib-dir',str(case/'state')],env=env,capture_output=True,text=True)
 assert (r.returncode==0)==success,(name,r.returncode,r.stdout,r.stderr)
 if not success:assert not log.exists() and not (case/'opt/bin').exists(),name+' mutated before refusal'
 count+=1;print('ok account-deploy',name)
 return json.loads(database.read_text())
fresh=run('fresh',{'passwd':[],'group':[]},True)
run('idempotent',fresh,True)
assert not (work/'idempotent/calls').exists()
run('legacy-privileged-config',fresh,old_config=True)
for label,field,value in [('wrong-uid',2,'123'),('wrong-gid',3,'123'),('wrong-home',5,'/tmp'),('wrong-shell',6,'/bin/bash')]:
 d=json.loads(json.dumps(fresh));row=d['passwd'][1].split(':');row[field]=value;d['passwd'][1]=':'.join(row);run(label,d)
for member in ('portable-ui','portable-agent','root'):
 d=json.loads(json.dumps(fresh));d['group']=[r+','+member if r.startswith('portable-operators:') else r for r in d['group']];run('operator-'+member,d)
d=json.loads(json.dumps(fresh));d['group'].append('sudo:x:27:portable-ui');run('sudo-ui',d)
run('uid-collision',{'passwd':['other:x:970:970::/nonexistent:/usr/sbin/nologin'],'group':[]})
run('gid-collision',{'passwd':[],'group':['other:x:970:']})
# Existing credit must already have the complete expected authority graph.
d=json.loads(json.dumps(fresh));d['group']=[r.split(':')[0]+':x:973:' if r.startswith('portable-operators:') else r for r in d['group']];run('credit-missing-operator',d)
run('ipc-gid-collision',{'passwd':[],'group':['other:x:974:']})
for member in ('portable-agent','portable-ui'):
 d=json.loads(json.dumps(fresh));d['group']=[r.replace('portable-agent,portable-ui',member) if r.startswith('portable-ipc:') else r for r in d['group']];run('ipc-missing-'+member,d)
d=json.loads(json.dumps(fresh));d['group']=[r+',portable-credit' if r.startswith('portable-ipc:') else r for r in d['group']];run('ipc-unexpected-credit',d)
print('account deployment checks:',count)
