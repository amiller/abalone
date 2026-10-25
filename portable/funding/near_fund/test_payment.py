# SPDX-License-Identifier: MIT
import unittest,tempfile,json,hashlib
from pathlib import Path
from unittest.mock import patch
import payment as m
import context
m.route.UNITS=2000000
context._CONFIG={"session":{"access_token":"synthetic"},"basePrivateKey":"0x"+bytes([1]*32).hex()}
class Tests(unittest.TestCase):
 def test_actual_postgresql_utc_expiry(self):
  import datetime
  expected=datetime.datetime(2026,10,15,15,58,12,723000,tzinfo=datetime.timezone.utc)
  for value in ('2026-10-15 15:58:12.723+00','2026-10-15T15:58:12.723+00:00','2026-10-15T15:58:12.723Z'):self.assertEqual(m.invoice_expiry(value),expected)
  for value in ('2026-10-15 15:58:12.723','2026-10-15 15:58:12.723+01','2026-10-15 15:58:12.723+00 trailing'):
   with self.assertRaises(ValueError):m.invoice_expiry(value)
 def test_account_balance_validated_and_unauthorized_unknown(self):
  import context as current_balance
  value={'organization_id':'org','remaining':2940572612,'total_spent':59427388,'spend_limit':3000000000,'unfunded_amount':0}
  with patch.object(m,'read',return_value={'access_token':'synthetic'}),patch.object(current_balance,'call',return_value=(200,value)):
   got=m.account_balance('org');self.assertEqual(got['state'],'known');self.assertEqual(got['unit'],'nanoUSD');self.assertEqual(got['remaining'],2940572612)
  for code,v in [(401,None),(200,{**value,'organization_id':'other'}),(200,{**value,'remaining':True}),(200,{**value,'total_spent':-1}),(200,{**value,'remaining':'2940572612'})]:
   with patch.object(m,'read',return_value={'access_token':'synthetic'}),patch.object(current_balance,'call',return_value=(code,v)):self.assertEqual(m.account_balance('org')['state'],'unknown')
 def test_invoice_success_and_aggregate_growth_separate(self):
  prior={'organization_id':'org','remaining':940572612,'total_spent':59427388};m.E=Path('/synthetic');m.P=Path('/synthetic/payment')
  balance={'state':'known','remaining':2940572612,'total_spent':59427388}
  with patch.object(m,'read',side_effect=lambda p: {'organizationId':'org','sessionId':'ours'} if p.name=='unsigned-plan.json' else prior):
   self.assertTrue(m.credit_observation('org','ours',True,balance))
   self.assertFalse(m.credit_observation('org','other',True,balance))
   self.assertFalse(m.credit_observation('org','ours',False,balance))
   self.assertFalse(m.credit_observation('org','ours',True,{'state':'unknown'}))
   self.assertFalse(m.credit_observation('org','ours',True,{**balance,'remaining':940572612}))
 def test_status_reports_distinct_facts_without_snapshot_writes(self):
  with tempfile.TemporaryDirectory() as d:
   with patch.object(m,'P',Path(d)),patch.object(m,'context',return_value=('org','ours')),patch.object(m,'payment_history',return_value={'invoicePaid':True}),patch.object(m,'account_balance',return_value={'state':'known','unit':'nanoUSD','remaining':2940572612}),patch.object(m,'credit_observation',return_value=True),patch.object(m,'save') as save:
    result=m.status();self.assertTrue(result['invoicePaymentConfirmed']);self.assertTrue(result['providerAccountCreditConfirmed']);self.assertTrue(result['invoiceLinkedAndCreditIncreaseObserved']);self.assertEqual(result['accountCredit']['remaining'],2940572612);save.assert_not_called()
 def incoming(self):return {'swapState':'SUCCESS','incomingUSDCObserved':True,'oldBalanceBaseline':{'usdcUnits':'69492'}}
 def test_exact_received_budget(self):m.admission(self.incoming(),{'usdcUnits':'2169492'},2020000)
 def test_pending_refused(self):
  i=self.incoming();i['swapState']='PROCESSING'
  with self.assertRaises(ValueError):m.admission(i,{'usdcUnits':'2169492'},2020000)
 def test_old_funds_cannot_cover_missing_incoming(self):
  with self.assertRaises(ValueError):m.admission(self.incoming(),{'usdcUnits':'2100000'},2020000)
 def test_payment_cap(self):
  with self.assertRaises(ValueError):m.admission(self.incoming(),{'usdcUnits':'9999999'},2100001)
 def test_same_invoice_history(self):
  with patch.object(m,'cloud',return_value={'organizationId':'org','payments':[{'id':'other','status':'SUCCESS','amount':2,'currency':'USD'},{'id':'ours','status':'PENDING','amount':2,'currency':'USD'}]}):self.assertFalse(m.payment_history('org','ours')['invoicePaid'])
 def test_wrong_invoice_amount_refused(self):
  with patch.object(m,'cloud',return_value={'organizationId':'org','payments':[{'id':'ours','status':'SUCCESS','amount':1,'currency':'USD'}]}):
   with self.assertRaises(ValueError):m.payment_history('org','ours')
 def test_replace_invoice_keeps_old_and_binds_new(self):
  with tempfile.TemporaryDirectory() as d,patch.object(m,'E',Path(d)),patch.object(m,'cloud',return_value={'sessionId':'new'}) as post:
   e=Path(d);m.save(e/'invoice.json',{'sessionId':'old'});m.save(e/'invoice-intent.json',{'amount':200,'organizationId':'org'})
   self.assertEqual(m.replace_invoice('org','old'),'new')
   self.assertEqual(post.call_args.args,('/api/pingpay/create-checkout-session',{'organizationId':'org','amount':200}))
   self.assertEqual(json.loads((e/'invoice.json').read_text()),{'sessionId':'new'});self.assertEqual(json.loads((e/'invoice-replaced-old.json').read_text()),{'sessionId':'old'})
 def test_expiring_invoice_replaced_once_before_payment(self):
  import datetime
  at=datetime.datetime(2026,10,15,12,tzinfo=datetime.timezone.utc);short={'expiresAt':'2026-10-15 12:03:00+00'}
  with tempfile.TemporaryDirectory() as d,patch.object(m,'P',Path(d)/'payment'),patch.object(m.route,'status',return_value=self.incoming()),patch.object(m.route,'balances',return_value={'usdcUnits':'2169492'}),patch.object(m,'context',return_value=('org','old')),patch.object(m,'payment_history',return_value={'invoicePaid':False}),patch.object(m,'session',return_value=short) as ses,patch.object(m,'replace_invoice',return_value='new') as rep,patch.object(m.route,'now',return_value=at):
   with self.assertRaises(ValueError):m.prepare()
   rep.assert_called_once_with('org','old');self.assertEqual([c.args[0] for c in ses.call_args_list],['old','new']);self.assertFalse((Path(d)/'payment').exists())
 def test_send_blocked_before_incoming_no_rpc(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);plan={'sessionId':'s','organizationId':'o','maximumTotalGasWei':str(m.GAS_CAP),'paymentUSDCUnits':2020000};raw=json.dumps(plan).encode();(p/'unsigned-plan.json').write_bytes(raw)
   with patch.object(m,'P',p),patch.object(m,'read',return_value=plan),patch.object(m,'context',return_value=('o','s')),patch.object(m.route,'status',return_value={'swapState':'PENDING_DEPOSIT','oldBalanceBaseline':{'usdcUnits':'69492'}}),patch.object(m.route,'balances',return_value={'usdcUnits':'69492'}),patch.object(m,'rpc') as rpc:
    with self.assertRaises(ValueError):m.send_reviewed(hashlib.sha256(raw).hexdigest())
    rpc.assert_not_called()
 def run_full_send(self,cancelled=False,l1=100,eth=100000000000000,gas_refusal=False):
  from eth_account import Account
  import datetime
  key=Account.from_key(bytes([1])*32);at=datetime.datetime(2026,10,15,12,tzinfo=datetime.timezone.utc)
  dest='0x'+'2'*40;asset='nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
  amount=2020000;data='0xa9059cbb'+dest[2:].zfill(64)+hex(amount)[2:].zfill(64)
  tx={'chainId':8453,'nonce':1,'to':m.route.TOKEN,'value':0,'data':data,'gas':50000,'maxFeePerGas':100,'maxPriorityFeePerGas':1,'type':2}
  signed=key.sign_transaction(tx);h='0x'+signed.hash.hex().removeprefix('0x')
  plan={'transaction':tx,'sessionId':'s','paymentId':'p','organizationId':'o','maximumTotalGasWei':str(m.GAS_CAP),'estimatedMaximumGasWei':'5000200','expectedTxHash':h,'paymentUSDCUnits':amount,'depositAddress':dest,'preparedAt':at.isoformat()}
  prepared={'quote':{'depositAddress':dest},'payment':{'paymentId':'p','depositAddress':dest,'request':{'idempotencyKey':'session:s'}}}
  backend={'status':'PENDING_DEPOSIT','quoteResponse':{'quoteRequest':{'originAsset':m.route.DEST,'refundTo':key.address,'refundType':'ORIGIN_CHAIN','recipient':'jasnah-treasury.sputnik-dao.near','recipientType':'DESTINATION_CHAIN','destinationAsset':asset,'swapType':'EXACT_OUTPUT','amount':'2000000','deadline':'2026-10-15T12:10:00Z'},'quote':{'depositAddress':dest,'amountIn':str(amount),'amountOut':'2000000','deadline':'2026-10-16T12:10:00Z'}}}
  fresh={'json':{'session':{'status':'CANCELLED' if cancelled else 'PENDING','sessionId':'s','paymentId':'p','metadata':{'organizationId':'o'},'amount':{'amount':'2000000','assetId':asset,'decimals':6},'expiresAt':'2026-10-15T13:00:00Z'}}}
  calls=[]
  def rpc(method,args):
   calls.append(method)
   if method=='eth_getTransactionCount':return '0x1'
   if method=='eth_estimateGas':return hex(40000)
   if method=='eth_getBlockByNumber':return {'baseFeePerGas':'0x14'}
   if method=='eth_call':return hex(l1 if args[0]['to'].startswith('0x4200') else 1)
   if method=='eth_sendRawTransaction':raise TimeoutError('synthetic ambiguous submission')
   raise AssertionError(method)
  original=m.read
  def read(p):
   if str(p).endswith('fresh-payer-wallet.json'):return {'private_key':'0x'+bytes([1]*32).hex()}
   return original(p)
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);m.save(p/'unsigned-plan.json',plan);m.save(p/'prepared-private.json',prepared);digest=hashlib.sha256((p/'unsigned-plan.json').read_bytes()).hexdigest()
   with patch.object(m,'P',p),patch.object(m,'read',side_effect=read),patch.object(m,'context',return_value=('o','s')),patch.object(m,'payment_history',return_value={'invoicePaid':False}),patch.object(m.route,'PAYER',key.address),patch.object(m.route,'now',return_value=at),patch.object(m.route,'status',return_value=self.incoming()),patch.object(m.route,'balances',return_value={'usdcUnits':'2169492','ethWei':str(eth)}),patch.object(m.route,'request',side_effect=[backend,fresh]),patch.object(m,'rpc',side_effect=rpc):
    if gas_refusal:
     with self.assertRaisesRegex(ValueError,'total gas cap'):m.send_reviewed(digest)
     self.assertNotIn('eth_sendRawTransaction',calls);self.assertFalse((p/'submission-intent-private.json').exists());return
    if cancelled:
     with self.assertRaises(ValueError):m.send_reviewed(digest)
     self.assertNotIn('eth_sendRawTransaction',calls);self.assertFalse((p/'submission-intent-private.json').exists());return
    with self.assertRaises(TimeoutError):m.send_reviewed(digest)
    result=m.failure_result();self.assertEqual(result['state'],'unknown');self.assertEqual(result['knownTxHash'],h)
    persisted=original(p/'submission-intent-private.json');self.assertEqual(persisted['txHash'],h);self.assertEqual(persisted['signedTransaction'],'0x'+bytes(signed.raw_transaction).hex());self.assertEqual(persisted['estimatedMaximumGasWei'],str(tx['gas']*tx['maxFeePerGas']+2*l1));self.assertIs(persisted['l1IsNotHardCap'],True)
    with self.assertRaises(ValueError):m.send_reviewed(digest)
    self.assertEqual(calls.count('eth_sendRawTransaction'),1)
 def test_full_send_timeout_durable_unknown_no_second_broadcast(self):self.run_full_send()
 def test_cancelled_invoice_future_expiry_no_broadcast(self):self.run_full_send(cancelled=True)
 def test_higher_live_l1_estimate_same_signed_wire_under_fixed_budget(self):self.run_full_send(l1=1000)
 def test_live_l1_crosses_fixed_budget_before_intent_or_broadcast(self):self.run_full_send(l1=m.GAS_CAP//2,gas_refusal=True)
 def test_live_eth_shortfall_before_intent_or_broadcast(self):self.run_full_send(l1=1000,eth=5001000,gas_refusal=True)
if __name__=='__main__':unittest.main()
