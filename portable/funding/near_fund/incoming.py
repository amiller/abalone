# SPDX-License-Identifier: MIT
"""Fixed incoming-only ZEC -> owned Base-USDC route. No asset transfer capability."""
import sys
if not __debug__:raise RuntimeError('optimized execution refused')
import json,datetime,urllib.request,urllib.error,urllib.parse,os,re,stat
from pathlib import Path
from context import read,save,client,config
E=None
PAYER=None
TOKEN='0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
DEST='nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'
D=None
UNITS=None # invoice amount in USDC units (6 decimals); incoming adds a 0.10 USDC fee residual
BUFFER,SLIPPAGE=102,500 # 5% slippage absorbs ZEC price moves before the fill; the 2% buffer keeps the guaranteed minimum above the floor
def floor():return UNITS+100000
def now():return datetime.datetime.now(datetime.timezone.utc)
def dt(s):return datetime.datetime.fromisoformat(s.replace('Z','+00:00'))
def request(url,body=None):
 req=urllib.request.Request(url,None if body is None else json.dumps(body).encode(),{'Content-Type':'application/json','User-Agent':'dsmack-incoming-funding/1.0'})
 try:r=client.open(req,timeout=30)
 except urllib.error.HTTPError as e:r=e
 with r:
  b=r.read(262145)
  if len(b)>262144:raise ValueError('response oversized')
  if r.code not in (200,201):raise ValueError('request refused')
  return json.loads(b)
def rpc(method,params):
 v=request('https://base-rpc.publicnode.com',{'jsonrpc':'2.0','id':1,'method':method,'params':params})
 if 'error' in v or 'result' not in v:raise ValueError('rpc refused')
 return v['result']
def balances():
 if int(rpc('eth_chainId',[]),16)!=8453:raise ValueError('chain refused')
 return dict(ethWei=str(int(rpc('eth_getBalance',[PAYER,'latest']),16)),usdcUnits=str(int(rpc('eth_call',[{'to':TOKEN,'data':'0x70a08231'+PAYER[2:].lower().zfill(64)},'latest']),16)))
def terms(refund,deadline,zatoshis):
 return dict(dry=False,swapType='EXACT_INPUT',originAsset='nep141:zec.omft.near',destinationAsset=DEST,amount=str(zatoshis),depositType='ORIGIN_CHAIN',recipientType='DESTINATION_CHAIN',refundType='ORIGIN_CHAIN',recipient=PAYER,refundTo=refund,deadline=deadline,slippageTolerance=SLIPPAGE)
def price(refund,deadline):
 v=request('https://1click.chaindefuser.com/v0/quote',dict(terms(refund,deadline,0),dry=True,swapType='EXACT_OUTPUT',amount=str(floor())))
 if not re.fullmatch('[1-9][0-9]{0,10}',v['quote']['amountIn']):raise ValueError('price refused')
 return -(-int(v['quote']['amountIn'])*BUFFER//100)
def validate(v,wanted):
 q=v['quoteRequest'];a=v['quote']
 if any(q.get(k)!=x for k,x in wanted.items()):raise ValueError('request binding refused')
 if a['amountIn']!=wanted['amount'] or int(a['minAmountOut'])<floor():raise ValueError('amount refused')
 import base58
 raw=base58.b58decode_check(a['depositAddress'])
 if len(raw)!=22 or raw[:2]!=bytes.fromhex('1cb8'):raise ValueError('deposit address refused')
 if type(a['timeEstimate']) is not int or not 0<=a['timeEstimate']<=3600:raise ValueError('estimate refused')
 return min(dt(q['deadline']),dt(a['deadline']))
def show(v,wanted,state,baseline,current=None):
 deadline=validate(v,wanted);a=v['quote'];left=int((deadline-now()).total_seconds());margin=max(455,a['timeEstimate'])+600
 r=dict(attempt=1,swapState=state,depositAddress=a['depositAddress'],amountZatoshis=a['amountIn'],amountZEC=f"{int(a['amountIn'])//100000000}.{int(a['amountIn'])%100000000:08d}",settlementDeadlineUTC=deadline.isoformat(),safeSendBeforeUTC=(deadline-datetime.timedelta(seconds=margin)).isoformat(),secondsRemaining=left,requiredRemainingSeconds=margin,acceptNewDeposit=state=='PENDING_DEPOSIT' and left>margin,destinationUSDC='%.2f'%(floor()/1e6),intendedNEARCreditUSD='%.2f'%(UNITS/1e6),residualUSDCBeforePaymentFees='0.10',paymentFeesComeFromResidual=True,BaseGasSeparate=True,refundAddress=wanted['refundTo'],ownedBaseRecipient=PAYER,oldBalanceBaseline=baseline,assetTransferSent=False)
 if current:r['currentBaseBalances']=current
 return r
def prepare():
 if D.exists():raise ValueError('attempt already exists; use status')
 from eth_account import Account
 from eth_account.messages import encode_defunct
 secret={'private_key':config()['basePrivateKey']}
 k=Account.from_key(secret['private_key'])
 if k.address!=PAYER:raise ValueError('wallet owner mismatch')
 m=encode_defunct(text='Dsmack incoming funding receiver ownership; no transaction or allowance')
 if Account.recover_message(m,signature=k.sign_message(m).signature)!=PAYER:raise ValueError('ownership proof refused')
 refund=config()['refundAddress'];backup={'verified':config()['refundBackupVerified']}
 if backup.get('verified') is not True:raise ValueError('refund backup missing')
 baseline=balances();os.mkdir(D,0o700);__import__("context").syncdir(D.parent)
 deadline=(now()+datetime.timedelta(hours=2)).isoformat(timespec='milliseconds').replace('+00:00','Z')
 wanted=terms(refund,deadline,price(refund,deadline))
 save(D/'intent.json',dict(request=wanted,baseline=baseline,ownedBaseKeyVerified=True,routeVersion=1))
 # Intent survives ambiguous network results; status never repeats this POST.
 v=request('https://1click.chaindefuser.com/v0/quote',wanted);save(D/'quote-private.json',v)
 r=show(v,wanted,'PENDING_DEPOSIT',baseline);save(D/'review.json',r);return r
def status():
 i=read(D/'intent.json');v=read(D/'quote-private.json');validate(v,i['request'])
 s=request('https://1click.chaindefuser.com/v0/status?'+urllib.parse.urlencode({'depositAddress':v['quote']['depositAddress']}))
 state=s.get('status')
 if state not in ('PENDING_DEPOSIT','KNOWN_DEPOSIT_TX','PROCESSING','SUCCESS','FAILED','REFUNDED','INCOMPLETE_DEPOSIT'):raise ValueError('unknown swap state')
 validate(s['quoteResponse'],i['request'])
 if any(s['quoteResponse']['quote'].get(k)!=v['quote'].get(k) for k in ('depositAddress','amountIn','amountOut','minAmountOut','deadline','timeEstimate')):raise ValueError('replacement quote refused')
 current=balances();r=show(s['quoteResponse'],i['request'],state,i['baseline'],current)
 r['incomingUSDCObserved']=state=='SUCCESS' and int(current['usdcUnits'])-int(i['baseline']['usdcUnits'])>=floor()
 r['providerCreditConfirmed']=False;r['nextStep']='Review same-invoice BaseUSDC payment and gas; no automatic transfer'
 return r
