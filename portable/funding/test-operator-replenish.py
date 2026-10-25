# SPDX-License-Identifier: MIT
"""Operator ~/fund standing, attempt retirement and key replenishment with synthetic account; no network."""
import contextlib,importlib.util,io,json,os,pathlib,sys,tempfile,types,unittest
from unittest.mock import patch
P=pathlib.Path(__file__).parent;sys.path.insert(0,str(P));sys.path.insert(0,str(P/'near_fund'))
import context
from near_fund import account as account_module
from eth_account import Account as Eth
import base58
s=importlib.util.spec_from_file_location('operator_session_replenish',P/'operator-session.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ORG='11111111-1111-1111-1111-111111111111'
class Fake:
 limit=20000000;usage=20000000;issued=True;limits=[]
 def __init__(self,directory):pass
 def ensure_session(self):return {'organizationId':ORG,'session':{'access_token':'synthetic','refresh_token':'synthetic'},'userAgent':'dsmack-portable-account/1.0'}
 def key_standing(self):return {'limitNanoUSD':Fake.limit,'usageNanoUSD':Fake.usage} if Fake.issued else None
 def set_key_limit(self,amount):Fake.limits.append(amount);Fake.limit=amount;return self.key_standing()
 def issue_key(self):return {'version':1,'provider':'near','model':'z-ai/glm-5.3-flash','apiKey':'sk-synthetic'}
class Tests(unittest.TestCase):
 def setUp(self):
  Fake.limit=20000000;Fake.usage=20000000;Fake.issued=True;Fake.limits=[]
  self.tmp=tempfile.TemporaryDirectory();self.base=pathlib.Path(self.tmp.name);self.base.chmod(0o700)
  for d in ('attempts','account'):(self.base/d).mkdir(mode=0o700)
  context.save(self.base/'account/session.json',{})
  key='0x'+'01'*32;refund=base58.b58encode_check(bytes.fromhex('1cb8')+b'\x02'*20).decode()
  context.save(self.base/'transit-private.json',{'baseAddress':Eth.from_key(key).address,'basePrivateKey':key,'refundAddress':refund,'refundBackupVerified':True})
 def tearDown(self):self.tmp.cleanup()
 def main(self,args,flow=None,remaining=1977000000):
  out=io.StringIO()
  balance=lambda path,token:(200,{'organization_id':ORG,'remaining':remaining,'total_spent':2023000000})
  with patch.object(m,'BASE',self.base),patch.object(m,'STATE',self.base/'attempts/current'),patch.object(m,'os',types.SimpleNamespace(getuid=lambda:972,replace=os.replace,rename=os.rename)),patch.object(account_module,'Account',Fake),patch.object(context,'call',balance),patch.object(m.flow,'fund',flow or (lambda *a,**k:self.fail('flow'))),patch.object(sys,'argv',['operator-session.py',*args]),contextlib.redirect_stdout(out):
   result=m.main()
  return result,[json.loads(line) for line in out.getvalue().splitlines()]
 def attempt(self,shown=True):
  (self.base/'attempts/current/incoming').mkdir(mode=0o700,parents=True)
  context.save(self.base/'attempts/current/invoice-intent.json',{'amount':200})
  if shown:context.save(self.base/'attempts/current/incoming/review.json',{})
 def test_completed_attempt_raises_key_to_account_and_is_recorded(self):
  context.save(self.base/'activation-complete.json',{'state':'funded-and-service-started'});self.attempt()
  def flow(run,prepare,complete,retire,emit,existing):
   self.assertTrue(existing);self.assertIsNone(complete({'invoiceId':'inv','accountCredit':{'observedUTC':'2026-10-21T18:00:00+00:00'}}));return {'state':'watching'}
  result,events=self.main(['fund'],flow)
  self.assertEqual(events[0],{'phase':'standing','account':{'organization_id':ORG,'remaining':1977000000,'total_spent':2023000000},'key':{'limitNanoUSD':20000000,'usageNanoUSD':20000000},'lastFunding':None})
  self.assertEqual(Fake.limits,[1997000000]);self.assertFalse((self.base/'attempts/current').exists())
  self.assertEqual([e['phase'] for e in events[1:]],['retired','funded']);self.assertEqual(events[2]['key'],{'limitNanoUSD':1997000000,'usageNanoUSD':20000000})
  result,events=self.main(['fund'],lambda *a,**k:{'state':'watching'})
  self.assertEqual(events[0]['lastFunding'],{'state':'funded','invoiceId':'inv','creditUSD':'2.00','observedUTC':'2026-10-21T18:00:00+00:00'})
 def test_key_never_lowered(self):
  context.save(self.base/'activation-complete.json',{'state':'funded-and-service-started'});self.attempt();Fake.limit=3000000000
  self.main(['fund'],lambda run,prepare,complete,retire,emit,existing:complete({'invoiceId':'inv','accountCredit':{'observedUTC':'x'}}))
  self.assertEqual(Fake.limits,[])
 def test_attempt_without_shown_address_is_retired_before_new_quote(self):
  self.attempt(shown=False)
  def flow(run,prepare,complete,retire,emit,existing):self.assertFalse(existing);return {'state':'watching'}
  result,events=self.main(['fund'],flow)
  self.assertEqual(events[1],{'phase':'retired','kind':'unissued'});self.assertEqual(len([p for p in (self.base/'attempts').iterdir() if p.name.endswith('-unissued')]),1)
 def test_first_funding_installs_key_instead_of_raising(self):
  Fake.issued=False;self.attempt()
  def flow(run,prepare,complete,retire,emit,existing):return complete({'invoiceId':'inv','accountCredit':{'observedUTC':'x'}})
  result,events=self.main(['fund'],flow)
  self.assertTrue(result['inferenceCredentialPrepared']);self.assertEqual(Fake.limits,[]);self.assertIsNone(events[0]['key'])
  self.assertEqual(context.read(self.base/'provider-next.json')['apiKey'],'sk-synthetic')
 def test_amount_reaches_new_quote_and_completion(self):
  context.save(self.base/'activation-complete.json',{'state':'funded-and-service-started'});seen=[]
  cli=types.SimpleNamespace(execute=lambda a:seen.append((a.command,a.amount)) or {},baseline=lambda:{'remaining':1977000000})
  loader=types.SimpleNamespace(util=types.SimpleNamespace(spec_from_file_location=lambda *a:types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda _:None)),module_from_spec=lambda _:cli))
  def flow(run,prepare,complete,retire,emit,existing):
   run('new');self.attempt();(self.base/'attempts/current/invoice-intent.json').unlink();context.save(self.base/'attempts/current/invoice-intent.json',{'amount':500})
   return complete({'invoiceId':'inv','accountCredit':{'observedUTC':'x'}})
  with patch.object(m,'importlib',loader):result,events=self.main(['fund','5'],flow)
  self.assertEqual(seen,[('new',5)]);self.assertEqual(events[-1]['creditUSD'],'5.00')
 def test_missing_funding_wallet_is_one_clear_result(self):
  (self.base/'transit-private.json').unlink()
  self.assertEqual(self.main(['fund']),({'state':'funding-not-set-up'},[]))
 def test_explicit_key_limit(self):
  result,_=self.main(['key-limit','3000000000'])
  self.assertEqual(result,{'state':'key-limit-set','key':{'limitNanoUSD':3000000000,'usageNanoUSD':20000000}});self.assertEqual(Fake.limits,[3000000000])
if __name__=='__main__':unittest.main()
