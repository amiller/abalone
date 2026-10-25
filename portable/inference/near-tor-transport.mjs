// SPDX-License-Identifier: MIT
// Trusted verifier embedding only; no endpoint/model selection from jobs.
// Buffered responses settle only after curl is reaped. Not streaming qualification.
// A request is cut after IDLE_MS without upstream bytes (waiting for the first byte counts) or after CEILING_MS in total.
import {spawn} from 'node:child_process';
import {NEAR_DIRECT_HOST} from '../../lib/near-direct.mjs';
const NEAR='https://cloud-api.near.ai',DISCOVERY='https://completions.near.ai';
// GLM-5.3 Flash streams ~10 tok/s here (16384 tokens ~ 27 min); the idle cut catches stalls, the ceiling only bounds the wait.
export const IDLE_MS=60000,CEILING_MS=2400000;
const direct=origin=>{const u=new URL(origin);return origin==='https://'+u.hostname && NEAR_DIRECT_HOST.test(u.hostname);};
const ORIGINS=new Set([NEAR,DISCOVERY,'https://api.trustedservices.intel.com','https://certificates.trustedservices.intel.com','https://rim.attestation.nvidia.com','https://ocsp.ndis.nvidia.com','https://base-rpc.publicnode.com']);
// BODY_LIMIT covers the hex-encrypted request (about 2x the 2 MiB codec bound plus per-message keys).
const HEADER_LIMIT=16384,BODY_LIMIT=8*1024*1024,OUTPUT_LIMIT=8*1024*1024;
const refused=()=>Object.assign(Error('NEAR Tor transport unavailable'),{code:'NEAR_TOR_TRANSPORT'});
const shim=`import os,sys
body=bytearray()
while True:
 chunk=os.read(3,min(65536,8388609-len(body)))
 if not chunk:break
 body.extend(chunk)
 if len(body)>8388608:raise SystemExit(2)
fd=os.memfd_create('near-request',0)
view=memoryview(body)
while view:
 n=os.write(fd,view)
 if n<=0:raise SystemExit(2)
 view=view[n:]
os.lseek(fd,0,0)
os.dup2(fd,3,inheritable=True)
os.set_inheritable(3,True)
if fd!=3:os.close(fd)
os.execve('/usr/bin/curl',['/usr/bin/curl',*sys.argv[1:]],{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
`;
// Inference is pinned only to an attested NEAR direct instance.
function binding(options){
 if(!options || Object.keys(options).sort().join(',')!=='hostname,origin,spkiPins' || typeof options.hostname!=='string' || !NEAR_DIRECT_HOST.test(options.hostname) || options.origin!=='https://'+options.hostname || !Array.isArray(options.spkiPins) || options.spkiPins.length!==1 || !/^[a-fA-F0-9]{64}$/.test(options.spkiPins[0]))throw refused();
 return {origin:options.origin,key:'sha256//'+Buffer.from(options.spkiPins[0],'hex').toString('base64')};
}
const quote=v=>'"'+v.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';
function request(input,init,pin){
 const url=new URL(input instanceof URL ? input.href : input);
 if(url.protocol!=='https:' || url.username || url.password || url.hash || !(ORIGINS.has(url.origin) || direct(url.origin)))throw refused();
 if(pin && (url.origin!==pin.origin || url.pathname!=='/v1/chat/completions' || url.search))throw refused();
 const method=(init.method??'GET').toUpperCase();
 if(!['GET','POST'].includes(method) || (pin && method!=='POST') || (init.redirect!==undefined && init.redirect!=='manual') || (init.credentials!==undefined && init.credentials!=='omit'))throw refused();
 const headers=new Headers(init.headers);let config='';
 for(const [name,value] of headers){
  if(!['authorization','content-type','accept','cache-control','x-signing-algo','x-client-pub-key','x-model-pub-key'].includes(name) || value.length>(name==='authorization'?8199:2048) || /[^\x20-\x7e]/.test(value))throw refused();
  if(name==='authorization' && (!(url.origin===NEAR || direct(url.origin)) || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(value)))throw refused();
  config+='header = '+quote(name+': '+value)+'\n';
 }
 let body=Buffer.alloc(0);
 if(init.body!==undefined && init.body!==null){
  if(method!=='POST' || !(typeof init.body==='string' || init.body instanceof Uint8Array))throw refused();
  body=Buffer.from(init.body);if(body.length>BODY_LIMIT)throw refused();
 }
 if(Buffer.byteLength(config)>16384)throw refused();
 const args=['-q','--silent','--show-error','--include','--http1.1','--proxy','socks5h://127.0.0.1:9050','--noproxy','','--proto','=https','--proto-redir','=https','--tlsv1.2','--connect-timeout','15','--max-time',String(CEILING_MS/1000+10),'--max-filesize',String(OUTPUT_LIMIT),'--request',method,'--header','Expect:','--header','accept-encoding: identity','--config','-'];
 if(pin)args.push('--pinnedpubkey',pin.key);
 if(method==='POST')args.push('--data-binary','@/dev/fd/3');
 args.push(url.href);return {args,body,config};
}
function response(raw){
 const end=raw.indexOf('\r\n\r\n');if(end<0 || end+4>HEADER_LIMIT || raw.length-end-4>OUTPUT_LIMIT)throw refused();
 const lines=raw.subarray(0,end).toString('latin1').split('\r\n');const status=/^HTTP\/1\.[01] ([0-9]{3})(?: [\x20-\x7e]*)?$/.exec(lines.shift());
 if(!status)throw refused();const code=Number(status[1]);if(code<200 || code>599 || (code>=300&&code<400))throw refused();
 const headers=new Headers();
 for(const line of lines){
  const m=/^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([\x20-\x7e\t]*)$/.exec(line);if(!m)throw refused();
  if(!['connection','transfer-encoding','content-length','set-cookie'].includes(m[1].toLowerCase()))headers.append(m[1],m[2]);
 }
 const body=raw.subarray(end+4);if([204,205,304].includes(code)&&body.length)throw refused();
 return new Response([204,205,304].includes(code)?null:body,{status:code,headers});
}
function factory(pin,spawnProcess,{idleMs,ceilingMs}={idleMs:IDLE_MS,ceilingMs:CEILING_MS}){
 let closing=false;const active=new Set();
 const fetch=async(input,init={})=>{
  if(!init || typeof init!=='object' || closing || init.signal?.aborted)throw refused();
  let wire;try{wire=request(input,init,pin);}catch{throw refused();}
  const controller=new AbortController();let child,closed=false,failed=false,timer,idle,cut=null,killTimer,settle;
  const done=new Promise(resolve=>{settle=resolve;});const operation={done,abort:()=>controller.abort()};active.add(operation);
  const stop=()=>{failed=true;if(child&&!closed){child.kill('SIGTERM');child.stdin.destroy();child.stdio[3].destroy();if(!killTimer)killTimer=setTimeout(()=>{if(!closed)child.kill('SIGKILL');},100);}};
  controller.signal.addEventListener('abort',stop,{once:true});
  const abort=()=>controller.abort();init.signal?.addEventListener('abort',abort,{once:true});
  const watch=()=>{clearTimeout(idle);idle=setTimeout(()=>{cut??='upstream_idle';abort();},idleMs);};
  timer=setTimeout(()=>{cut??='upstream_deadline';abort();},ceilingMs);watch();
  try{
   child=spawnProcess('/usr/bin/python3',['-I','-S','-c',shim,...wire.args],{stdio:['pipe','pipe','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
   let chunks=[],total=0,stderr=0,headerProbe=Buffer.alloc(0),headerSeen=false;
   const reaped=new Promise(resolve=>{
    child.once('error',()=>{failed=true;});
    child.once('close',code=>{closed=true;resolve(code);});
   });
   child.stdout.on('data',b=>{watch();total+=b.length;if(total>OUTPUT_LIMIT+HEADER_LIMIT){stop();return;}if(!headerSeen){headerProbe=Buffer.concat([headerProbe,b]);const n=headerProbe.indexOf('\r\n\r\n');if(n>=0){if(n+4>HEADER_LIMIT){stop();return;}headerSeen=true;headerProbe=null;}else if(headerProbe.length>HEADER_LIMIT){stop();return;}}chunks.push(b);});
   child.stdout.on('error',stop);child.stderr.on('data',b=>{stderr+=b.length;if(stderr>8192)stop();});
   child.stdin.on('error',stop);child.stdio[3].on('error',stop);
   child.stdin.end(wire.config);child.stdio[3].end(wire.body);wire=null;
   if(closing || init.signal?.aborted || controller.signal.aborted)stop();
   const code=await reaped;
   // libcurl's fixed pin-mismatch exit is an immutable security refusal, not
   // a transient fetch exception that the SDK may automatically retry.
   if(pin && code===90 && !failed && !controller.signal.aborted)return new Response(JSON.stringify({error:{message:'✗ refused: NEAR TLS SPKI pin mismatch'}}),{status:403,headers:{'content-type':'application/json'}});
   if(failed || code!==0 || controller.signal.aborted)throw refused();
   return response(Buffer.concat(chunks,total));
  }catch{stop();throw cut?Object.assign(Error('NEAR upstream '+(cut==='upstream_idle'?'idle':'deadline')),{code:cut}):refused();}
  finally{
   // Close resolves only after every operation's one owned child has closed.
   // spawnProcess is a trusted fixture seam; production Node close follows error.
   if(child&&!closed)await new Promise(resolve=>child.once('close',resolve));
   clearTimeout(timer);clearTimeout(idle);clearTimeout(killTimer);init.signal?.removeEventListener('abort',abort);active.delete(operation);settle();
  }
 };
 return {fetch,async close(){closing=true;for(const op of active)op.abort();await Promise.all([...active].map(op=>op.done));}};
}
export function createNearAdmissionTransport(){return factory(null,spawn);}
export function createNearPinnedTransport(options){return factory(binding(options),spawn);}
// Explicit trusted in-process fixture constructor, never a CLI/HTTP option.
export function createNearTorTransportForTesting({pin=null,spawnProcess,limits}){
 if(typeof spawnProcess!=='function')throw refused();return factory(pin===null?null:binding(pin),spawnProcess,limits);
}
