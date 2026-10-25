# SPDX-License-Identifier: MIT
import importlib.util,pathlib,tempfile,unittest
from unittest.mock import patch
P=pathlib.Path(__file__).parent
s=importlib.util.spec_from_file_location('status_cli',P/'near-fund.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
p=m.payment;h='0x'+'1'*64
class Tests(unittest.TestCase):
 def payment_case(self,history_error,receipt_error=None):
  with tempfile.TemporaryDirectory() as d:
   path=pathlib.Path(d);m.custody.save(path/'submission-intent-private.json',{'txHash':h});order=[]
   def rpc(*args):
    order.append('receipt')
    if receipt_error:raise receipt_error
    return {'transactionHash':h,'from':'payer','to':'token','status':'0x1'}
   def history(*args):order.append('history');raise history_error
   with patch.object(p,'P',path),patch.object(p,'context',return_value=('org','invoice')),patch.object(p.route,'PAYER','payer'),patch.object(p.route,'TOKEN','token'),patch.object(p,'rpc',side_effect=rpc),patch.object(p,'payment_history',side_effect=history),patch.object(p,'account_balance',return_value={'state':'unknown'}),patch.object(p,'credit_observation',return_value=False):
    result=p.status()
   return result,order
 def test_history_http_failure_preserves_confirmed_receipt(self):
  r,order=self.payment_case(m.custody.TransportReadError('http refused'));self.assertEqual(order,['receipt','history']);self.assertEqual(r['transactionState'],'confirmed');self.assertEqual(r['transactionHash'],h);self.assertEqual(r['invoiceObservation'],'http-read-unavailable')
 def test_both_http_failures_keep_known_hash(self):
  r,_=self.payment_case(m.custody.TransportReadError('http'),m.custody.TransportReadError('http'));self.assertEqual(r['transactionHash'],h);self.assertEqual(r['transactionObservation'],'http-read-unavailable')
 def test_invoice_binding_failure_still_refuses(self):
  with self.assertRaises(ValueError):self.payment_case(ValueError('history organization'))
 def test_incoming_failure_cannot_hide_payment(self):
  with patch.object(p,'status',return_value={'transactionHash':h,'transactionState':'confirmed'}),patch.object(m.incoming,'status',side_effect=m.custody.TransportReadError('http')):
   r=m.status();self.assertEqual(r['payment']['transactionHash'],h);self.assertEqual(r['incoming']['state'],'unknown')
 def test_incoming_binding_error_still_refuses(self):
  with patch.object(p,'status',return_value={}),patch.object(m.incoming,'status',side_effect=ValueError('replacement quote refused')):
   with self.assertRaises(ValueError):m.status()
if __name__=='__main__':unittest.main()
