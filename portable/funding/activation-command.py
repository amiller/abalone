#!/usr/bin/python3
# SPDX-License-Identifier: MIT
"""Trusted maintenance of current retained identity; no authentication or inference-credit purchase."""
import hashlib,json,os,pathlib,signal,sys
sys.path.insert(0,'/opt/portable/funding-runtime/deps')
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from near_fund import context
from near_fund.activation import Activation,need
B=pathlib.Path('/run/portable-vault/funding')
def main():
 need(os.getuid()==os.getgid()==972 and len(sys.argv) in (2,3));context.protect_process()
 import base58
 from nacl.signing import SigningKey
 i=context.read(B/'account/identity-private.json');public=bytes(SigningKey(bytes.fromhex(i['seedHex'])).verify_key);need(i['accountId']==public.hex())
 a=Activation(B/'account/activation',{'accountId':public.hex(),'publicKey':'ed25519:'+base58.b58encode(public).decode()},context.read(B/'transit-private.json'))
 command=sys.argv[1]
 if command=='status' and len(sys.argv)==2:return a.status()
 if command=='prepare' and len(sys.argv)==2:return a.prepare()
 if command=='plan' and len(sys.argv)==2:
  plan,_=a.plan();context.save(a.d/'review-001.json',plan)
  return {'state':'planned','review':plan,'planSha256':hashlib.sha256(json.dumps(plan,sort_keys=True).encode()).hexdigest()}
 if command=='send-reviewed' and len(sys.argv)==3:
  saved=context.read(a.d/'review-001.json');need(hashlib.sha256(json.dumps(saved,sort_keys=True).encode()).hexdigest()==sys.argv[2]);return a.send(sys.argv[2])
 raise ValueError('activation command refused')
def cancelled(*_):
 # Enter Python finally blocks once; repeated polite signals cannot interrupt reap.
 for signum in (signal.SIGTERM,signal.SIGINT):signal.signal(signum,signal.SIG_IGN)
 raise KeyboardInterrupt()
if __name__=='__main__':
 signal.signal(signal.SIGTERM,cancelled);signal.signal(signal.SIGINT,cancelled)
 try:print(json.dumps(main()))
 except BaseException:
  # Never assert no-send: the durable submission intent may precede a timeout.
  print(json.dumps({'state':'unknown-reconcile-same-attempt','automaticRetry':False,'transportDiagnostic':context.transport_diagnostic()}));sys.exit(1)
