# SPDX-License-Identifier: MIT
"""Fixed NEAR credential switch while root operator retains vault lifecycle custody."""
import hashlib,importlib.util,json,os,stat
from pathlib import Path
BASE=Path('/run/portable-vault/funding');CREDIT=Path('/run/portable-vault/credit')
def require(v):
 if not v:raise ValueError('credential switch refused')
def unique(pairs):
 result={}
 for k,v in pairs:
  require(k not in result);result[k]=v
 return result
def private(path):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd);require(stat.S_ISREG(s.st_mode) and (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode),s.st_nlink)==(972,972,0o600,1) and 0<s.st_size<=16384)
  raw=os.read(fd,16385);require(len(raw)==s.st_size);return raw,(s.st_dev,s.st_ino)
 finally:os.close(fd)
def sync(path):
 fd=os.open(path,os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)
def switch(check):
 require(os.getuid()==0);check()
 for p in (BASE,CREDIT):
  s=p.lstat();require(stat.S_ISDIR(s.st_mode) and (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(972,972,0o700))
 source=BASE/'provider-next.json';target=CREDIT/'provider.json';backup=BASE/'provider-previous.json';intent=BASE/'activation-intent.json'
 require(not intent.exists() and not backup.exists())
 raw,identity=private(source);record=json.loads(raw,object_pairs_hook=unique);require(type(record.get('version')) is int)
 from enrollment import credentials
 expected=credentials(bytearray(b'validate'),bytearray(b'validate'),bytearray(record['apiKey'].encode('ascii')),provider='near',account=record.get('account'))
 require(record==json.loads(expected))
 old,oldid=private(target)
 path=Path(__file__).resolve().parent.parent/'raspberry-pi/storage/guest/vault-broker.py';spec=importlib.util.spec_from_file_location('fixed_credit_control',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 broker=module.Broker.__new__(module.Broker)
 rc,_,_,timed=broker.run_supervisor('stop',30);require(rc==0 and not timed)
 props,error=broker.show_credit(('ActiveState','MainPID','ControlGroup'),10)
 require(not error and props['ActiveState'] in ('inactive','failed') and props['MainPID']=='0' and broker.credit_cgroup_empty(props['ControlGroup'])[0])
 check();require(private(source)==(raw,identity) and private(target)==(old,oldid))
 # The stopped consumer cannot refresh its account sidecar during this switch.
 sidecar=CREDIT/'near-account.json';side=None
 try:side=private(sidecar)
 except FileNotFoundError:pass
 if side is not None:
  account=json.loads(side[0],object_pairs_hook=unique)
  previous=json.loads(old,object_pairs_hook=unique)
  require(type(account) is dict and set(account)=={'organizationId','accessToken'})
  credentials(bytearray(b'validate'),bytearray(b'validate'),bytearray(record['apiKey'].encode('ascii')),provider='near',account=account)
  require(account['organizationId']==previous.get('account',{}).get('organizationId'))
 fd=os.open(intent,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:os.write(fd,json.dumps({'oldSha256':hashlib.sha256(old).hexdigest(),'newSha256':hashlib.sha256(raw).hexdigest(),'state':'switching-no-retry'}).encode());os.fsync(fd)
 finally:os.close(fd)
 sync(BASE);os.link(target,backup,follow_symlinks=False);sync(BASE)
 if side is not None:
  check();require(private(sidecar)==side)
  os.unlink(sidecar);sync(CREDIT)
 # New provider.account is the balance fallback until its own refresh sidecar.
 os.replace(source,target);sync(CREDIT);sync(BASE);check()
 rc,_,_,timed=broker.run_supervisor('start',30);require(rc==0 and not timed)
 props,error=broker.show_credit(('ActiveState','MainPID'),10)
 require(not error and props['ActiveState']=='active' and props['MainPID'].isdigit() and int(props['MainPID'])>0)
 receipt=BASE/'activation-complete.json';fd=os.open(receipt,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:os.write(fd,b'{"state":"funded-and-service-started"}\n');os.fchown(fd,972,972);os.fsync(fd)
 finally:os.close(fd)
 sync(BASE)
 return {'state':'funded-and-service-started','previousCredentialPreserved':True,'inferenceReadiness':'next-agent-status-probe','walletAuthoritySharedWithAgent':False}
