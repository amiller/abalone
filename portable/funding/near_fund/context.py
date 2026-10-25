# SPDX-License-Identifier: MIT
"""Operator-only configuration, exclusive durable state and fixed Tor HTTP."""
import ctypes,hashlib,json,os,re,resource,selectors,signal,stat,subprocess,time,urllib.parse
import sys
from pathlib import Path
class TransportReadError(ValueError):pass
_CONFIG=None
_LAST_TRANSPORT=None
_TRANSPORT_ORIGIN=None
_TRANSPORT_TIME=0
def _transport(phase,curlcode=None,http_status=None):
 global _LAST_TRANSPORT,_TRANSPORT_TIME
 _LAST_TRANSPORT={'phase':phase,'curlCode':curlcode,'httpStatus':http_status,'origin':_TRANSPORT_ORIGIN};_TRANSPORT_TIME=time.monotonic_ns()
def transport_diagnostic():
 # Legacy CLI and package imports share source but may have separate module instances.
 modules=[sys.modules.get(name) for name in ('context','near_fund.context')]
 candidates=[m for m in modules if m is not None and getattr(m,'_LAST_TRANSPORT',None) is not None]
 if not candidates:return None
 return dict(max(candidates,key=lambda m:m._TRANSPORT_TIME)._LAST_TRANSPORT)

ORIGINS={'https://rpc.mainnet.near.org','https://cloud.near.ai','https://cloud-api.near.ai','https://pay.pingpay.io','https://1click.chaindefuser.com','https://base-rpc.publicnode.com'}
def config():
 if _CONFIG is None:raise ValueError('configuration absent')
 return _CONFIG

def private_directory(path):
 p=Path(path).absolute()
 for x in [*reversed(p.parents),p]:
  s=x.lstat()
  if not stat.S_ISDIR(s.st_mode):raise ValueError('directory refused')
 s=p.stat()
 if s.st_uid!=os.getuid() or stat.S_IMODE(s.st_mode)!=0o700:raise ValueError('private directory required')
 return p

def read(path):
 fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  s=os.fstat(fd)
  if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_nlink!=1 or stat.S_IMODE(s.st_mode)!=0o600 or s.st_size>262144:raise ValueError('private record refused')
  b=os.read(fd,262145)
  if len(b)>262144:raise ValueError('record oversized')
  return json.loads(b)
 finally:os.close(fd)

def syncdir(path):
 fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:os.fsync(fd)
 finally:os.close(fd)

def save(path,value):
 b=(json.dumps(value,sort_keys=True)+'\n').encode()
 if len(b)>262144:raise ValueError('record oversized')
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:
  view=memoryview(b)
  while view:view=view[os.write(fd,view):]
  os.fsync(fd)
 finally:os.close(fd)
 syncdir(Path(path).parent)

def protect_process():
 resource.setrlimit(resource.RLIMIT_CORE,(0,0))
 libc=ctypes.CDLL(None,use_errno=True)
 if libc.prctl(4,0,0,0,0)!=0 or libc.prctl(3,0,0,0,0)!=0:raise ValueError("process protection refused")
 if resource.getrlimit(resource.RLIMIT_CORE)!=(0,0):raise ValueError("core policy refused")

def configure(path):
 global _CONFIG
 protect_process()
 p=Path(path).absolute();private_directory(p.parent);v=read(p)
 if set(v)-{'userAgent'}!={'version','organizationId','baseAddress','basePrivateKey','refundAddress','refundBackupVerified','session'} or v['version']!=1:raise ValueError('configuration refused')
 if not re.fullmatch('[a-f0-9-]{36}',v['organizationId']) or not re.fullmatch('0x[0-9a-fA-F]{40}',v['baseAddress']) or not re.fullmatch('0x[0-9a-fA-F]{64}',v['basePrivateKey']):raise ValueError('configuration refused')
 if v['refundBackupVerified'] is not True or not isinstance(v['session'],dict) or set(v['session'])!={'access_token','refresh_token'}:raise ValueError('configuration refused')
 for x in v['session'].values():
  if not isinstance(x,str) or not re.fullmatch('[A-Za-z0-9._~-]{1,8192}',x):raise ValueError('session refused')
 if 'userAgent' in v and v['userAgent'] not in ('dsmack-portable-account/1.0','dsmack-near-wallet-research/1.0','dsmack-existing-credit-reuse/1.0'):raise ValueError('session user agent refused')
 import base58
 raw=base58.b58decode_check(v['refundAddress'])
 if len(raw)!=22 or raw[:2]!=bytes.fromhex('1cb8'):raise ValueError('refund refused')
 from eth_account import Account
 address=Account.from_key(v["basePrivateKey"]).address
 if address.lower()!=v["baseAddress"].lower():raise ValueError("signer mismatch")
 v["baseAddress"]=address
 _CONFIG=v
 return hashlib.sha256(json.dumps({k:v[k] for k in ('version','organizationId','baseAddress','refundAddress')},sort_keys=True).encode()).hexdigest()

