# SPDX-License-Identifier: MIT
import importlib.util,pathlib,tempfile,unittest
from unittest.mock import patch
P=pathlib.Path(__file__).parent
s=importlib.util.spec_from_file_location('baseline_cli',P/'near-fund.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ORG='11111111-1111-1111-1111-111111111111'
CONFIG={'organizationId':ORG,'session':{'access_token':'synthetic'}}
EMPTY={'organization_id':ORG,'credit_limits':[],'total_spent':0,'unfunded_amount':0,'legacy_unattributed_amount':0,'total_requests':0,'total_tokens':0}
class Tests(unittest.TestCase):
 def baseline(self,value):
  with patch.object(m.custody,'config',return_value=CONFIG),patch.object(m.custody,'call',return_value=(200,value)):return m.baseline()
 def test_actual_empty_schema(self):self.assertEqual(self.baseline(EMPTY),{'organization_id':ORG,'remaining':0,'total_spent':0})
 def test_funded_unchanged(self):self.assertEqual(self.baseline({'organization_id':ORG,'remaining':123,'total_spent':7})['remaining'],123)
 def test_missing_is_not_generally_zero(self):
  for delta in [{'credit_limits':[{}]},{'legacy_unattributed_amount':1},{'total_spent':False},{'unfunded_amount':1},{'remaining':None},{'spend_limit':0}]:
   with self.subTest(delta=delta),self.assertRaises(ValueError):self.baseline(dict(EMPTY,**delta))
 def test_resume_binding_or_baseline_before_invoice_only(self):
  for saved in [False,True]:
   with tempfile.TemporaryDirectory() as d:
    state=pathlib.Path(d)/'current';state.mkdir(mode=0o700);m.custody.save(state/'binding.json',{'version':1,'contextSha256':'pin'})
    if saved:m.custody.save(state/'baseline-credit.json',{'organization_id':ORG,'remaining':0,'total_spent':0})
    with patch.object(m.custody,'config',return_value=CONFIG),patch.object(m.custody,'call',return_value=(200,EMPTY)) as get,patch.object(m.payment,'cloud',return_value={'sessionId':'owned_invoice'}) as post,patch.object(m.incoming,'prepare',return_value={'state':'quote'}) as quote:
     self.assertTrue(m.preinvoice_state(state));m.new_attempt(state,'pin',2);self.assertEqual(get.call_count,0 if saved else 1);post.assert_called_once();quote.assert_called_once()
     with self.assertRaises(ValueError):m.new_attempt(state,'pin',2)
     self.assertEqual(post.call_count,1)
 def test_unknown_invoice_intent_never_posted_again(self):
  with tempfile.TemporaryDirectory() as d:
   state=pathlib.Path(d)/'current';state.mkdir(mode=0o700)
   for n in ['binding.json','invoice-intent.json']:m.custody.save(state/n,{'version':1,'contextSha256':'pin'})
   with patch.object(m.payment,'cloud') as post,patch.object(m.custody,'call') as get:
    self.assertFalse(m.preinvoice_state(state))
    with self.assertRaises(ValueError):m.new_attempt(state,'pin',2)
    post.assert_not_called();get.assert_not_called()
 def test_wrong_binding_refused_before_get(self):
  with tempfile.TemporaryDirectory() as d:
   state=pathlib.Path(d)/'current';state.mkdir(mode=0o700);m.custody.save(state/'binding.json',{'version':1,'contextSha256':'wrong'})
   with patch.object(m.custody,'call') as get:
    with self.assertRaises(ValueError):m.new_attempt(state,'pin',2)
    get.assert_not_called()
if __name__=='__main__':unittest.main()
