# SPDX-License-Identifier: MIT
"""Second stage: prepare a bounded Base-USDC payment from this incoming swap only.
prepare sends no assets; send-reviewed is deliberately separate and one-shot.
"""
import sys
if not __debug__:raise RuntimeError('optimized execution refused')
import json,datetime,urllib.request,urllib.error,re,hashlib,os
from decimal import Decimal
from context import read,save,client,config,TransportReadError
E=None
import incoming as route
P=None;GAS_CAP=10**13
ORG=None

def cloud(path,body=None):
 session=config()['session']
 req=urllib.request.Request('https://cloud.near.ai'+path,None if body is None else json.dumps(body).encode(),{'Content-Type':'application/json','Cookie':'access_token='+session['access_token']+'; refresh_token='+session['refresh_token'],'User-Agent':config().get('userAgent','dsmack-incoming-funding/1.0')})
 with client.open(req,timeout=30) as r:
  b=r.read(262145)
  if len(b)>262144:raise ValueError('oversize')
  return json.loads(b)
def context():
 return config()['organizationId'],read(E/'invoice.json')['sessionId']
def payment_history(org,sid):
 v=cloud('/api/pingpay/payment?organizationId='+org)
 if v.get('organizationId')!=org:raise ValueError('history organization')
 rows=[x for x in v.get('payments',[]) if x.get('id')==sid]
 if len(rows)>1:raise ValueError('ambiguous invoice')
 if not rows:return {'invoiceFound':False,'invoicePaid':False}
 p=rows[0]
 if Decimal(str(p['amount']))!=Decimal(route.UNITS)/10**6 or p['currency']!='USD':raise ValueError('invoice amount')
 return {'invoiceFound':True,'invoicePaid':p['status']=='SUCCESS','invoiceStatus':p['status'],'expectedCreditUSD':'%.2f'%(route.UNITS/1e6)}
def admission(incoming,current,amount):
 baseline=int(incoming['oldBalanceBaseline']['usdcUnits'])
 if incoming['swapState']!='SUCCESS' or incoming.get('incomingUSDCObserved') is not True:raise ValueError('incoming not settled')
 if not route.UNITS<=amount<=route.UNITS+100000:raise ValueError('payment exceeds incoming budget')
 if int(current['usdcUnits'])-baseline<route.UNITS+100000:raise ValueError('incoming balance unavailable')
def rpc(method,args):return route.rpc(method,args)
def invoice_expiry(value):
 if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00(?::00)?)',value):raise ValueError('invoice expiry format')
 normalized=value.replace(' ','T')
 if normalized.endswith('+00'):normalized+=':00'
 return route.dt(normalized)
def session(sid):return route.request('https://pay.pingpay.io/api/rpc/checkout/getSession',{'json':{'sessionId':sid}})['json']['session']
def replace_invoice(org,sid):
 os.rename(E/'invoice.json',E/('invoice-replaced-%s.json'%sid));__import__('context').syncdir(E)
 result=cloud('/api/pingpay/create-checkout-session',{'organizationId':org,'amount':read(E/'invoice-intent.json')['amount']})
 if not isinstance(result,dict) or not isinstance(result.get('sessionId'),str) or not re.fullmatch('[A-Za-z0-9_-]{1,128}',result['sessionId']):raise ValueError('invoice refused')
 save(E/'invoice.json',{'sessionId':result['sessionId']});return result['sessionId']
