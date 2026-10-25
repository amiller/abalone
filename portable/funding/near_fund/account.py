# SPDX-License-Identifier: MIT
"""Trusted fixed NEAR owner bootstrap/renewal; no payments or model requests.

Seeds remain in funding state. Public exceptions never contain HTTP/state content.
The returned account session is for the trusted operator, never the workspace API.
"""
import base64,datetime,functools,hashlib,json,os,re,stat,struct,time,urllib.request,weakref
from pathlib import Path
from . import context
UA='dsmack-portable-account/1.0'
LEGACY_UA='dsmack-existing-credit-reuse/1.0'
ORIGIN='https://cloud-api.near.ai'
UUID=re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}')
TOKEN=re.compile(r'[A-Za-z0-9._~-]+')
class AccountUnavailable(Exception):pass
def require(value):
 if not value:raise AccountUnavailable('Account unavailable')
def safe(fn):
 @functools.wraps(fn)
 def wrapper(*a,**kw):
  try:return fn(*a,**kw)
  except Exception:raise AccountUnavailable('Account unavailable') from None
 return wrapper
def unique(pairs):
 result={}
 for k,v in pairs:require(k not in result);result[k]=v
 return result
def read(path):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd);require(stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600 and 0<s.st_size<=32768)
  raw=os.read(fd,32769);require(len(raw)==s.st_size)
  return json.loads(raw.decode('utf8'),object_pairs_hook=unique)
 finally:os.close(fd)
def new(path,value):
 require(len(json.dumps(value,allow_nan=False).encode())<=32768);context.save(path,value)
def promote(candidate,target):
 if target.exists():read(target)
 os.replace(candidate,target);context.syncdir(target.parent)
def uuid(value):return isinstance(value,str) and UUID.fullmatch(value) is not None
def token(value,limit):return isinstance(value,str) and 0<len(value)<=limit and TOKEN.fullmatch(value) is not None
def tokens(value):
 require(type(value) is dict and set(value) in ({'access_token','refresh_token','refresh_token_expiration'},{'access_token','refresh_token','refresh_token_expiration','user'}))
 if 'user' in value:require(type(value['user']) is dict)
 require(token(value['access_token'],8192) and token(value['refresh_token'],16384) and value['refresh_token'].startswith('rt_'))
 expiry=datetime.datetime.fromisoformat(value['refresh_token_expiration'].replace('Z','+00:00'))
 require(expiry.tzinfo is not None and expiry.utcoffset()==datetime.timedelta(0))
 return {k:value[k] for k in ('access_token','refresh_token','refresh_token_expiration')}
def jwt_exp(access):
 value=json.loads(base64.urlsafe_b64decode(access.split('.')[1]+'==='),object_pairs_hook=unique)['exp']
 require(type(value) is int and value>0);return value # scheduling hint, not signature verification

def money(value,amount):
 return type(value) is dict and set(value)=={'amount','currency','scale'} and type(value['amount']) is int and value['amount']==amount and type(value['scale']) is int and value['scale']==9 and value['currency']=='USD'
def nano(value):
 require(type(value) is dict and type(value.get('amount')) is int and 0<=value['amount']<=9007199254740991 and money(value,value['amount']));return value['amount']

@safe
def owner_request(method,path,token=None,body=None,user_agent=UA):
 require(user_agent in (UA,LEGACY_UA))
 allowed=(method=='POST' and path in ('/v1/auth/near','/v1/users/me/access-tokens')) or (method=='GET' and (path=='/v1/users/me' or re.fullmatch(r'/v1/organizations/[a-f0-9-]{36}/usage/balance',path))) or (method in ('GET','POST') and re.fullmatch(r'/v1/workspaces/[a-f0-9-]{36}/api-keys',path)) or (method=='PATCH' and re.fullmatch(r'/v1/workspaces/[a-f0-9-]{36}/api-keys/[a-f0-9-]{36}/spend-limit',path))
 require(allowed)
 headers={'Accept':'application/json','User-Agent':user_agent}
 if token is not None:require(globals()['token'](token,16384));headers['Authorization']='Bearer '+token
 raw=None if method=='GET' else b'' if body is None else json.dumps(body,separators=(',',':')).encode()
 if body is not None:headers['Content-Type']='application/json'
 response,code=context.curl_request(urllib.request.Request(ORIGIN+path,data=raw,headers=headers,method=method))
 require(code in (200,201) and len(response)<=32768)
 return json.loads(response.decode('utf8'),object_pairs_hook=unique)

