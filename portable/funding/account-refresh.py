#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Fixed seed-free account renewal child of the leased NEAR credit monitor."""
import os,signal,sys
from pathlib import Path
sys.path.insert(0,'/opt/portable/funding-runtime/deps')
sys.path.insert(0,str(Path(__file__).resolve().parent))
from near_fund.account import Account,AccountUnavailable,read,require
ACCOUNT=Path('/run/portable-vault/funding/account')
PRIOR=Path('/run/portable-vault/funding/prior-account')
CREDIT=Path('/run/portable-vault/credit')
def refresh(account,credit=CREDIT):
 provider=read(credit/'provider.json');state=account.load()
 require(provider.get('provider')=='near' and provider.get('model')=='z-ai/glm-5.3-flash' and provider.get('version')==1 and isinstance(provider.get('account'),dict) and provider['account'].get('organizationId')==state['organizationId'])
 # Bind BEFORE the only refresh POST, not merely before publishing the result.
 account.ensure_session(force=True);account.publish_balance_account(credit)
def select_account(credit=CREDIT,current=ACCOUNT,prior=PRIOR):
 provider=read(credit/'provider.json')
 require(provider.get('provider')=='near' and isinstance(provider.get('account'),dict))
 expected=provider['account'].get('organizationId');matches=[]
 try:
  for directory in (current,prior):
   account=None
   try:
    account=Account(directory)
    if account.load()['organizationId']==expected:
     identity=os.fstat(account._fd)
     if any((os.fstat(item._fd).st_dev,os.fstat(item._fd).st_ino)==(identity.st_dev,identity.st_ino) for item in matches):account.close()
     else:matches.append(account)
     account=None
   except (AccountUnavailable,FileNotFoundError):pass
   finally:
    if account is not None:account.close()
  require(len(matches)==1)
  return matches.pop()
 finally:
  for account in matches:account.close()
def cancelled(*args):
 # One cancellation enters cleanup; repeated polite signals cannot interrupt reap.
 for signum in (signal.SIGTERM,signal.SIGINT,signal.SIGALRM):signal.signal(signum,signal.SIG_IGN)
 signal.setitimer(signal.ITIMER_REAL,0)
 raise RuntimeError('Account refresh cancelled')
def main():
 try:
  require(len(sys.argv)==1 and os.getuid()==os.getgid()==972 and os.getgroups()==[])
  status=Path('/proc/self/status').read_text()
  require(all('\n'+k+':\t0000000000000000\n' in '\n'+status for k in ('CapPrm','CapEff','CapInh','CapAmb')) and '\nNoNewPrivs:\t1\n' in '\n'+status)
  signal.signal(signal.SIGTERM,cancelled);signal.signal(signal.SIGINT,cancelled);signal.signal(signal.SIGALRM,cancelled)
  signal.setitimer(signal.ITIMER_REAL,20)
  account=select_account()
  try:refresh(account)
  finally:account.close()
  print('ACCOUNT_REFRESHED',flush=True);return 0
 except BaseException:
  print('ACCOUNT_UNAVAILABLE',flush=True);return 1
 finally:signal.setitimer(signal.ITIMER_REAL,0)
if __name__=='__main__':raise SystemExit(main())
