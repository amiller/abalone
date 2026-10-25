# SPDX-License-Identifier: MIT
"""Actual fresh NEP413/config/invoice/quote join with synthetic HTTP; no network."""
import base64,importlib.util,json,os,pathlib,sys,tempfile,time,types,unittest,urllib.parse
from unittest.mock import patch
P=pathlib.Path(__file__).parent;sys.path.insert(0,str(P));sys.path.insert(0,str(P/'near_fund'))
import context
from near_fund import activation
from near_fund import context as account_context
from eth_account import Account
import base58
s=importlib.util.spec_from_file_location('operator_session',P/'operator-session.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def test_actual_fresh_account_to_owned_quote(self):
  calls=[];identity={};org='11111111-1111-1111-1111-111111111111';work='22222222-2222-2222-2222-222222222222';owner='33333333-3333-3333-3333-333333333333'
  jwt='e30.'+base64.urlsafe_b64encode(json.dumps({'exp':int(time.time())+3600}).encode()).decode().rstrip('=')+'.synthetic'
  def http(req):
   path=urllib.parse.urlsplit(req.full_url).path;body=json.loads(req.data) if req.data else None;calls.append(path)
   if path=='/v1/auth/near':
    identity['id']=body['signed_message']['accountId'];self.assertEqual(body['payload']['recipient'],'cloud.near.ai')
    value={'access_token':jwt,'refresh_token':'rt_synthetic','refresh_token_expiration':'2099-01-01T00:00:00Z'}
   elif path=='/v1/users/me':value={'auth_provider':'near','is_active':True,'id':owner,'email':identity['id']+'@near','organizations':[{'id':org,'role':'owner','is_active':True}],'workspaces':[{'id':work,'organization_id':org,'is_active':True}]}
   elif path.endswith('/usage/balance'):value={'organization_id':org,'remaining':0,'total_spent':0}
   elif path=='/api/pingpay/create-checkout-session':value={'sessionId':'synthetic-checkout'}
   elif path in ('','/'):value={'result':{'eth_chainId':'0x2105','eth_getBalance':'0x100000000000000','eth_call':'0x0'}[body['method']]}
   elif path=='/v0/quote':value={'quoteRequest':body,'quote':{'amountOut':'2160000','minAmountOut':'2140000','amountIn':'100000' if body['dry'] else body['amount'],'depositAddress':body['refundTo'],'deadline':body['deadline'],'timeEstimate':455}}
   else:self.fail('unexpected fixed request '+path)
   return json.dumps(value).encode(),200
  with tempfile.TemporaryDirectory() as d:
   base=pathlib.Path(d);base.chmod(0o700);(base/'attempts').mkdir(mode=0o700)
   key='0x'+'01'*32;refund=base58.b58encode_check(bytes.fromhex('1cb8')+b'\x02'*20).decode()
   context.save(base/'transit-private.json',{'baseAddress':Account.from_key(key).address,'basePrivateKey':key,'refundAddress':refund,'refundBackupVerified':True})
   def first_step(run,prepare,complete,retire,emit,existing=False):
    self.assertFalse(existing);prepare();quote=run('new');self.assertTrue(quote['acceptNewDeposit']);self.assertEqual(quote['amountZEC'],'0.00102000');return {'state':'waiting-for-user-deposit'}
   with patch.object(m,'BASE',base),patch.object(m,'STATE',base/'attempts/current'),patch.object(m,'os',types.SimpleNamespace(getuid=lambda:972,replace=os.replace)),patch.object(context,'curl_request',http),patch.object(account_context,'curl_request',http),patch.object(m.flow,'fund',first_step),patch.object(activation,'Activation',lambda *_:types.SimpleNamespace(ensure=lambda:{'state':'activated-fixture'})),patch.object(sys,'argv',['operator-session.py','fund']):
    self.assertEqual(m.main(),{'state':'waiting-for-user-deposit'})
   self.assertEqual(calls.count('/v1/auth/near'),1);self.assertEqual(calls.count('/v0/quote'),2)
   cfg=context.read(base/'config.json');self.assertEqual(cfg['organizationId'],org);self.assertEqual(cfg['basePrivateKey'],key);self.assertEqual(cfg['userAgent'],'dsmack-portable-account/1.0')
   self.assertTrue((base/'account/identity-private.json').exists());self.assertTrue((base/'attempts/current/incoming/intent.json').exists())
if __name__=='__main__':unittest.main()
