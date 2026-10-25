# SPDX-License-Identifier: MIT
import unittest,datetime,tempfile
from pathlib import Path
from unittest.mock import patch
import incoming as m
class Tests(unittest.TestCase):
 def setUp(self):
  m.D=Path("/synthetic/incoming");m.UNITS=2000000
  self.n=datetime.datetime(2026,10,15,12,tzinfo=datetime.timezone.utc)
  self.w=m.terms('owned','2026-10-15T14:00:00Z',184861)
  self.v={'quoteRequest':dict(self.w),'quote':dict(amountOut='2160000',minAmountOut='2140000',amountIn='184861',amountInFormatted='0.00184861',depositAddress='t1JL9Q4crEv7KY29jwTRktabfE6nVdjJKwA',timeEstimate=457,deadline='2026-10-18T14:00:00Z')}
 def test_margin_and_earliest_deadline(self):
  with patch.object(m,'now',return_value=self.n):r=m.show(self.v,self.w,'PENDING_DEPOSIT',{})
  self.assertTrue(r['acceptNewDeposit']);self.assertEqual(r['safeSendBeforeUTC'],'2026-10-15T13:42:23+00:00')
 def test_amount_derived_from_integer(self):
  self.v['quote']['amountInFormatted']='999999'
  with patch.object(m,'now',return_value=self.n):r=m.show(self.v,self.w,'PENDING_DEPOSIT',{})
  self.assertEqual(r['amountZEC'],'0.00184861')
 def test_changed_status_terms_refused(self):
  import copy
  changed=copy.deepcopy(self.v);changed['quote']['timeEstimate']=999
  with patch.object(m,'read',side_effect=[{'request':self.w,'baseline':{'usdcUnits':'5'}},self.v]),patch.object(m,'request',return_value={'status':'PENDING_DEPOSIT','quoteResponse':changed}),patch.object(m,'balances') as b:
   with self.assertRaises(ValueError):m.status()
   b.assert_not_called()
 def test_too_late_refuses(self):
  with patch.object(m,'now',return_value=self.n+datetime.timedelta(seconds=6200)):r=m.show(self.v,self.w,'PENDING_DEPOSIT',{})
  self.assertFalse(r['acceptNewDeposit'])
 def test_partial_refuses_new_funds(self):
  with patch.object(m,'now',return_value=self.n):r=m.show(self.v,self.w,'INCOMPLETE_DEPOSIT',{})
  self.assertFalse(r['acceptNewDeposit'])
 def test_amount_scales_request_and_display(self):
  m.UNITS=5000000;w=m.terms('owned','2026-10-15T14:00:00Z',184861)
  v={'quoteRequest':dict(w),'quote':dict(self.v['quote'],minAmountOut='5100000')}
  with patch.object(m,'now',return_value=self.n):r=m.show(v,w,'PENDING_DEPOSIT',{})
  self.assertEqual((r['destinationUSDC'],r['intendedNEARCreditUSD']),('5.10','5.00'))
  with self.assertRaises(ValueError):m.validate(self.v,w)
 def test_refund_substitution(self):
  self.v['quoteRequest']['refundTo']='other'
  with self.assertRaises(ValueError):m.validate(self.v,self.w)
 def test_minimum_below_floor_refused(self):
  self.v['quote']['minAmountOut']='2099999'
  with self.assertRaises(ValueError):m.validate(self.v,self.w)
 def test_input_substitution(self):
  self.v['quote']['amountIn']='184860'
  with self.assertRaises(ValueError):m.validate(self.v,self.w)
 def test_price_buffers_exact_output_quote(self):
  with patch.object(m,'request',return_value={'quote':{'amountIn':'160448'}}) as r:z=m.price('owned','2026-10-15T14:00:00Z')
  body=r.call_args.args[1];self.assertEqual((body['dry'],body['swapType'],body['amount']),(True,'EXACT_OUTPUT','2100000'));self.assertEqual(z,163657)
  self.assertEqual((self.w['swapType'],self.w['amount'],self.w['slippageTolerance']),('EXACT_INPUT','184861',500))
 def test_partial_intent_prevents_second_prepare(self):
  with tempfile.TemporaryDirectory() as d,patch.object(m,'D',Path(d)),patch.object(m,'request') as r:
   (Path(d)/'intent.json').write_text('{}')
   with self.assertRaises(ValueError):m.prepare()
   r.assert_not_called()
 def test_status_same_id_only(self):
  with patch.object(m,'read',side_effect=[{'request':self.w,'baseline':{'usdcUnits':'5'}},self.v]),patch.object(m,'request',return_value={'status':'PENDING_DEPOSIT','quoteResponse':self.v}) as req,patch.object(m,'balances',return_value={'usdcUnits':'5'}),patch.object(m,'now',return_value=self.n):
   r=m.status()
  self.assertEqual(req.call_count,1);self.assertIn('depositAddress='+self.v['quote']['depositAddress'],req.call_args.args[0]);self.assertEqual(len(req.call_args.args),1);self.assertFalse(r['providerCreditConfirmed'])
if __name__=='__main__':unittest.main()