class Account:
 @safe
 def __init__(self,directory,request=owner_request,clock=time.time):
  context.protect_process();self.directory=context.private_directory(directory);self.request=request;self.clock=clock
  self._fd=os.open(self.directory,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  self._close=weakref.finalize(self,os.close,self._fd)
  s=os.fstat(self._fd);require(stat.S_ISDIR(s.st_mode) and s.st_uid==os.getuid() and stat.S_IMODE(s.st_mode)==0o700)
 def close(self):self._close()
 def p(self,name):return Path('/proc/self/fd')/str(self._fd)/name
 def write(self,name,value):
  raw=(json.dumps(value,sort_keys=True,allow_nan=False)+'\n').encode();require(len(raw)<=32768)
  fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=self._fd)
  try:
   os.fchmod(fd,0o600);view=memoryview(raw)
   while view:
    n=os.write(fd,view);require(n>0);view=view[n:]
   os.fsync(fd)
  finally:os.close(fd)
  os.fsync(self._fd)
 def promote(self,name):
  if self.exists('session.json'):read(self.p('session.json'))
  os.replace(name,'session.json',src_dir_fd=self._fd,dst_dir_fd=self._fd);os.fsync(self._fd)
 def exists(self,name):return os.path.lexists(self.p(name))
 def state(self,rec):
  return {k:rec[k] for k in ('ownerId','organizationId','workspaceId','userAgent')}|{'session':{k:rec['session'][k] for k in ('access_token','refresh_token')}}
 def load(self):
  v=read(self.p('session.json'))
  require(type(v) is dict and set(v)=={'version','generation','accountId','ownerId','organizationId','workspaceId','userAgent','session'} and type(v['version']) is int and v['version']==1 and type(v['generation']) is int and 1<=v['generation']<=2147483647)
  require(isinstance(v['accountId'],str) and re.fullmatch('[a-f0-9]{64}',v['accountId']) and all(uuid(v[k]) for k in ('ownerId','organizationId','workspaceId')) and v['userAgent'] in (UA,LEGACY_UA));require(type(v['session']) is dict and set(v['session'])=={'access_token','refresh_token','refresh_token_expiration'});tokens(v['session']);return v
 def me(self,access,account_id,user_agent):
  me=self.request('GET','/v1/users/me',token=access,user_agent=user_agent)
  require(me.get('auth_provider')=='near' and me.get('is_active') is True and uuid(me.get('id')) and me.get('email')==account_id+'@near')
  orgs=[o for o in me.get('organizations',[]) if o.get('is_active') is True and o.get('role')=='owner']
  require(len(orgs)==1 and uuid(orgs[0].get('id')));org=orgs[0]['id']
  work=[w for w in me.get('workspaces',[]) if w.get('is_active') is True and w.get('organization_id')==org]
  require(len(work)==1 and uuid(work[0].get('id')))
  return me['id'],org,work[0]['id']
 @safe
 def bootstrap(self,*,before_auth=None):
  if self.exists('session.json'):return self.state(self.load())
  require(not self.exists('bootstrap-intent.json'))
  require(before_auth is None or callable(before_auth))
  import base58
  from nacl.signing import SigningKey
  if self.exists('identity-private.json'):
   identity=read(self.p('identity-private.json'));require(set(identity)=={'version','seedHex','accountId'} and type(identity['version']) is int and identity['version']==1 and isinstance(identity['seedHex'],str) and re.fullmatch('[0-9a-f]{64}',identity['seedHex']))
   seed=bytes.fromhex(identity['seedHex']);require(len(seed)==32)
  else:
   seed=os.urandom(32);identity={'version':1,'seedHex':seed.hex(),'accountId':bytes(SigningKey(seed).verify_key).hex()};self.write('identity-private.json',identity)
  key=SigningKey(seed);pub=bytes(key.verify_key);require(identity['accountId']==pub.hex())
  # Trusted caller may prove implicit-account activation before any auth effect.
  # An existing ambiguous auth intent was refused above, before this callback.
  if before_auth is not None:before_auth({'accountId':pub.hex(),'publicKey':'ed25519:'+base58.b58encode(pub).decode()})
  nonce=int(self.clock()*1000).to_bytes(8,'big')+os.urandom(24);message=b'Sign in to NEAR AI Cloud';recipient=b'cloud.near.ai'
  signed=struct.pack('<II',2**31+413,len(message))+message+nonce+struct.pack('<I',len(recipient))+recipient+b'\0'
  body={'signed_message':{'accountId':pub.hex(),'publicKey':'ed25519:'+base58.b58encode(pub).decode(),'signature':base64.b64encode(key.sign(hashlib.sha256(signed).digest()).signature).decode()},'payload':{'message':message.decode(),'nonce':list(nonce),'recipient':recipient.decode()}}
  self.write('bootstrap-intent.json',{'version':1,'accountId':pub.hex(),'automaticRetry':False})
  reply=self.request('POST','/v1/auth/near',body=body,user_agent=UA)
  self.write('bootstrap-response-private.json',reply) # complete decoded response durable BEFORE schema validation
  pair=tokens(reply)
  candidate={'version':1,'generation':1,'accountId':pub.hex(),'ownerId':None,'organizationId':None,'workspaceId':None,'userAgent':UA,'session':pair}
  self.write('bootstrap-candidate.json',candidate) # pair durable BEFORE identity read
  owner,org,work=self.me(pair['access_token'],pub.hex(),UA)
  candidate.update(ownerId=owner,organizationId=org,workspaceId=work)
  self.write('bootstrap-verified.json',candidate);self.promote('bootstrap-verified.json')
  return self.state(candidate)
 @safe
 def ensure_session(self,force=False):
  require(type(force) is bool);rec=self.load();generation=rec['generation']
  # Unresolved rotation always takes precedence over a cached old access token.
  intent='refresh-intent-%d.json'%generation;require(not self.exists(intent))
  if not force and jwt_exp(rec['session']['access_token'])-self.clock()>120:return self.state(rec)
  expiry=datetime.datetime.fromisoformat(rec['session']['refresh_token_expiration'].replace('Z','+00:00'));require(expiry.timestamp()>self.clock())
  self.write(intent,{'version':1,'generation':generation,'automaticRetry':False})
  pair=tokens(self.request('POST','/v1/users/me/access-tokens',token=rec['session']['refresh_token'],body=None,user_agent=rec['userAgent']))
  candidate=dict(rec,generation=generation+1,session=pair);name='refresh-candidate-%d.json'%generation
  self.write(name,candidate) # retain even if identity validation fails
  require(self.me(pair['access_token'],rec['accountId'],rec['userAgent'])==(rec['ownerId'],rec['organizationId'],rec['workspaceId']))
  self.promote(name);return self.state(candidate)
 @safe
 def issue_key(self):
  self.ensure_session();rec=self.load()
  if self.exists('api-key-private.json'):
   v=read(self.p('api-key-private.json'));require(set(v)=={'key','id','workspaceId'} and uuid(v['id']) and v['workspaceId']==rec['workspaceId'] and token(v['key'],512) and v['key'].startswith('sk-'))
   return {'version':1,'provider':'near','model':'z-ai/glm-5.3-flash','apiKey':v['key']}
  require(not self.exists('key-intent.json'))
  rec=self.load();access=rec['session']['access_token'];org=rec['organizationId'];workspace=rec['workspaceId']
  balance=self.request('GET','/v1/organizations/'+org+'/usage/balance',token=access,user_agent=rec['userAgent'])
  require(balance.get('organization_id')==org and all(type(balance.get(k)) is int and 0<=balance[k]<=9007199254740991 for k in ('remaining','total_spent','spend_limit','unfunded_amount')) and balance['remaining']>0)
  cap=balance['remaining'] # the key may spend everything the account holds
  self.write('key-intent.json',{'version':1,'organizationId':org,'workspaceId':workspace,'capNanoUSD':cap,'automaticRetry':False})
  path='/v1/workspaces/'+workspace+'/api-keys'
  value=self.request('POST',path,token=access,body={'name':'Dsmack portable demo','spendLimit':{'amount':cap,'currency':'USD'}},user_agent=rec['userAgent'])
  self.write('key-candidate.json',value)
  require(token(value.get('key'),512) and value['key'].startswith('sk-') and uuid(value.get('id')) and value.get('workspace_id')==workspace)
  rows=self.request('GET',path,token=access,user_agent=rec['userAgent']).get('api_keys');require(type(rows) is list)
  rows=[k for k in rows if k.get('id')==value['id']];require(len(rows)==1);row=rows[0]
  require(row.get('workspace_id')==workspace and row.get('created_by_user_id')==rec['ownerId'] and row.get('is_active') is True and row.get('deleted_at') is None and money(row.get('spend_limit'),cap) and money(row.get('usage'),0))
  self.write('api-key-private.json',{'key':value['key'],'id':value['id'],'workspaceId':workspace})
  return {'version':1,'provider':'near','model':'z-ai/glm-5.3-flash','apiKey':value['key']}
 def key_row(self,rec):
  v=read(self.p('api-key-private.json'));require(uuid(v.get('id')) and v.get('workspaceId')==rec['workspaceId'])
  rows=self.request('GET','/v1/workspaces/'+rec['workspaceId']+'/api-keys',token=rec['session']['access_token'],user_agent=rec['userAgent']).get('api_keys');require(type(rows) is list)
  rows=[k for k in rows if k.get('id')==v['id']];require(len(rows)==1 and rows[0].get('is_active') is True and rows[0].get('deleted_at') is None)
  return rows[0]
 @safe
 def key_standing(self):
  """Issued key's cumulative cap and usage, or None before a key exists."""
  self.ensure_session();rec=self.load()
  if not self.exists('api-key-private.json'):return None
  row=self.key_row(rec);return {'limitNanoUSD':nano(row.get('spend_limit')),'usageNanoUSD':nano(row.get('usage'))}
 @safe
 def set_key_limit(self,amount):
  require(type(amount) is int and 0<amount<=9007199254740991)
  self.ensure_session();rec=self.load();row=self.key_row(rec)
  value=self.request('PATCH','/v1/workspaces/'+rec['workspaceId']+'/api-keys/'+row['id']+'/spend-limit',token=rec['session']['access_token'],body={'spendLimit':{'amount':amount,'currency':'USD'}},user_agent=rec['userAgent'])
  require(value.get('id')==row['id'] and money(value.get('spend_limit'),amount))
  return {'limitNanoUSD':amount,'usageNanoUSD':nano(value.get('usage'))}
 @safe
 def publish_balance_account(self,credit_directory):
  directory=context.private_directory(credit_directory);rec=self.load()
  provider=read(directory/'provider.json')
  require(provider.get('version')==1 and provider.get('provider')=='near' and provider.get('model')=='z-ai/glm-5.3-flash' and type(provider.get('account')) is dict and provider['account'].get('organizationId')==rec['organizationId'])
  # Never read identity-private.json or return refresh/signing capabilities here.
  candidate=directory/'near-account.new.json';target=directory/'near-account.json'
  new(candidate,{'organizationId':rec['organizationId'],'accessToken':rec['session']['access_token']})
  promote(candidate,target);return {'accountPublished':True,'organizationId':rec['organizationId']}