def prepare():
 if P.exists():raise ValueError('attempt exists; reconcile')
 incoming=route.status();current=route.balances();admission(incoming,current,route.UNITS)
 org,sid=context();history=payment_history(org,sid)
 if history['invoicePaid']:raise ValueError('invoice already paid')
 v=session(sid)
 # PingPay invoices live 1 h; the ZEC deposit window plus the swap can outlast one. An unpaid expiring invoice is replaced, never paid late.
 if invoice_expiry(v['expiresAt'])<route.now()+datetime.timedelta(minutes=5):sid=replace_invoice(org,sid);v=session(sid)
 if invoice_expiry(v['expiresAt'])<route.now()+datetime.timedelta(minutes=5):raise ValueError('invoice expired or too short')
 if v['status'] not in ('CREATED','PENDING') or v['sessionId']!=sid or v['metadata']['organizationId']!=org or v['amount']['amount']!=str(route.UNITS) or v['amount']['decimals']!=6 or v['amount']['assetId']!='nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1':raise ValueError('invoice binding')
 P.mkdir(mode=0o700);__import__("context").syncdir(P.parent)
 body={'json':{'input':{'sessionId':sid,'payerAsset':{'amount':'0','asset':{'chain':'base','symbol':'USDC','contractAddress':route.TOKEN}},'payer':{'address':route.PAYER},'idempotencyKey':'session:'+sid,'paymentMethod':'DEPOSIT'}}}
 save(P/'prepare-intent-private.json',{'request':body,'incoming':incoming,'previousZecDepositInvalid':True})
 p=route.request('https://pay.pingpay.io/api/rpc/payments/prepare',body)['json'];save(P/'prepared-private.json',p)
 q=p['quote'];pay=p['payment'];amount=int(q['amountIn'])
 admission(incoming,route.balances(),amount)
 if pay['status']!='PENDING' or pay['paymentMethod']!='DEPOSIT' or q['quoteRequest']['originAsset']!=route.DEST or q['amountOut']!=str(route.UNITS) or pay['request']['recipient']['address']!='jasnah-treasury.sputnik-dao.near' or pay['request']['idempotencyKey']!='session:'+sid:raise ValueError('payment terms')
 to=p['depositAddress']
 if pay['depositAddress']!=to or q['quoteRequest']['destinationAsset']!='nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1' or q['depositAddress']!=to or not re.fullmatch('0x[0-9a-fA-F]{40}',to):raise ValueError('deposit')
 data='0xa9059cbb'+to[2:].lower().zfill(64)+hex(amount)[2:].zfill(64)
 tx={'from':route.PAYER,'to':route.TOKEN,'data':data,'value':'0x0'}
 if int(rpc('eth_call',[tx,'latest']),16)!=1:raise ValueError('transfer simulation')
 gas=int(rpc('eth_estimateGas',[tx]),16)*12//10
 block=rpc('eth_getBlockByNumber',['latest',False]);fee=2*int(block['baseFeePerGas'],16)+1000000
 # Reserve full cap for L1 fees too; exact signed L1 estimate checked before submission.
 if gas*fee>=GAS_CAP or int(current['ethWei'])<GAS_CAP:raise ValueError('gas budget')
 plan={'chainId':8453,'nonce':int(rpc('eth_getTransactionCount',[route.PAYER,'pending']),16),'to':route.TOKEN,'value':0,'data':data,'gas':gas,'maxFeePerGas':fee,'maxPriorityFeePerGas':1000000,'type':2}
 from eth_account import Account
 from eth_abi import encode
 from eth_utils import keccak
 key=Account.from_key(config()['basePrivateKey'])
 if key.address!=route.PAYER:raise ValueError('owner')
 signed=key.sign_transaction(plan)
 fee_data='0x'+(keccak(text='getL1Fee(bytes)')[:4]+encode(['bytes'],[bytes(signed.raw_transaction)])).hex()
 l1=int(rpc('eth_call',[{'to':'0x420000000000000000000000000000000000000F','data':fee_data},'latest']),16)
 maximum=gas*fee+2*l1
 if maximum>=GAS_CAP or maximum>int(current['ethWei']):raise ValueError('total gas cap')
 save(P/'unsigned-plan.json',{'estimatedMaximumGasWei':str(maximum),'l1IsNotHardCap':True,'expectedTxHash':'0x'+signed.hash.hex().removeprefix('0x'),'transaction':plan,'maximumTotalGasWei':str(GAS_CAP),'incomingUSDCUnits':route.UNITS+100000,'paymentUSDCUnits':amount,'residualUSDCUnits':route.UNITS+100000-amount,'depositAddress':to,'sessionId':sid,'paymentId':pay['paymentId'],'organizationId':org,'preparedAt':route.now().isoformat()})
 return {'state':'review-required','paymentUSDCUnits':amount,'estimatedMaximumGasWei':str(maximum),'l1IsNotHardCap':True,'maximumTotalGasWei':str(GAS_CAP),'fundsSent':False}
