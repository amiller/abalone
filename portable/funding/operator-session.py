#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""UID972 fixed operator child. Keys stay in encrypted funding custody."""
import argparse,hashlib,importlib.util,json,os,signal,sys,time,urllib.request
from pathlib import Path
sys.path.insert(0,'/opt/portable/funding-runtime/deps')
sys.path.insert(0,str(Path(__file__).resolve().parent))
sys.path.insert(0,str(Path(__file__).resolve().parent/'near_fund'))
import context,flow
BASE=Path('/run/portable-vault/funding');STATE=BASE/'attempts/current'
def atomic_private(path,value):
 temp=path.with_name(path.name+'.new');context.save(temp,value);os.replace(temp,path);context.syncdir(path.parent)
def main():
 if os.getuid()!=972:raise ValueError('operator identity')
 context.protect_process();context.private_directory(BASE)
 if not (BASE/'transit-private.json').exists():return {'state':'funding-not-set-up'}
 command=sys.argv[1];dollars=int(sys.argv[2]) if command=='fund' and len(sys.argv)==3 else 2
 if (BASE/'new-demo-intent.json').exists():raise ValueError('archive incomplete')
 if command=='new-demo':
  from archive import closed_cycle
  closed_cycle(BASE);command='fund'
 from near_fund.account import Account
 (BASE/'account').mkdir(mode=0o700,exist_ok=True)
 account=Account(BASE/'account')
 def prepare_account():
  transit=context.read(BASE/'transit-private.json')
  if set(transit)!={'baseAddress','basePrivateKey','refundAddress','refundBackupVerified'} or transit['refundBackupVerified'] is not True:raise ValueError('transit custody refused')
  from near_fund import activation
  from near_fund.activation import Activation
  activation.PAYER=transit['baseAddress']
  def activate_identity(identity):
   print(json.dumps({'state':'account-activation','nativeNEAR':'0.01','inferenceCreditPurchased':False}),flush=True)
   result=Activation(BASE/'account/activation',identity,transit).ensure()
   print(json.dumps({'state':'account-activated-authenticating'}),flush=True);return result
  value=account.ensure_session() if (BASE/'account/session.json').exists() else account.bootstrap(before_auth=activate_identity)
  config={'version':1,'organizationId':value['organizationId'],'session':value['session'],'userAgent':value['userAgent'],**transit}
  atomic_private(BASE/'config.json',config)
  context.configure(BASE/'config.json')
 def activate():
  record=account.issue_key();session=account.ensure_session()
  record['account']={'organizationId':session['organizationId'],'accessToken':session['session']['access_token']}
  context.save(BASE/'provider-next.json',record)
  return {'state':'funded','inferenceCredentialPrepared':True,'activation':'trusted-controller-stop-drain-install-restart-required'}
 spec=importlib.util.spec_from_file_location('fixed_near_fund',Path(__file__).with_name('near-fund.py'));cli=importlib.util.module_from_spec(spec);spec.loader.exec_module(cli)
 def run(command,sha=None):
  prepare_account() # bounded seed-free refresh before each finite funding operation
  saved=STATE/'payment/unsigned-plan.json'
  if command=='prepare-payment' and saved.exists():
   plan=context.read(saved);plan['planSha256']=hashlib.sha256(saved.read_bytes()).hexdigest();return plan
  return cli.execute(argparse.Namespace(config=str(BASE/'config.json'),state=str(STATE),command=command,plan_sha=sha,amount=dollars))
 def emit(value):print(json.dumps(value),flush=True)
 def retire(kind,outcome=None):
  if outcome:context.save(STATE/'outcome.json',outcome)
  os.rename(STATE,STATE.with_name(time.strftime('%Y%m%dT%H%M%SZ-',time.gmtime())+kind));context.syncdir(STATE.parent)
  emit({'phase':'retired','kind':kind})
 def complete(payment):
  credit='%.2f'%(context.read(STATE/'invoice-intent.json')['amount']/100)
  if not (BASE/'activation-complete.json').exists():
   emit({'phase':'funded','creditUSD':credit,'key':None});return activate()
  # Replenish: the key may spend everything the account now holds.
  key=account.key_standing();target=key['usageNanoUSD']+cli.baseline()['remaining']
  if target>key['limitNanoUSD']:key=account.set_key_limit(target)
  retire('funded',{'state':'funded','invoiceId':payment['invoiceId'],'creditUSD':credit,'observedUTC':payment['accountCredit']['observedUTC']})
  emit({'phase':'funded','creditUSD':credit,'key':key})
 def standing():
  funded=sorted(p for p in (BASE/'attempts').iterdir() if p.name.endswith('-funded'))
  return {'phase':'standing','account':cli.baseline(),'key':account.key_standing(),'lastFunding':context.read(funded[-1]/'outcome.json') if funded else None}
 sha=sys.argv[2] if len(sys.argv)==3 else None
 if command=='fund':
  prepare_account();emit(standing())
  # An attempt that never displayed its deposit address cannot have been paid.
  if STATE.exists() and not (STATE/'incoming/review.json').exists():retire('unissued')
  return flow.fund(run,prepare_account,complete,retire,emit,existing=STATE.exists())
 prepare_account()
 if command=='key-limit':return {'state':'key-limit-set','key':account.set_key_limit(int(sha))}
 if command=='fresh':return {'state':'account-ready'}
 if command=='activate':
  proof=run('status')['payment']
  if proof.get('invoiceLinkedAndCreditIncreaseObserved') is not True:raise ValueError('credit proof absent')
  return activate()
 return run(command,sha)
def cancelled(*_):
 # Enter Python finally blocks once; repeated polite signals cannot interrupt reap.
 for signum in (signal.SIGTERM,signal.SIGINT):signal.signal(signum,signal.SIG_IGN)
 raise KeyboardInterrupt()
if __name__=='__main__':
 signal.signal(signal.SIGTERM,cancelled);signal.signal(signal.SIGINT,cancelled)
 try:result=main()
 except BaseException as error:result={'state':'unknown','reason':'operator-step-refused-reconcile-same-attempt','error':'%s: %s'%(type(error).__name__,error),'retryPerformed':False,'transportDiagnostic':context.transport_diagnostic()};print(json.dumps(result));sys.exit(1)
 print(json.dumps(result))
