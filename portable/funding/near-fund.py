#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Operator-only NEAR credit route ($2 unless --amount). No inference-key authority."""
import argparse,fcntl,json,os,re,sys,urllib.request
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent/'near_fund'))
import context as custody
import incoming,payment

def baseline():
 org=custody.config()['organizationId'];code,b=custody.call('/v1/organizations/'+org+'/usage/balance',custody.config()['session']['access_token'])
 if code!=200 or b.get('organization_id')!=org:raise ValueError('baseline refused')
 # The API omits optional limits for a proven fresh, empty organization.
 if 'remaining' not in b and 'spend_limit' not in b:
  if b.get('credit_limits')!=[] or any(type(b.get(k)) is not int or b[k]!=0 for k in ('total_spent','unfunded_amount','legacy_unattributed_amount')):raise ValueError('empty baseline unproved')
  return {'organization_id':org,'remaining':0,'total_spent':0}
 if any(type(b.get(k)) is not int or b[k]<0 for k in ('remaining','total_spent')):raise ValueError('baseline refused')
 return {k:b[k] for k in ('organization_id','remaining','total_spent')}

def preinvoice_state(state):
 if not state.exists():return False
 custody.private_directory(state)
 return {p.name for p in state.iterdir()} in ({'binding.json'},{'binding.json','baseline-credit.json'})

def new_attempt(state,binding,dollars):
 expected={'version':1,'contextSha256':binding}
 if state.exists():
  if not preinvoice_state(state) or custody.read(state/'binding.json')!=expected:raise ValueError('attempt exists; reconcile')
 else:
  state.mkdir(mode=0o700);custody.syncdir(state.parent);custody.save(state/'binding.json',expected)
 saved=state/'baseline-credit.json'
 if saved.exists():
  b=custody.read(saved)
  if set(b)!={'organization_id','remaining','total_spent'} or b['organization_id']!=custody.config()['organizationId'] or any(type(b[k]) is not int or b[k]<0 for k in ('remaining','total_spent')):raise ValueError('saved baseline refused')
 else:custody.save(saved,baseline())
 # Exclusive intent is the POST boundary; existing intent is NEVER resumed here.
 custody.save(state/'invoice-intent.json',{'organizationId':custody.config()['organizationId'],'amount':dollars*100})
 result=payment.cloud('/api/pingpay/create-checkout-session',{'organizationId':custody.config()['organizationId'],'amount':dollars*100})
 if not isinstance(result,dict) or not isinstance(result.get('sessionId'),str) or not re.fullmatch('[A-Za-z0-9_-]{1,128}',result['sessionId']):raise ValueError('invoice refused')
 custody.save(state/'invoice.json',{'sessionId':result['sessionId']})
 return incoming.prepare()

def status():
 payment_state=payment.status()
 try:incoming_state=incoming.status()
 except custody.TransportReadError:incoming_state={'state':'unknown','reason':'http-read-unavailable','swapState':'UNKNOWN','incomingUSDCObserved':False,'acceptNewDeposit':False}
 return {'incoming':incoming_state,'payment':payment_state,'assetTransferSentByThisCommand':False}

def execute(args):
 if os.getuid() in (970,971):raise ValueError('financial operator required')
 binding=custody.configure(args.config)
 if args.command=='credit':
  value=baseline()
  return {'state':'known','unit':'nanoUSD','accountCredit':value,'invoiceAttribution':None,'assetTransferSentByThisCommand':False}
 if not args.state:raise ValueError('state required')
 state=Path(args.state).absolute();custody.private_directory(state.parent)
 incoming.E=payment.E=state;incoming.D=state/'incoming';payment.P=state/'payment';incoming.PAYER=custody.config()['baseAddress']
 # One lock for this operator state parent; no async status racing a send.
 lock=os.open(state.parent/'.near-fund.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
 try:
  import stat
  s=os.fstat(lock)
  if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_nlink!=1 or stat.S_IMODE(s.st_mode)!=0o600:raise ValueError('lock refused')
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  if args.command=='new':
   if type(args.amount) is not int or not 1<=args.amount<=10:raise ValueError('amount refused')
   incoming.UNITS=args.amount*1000000;return new_attempt(state,binding,args.amount)
  custody.private_directory(state)
  if custody.read(state/'binding.json')!={'version':1,'contextSha256':binding}:raise ValueError('context changed')
  incoming.UNITS=custody.read(state/'invoice-intent.json')['amount']*10000
  for sub in (incoming.D,payment.P):
   if sub.exists():custody.private_directory(sub)
  if args.command in ('status','resume'):return status()
  if args.command=='prepare-payment':
   result=payment.prepare();result['planSha256']=__import__('hashlib').sha256((payment.P/'unsigned-plan.json').read_bytes()).hexdigest();result['planPath']=str(payment.P/'unsigned-plan.json');return result
  if args.command=='send-reviewed':return payment.send_reviewed(args.plan_sha)
  raise ValueError('command refused')
 finally:os.close(lock)

def main():
 parser=argparse.ArgumentParser(description=__doc__)
 parser.add_argument('--config',required=True,help='operator-owned0600 private JSON in0700 directory')
 parser.add_argument('--state',help='exclusive attempt directory under private0700 parent')
 parser.add_argument('command',choices=['new','status','resume','prepare-payment','send-reviewed','credit'])
 parser.add_argument('plan_sha',nargs='?');parser.add_argument('--amount',type=int,default=2,help='whole USD for a new attempt');a=parser.parse_args()
 if (a.command=='send-reviewed')!=(a.plan_sha is not None):parser.error('plan hash only with send-reviewed')
 try:r=execute(a)
 except Exception:
  r={'state':'unknown','reason':'operation-refused','retryPerformed':False}
  if payment.P is not None:
   try:
    if (payment.P/'submission-intent-private.json').exists():r=payment.failure_result()
   except Exception:pass
  print(json.dumps(r));return 1
 print(json.dumps(r));return 0
if __name__=='__main__':raise SystemExit(main())
