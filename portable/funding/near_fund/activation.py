# SPDX-License-Identifier: MIT
"""Fixed 0.01 NEAR implicit-account activation; separate from inference credit."""
import datetime,hashlib,json,os,re,time,urllib.parse,urllib.request
from pathlib import Path
from . import context
PAYER=None # the custody record's baseAddress, set by the operator session
NEAR='https://rpc.mainnet.near.org';BASE='https://base-rpc.publicnode.com';CLICK='https://1click.chaindefuser.com'
OUT=10**22;MAX_INPUT=3*10**13;MAX_ESTIMATE=4*10**13

def need(v):
 if not v:raise ValueError('account activation refused; reconcile same attempt')
def request(url,body=None,*,response_sink=None):
 raw=None if body is None else json.dumps(body,separators=(',',':')).encode()
 response,code=context.curl_request(urllib.request.Request(url,data=raw,headers={'Content-Type':'application/json','User-Agent':'dsmack-portable-account/1.0'},method='GET' if body is None else 'POST'),response_sink=response_sink)
 need(code in (200,201));return json.loads(response)
def now():return datetime.datetime.now(datetime.timezone.utc)
def integer(v):
 need(type(v) is str and re.fullmatch('0|[1-9][0-9]*',v));return int(v)
def terms(identity,deadline):
 return dict(dry=False,swapType='EXACT_OUTPUT',slippageTolerance=100,originAsset='nep141:base.omft.near',depositType='ORIGIN_CHAIN',destinationAsset='nep141:wrap.near',amount=str(OUT),refundTo=PAYER,refundType='ORIGIN_CHAIN',recipient=identity['accountId'],recipientType='DESTINATION_CHAIN',deadline=deadline,quoteWaitingTimeMs=3000)
