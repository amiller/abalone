# SPDX-License-Identifier: MIT
"""Offline owner/account contracts. No auth/provider/model/payment calls."""
import base64,datetime,hashlib,json,os,struct,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import base58
from nacl.signing import VerifyKey
from . import account as a
OWNER='12345678-1234-4234-8234-123456789abc';ORG='23456789-1234-4234-8234-123456789abc';WORK='34567890-1234-4234-8234-123456789abc';KID='45678901-1234-4234-8234-123456789abc'
def jwt(exp):return 'A.'+base64.urlsafe_b64encode(json.dumps({'exp':exp}).encode()).rstrip(b'=').decode()+'.SYNTHETIC'
class Fixture:
 def __init__(self,path):self.path=path;self.now=1760000000;self.calls=[];self.accountId=None;self.generation=0;self.zero=False;self.wrong=False;self.timeout=False;self.cap=2000000000;self.usage=0;self.patches=[]
 def pair(self):return {'access_token':jwt(self.now+3600),'refresh_token':'rt_SYNTHETIC_'+str(self.generation),'refresh_token_expiration':datetime.datetime.fromtimestamp(self.now+604800,datetime.timezone.utc).isoformat()}
 def request(self,method,path,token=None,body=None,user_agent=None):
  self.calls.append((method,path));assert user_agent==a.UA
  if path=='/v1/auth/near':
   self.accountId=body['signed_message']['accountId'];pub=base58.b58decode(body['signed_message']['publicKey'].split(':')[1]);assert pub.hex()==self.accountId
   message=body['payload']['message'].encode();recipient=body['payload']['recipient'].encode();nonce=bytes(body['payload']['nonce'])
   signed=struct.pack('<II',2**31+413,len(message))+message+nonce+struct.pack('<I',len(recipient))+recipient+b'\0'
   VerifyKey(pub).verify(hashlib.sha256(signed).digest(),base64.b64decode(body['signed_message']['signature']));assert (self.path/'bootstrap-intent.json').exists();return self.pair()
  if path=='/v1/users/me/access-tokens':
   assert body is None and token.startswith('rt_');assert (self.path/'refresh-intent-1.json').exists()
   if self.timeout:raise RuntimeError('SYNTHETIC_SECRET_CANARY')
   self.generation+=1;return self.pair()
  if path=='/v1/users/me':
   candidate=self.path/('bootstrap-candidate.json' if self.generation==0 else 'refresh-candidate-1.json')
   assert candidate.exists() and a.read(candidate)['session']['access_token']==token
   org=KID if self.wrong else ORG
   return {'id':OWNER,'auth_provider':'near','is_active':True,'email':self.accountId+'@near','organizations':[{'id':org,'role':'owner','is_active':True}],'workspaces':[{'id':WORK,'organization_id':org,'is_active':True}]}
  if '/usage/balance' in path:return {'organization_id':ORG,'remaining':0 if self.zero else 2000000000,'total_spent':0,'spend_limit':2000000000,'unfunded_amount':0}
  if path.endswith('/api-keys') and method=='POST':
   assert body['spendLimit']=={'amount':2000000000,'currency':'USD'};assert (self.path/'key-intent.json').exists();return {'key':'sk-SYNTHETIC_KEY','id':KID,'workspace_id':WORK}
  if path.endswith('/api-keys'):
   assert (self.path/'key-candidate.json').exists();return {'api_keys':[{'id':KID,'workspace_id':WORK,'created_by_user_id':OWNER,'is_active':True,'deleted_at':None,'spend_limit':{'amount':self.cap,'currency':'USD','scale':9},'usage':{'amount':self.usage,'currency':'USD','scale':9}}]}
  if method=='PATCH' and path=='/v1/workspaces/'+WORK+'/api-keys/'+KID+'/spend-limit':
   assert token==self.pair()['access_token'] and set(body)=={'spendLimit'};self.patches.append(body['spendLimit']);self.cap=body['spendLimit']['amount']+(1 if self.wrong else 0)
   return {'id':KID,'spend_limit':{'amount':self.cap,'currency':'USD','scale':9},'usage':{'amount':self.usage,'currency':'USD','scale':9}}
  raise AssertionError('unexpected fixed request')