def send_reviewed(expected_hash):
 from eth_account import Account
 from eth_abi import encode
 if (P/'submission-intent-private.json').exists():raise ValueError('submission exists; reconcile known hash')
 if not re.fullmatch('[a-f0-9]{64}',expected_hash):raise ValueError('review hash')
 path=P/'unsigned-plan.json';raw=path.read_bytes()
 if hashlib.sha256(raw).hexdigest()!=expected_hash:raise ValueError('changed plan')
 plan=read(path);org,sid=context()
 if plan['sessionId']!=sid or plan['organizationId']!=org or int(plan['maximumTotalGasWei'])!=GAS_CAP:raise ValueError('plan context')
 incoming=route.status();current=route.balances();amount=plan['paymentUSDCUnits'];admission(incoming,current,amount)
 if payment_history(org,sid)['invoicePaid']:raise ValueError('invoice already paid')
 if route.now()-route.dt(plan['preparedAt'])>datetime.timedelta(minutes=2):raise ValueError('stale payment plan')
 prepared=read(P/'prepared-private.json');deposit=plan['depositAddress'];tx=plan['transaction']
 backend=route.request('https://1click.chaindefuser.com/v0/status?'+__import__('urllib.parse',fromlist=['urlencode']).urlencode({'depositAddress':deposit}))
 qr=backend['quoteResponse']['quoteRequest'];quote=backend['quoteResponse']['quote']
 if backend['status']!='PENDING_DEPOSIT' or qr['originAsset']!=route.DEST or qr['refundTo'].lower()!=route.PAYER.lower() or qr['refundType']!='ORIGIN_CHAIN' or qr['recipient']!='jasnah-treasury.sputnik-dao.near' or qr['amount']!=str(route.UNITS) or qr['destinationAsset']!='nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1' or qr['swapType']!='EXACT_OUTPUT' or qr['recipientType']!='DESTINATION_CHAIN' or quote['amountOut']!=str(route.UNITS):raise ValueError('swap terms')
 if prepared['payment']['request']['idempotencyKey']!='session:'+sid or prepared['payment']['paymentId']!=plan['paymentId'] or prepared['payment']['depositAddress']!=deposit or quote['depositAddress']!=deposit or int(quote['amountIn'])!=amount or prepared['quote']['depositAddress']!=deposit:raise ValueError('changed quote')
 if min(route.dt(qr['deadline']),route.dt(quote['deadline']))<route.now()+datetime.timedelta(seconds=120):raise ValueError('short deadline')
 expected_data='0xa9059cbb'+deposit[2:].lower().zfill(64)+hex(amount)[2:].zfill(64)
 if tx['chainId']!=8453 or tx['to']!=route.TOKEN or tx['value']!=0 or tx['data']!=expected_data or tx['type']!=2:raise ValueError('not exact transfer')
 if tx['nonce']!=int(rpc('eth_getTransactionCount',[route.PAYER,'pending']),16):raise ValueError('nonce changed')
 call={'from':route.PAYER,'to':route.TOKEN,'data':expected_data,'value':'0x0'}
 if int(rpc('eth_call',[call,'latest']),16)!=1:raise ValueError('simulation failed')
 if int(rpc('eth_estimateGas',[call]),16)>tx['gas']:raise ValueError('gas changed')
 if int(rpc('eth_getBlockByNumber',['latest',False])['baseFeePerGas'],16)+tx['maxPriorityFeePerGas']>tx['maxFeePerGas']:raise ValueError('fee changed')
 k=Account.from_key(config()['basePrivateKey'])
 if k.address!=route.PAYER:raise ValueError('owner')
 signed=k.sign_transaction(tx);wire=bytes(signed.raw_transaction)
 from eth_utils import keccak
 data='0x'+(keccak(text='getL1Fee(bytes)')[:4]+encode(['bytes'],[wire])).hex()
 l1=int(rpc('eth_call',[{'to':'0x420000000000000000000000000000000000000F','data':data},'latest']),16)
 # The reviewed fixed budget governs fresh admission; historical L1 is an estimate,
 # not a signed/on-chain ceiling. Never reprice or change the reviewed transaction.
 maximum=tx['gas']*tx['maxFeePerGas']+2*l1
 if maximum>=GAS_CAP or maximum>int(current['ethWei']):raise ValueError('total gas cap')
 if int(current['usdcUnits'])-amount<int(incoming['oldBalanceBaseline']['usdcUnits']):raise ValueError('old funds')
 h='0x'+signed.hash.hex().removeprefix('0x')
 if h!=plan['expectedTxHash']:raise ValueError('changed transaction')
 fresh=route.request('https://pay.pingpay.io/api/rpc/checkout/getSession',{'json':{'sessionId':sid}})['json']['session']
 if fresh['status'] not in ('CREATED','PENDING') or fresh['sessionId']!=sid or fresh['paymentId']!=plan['paymentId'] or fresh['metadata']['organizationId']!=org or fresh['amount']['amount']!=str(route.UNITS) or fresh['amount']['assetId']!=qr['destinationAsset'] or fresh['amount']['decimals']!=6:raise ValueError('fresh invoice binding')
 if invoice_expiry(fresh['expiresAt'])<route.now()+datetime.timedelta(seconds=90) or min(route.dt(qr['deadline']),route.dt(quote['deadline']))<route.now()+datetime.timedelta(seconds=90) or route.now()-route.dt(plan['preparedAt'])>datetime.timedelta(minutes=2):raise ValueError('final expiry')
 save(P/'submission-intent-private.json',{'txHash':h,'nonce':tx['nonce'],'signedTransaction':'0x'+wire.hex(),'estimatedMaximumGasWei':str(maximum),'l1IsNotHardCap':True,'USDCUnits':amount,'reviewedPlanSha256':expected_hash})
 fd=os.open(P,os.O_RDONLY|os.O_DIRECTORY);os.fsync(fd);os.close(fd)
 # Exactly one broadcast. Ambiguity retains the known hash; never signs a new nonce automatically.
 result=rpc('eth_sendRawTransaction',['0x'+wire.hex()])
 if result.lower()!=h.lower():raise ValueError('broadcast unknown')
 save(P/'submitted.json',{'txHash':h,'estimatedMaximumGasWei':str(maximum),'l1IsNotHardCap':True,'USDCUnits':amount})
 return {'state':'submitted','txHash':h,'estimatedMaximumGasWei':str(maximum),'l1IsNotHardCap':True,'USDCUnits':amount,'providerCreditConfirmed':False}
