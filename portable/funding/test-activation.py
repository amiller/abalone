# SPDX-License-Identifier: MIT
import datetime,hashlib,json,pathlib,sys,tempfile,unittest,subprocess
from unittest.mock import patch
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from near_fund import activation as a,context
import base58
from eth_account import Account
class Tests(unittest.TestCase):
 def setup_case(self,d):
  key='01'*32;payer=Account.from_key(key).address;identity={'accountId':('61'*32),'publicKey':'ed25519:'+base58.b58encode(b'a'*32).decode()};calls=[]
  def req(url,body=None,**kwargs):
   calls.append((url,body))
   if url==a.NEAR:return {'error':{'cause':{'name':'UNKNOWN_ACCOUNT'}}}
   if url==a.CLICK+'/v0/quote':return {'quoteRequest':body.copy(),'quote':{'amountIn':'21000000000000','amountOut':str(a.OUT),'minAmountOut':str(a.OUT),'depositAddress':'0x'+'2'*40,'deadline':body['deadline']}}
   method=body['method'];answers={'eth_chainId':'0x2105','eth_getTransactionCount':'0x3','eth_getBalance':hex(10**18),'eth_getBlockByNumber':{'baseFeePerGas':'0x1'},'eth_estimateGas':'0x5208','eth_call':'0x1'}
   if method=='eth_sendRawTransaction':raise TimeoutError('SYNTHETIC_PRIVATE_CANARY')
   return {'result':answers[method]}
  return a.Activation(pathlib.Path(d)/'activation',identity,{'baseAddress':payer,'basePrivateKey':key},request=req),calls,payer
 def test_signed_timeout_preserves_intent_and_never_resends(self):
  with tempfile.TemporaryDirectory() as d,patch.object(a,'PAYER',Account.from_key('01'*32).address):
   obj,calls,_=self.setup_case(d);obj.prepare()
   with self.assertRaises(TimeoutError):obj.send()
   saved=context.read(obj.d/'submission-intent.json');self.assertEqual(saved['txHash'],'0x'+__import__('eth_utils').keccak(bytes.fromhex(saved['signedTransaction'][2:])).hex())
   self.assertEqual(Account.recover_transaction(saved['signedTransaction']).lower(),a.PAYER.lower());self.assertEqual(saved['transaction']['value'],21000000000000)
   before=len(calls)
   with self.assertRaises(ValueError):obj.send()
   self.assertEqual(len(calls),before);self.assertEqual(sum(b and b.get('method')=='eth_sendRawTransaction' for _,b in calls),1)
 def test_actual_http_boundary_201_retained_before_parse(self):
  with tempfile.TemporaryDirectory() as d,patch.object(a,'PAYER',Account.from_key('01'*32).address):
   obj,_,_=self.setup_case(d);obj.request=a.request;original=subprocess.Popen
   def spawn(*args,**kwargs):
    wanted=context.read(obj.d/'quote-intent.json')['request']
    reply={'quoteRequest':wanted,'quote':{'amountIn':'21000000000000','amountOut':str(a.OUT),'minAmountOut':str(a.OUT),'depositAddress':'0x'+'2'*40,'deadline':wanted['deadline']}}
    payload=json.dumps(reply).encode()+b'\n201'
    return original([sys.executable,'-c',"import sys;sys.stdin.buffer.read();sys.stdout.buffer.write("+repr(payload)+")"],**kwargs)
   with patch.object(obj,'chain_ready',return_value=False),patch.object(context.subprocess,'Popen',spawn):result=obj.prepare()
   self.assertEqual(result['state'],'quoted');self.assertEqual(context.read(obj.d/'quote-response-status.json')['httpStatus'],201)
   self.assertEqual(json.loads((obj.d/'quote-response.private').read_bytes()),context.read(obj.d/'quote-private.json'))
 def test_http_error_raw_response_survives_refusal(self):
  with tempfile.TemporaryDirectory() as d,patch.object(a,'PAYER',Account.from_key('01'*32).address):
   obj,_,_=self.setup_case(d);obj.request=a.request;original=subprocess.Popen
   def spawn(*args,**kwargs):return original([sys.executable,'-c',"import sys;sys.stdin.buffer.read();sys.stdout.buffer.write(b'SYNTHETIC_PRIVATE_CANARY\\n500')"],**kwargs)
   with patch.object(obj,'chain_ready',return_value=False),patch.object(context.subprocess,'Popen',spawn):
    with self.assertRaises(ValueError):obj.prepare()
   self.assertEqual((obj.d/'quote-response.private').read_bytes(),b'SYNTHETIC_PRIVATE_CANARY');self.assertEqual(context.read(obj.d/'quote-response-status.json')['httpStatus'],500)
   self.assertFalse((obj.d/'quote-private.json').exists());self.assertTrue((obj.d/'quote-intent.json').exists())
 def test_saved_transaction_survives_safe_fee_change(self):
  with tempfile.TemporaryDirectory() as d,patch.object(a,'PAYER',Account.from_key('01'*32).address):
   obj,calls,_=self.setup_case(d);obj.prepare();review,wire=obj.plan();context.save(obj.d/'review-001.json',review)
   original=obj.request
   def changed(url,body=None):
    if body and body.get('method')=='eth_getBlockByNumber':return {'result':{'baseFeePerGas':'0x2'}}
    if body and body.get('method')=='eth_call':return {'result':'0x2'}
    if body and body.get('method')=='eth_sendRawTransaction':
     self.assertEqual(body['params'],['0x'+wire.hex()]);return {'result':review['txHash']}
    return original(url,body)
   obj.request=changed
   result=obj.send(hashlib.sha256(json.dumps(review,sort_keys=True).encode()).hexdigest());self.assertEqual(result['txHash'],review['txHash'])
 def test_wronghash_nonce_and_expiry_refuse_before_intent(self):
  for mode in ['hash','nonce','expiry']:
   with self.subTest(mode=mode),tempfile.TemporaryDirectory() as d,patch.object(a,'PAYER',Account.from_key('01'*32).address):
    obj,calls,_=self.setup_case(d);obj.prepare();review,_=obj.plan();context.save(obj.d/'review-001.json',review)
    expected=hashlib.sha256(json.dumps(review,sort_keys=True).encode()).hexdigest();original=obj.request
    if mode=='hash':expected='0'*64
    if mode=='nonce':obj.request=lambda url,body: {'result':'0x4'} if body.get('method')=='eth_getTransactionCount' else original(url,body)
    later=a.now()+datetime.timedelta(minutes=6)
    with patch.object(a,'now',return_value=later if mode=='expiry' else a.now()):
     with self.assertRaises(ValueError):obj.send(expected)
    self.assertFalse((obj.d/'submission-intent.json').exists());self.assertFalse(any(b and b.get('method')=='eth_sendRawTransaction' for _,b in calls))
 def test_existing_fullaccess_skips_quote_and_send(self):
  with tempfile.TemporaryDirectory() as d,patch.object(a,'PAYER',Account.from_key('01'*32).address):
   obj,_,_=self.setup_case(d);calls=[]
   obj.request=lambda url,body:(calls.append(url) or {'result':{'amount':'1'}} if body['params']['request_type']=='view_account' else (calls.append(url) or {'result':{'permission':'FullAccess','nonce':0}}))
   self.assertEqual(obj.ensure()['state'],'activated');self.assertEqual(calls,[a.NEAR,a.NEAR])
 def test_wrong_key_or_functioncall_refused(self):
  with tempfile.TemporaryDirectory() as d,patch.object(a,'PAYER',Account.from_key('01'*32).address):
   obj,_,_=self.setup_case(d)
   for value in [{'error':{'cause':{'name':'UNKNOWN_ACCESS_KEY'}}},{'result':{'permission':{'FunctionCall':{}},'nonce':0}}]:
    obj.request=lambda url,body: {'result':{'amount':'1'}} if body['params']['request_type']=='view_account' else value
    with self.assertRaises(ValueError):obj.chain_ready()
 def test_quote_tamper_refuses(self):
  wanted=a.terms({'accountId':'a'*64},(a.now()+datetime.timedelta(minutes=30)).isoformat());q={'quoteRequest':wanted.copy(),'quote':{'amountIn':'1','amountOut':str(a.OUT),'minAmountOut':str(a.OUT),'depositAddress':'0x'+'1'*40,'deadline':wanted['deadline']}}
  for field in ['recipient','refundTo','destinationAsset','swapType']:
   bad=json.loads(json.dumps(q));bad['quoteRequest'][field]='bad'
   with self.assertRaises(ValueError):a.validate(bad,wanted)
 def test_actual_deadline_millisecond_normalization(self):
  wanted=a.terms({'accountId':'a'*64},'2026-01-01T09:25:48.899465Z')
  q={'quoteRequest':dict(wanted,deadline='2026-01-01T09:25:48.899Z'),'quote':{'amountIn':'22000000000000','amountOut':str(a.OUT),'minAmountOut':str(a.OUT),'depositAddress':'0x'+'1'*40,'deadline':'2026-01-04T09:25:48.899Z'}}
  self.assertEqual(a.validate(q,wanted,False)['amountIn'],'22000000000000')
  for deadline in ['2026-01-01T09:25:48.900Z','2026-01-01T09:25:48.901Z','2026-01-01T09:25:49.899Z','2026-01-01T10:25:48.899+01:00','2026-01-01T09:25:48.899']:
   with self.subTest(deadline=deadline):
    q['quoteRequest']['deadline']=deadline
    with self.assertRaises(ValueError):a.validate(q,wanted,False)
 def test_producer_serializes_milliseconds(self):
  with tempfile.TemporaryDirectory() as d,patch.object(a,'PAYER',Account.from_key('01'*32).address):
   obj,_,_=self.setup_case(d);obj.prepare();deadline=context.read(obj.d/'quote-intent.json')['request']['deadline']
   self.assertRegex(deadline,r'\.\d{3}Z$')
 def test_missing_provider_deadline_refused(self):
  wanted=a.terms({'accountId':'a'*64},(a.now()+datetime.timedelta(minutes=30)).isoformat());q={'quoteRequest':wanted.copy(),'quote':{'amountIn':'1','amountOut':str(a.OUT),'minAmountOut':str(a.OUT),'depositAddress':'0x'+'1'*40}}
  with self.assertRaises(KeyError):a.validate(q,wanted)
 def test_quote_intent_unknown_never_requoted(self):
  with tempfile.TemporaryDirectory() as d,patch.object(a,'PAYER',Account.from_key('01'*32).address):
   obj,calls,_=self.setup_case(d);obj.prepare();before=len(calls)
   with self.assertRaises(ValueError):obj.prepare()
   self.assertEqual(len(calls),before+1) # only readonly chain check
if __name__=='__main__':unittest.main()
