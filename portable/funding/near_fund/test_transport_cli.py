# SPDX-License-Identifier: MIT
import importlib.util,json,os,subprocess,sys,tempfile,unittest,urllib.request
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import context
spec=importlib.util.spec_from_file_location('near_fund_cli',Path(__file__).parent.parent/'near-fund.py');cli=importlib.util.module_from_spec(spec);spec.loader.exec_module(cli)
class Tests(unittest.TestCase):
 def test_lowercase_signer_normalized_and_protected_before_read(self):
  import base58
  from eth_account import Account
  key='0x'+bytes([1]*32).hex();address=Account.from_key(key).address
  v={'version':1,'organizationId':'00000000-0000-0000-0000-000000000000','baseAddress':address.lower(),'basePrivateKey':key,'refundAddress':base58.b58encode_check(bytes.fromhex('1cb8')+bytes([1])*20).decode(),'refundBackupVerified':True,'session':{'access_token':'synthetic','refresh_token':'synthetic'}}
  order=[]
  with tempfile.TemporaryDirectory() as d,patch.object(context,'protect_process',side_effect=lambda:order.append('protected')),patch.object(context,'read',side_effect=lambda p:(order.append('read'),v)[1]):
   context.configure(Path(d)/'config.json')
  self.assertEqual(order,['protected','read']);self.assertEqual(context.config()['baseAddress'],address)
 def test_actual_process_core_and_dump_policy(self):
  code="import sys,resource,ctypes;sys.path.insert(0,sys.argv[1]);import context;context.protect_process();assert resource.getrlimit(resource.RLIMIT_CORE)==(0,0);assert ctypes.CDLL(None).prctl(3,0,0,0,0)==0"
  result=subprocess.run([sys.executable,'-I','-c',code,str(Path(context.__file__).parent)],capture_output=True,timeout=5)
  self.assertEqual(result.returncode,0)
 def test_actual_pipe_no_credentials_argv_env_fixed_tor(self):
  original=subprocess.Popen;calls=[]
  def spawn(argv,**kw):
   calls.append((argv,kw));return original([sys.executable,'-I','-c','import sys; x=sys.stdin.buffer.read(); assert b"synthetic-token" in x; sys.stdout.write("{\\\"ok\\\":true}\\n200")'],**kw)
  req=urllib.request.Request('https://cloud-api.near.ai/v1/test',headers={'Authorization':'Bearer synthetic-token'})
  with patch.object(context.subprocess,'Popen',side_effect=spawn):body,code=context.curl_request(req)
  self.assertEqual(code,200);self.assertEqual(json.loads(body),{'ok':True})
  argv,kw=calls[0];self.assertEqual(argv[0:2],['/usr/bin/curl','--disable']);self.assertNotIn('synthetic-token',' '.join(argv));self.assertEqual(kw['env'],{})
  for flag,value in [('--socks5-hostname','127.0.0.1:9050'),('--noproxy',''),('--retry','0'),('--proto','=https'),('--max-redirs','0')]:self.assertEqual(argv[argv.index(flag)+1],value)
  self.assertNotIn('--location',argv);self.assertNotIn('--insecure',argv)
 def test_patch_wire_on_stdin_and_delete_refused(self):
  original=subprocess.Popen
  def spawn(argv,**kw):
   return original([sys.executable,'-I','-c','import sys; x=sys.stdin.buffer.read(); assert b"request = \\"PATCH\\"" in x and b"spendLimit" in x; sys.stdout.write("{}\\n200")'],**kw)
  req=urllib.request.Request('https://cloud-api.near.ai/v1/test',data=b'{"spendLimit":{}}',method='PATCH')
  with patch.object(context.subprocess,'Popen',side_effect=spawn):self.assertEqual(context.curl_request(req)[1],200)
  with patch.object(context.subprocess,'Popen') as p:
   with self.assertRaises(ValueError):context.curl_request(urllib.request.Request('https://cloud-api.near.ai/v1/test',method='DELETE'))
   p.assert_not_called()
 def test_fixed_near_chain_isolation_only(self):
  original=subprocess.Popen;calls=[]
  def spawn(argv,**kw):
   calls.append(argv);return original([sys.executable,'-I','-c','import sys;sys.stdin.buffer.read();print("{}\\n200",end="")'],**kw)
  for url in ['https://rpc.mainnet.near.org','https://base-rpc.publicnode.com','https://cloud-api.near.ai/v1/test']:
   with patch.object(context.subprocess,'Popen',side_effect=spawn):context.curl_request(urllib.request.Request(url))
  self.assertEqual(calls[0][calls[0].index('--proxy-user')+1],'dsmack-near-chain:1')
  for argv in calls[1:]:self.assertNotIn('--proxy-user',argv)
 def test_bad_origin_and_auth_no_process(self):
  for url,headers in [('http://cloud-api.near.ai/x',{}),('https://evil.invalid/x',{}),('https://mainnet.base.org',{}),('https://base-rpc.publicnode.com',{'Authorization':'Bearer synthetic'}),('https://pay.pingpay.io/x',{'Cookie':'synthetic'})]:
   with patch.object(context.subprocess,'Popen') as p:
    with self.assertRaises(ValueError):context.curl_request(urllib.request.Request(url,headers=headers))
    p.assert_not_called()
 def test_oversized_output_killed_reaped(self):
  original=subprocess.Popen;children=[]
  def spawn(argv,**kw):
   p=original([sys.executable,'-I','-c','import sys;sys.stdin.buffer.read();sys.stdout.buffer.write(b"x"*300000);sys.stdout.flush()'],**kw);children.append(p);return p
  with patch.object(context.subprocess,'Popen',side_effect=spawn):
   with self.assertRaises(ValueError):context.curl_request(urllib.request.Request('https://base-rpc.publicnode.com'))
  self.assertIsNotNone(children[0].returncode)
 def test_ambiguous_invoice_blocks_second_new_no_quote(self):
  with tempfile.TemporaryDirectory() as d:
   state=Path(d)/'attempt';config={'organizationId':'00000000-0000-0000-0000-000000000000'}
   with patch.object(context,'config',return_value=config),patch.object(cli,'baseline',return_value={}),patch.object(cli.payment,'cloud',side_effect=TimeoutError),patch.object(cli.incoming,'prepare') as quote:
    with self.assertRaises(TimeoutError):cli.new_attempt(state,'binding',2)
    self.assertTrue((state/'invoice-intent.json').exists())
    with self.assertRaises(ValueError):cli.new_attempt(state,'binding',2)
    quote.assert_not_called()
 def test_amount_sets_invoice_and_quote_and_is_bounded(self):
  with tempfile.TemporaryDirectory() as d:
   state=Path(d)/'attempt';config={'organizationId':'00000000-0000-0000-0000-000000000000'};cli.incoming.UNITS=5000000
   with patch.object(context,'config',return_value=config),patch.object(cli,'baseline',return_value={}),patch.object(cli.payment,'cloud',return_value={'sessionId':'s'}) as post,patch.object(cli.incoming,'prepare',side_effect=lambda:str(cli.incoming.floor())):
    self.assertEqual(cli.new_attempt(state,'binding',5),'5100000')
    self.assertEqual(post.call_args.args[1]['amount'],500);self.assertEqual(context.read(state/'invoice-intent.json')['amount'],500)
  for bad in (0,11,True):
   with patch.object(context,'configure',return_value='b'),patch.object(cli.payment,'cloud') as post,tempfile.TemporaryDirectory() as d:
    with self.assertRaises(ValueError):cli.execute(SimpleNamespace(config='unused',state=d+'/attempt',command='new',plan_sha=None,amount=bad))
    post.assert_not_called()
 def test_credit_requires_no_attempt_and_performs_only_balance_get(self):
  from types import SimpleNamespace
  config={'organizationId':'00000000-0000-0000-0000-000000000000','session':{'access_token':'synthetic'}}
  good={'organization_id':config['organizationId'],'remaining':1,'total_spent':2}
  for value,ok in [(good,True),({**good,'organization_id':'other'},False),({**good,'remaining':-1},False),({**good,'remaining':True},False)]:
   with patch.object(context,'configure',return_value='binding'),patch.object(context,'config',return_value=config),patch.object(context,'call',return_value=(200,value)) as call,patch.object(context,'private_directory') as directory,patch.object(context,'save') as save,patch.object(cli.payment,'cloud') as post:
    if ok:self.assertEqual(cli.execute(SimpleNamespace(config='unused',state=None,command='credit'))['accountCredit'],good)
    else:
     with self.assertRaises(ValueError):cli.execute(SimpleNamespace(config='unused',state=None,command='credit'))
    self.assertEqual(call.call_count,1);directory.assert_not_called();save.assert_not_called();post.assert_not_called()
 def test_status_and_resume_dispatch_never_mutate(self):
  from types import SimpleNamespace
  with tempfile.TemporaryDirectory() as d:
   state=Path(d)/'attempt';state.mkdir(mode=0o700);context.save(state/'binding.json',{'version':1,'contextSha256':'binding'});context.save(state/'invoice-intent.json',{'amount':300})
   for command in ('status','resume'):
    with patch.object(context,'configure',return_value='binding'),patch.object(context,'config',return_value={'baseAddress':'synthetic'}),patch.object(cli,'status',return_value={'known':True}),patch.object(cli.incoming,'prepare') as quote,patch.object(cli.payment,'send_reviewed') as send:
     self.assertEqual(cli.execute(SimpleNamespace(config='unused',state=str(state),command=command)),{'known':True});quote.assert_not_called();send.assert_not_called();self.assertEqual(cli.incoming.UNITS,3000000)
if __name__=='__main__':unittest.main()