def account_balance(org):
 # Fresh authenticated account observation; no snapshot overwrite or auth refresh.
 try:
  from context import call
  session=config()['session']
  code,value=call('/v1/organizations/'+org+'/usage/balance',session['access_token'])
  fields=('remaining','total_spent','spend_limit','unfunded_amount')
  if code!=200 or not isinstance(value,dict) or value.get('organization_id')!=org or any(type(value.get(k)) is not int or value[k]<0 for k in fields):raise ValueError('balance refused')
  return {'state':'known','organizationId':org,'unit':'nanoUSD','observedUTC':route.now().isoformat(),**{k:value[k] for k in fields}}
 except Exception:return {'state':'unknown','unit':'nanoUSD'}
def credit_observation(org,sid,invoice_paid,balance):
 if not invoice_paid or balance['state']!='known':return False
 try:
  plan=read(P/'unsigned-plan.json')
  if plan.get('organizationId')!=org or plan.get('sessionId')!=sid:return False
  prior=read(E/'baseline-credit.json')
  if prior.get('organization_id')!=org:return False
  if any(type(prior.get(k)) is not int or prior[k]<0 for k in ('remaining','total_spent')):return False
  baseline=prior['remaining']+prior['total_spent']
  return balance['remaining']+balance['total_spent']>=baseline+route.UNITS*1000
 except Exception:return False
def status():
 org,sid=context();r={'invoiceId':sid}
 # Independent known-hash evidence comes first; a history outage cannot erase it.
 intent=P/'submission-intent-private.json'
 if intent.exists():
  sent=read(intent);h=sent['txHash']
  if not re.fullmatch('0x[a-fA-F0-9]{64}',h):raise ValueError('transaction hash')
  r['transactionHash']=h;r['transactionState']='pending-or-unknown'
  try:receipt=rpc('eth_getTransactionReceipt',[h])
  except TransportReadError:r['transactionObservation']='http-read-unavailable'
  else:
   if receipt is not None and (receipt['transactionHash'].lower()!=h.lower() or receipt['from'].lower()!=route.PAYER.lower() or receipt['to'].lower()!=route.TOKEN.lower()):raise ValueError('receipt mismatch')
   r['transactionState']='pending-or-unknown' if receipt is None else 'confirmed' if int(receipt['status'],16)==1 else 'failed'
 try:r.update(payment_history(org,sid));r['invoiceObservation']='known'
 except TransportReadError:r.update(invoiceFound=None,invoicePaid=False,invoiceObservation='http-read-unavailable')
 r['invoicePaymentConfirmed']=r['invoicePaid']
 balance=account_balance(org);r['accountCredit']=balance
 r['providerAccountCreditConfirmed']=balance['state']=='known'
 r['invoiceLinkedAndCreditIncreaseObserved']=credit_observation(org,sid,r['invoicePaid'],balance)
 r['creditAttribution']='separate-invoice-success-and-aggregate-account-observation-not-atomic-attribution'
 r['assetTransferSentByThisCommand']=False
 return r
def failure_result():
 r={'state':'refused','reason':'funding-or-invoice-or-gas-precondition','assetTransferSent':False}
 if (P/'submission-intent-private.json').exists():
  r={'state':'unknown','reason':'reconcile-known-transaction-no-retry','broadcastMayHaveOccurred':True}
  try:
   h=read(P/'submission-intent-private.json')['txHash']
   if re.fullmatch('0x[a-fA-F0-9]{64}',h):r['knownTxHash']=h
  except Exception:pass
 return r