def utc_millisecond(value):
 need(type(value) is str and re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)',value))
 parsed=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
 need(parsed.utcoffset()==datetime.timedelta(0))
 return parsed.replace(microsecond=(parsed.microsecond//1000)*1000)
def validate(q,wanted,fresh=True):
 need(all(q['quoteRequest'].get(k)==v for k,v in wanted.items() if k!='deadline'))
 need(utc_millisecond(q['quoteRequest'].get('deadline'))==utc_millisecond(wanted['deadline']));v=q['quote']
 need(integer(v['amountOut'])==OUT and integer(v['minAmountOut'])>=OUT and 0<integer(v['amountIn'])<=MAX_INPUT)
 need(re.fullmatch('0x[0-9a-fA-F]{40}',v['depositAddress']))
 dates=[utc_millisecond(x) for x in (wanted['deadline'],v['deadline'])]
 need(all(x.utcoffset()==datetime.timedelta(0) for x in dates))
 if fresh:need((min(dates)-now()).total_seconds()>=1500)
 return v
class Activation:
 def __init__(self,directory,identity,transit,request=request):
  import base58
  need(set(identity)=={'accountId','publicKey'} and re.fullmatch('[a-f0-9]{64}',identity['accountId']))
  need(identity['publicKey'].startswith('ed25519:') and base58.b58decode(identity['publicKey'][8:]).hex()==identity['accountId'])
  need(transit['baseAddress'].lower()==PAYER.lower())
  self.d=Path(directory);self.identity=dict(identity);self.transit=transit;self.request=request
  if not self.d.exists():self.d.mkdir(mode=0o700);context.syncdir(self.d.parent)
  context.private_directory(self.d)
 def rpc(self,method,params):
  r=self.request(BASE,{'jsonrpc':'2.0','id':1,'method':method,'params':params});need('error' not in r and 'result' in r);return r['result']
 def chain_ready(self):
  # Some RPCs return legacy key-query error objects under result for absent
  # implicit accounts. Establish account existence first, then require exactkey.
  account=self.request(NEAR,{'jsonrpc':'2.0','id':1,'method':'query','params':{'request_type':'view_account','finality':'final','account_id':self.identity['accountId']}})
  if 'error' in account:
   need(account['error'].get('cause',{}).get('name')=='UNKNOWN_ACCOUNT');return False
  need(type(account.get('result')) is dict and integer(account['result']['amount'])>=0)
  r=self.request(NEAR,{'jsonrpc':'2.0','id':1,'method':'query','params':{'request_type':'view_access_key','finality':'final','account_id':self.identity['accountId'],'public_key':self.identity['publicKey']}})
  need('error' not in r and type(r.get('result')) is dict and r['result'].get('permission')=='FullAccess' and type(r['result'].get('nonce')) is int);return True
 def prepare(self):
  if self.chain_ready():return {'state':'activated','spendRequired':False}
  need(not (self.d/'quote-intent.json').exists())
  wanted=terms(self.identity,(now()+datetime.timedelta(minutes=30)).isoformat(timespec='milliseconds').replace('+00:00','Z'))
  context.save(self.d/'quote-intent.json',{'identity':self.identity,'request':wanted,'automaticRetry':False})
  def retain(raw,status):
   need(type(raw) is bytes and len(raw)<=262144 and type(status) is int and 100<=status<=599)
   fd=os.open(self.d/'quote-response.private',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
   try:
    view=memoryview(raw)
    while view:
     n=os.write(fd,view);need(n>0);view=view[n:]
    os.fsync(fd)
   finally:os.close(fd)
   context.syncdir(self.d)
   context.save(self.d/'quote-response-status.json',{'httpStatus':status,'bytes':len(raw)})
  q=self.request(CLICK+'/v0/quote',wanted,response_sink=retain);context.save(self.d/'quote-private.json',q);v=validate(q,wanted)
  return {'state':'quoted','amountInWei':v['amountIn'],'nativeNEAR':'0.01','inferenceCreditPurchased':False}
 def bound(self,fresh=False):
  i=context.read(self.d/'quote-intent.json');need(i['identity']==self.identity)
  q=context.read(self.d/'quote-private.json');validate(q,i['request'],fresh);return i,q
 def plan(self):
  from eth_account import Account
  from eth_abi import encode
  from eth_utils import keccak
  need(not (self.d/'submission-intent.json').exists());i,q=self.bound(True);v=q['quote']
  key=Account.from_key(self.transit['basePrivateKey']);need(key.address.lower()==PAYER.lower());need(int(self.rpc('eth_chainId',[]),16)==8453)
  nonce=int(self.rpc('eth_getTransactionCount',[PAYER,'pending']),16);balance=int(self.rpc('eth_getBalance',[PAYER,'latest']),16)
  value=integer(v['amountIn']);fee=2*int(self.rpc('eth_getBlockByNumber',['latest',False])['baseFeePerGas'],16)+1000000
  gas=int(self.rpc('eth_estimateGas',[{'from':PAYER,'to':v['depositAddress'],'value':hex(value)}]),16)+2000
  tx=dict(chainId=8453,nonce=nonce,to=__import__('eth_utils').to_checksum_address(v['depositAddress']),value=value,gas=gas,maxFeePerGas=fee,maxPriorityFeePerGas=1000000,type=2)
  signed=key.sign_transaction(tx);wire=bytes(signed.raw_transaction)
  data='0x'+(keccak(text='getL1Fee(bytes)')[:4]+encode(['bytes'],[wire])).hex()
  l1=int(self.rpc('eth_call',[{'to':'0x420000000000000000000000000000000000000F','data':data},'latest']),16)
  estimate=value+gas*fee+2*l1;need(estimate<=MAX_ESTIMATE and estimate<balance)
  review={'identity':self.identity,'transaction':tx,'txHash':'0x'+bytes(signed.hash).hex(),'estimatedTotalWei':estimate,'estimatedL1Wei':l1,'l1IsNotHardCap':True,'quoteSha256':hashlib.sha256(json.dumps(q,sort_keys=True).encode()).hexdigest()}
  return review,wire
 def send(self,expected=None):
  from eth_account import Account
  from eth_abi import encode
  from eth_utils import keccak,to_checksum_address
  # The reviewed transaction is immutable; fresh checks never reprice it.
  need(not (self.d/'submission-intent.json').exists())
  saved=self.d/'review-001.json'
  if expected is None and not saved.exists():
   review,_=self.plan();context.save(saved,review)
  review=context.read(saved)
  digest=hashlib.sha256(json.dumps(review,sort_keys=True).encode()).hexdigest()
  if expected is not None:need(digest==expected)
  need(review['identity']==self.identity)
  i,q=self.bound(True);v=q['quote']
  need(review['quoteSha256']==hashlib.sha256(json.dumps(q,sort_keys=True).encode()).hexdigest())
  tx=review['transaction'];need(set(tx)=={'chainId','nonce','to','value','gas','maxFeePerGas','maxPriorityFeePerGas','type'})
  need(all(type(tx[k]) is int and tx[k]>=0 for k in tx if k!='to'))
  need(tx['chainId']==8453 and tx['type']==2 and tx['to']==to_checksum_address(v['depositAddress']) and tx['value']==integer(v['amountIn']) and tx['gas']>0)
  need(tx['maxPriorityFeePerGas']==1000000 and tx['maxFeePerGas']>=tx['maxPriorityFeePerGas'])
  key=Account.from_key(self.transit['basePrivateKey']);need(key.address.lower()==PAYER.lower())
  signed=key.sign_transaction(tx);wire=bytes(signed.raw_transaction)
  need('0x'+bytes(signed.hash).hex()==review['txHash'])
  need(int(self.rpc('eth_chainId',[]),16)==8453 and int(self.rpc('eth_getTransactionCount',[PAYER,'pending']),16)==tx['nonce'])
  balance=int(self.rpc('eth_getBalance',[PAYER,'latest']),16)
  base=int(self.rpc('eth_getBlockByNumber',['latest',False])['baseFeePerGas'],16)
  need(base+tx['maxPriorityFeePerGas']<=tx['maxFeePerGas'])
  gas=int(self.rpc('eth_estimateGas',[{'from':PAYER,'to':tx['to'],'value':hex(tx['value'])}]),16);need(gas<=tx['gas'])
  data='0x'+(keccak(text='getL1Fee(bytes)')[:4]+encode(['bytes'],[wire])).hex()
  l1=int(self.rpc('eth_call',[{'to':'0x420000000000000000000000000000000000000F','data':data},'latest']),16)
  estimate=tx['value']+tx['gas']*tx['maxFeePerGas']+2*l1
  need(estimate<=MAX_ESTIMATE and estimate<balance)
  self.bound(True) # deadline checked after all bounded fresh RPCs
  context.save(self.d/'submission-intent.json',dict(review,signedTransaction='0x'+wire.hex(),freshEstimatedTotalWei=estimate,freshEstimatedL1Wei=l1,automaticRetry=False))
  result=self.rpc('eth_sendRawTransaction',['0x'+wire.hex()]);need(result.lower()==review['txHash'].lower())
  context.save(self.d/'submission-return.json',{'txHash':result})
  return {'state':'submitted','txHash':result,'estimatedTotalWei':estimate,'l1IsNotHardCap':True}
 def status(self):
  ready=self.chain_ready();result={'state':'activated' if ready else 'pending','accountKeyFinalFullAccess':ready,'inferenceCreditPurchased':False}
  p=self.d/'submission-intent.json'
  if p.exists():
   intent=context.read(p);need(intent['identity']==self.identity)
   receipt=self.rpc('eth_getTransactionReceipt',[intent['txHash']]);result['txHash']=intent['txHash'];result['broadcastOutcome']='unknown' if receipt is None else 'confirmed' if int(receipt['status'],16)==1 else 'reverted'
  return result
 def ensure(self):
  if self.chain_ready():return {'state':'activated'}
  if not (self.d/'quote-intent.json').exists():self.prepare()
  if not (self.d/'submission-intent.json').exists():self.send()
  end=time.monotonic()+300
  while time.monotonic()<end:
   r=self.status()
   if r['accountKeyFinalFullAccess']:return r
   need(r.get('broadcastOutcome')!='reverted');time.sleep(5)
  raise ValueError('activation pending; resume same attempt')
