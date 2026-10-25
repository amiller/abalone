// SPDX-License-Identifier: MIT
// Trusted profile request bounds are NOT dollar caps; provider-side budget remains separate.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import {once} from 'node:events';
import {encodeRequest} from '../../lib/near-tool-codec.mjs';
import {nearToolBridgeDiagnostic} from '../../lib/near-tool-bridge.mjs';
import {peerCredential} from '../workspace-service/syscred.mjs';
const PARENT='/run/portable-inference';
const PROFILES=Object.freeze({zai:Object.freeze({model:'glm-5.3',socket:'zai.sock',maxRequests:3}),near:Object.freeze({model:'z-ai/glm-5.3-flash',socket:'near.sock',maxRequests:16384})});
export function directProfile(name='zai'){if(!Object.hasOwn(PROFILES,name))throw fail();return PROFILES[name];}
const fail=()=>Error('Inference unavailable');
const keys=(v,n)=>v && Object.getPrototypeOf(v)===Object.prototype && Object.keys(v).sort().join(',')===n.split(',').sort().join(',');
export async function readProviderRecord(lease,profileName='zai',signal=lease.signal) {
 const profile=directProfile(profileName);
 try {
  if(signal?.aborted || lease.signal.aborted || await lease.assertCurrent(signal)!==true)throw fail();
  const a=fs.fstatSync(lease.fd);
  if(!a.isFile() || a.uid!==972 || a.gid!==972 || (a.mode&0o7777)!==0o600 || a.nlink!==1 || a.size<1 || a.size>16384)throw fail();
  const b=Buffer.alloc(a.size);let value;
  try {if(fs.readSync(lease.fd,b,0,b.length,0)!==b.length)throw fail();value=JSON.parse(b.toString('utf8'));}finally{b.fill(0);}
  const z=fs.fstatSync(lease.fd);
  if(['dev','ino','mode','uid','gid','nlink','size','mtimeMs','ctimeMs'].some(k=>a[k]!==z[k]) || signal?.aborted || lease.signal.aborted || await lease.assertCurrent(signal)!==true)throw fail();
  if(!(keys(value,'version,provider,model,apiKey') || (profileName==='near' && keys(value,'version,provider,model,apiKey,account'))) || value.version!==1 || value.provider!==profileName || value.model!==profile.model || typeof value.apiKey!=='string' || value.apiKey.length<1 || value.apiKey.length>512 || /[\x00-\x20\x7f]/.test(value.apiKey))throw fail();
  if(value.account!==undefined && (!keys(value.account,'organizationId,accessToken') || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.account.organizationId) || typeof value.account.accessToken!=='string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(value.account.accessToken)))throw fail();
  if(signal?.aborted)throw fail();
  return value;
 }catch{throw fail();}
}
export async function readCredential(lease,profileName='zai'){return (await readProviderRecord(lease,profileName)).apiKey;}
export async function readNearAccount(lease,signal=lease.signal){
 // Account refresh writes only this access-only sidecar, never provider.json.
 // A per-account timeout must not revoke the independent inference lease.
 let directory,fd,buffer;
 try {
  if(signal?.aborted)throw fail();
  const fallback=(await readProviderRecord(lease,'near',lease.signal)).account??null;
  const flags=fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK;
  try {
   directory=fs.openSync('/run/portable-vault/credit',flags|fs.constants.O_DIRECTORY);
   const d=fs.fstatSync(directory);
   if(!d.isDirectory() || d.uid!==972 || d.gid!==972 || (d.mode&0o7777)!==0o700)throw fail();
   fd=fs.openSync('/proc/self/fd/'+directory+'/near-account.json',flags);
  }catch(e){if(e.code==='ENOENT'){if(signal?.aborted)throw fail();return fallback;}throw e;}
  const a=fs.fstatSync(fd),provider=fs.fstatSync(lease.fd);
  const mount=n=>fs.readFileSync('/proc/self/fdinfo/'+n,'utf8').match(/^mnt_id:\s+(\d+)$/m)?.[1];
  if(!a.isFile() || a.uid!==972 || a.gid!==972 || (a.mode&0o7777)!==0o600 || a.nlink!==1 || a.size<1 || a.size>16384 || a.dev!==provider.dev || !mount(fd) || mount(fd)!==mount(lease.fd))throw fail();
  buffer=Buffer.alloc(a.size);if(fs.readSync(fd,buffer,0,buffer.length,0)!==buffer.length)throw fail();
  const value=JSON.parse(buffer.toString('utf8')),z=fs.fstatSync(fd);
  if(['dev','ino','mode','uid','gid','nlink','size','mtimeMs','ctimeMs'].some(k=>a[k]!==z[k]) || !keys(value,'organizationId,accessToken') || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.organizationId) || typeof value.accessToken!=='string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(value.accessToken))throw fail();
  if(!fallback || value.organizationId!==fallback.organizationId || signal?.aborted || lease.signal.aborted || await lease.assertCurrent(lease.signal)!==true)throw fail();
  return value;
 }catch{throw fail();}finally{buffer?.fill(0);if(fd!==undefined)fs.closeSync(fd);if(directory!==undefined)fs.closeSync(directory);}
}
export function validateRequest(v,profileName='zai') {
 const profile=directProfile(profileName);
 if(profileName==='near'){if(v?.model!==profile.model || !Number.isInteger(v.max_tokens) || v.max_tokens<1 || v.max_tokens>16384)throw fail();encodeRequest(v);return v;}
 const allowed=new Set(['model','messages','stream','max_tokens','reasoning_effort','tools','tool_choice','stream_options','thinking','store','tool_stream']);
 if(!v || Object.getPrototypeOf(v)!==Object.prototype || Object.keys(v).some(k=>!allowed.has(k)) || v.model!=='glm-5.3' || v.stream!==true || !Number.isInteger(v.max_tokens) || v.max_tokens<1 || v.max_tokens>1024 || v.reasoning_effort!=='low' || !Array.isArray(v.messages) || !v.messages.length || v.messages.length>128)throw fail();
 if(v.tools!==undefined && (!Array.isArray(v.tools) || v.tools.length>64 || v.tool_stream!==true))throw fail();
 if(v.tool_stream!==undefined && v.tool_stream!==true)throw fail();
 if(v.thinking!==undefined && (!keys(v.thinking,'type,clear_thinking') || v.thinking.type!=='enabled' || v.thinking.clear_thinking!==false))throw fail();
 if(v.store!==undefined && v.store!==false)throw fail();
 if(v.stream_options!==undefined && !keys(v.stream_options,'include_usage'))throw fail();
 if(v.stream_options && typeof v.stream_options.include_usage!=='boolean')throw fail();
 return v;
}
async function prepareEndpoint(socketName='zai.sock') {
 const SOCKET=PARENT+'/'+socketName;
 const dir=await fsp.open(PARENT,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 const pinned=await dir.stat();
 const check=async()=>{const s=await fsp.lstat(PARENT);if(s.dev!==pinned.dev || s.ino!==pinned.ino || !s.isDirectory() || s.uid!==972 || s.gid!==974 || (s.mode&0o7777)!==0o2750)throw fail();};
 try {
  await check();const anchored=`/proc/self/fd/${dir.fd}/${socketName}`;let old;
  try{old=await fsp.lstat(anchored);}catch(e){if(e.code!=='ENOENT')throw e;}
  const eligible=s=>s.isSocket() && s.uid===972 && s.gid===974 && (s.mode&0o7777)===0o660 && s.nlink===1;
  if(old){
   if(!eligible(old))throw fail();
   const stale=await new Promise(resolve=>{let refused=false,decided=false;const socket=net.createConnection(SOCKET);
    const timer=setTimeout(()=>{decided=true;socket.destroy();},250);
    socket.once('connect',()=>{decided=true;socket.destroy();});socket.once('error',e=>{if(!decided){decided=true;refused=e.code==='ECONNREFUSED';}socket.destroy();});socket.once('close',()=>{clearTimeout(timer);resolve(refused);});});
   if(!stale)throw fail();await check();const now=await fsp.lstat(anchored);
   if(!eligible(now) || old.dev!==now.dev || old.ino!==now.ino)throw fail();
   // Fixed serialized unit; root/out-of-band UID972 writers are trusted.
   // This identity recheck is not atomic unlink protection against that TCB.
   await fsp.unlink(anchored);
  }
  await check();return {check,close:()=>dir.close()};
 }catch(e){await dir.close();throw e;}
}
function failureDiagnostic(stage,error,admission=null){
 // Failure-only fixed metadata. The keeper suppresses child stderr, so retain
 // this same bounded projection in the existing trusted UID972 runtime directory.
 const codes=['provider_admission_expired','provider_admission_refused','provider_closed','request_refused','credit_exhausted','access_revoked_or_expired','transport_refused','upstream_idle','upstream_deadline','provider_response_refused','provider_unavailable','NEAR_TOR_TRANSPORT','ABORT_ERR','ETIMEDOUT','ECONNRESET','EPIPE'];
 const names=['Error','TypeError','RangeError','SyntaxError','AbortError','TimeoutError'];
 const status=error?.status??error?.statusCode;
 const value={version:1,stage,atMs:Date.now(),monotonicMs:Math.floor(performance.now()),causeCode:codes.includes(error?.code)?error.code:null,errorName:names.includes(error?.name)?error.name:null,httpStatus:Number.isInteger(status)&&status>=100&&status<=599?status:null,bridge:nearToolBridgeDiagnostic(error),admission};
 const line=JSON.stringify(value)+'\n';let fd;
 try{
  fd=fs.openSync(PARENT+'/last-failure.json',fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK,0o600);
  const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==972||(s.mode&0o777)!==0o600||s.nlink!==1||s.size>4096)return;
  fs.ftruncateSync(fd,0);fs.writeSync(fd,line);
 }catch{}finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
 try{process.stderr.write(line);}catch{}
 // The keeper discards stderr; the journal keeps every failure, not only the last.
 spawn('/usr/bin/logger',['-t','dsmack-inference','--',line.trim()],{stdio:'ignore'});
}
const closeServer=server=>!server?Promise.resolve():new Promise((resolve,reject)=>{server.close(error=>{if(error && error.code!=='ERR_SERVER_NOT_RUNNING')reject(fail());else resolve();});});
export async function startBroker({lease,transport,authenticate=peerCredential,profileName='zai'}={}) {
 const profile=directProfile(profileName),SOCKET=PARENT+'/'+profile.socket;
 if(process.getuid()!==972 || typeof transport!=='function' || !lease || lease.signal.aborted)throw fail();
 let server,httpServer,socketIdentity,endpoint,closing=false,stopPromise,active=null;
 const connections=new Set(),auths=new Set(),jobs=new Set(),consumed=new Set();
 let admissionDiagnostic=()=>null;
 const error=(res,code,status=503,admission=null,bridge=null)=>{if(!res.headersSent)res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({error:{code,message:admission?`Admission failed (${admission.stage}; ${admission.errorCode}${admission.httpStatus===null?'':`; HTTP ${admission.httpStatus}`}). No inference was sent. A new prompt may retry.`:`Inference unavailable${bridge?` after ${bridge.attempt} attempt${bridge.attempt===1?'':'s'} (${bridge.stage}; ${bridge.causeCode??bridge.errorName}${bridge.httpStatus?`; HTTP ${bridge.httpStatus}`:''}; ${bridge.elapsedMs} ms${bridge.deadlineAborted?'; bridge deadline':''})`:''}. A new prompt may retry.`}}));};
 try {
  await readCredential(lease,profileName);
  // Only the NEAR deployment carries its verifier/admission dependency closure.
  if(profileName==='near')admissionDiagnostic=(await import('../../lib/coupon-near.mjs')).couponNearAdmissionDiagnostic;
  for(const p of ['/','/run',PARENT]){const s=await fsp.lstat(p);if(!s.isDirectory() || s.isSymbolicLink() || s.mode&0o022 || (p===PARENT?(s.uid!==972 || s.gid!==974 || (s.mode&0o7777)!==0o2750):s.uid!==0))throw fail();}
  endpoint=await prepareEndpoint(profile.socket);
  httpServer=http.createServer((req,res)=>{
   const job=(async()=>{
    let operation,controller,upstream,timer,stage='request';
    try {
     if(closing || lease.signal.aborted || req.method!=='POST' || req.url!=='/v1/chat/completions' || req.headers.authorization!=='Bearer inference-broker-session' || req.headers['content-type']!=='application/json')throw fail();
     for(const header of ['authorization','x-inference-request-id'])if(req.rawHeaders.filter((x,i)=>i%2===0 && x.toLowerCase()===header).length!==1)throw fail();
     const id=req.headers['x-inference-request-id'];if(typeof id!=='string' || !/^[A-Za-z0-9_-]{16,64}$/.test(id))throw fail();
     if(consumed.has(id)){error(res,'duplicate',409);return;}
     if(active){error(res,'busy',409);return;}
     if(consumed.size>=profile.maxRequests){error(res,'session-limit',429);return;}
     // Reserve before reading/transport; malformed/aborted attempts stay consumed.
     consumed.add(id);controller=new AbortController();operation={controller};active=operation;timer=setTimeout(()=>controller.abort(),2430000);
     const cancel=()=>controller.abort();req.on('aborted',cancel);res.on('close',()=>{if(!res.writableFinished)cancel();});
     const parts=[];let size=0;
     for await(const part of req){size+=part.length;if(size>4*1024*1024)throw fail();parts.push(part);}
     if(controller.signal.aborted || closing || lease.signal.aborted)throw fail();
     const body=validateRequest(JSON.parse(Buffer.concat(parts).toString('utf8')),profileName);
     stage='lease';if(await lease.assertCurrent(controller.signal)!==true)throw fail();
     stage='transport';upstream=await transport(body,{signal:controller.signal,getApiKey:async()=>{if(controller.signal.aborted || closing)throw fail();const key=await readCredential(lease,profileName);if(controller.signal.aborted || closing)throw fail();return key;}});
     stage='response';if(controller.signal.aborted || closing || lease.signal.aborted)throw fail();
     if(!upstream || !Number.isInteger(upstream.status) || upstream.status!==200 || !upstream.body?.[Symbol.asyncIterator] || !upstream.finished?.then)throw fail();
     // Attach rejection handler immediately; finished means transport child reaped.
     const finished=Promise.resolve(upstream.finished);finished.catch(()=>{});
     // NEAR bridge already validates and buffers the complete decrypted turn.
     // Do not expose terminal DONE until transport drain and final lease ACK:
     // SDKs may cancel their HTTP body immediately when they consume DONE.
     if(profileName==='near'){
      const output=[];let total=0;
      for await(const part of upstream.body){if(controller.signal.aborted)throw fail();const chunk=Buffer.from(part);total+=chunk.length;if(total>8*1024*1024)throw fail();output.push(chunk);}
      await finished;
      stage='final-lease';if(controller.signal.aborted || await lease.assertCurrent(controller.signal)!==true)throw fail();
      if(controller.signal.aborted || closing || lease.signal.aborted)throw fail();
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
      res.end(Buffer.concat(output,total));return;
     }
     res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
     let bytes=0;
     for await(const part of upstream.body){if(controller.signal.aborted)throw fail();const chunk=Buffer.from(part);bytes+=chunk.length;if(bytes>8*1024*1024)throw fail();if(!res.write(chunk))await once(res,'drain',{signal:controller.signal});}
     await finished;
     stage='final-lease';if(controller.signal.aborted || await lease.assertCurrent(controller.signal)!==true)throw fail();
     res.end();
    }catch(failure){const admission=admissionDiagnostic(failure);failureDiagnostic(stage,failure,admission);controller?.abort();if(!res.headersSent)error(res,'unavailable',503,stage==='transport'&&!nearToolBridgeDiagnostic(failure)?admission:null,nearToolBridgeDiagnostic(failure));else res.destroy();}
    finally {
     clearTimeout(timer);controller?.abort();
     if(upstream?.finished)await Promise.resolve(upstream.finished).catch(()=>{});
     if(operation && active===operation)active=null;
    }
   })();jobs.add(job);job.finally(()=>jobs.delete(job)).catch(()=>{});
  });
  httpServer.requestTimeout=10000;httpServer.headersTimeout=10000;httpServer.maxHeadersCount=16;
  server=net.createServer(socket=>{
   if(closing || connections.size>=4){socket.destroy();return;}
   connections.add(socket);socket.pause();socket.on('error',()=>{});socket.once('close',()=>connections.delete(socket));
   const task=(async()=>{try{const peer=await authenticate(socket._handle.fd,{python:'/usr/bin/python3',timeoutMs:5000,signal:lease.signal});if(peer.uid!==970 || closing || lease.signal.aborted)throw fail();httpServer.emit('connection',socket);socket.resume();}catch{socket.destroy();}})();auths.add(task);task.finally(()=>auths.delete(task)).catch(()=>{});
  });
  await endpoint.check();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(SOCKET,resolve);});
  await fsp.chmod(SOCKET,0o660);socketIdentity=await fsp.lstat(SOCKET);
  if(!socketIdentity.isSocket() || socketIdentity.uid!==972 || socketIdentity.gid!==974 || (socketIdentity.mode&0o7777)!==0o660 || socketIdentity.nlink!==1)throw fail();
  await endpoint.close();endpoint=null;
 }catch{closing=true;active?.controller.abort();const closed=closeServer(server);for(const s of connections)s.destroy();await Promise.allSettled([...auths,...jobs]);try{await closed;await endpoint?.close();}finally{try{await transport.close?.();}finally{await lease.release();}}throw fail();}
 async function stop(){
  if(!stopPromise)stopPromise=(async()=>{closing=true;active?.controller.abort();const closed=closeServer(server);for(const s of connections)s.destroy();await Promise.allSettled([...auths,...jobs]);await closed;
   try{const s=await fsp.lstat(SOCKET);if(s.dev===socketIdentity.dev && s.ino===socketIdentity.ino)await fsp.unlink(SOCKET);}catch(e){if(e.code!=='ENOENT')throw e;}finally{try{await transport.close?.();}finally{await lease.release();}}})();return stopPromise;
 }
 lease.signal.addEventListener('abort',()=>{void stop().catch(()=>{});},{once:true});if(lease.signal.aborted)await stop();
 return {stop};
}