def curl_request(req,*,response_sink=None):
 global _TRANSPORT_ORIGIN
 _TRANSPORT_ORIGIN=None
 _transport('request-validation')
 if response_sink is not None and not callable(response_sink):raise ValueError('response sink refused')
 url=req.full_url;u=urllib.parse.urlsplit(url)
 if u.scheme!='https' or u.netloc!=u.hostname or 'https://'+u.netloc not in ORIGINS or u.fragment or u.username:raise ValueError('origin refused')
 _TRANSPORT_ORIGIN={'rpc.mainnet.near.org':'near-chain','base-rpc.publicnode.com':'base-chain','cloud-api.near.ai':'near-api','cloud.near.ai':'near-dashboard','pay.pingpay.io':'pingpay','1click.chaindefuser.com':'oneclick'}[u.hostname]
 method=req.get_method()
 if method not in ('GET','POST','PATCH'):raise ValueError('method refused')
 def quote(s):
  if not isinstance(s,str) or any(ord(c)<32 or ord(c)==127 for c in s):raise ValueError('config control refused')
  return '"'+s.replace('\\','\\\\').replace('"','\\"')+'"'
 lines=['url = '+quote(url),'request = '+quote(method)]
 for k,v in req.header_items():
  if k.lower() not in ('accept','content-type','user-agent','authorization','cookie'):raise ValueError('header refused')
  if k.lower()=='authorization' and u.hostname!='cloud-api.near.ai':raise ValueError('auth origin refused')
  if k.lower()=='cookie' and u.hostname!='cloud.near.ai':raise ValueError('cookie origin refused')
  lines.append('header = '+quote(k+': '+v))
 if req.data is not None:
  if len(req.data)>262144:raise ValueError('body oversized')
  lines.append('data-binary = '+quote(req.data.decode('utf8')))
 payload=('\n'.join(lines)+'\n').encode()
 argv=['/usr/bin/curl','--disable','--silent','--show-error','--proto','=https','--socks5-hostname','127.0.0.1:9050','--noproxy','','--connect-timeout','15','--max-time','45','--retry','0','--max-redirs','0','--max-filesize','262144','--write-out','\n%{http_code}','--config','-']
 _transport('spawn')
 # Public fixed circuit-isolation label, never a provider credential.
 if u.hostname=='rpc.mainnet.near.org':argv+=['--proxy-user','dsmack-near-chain:1']
 p=subprocess.Popen(argv,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,env={})
 sel=selectors.DefaultSelector();out=bytearray();err=bytearray();position=0;deadline=time.monotonic()+50
 for stream,event in [(p.stdin,selectors.EVENT_WRITE),(p.stdout,selectors.EVENT_READ),(p.stderr,selectors.EVENT_READ)]:os.set_blocking(stream.fileno(),False);sel.register(stream,event)
 _transport('io')
 try:
  while sel.get_map():
   if time.monotonic()>=deadline:_transport('deadline');raise TransportReadError('transport deadline')
   for key,mask in sel.select(min(0.2,max(0,deadline-time.monotonic()))):
    stream=key.fileobj
    if stream is p.stdin:
     n=os.write(stream.fileno(),payload[position:position+16384]);position+=n
     if position==len(payload):sel.unregister(stream);stream.close()
    else:
     b=os.read(stream.fileno(),16384)
     if not b:sel.unregister(stream);stream.close();continue
     target=out if stream is p.stdout else err;target.extend(b)
     if len(target)>(262149 if target is out else 4096):_transport('output-bound');raise ValueError('transport oversized')
  while os.waitid(os.P_PID,p.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT) is None:
   if time.monotonic()>=deadline:_transport("deadline");raise TransportReadError("transport deadline")
   time.sleep(0.01)
  # Retain leader PID until its owned group is terminated, then reap once.
 finally:
  sel.close()
  try:os.killpg(p.pid,signal.SIGKILL)
  except ProcessLookupError:pass
  code=p.wait(timeout=5)
  previous=_LAST_TRANSPORT['phase'];_transport(previous,code)
  for stream in (p.stdin,p.stdout,p.stderr):stream.close()
 if code!=0:_transport('exit',code);raise TransportReadError('transport refused')
 _transport('http-frame',code)
 body,sep,status=bytes(out).rpartition(b'\n')
 if not sep or not re.fullmatch(b'[1-5][0-9]{2}',status) or len(body)>262144:raise ValueError('http refused')
 code=int(status)
 _transport('response',0,code)
 if response_sink is not None:
  _transport('response-sink',0,code);response_sink(body,code);_transport('response',0,code)
 if code not in (200,201):_transport('http-status',0,code);raise TransportReadError('http refused')
 return body,code

class Response:
 def __init__(self,body,code):self.body=body;self.code=self.status=code
 def read(self,n):return self.body[:n]
 def __enter__(self):return self
 def __exit__(self,*args):return False
class Client:
 def open(self,req,timeout=None):return Response(*curl_request(req))
client=Client()
def call(path,token):
 import urllib.request
 if not re.fullmatch('/v1/organizations/[a-f0-9-]{36}/usage/balance',path):raise ValueError('balance path')
 with client.open(urllib.request.Request('https://cloud-api.near.ai'+path,headers={'Authorization':'Bearer '+token,**({'User-Agent':config()['userAgent']} if 'userAgent' in config() else {})})) as r:return r.code,json.loads(r.read(262145))