class Tests(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.dir=Path(self.tmp.name);self.dir.chmod(0o700);self.f=Fixture(self.dir);self.account=a.Account(self.dir,self.f.request,lambda:self.f.now)
 def tearDown(self):self.account.close();self.tmp.cleanup()
 def test_real_auth_response_user_metadata_canonicalized_and_raw_durable(self):
  request=self.f.request
  def reply(method,path,**kwargs):
   value=request(method,path,**kwargs)
   if path=='/v1/auth/near':value=dict(value,user={'id':OWNER,'metadata':'SYNTHETIC'})
   if path=='/v1/users/me':self.assertEqual(a.read(self.dir/'bootstrap-response-private.json')['user']['id'],OWNER)
   return value
  self.account.request=reply
  self.account.bootstrap();saved=self.account.load()
  self.assertEqual(set(saved['session']),{'access_token','refresh_token','refresh_token_expiration'})
  self.assertEqual(a.read(self.dir/'bootstrap-response-private.json')['user'],{'id':OWNER,'metadata':'SYNTHETIC'})
 def test_auth_response_unknown_fields_or_bad_user_retained_before_refusal(self):
  for metadata in ({'unknown':'SYNTHETIC'}, {'user':None}, {'user':[]}, {'user':'SYNTHETIC'}):
   with self.subTest(metadata=metadata),tempfile.TemporaryDirectory() as d:
    directory=Path(d);directory.chmod(0o700);fixture=Fixture(directory);request=fixture.request
    def reply(method,path,**kwargs):
     result=request(method,path,**kwargs)
     return dict(result,**metadata) if path=='/v1/auth/near' else result
    account=a.Account(directory,reply,lambda:fixture.now)
    try:
     with self.assertRaises(a.AccountUnavailable):account.bootstrap()
     raw=a.read(directory/'bootstrap-response-private.json')
     for k,v in metadata.items():self.assertEqual(raw[k],v)
     self.assertFalse((directory/'session.json').exists());self.assertEqual(fixture.calls,[('POST','/v1/auth/near')])
    finally:account.close()
 def test_persisted_session_rejects_response_only_user_metadata(self):
  self.account.bootstrap();record=self.account.load();record['session']['user']={}
  self.account.write('bad-session.json',record);self.account.promote('bad-session.json')
  with self.assertRaises(a.AccountUnavailable):self.account.ensure_session()
 def test_activation_hook_is_public_only_before_auth_and_cached_session_skips(self):
  observed=[]
  def activate(identity):
   self.assertEqual(set(identity),{'accountId','publicKey'})
   self.assertEqual(base58.b58decode(identity['publicKey'].split(':')[1]).hex(),identity['accountId'])
   self.assertTrue((self.dir/'identity-private.json').exists());self.assertFalse((self.dir/'bootstrap-intent.json').exists());self.assertEqual(self.f.calls,[])
   observed.append(identity)
  self.account.bootstrap(before_auth=activate);self.assertEqual(len(observed),1)
  self.account.bootstrap(before_auth=lambda _:self.fail('cached session must skip activation'))
 def test_activation_failure_makes_no_auth_intent_or_request_and_reuses_identity(self):
  observed=[]
  def fail(identity):observed.append(identity);raise RuntimeError('PRIVATE')
  with self.assertRaisesRegex(a.AccountUnavailable,'^Account unavailable$'):self.account.bootstrap(before_auth=fail)
  self.assertEqual(self.f.calls,[]);self.assertFalse((self.dir/'bootstrap-intent.json').exists())
  self.account.bootstrap(before_auth=lambda identity:self.assertEqual(identity,observed[0]))
 def test_ambiguous_auth_intent_refuses_before_activation_hook(self):
  self.account.write('bootstrap-intent.json',{'version':1,'automaticRetry':False})
  with self.assertRaises(a.AccountUnavailable):self.account.bootstrap(before_auth=lambda _:self.fail('must not activate after ambiguous auth'))
  self.assertEqual(self.f.calls,[])
 def test_real_signature_bootstrap_pair_durable_before_identity_and_cached_read(self):
  state=self.account.bootstrap();self.assertEqual(state['organizationId'],ORG);self.assertNotIn('seedHex',json.dumps(state));self.assertEqual(len(self.f.calls),2)
  self.assertEqual(self.account.bootstrap(),state);self.assertEqual(self.account.ensure_session(),state);self.assertEqual(len(self.f.calls),2)
  self.assertEqual((self.dir/'identity-private.json').stat().st_mode&0o777,0o600)
 def test_seed_free_rotation_pair_retained_before_identity(self):
  self.account.bootstrap();self.f.now+=3600;real=a.read
  def read(path):
   self.assertNotEqual(path.name,'identity-private.json');return real(path)
  with patch.object(a,'read',side_effect=read):state=self.account.ensure_session()
  self.assertEqual(state['session']['refresh_token'],'rt_SYNTHETIC_1');self.assertEqual(a.read(self.dir/'session.json')['generation'],2)
 def test_timeout_intent_survives_restart_and_never_posts_twice(self):
  self.account.bootstrap();self.f.now+=3600;self.f.timeout=True
  for account in (self.account,a.Account(self.dir,self.f.request,lambda:self.f.now)):
   with self.assertRaisesRegex(a.AccountUnavailable,'^Account unavailable$'):account.ensure_session()
  self.assertEqual(self.f.calls.count(('POST','/v1/users/me/access-tokens')),1)
 def test_wrong_owner_scope_keeps_rotated_pair_and_old_session(self):
  self.account.bootstrap();self.f.now+=3600;self.f.wrong=True
  with self.assertRaises(a.AccountUnavailable):self.account.ensure_session()
  self.assertEqual(a.read(self.dir/'session.json')['generation'],1);self.assertEqual(a.read(self.dir/'refresh-candidate-1.json')['session']['refresh_token'],'rt_SYNTHETIC_1')
 def test_zero_credit_never_creates_key(self):
  self.account.bootstrap();self.f.zero=True
  with self.assertRaises(a.AccountUnavailable):self.account.issue_key()
  self.assertFalse((self.dir/'key-intent.json').exists());self.assertEqual(sum(method=='POST' and path.endswith('/api-keys') for method,path in self.f.calls),0)
 def test_capped_key_single_creation_and_access_only_publisher_keep_provider_inode(self):
  self.account.bootstrap();key=self.account.issue_key();self.assertEqual(key['apiKey'],'sk-SYNTHETIC_KEY');self.assertEqual(self.account.issue_key(),key)
  credit=self.dir/'credit';credit.mkdir(mode=0o700);provider=credit/'provider.json';provider.write_text(json.dumps(dict(key,account={'organizationId':ORG,'accessToken':self.f.pair()['access_token']})));provider.chmod(0o600);before=provider.stat()
  self.account.publish_balance_account(credit);self.account.publish_balance_account(credit)
  sidecar=a.read(credit/'near-account.json');self.assertEqual(set(sidecar),{'organizationId','accessToken'});self.assertNotIn('refresh_token',json.dumps(sidecar));self.assertEqual(provider.stat().st_ino,before.st_ino)
  self.assertEqual(sum(method=='POST' and path.endswith('/api-keys') for method,path in self.f.calls),1)
 def test_wrong_cap_retains_candidate_and_prevents_second_creation(self):
  self.account.bootstrap();self.f.cap=2000000001
  for _ in range(2):
   with self.assertRaises(a.AccountUnavailable):self.account.issue_key()
  self.assertTrue((self.dir/'key-candidate.json').exists());self.assertFalse((self.dir/'api-key-private.json').exists());self.assertEqual(sum(method=='POST' and path.endswith('/api-keys') for method,path in self.f.calls),1)
 def test_key_standing_absent_before_issue_then_cap_and_usage(self):
  self.account.bootstrap();self.assertIsNone(self.account.key_standing());self.account.issue_key();self.f.usage=12345
  self.assertEqual(self.account.key_standing(),{'limitNanoUSD':2000000000,'usageNanoUSD':12345})
 def test_set_key_limit_patches_issued_key_and_verifies_reply(self):
  self.account.bootstrap();self.account.issue_key();self.f.usage=20000000
  self.assertEqual(self.account.set_key_limit(3000000000),{'limitNanoUSD':3000000000,'usageNanoUSD':20000000})
  self.assertEqual(self.f.patches,[{'amount':3000000000,'currency':'USD'}])
  self.f.wrong=True
  with self.assertRaises(a.AccountUnavailable):self.account.set_key_limit(4000000000)
  for bad in (0,-1,True,'3000000000'):
   with self.assertRaises(a.AccountUnavailable):self.account.set_key_limit(bad)
  self.assertEqual(len(self.f.patches),2)
 def test_set_key_limit_requires_issued_key(self):
  self.account.bootstrap()
  with self.assertRaises(a.AccountUnavailable):self.account.set_key_limit(3000000000)
  self.assertEqual(self.f.patches,[])
 def test_patch_refused_for_other_paths(self):
  with patch.object(a.context,'curl_request',side_effect=AssertionError('no transport')):
   for path in ('/v1/workspaces/'+WORK+'/api-keys/'+KID,'/v1/workspaces/'+WORK+'/api-keys','/v1/users/me'):
    with self.assertRaises(a.AccountUnavailable):a.owner_request('PATCH',path,token='t',body={})
 def test_account_b_cannot_publish_while_provider_a_active(self):
  self.account.bootstrap();credit=self.dir/'credit';credit.mkdir(mode=0o700)
  a.new(credit/'provider.json',{'version':1,'provider':'near','model':'z-ai/glm-5.3-flash','account':{'organizationId':KID,'accessToken':'SYNTHETIC'}})
  with self.assertRaises(a.AccountUnavailable):self.account.publish_balance_account(credit)
  self.assertFalse((credit/'near-account.json').exists())
 def test_refresh_helper_refuses_account_b_before_any_refresh_post(self):
  import importlib.util
  spec=importlib.util.spec_from_file_location('account_refresh',Path(__file__).resolve().parents[1]/'account-refresh.py');helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
  self.account.bootstrap();credit=self.dir/'credit';credit.mkdir(mode=0o700)
  a.new(credit/'provider.json',{'version':1,'provider':'near','model':'z-ai/glm-5.3-flash','account':{'organizationId':KID,'accessToken':'SYNTHETIC'}})
  before=len(self.f.calls)
  with self.assertRaises(a.AccountUnavailable):helper.refresh(self.account,credit)
  self.assertEqual(len(self.f.calls),before);self.assertFalse((credit/'near-account.json').exists())
 def test_refresh_directory_stays_pinned_across_new_account_directory_replacement(self):
  self.account.bootstrap();self.f.now+=3600
  archived=self.dir.with_name(self.dir.name+'-archived');os.rename(self.dir,archived);self.dir.mkdir(mode=0o700)
  self.f.path=archived
  try:
   self.account.ensure_session()
   self.assertEqual(a.read(archived/'session.json')['generation'],2)
   self.assertFalse((self.dir/'session.json').exists())
  finally:
   import shutil
   shutil.rmtree(archived)
 def test_fixed_two_slot_selector_uses_legacy_active_a_not_fresh_b_and_refuses_duplicate(self):
  import importlib.util,shutil
  spec=importlib.util.spec_from_file_location('account_refresh',Path(__file__).resolve().parents[1]/'account-refresh.py');helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
  self.account.bootstrap();prior=self.dir/'prior';current=self.dir/'current';credit=self.dir/'credit'
  for p in (prior,current,credit):p.mkdir(mode=0o700)
  a.new(credit/'provider.json',{'version':1,'provider':'near','model':'z-ai/glm-5.3-flash','account':{'organizationId':ORG,'accessToken':'SYNTHETIC'}})
  record=a.read(self.dir/'session.json');a.new(prior/'session.json',record)
  # A new B directory legitimately exists before it has any owner session.
  selected=helper.select_account(credit,current,prior)
  try:self.assertEqual(selected.load()['organizationId'],ORG);self.assertEqual(selected.directory,prior)
  finally:selected.close()
  # Malformed B remains skipped under the pre-existing AccountUnavailable policy.
  a.new(current/'session.json',{'version':1})
  selected=helper.select_account(credit,current,prior)
  try:self.assertEqual(selected.directory,prior)
  finally:selected.close()
  os.unlink(current/'session.json')
  b=dict(record,organizationId=KID);a.new(current/'session.json',b)
  selected=helper.select_account(credit,current,prior)
  try:self.assertEqual(selected.load()['organizationId'],ORG);self.assertEqual(selected.directory,prior)
  finally:selected.close()
  os.unlink(current/'session.json');a.new(current/'session.json',record)
  with self.assertRaises(a.AccountUnavailable):helper.select_account(credit,current,prior)
 def test_fixed_refresh_wire_is_empty_post_with_original_agent(self):
  seen=[]
  def call(req):seen.append(req);return json.dumps(self.f.pair()).encode(),200
  with patch.object(a.context,'curl_request',side_effect=call):a.owner_request('POST','/v1/users/me/access-tokens',token='rt_SYNTHETIC',user_agent=a.LEGACY_UA)
  self.assertEqual(seen[0].data,b'');self.assertEqual(seen[0].get_header('User-agent'),a.LEGACY_UA)
  with self.assertRaises(a.AccountUnavailable):a.owner_request('POST','/v1/organizations/'+ORG+'/usage/balance',token='rt_SYNTHETIC')
if __name__=='__main__':unittest.main()
