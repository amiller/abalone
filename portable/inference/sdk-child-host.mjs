// Dedicated adapter host. Not connected to the existing inference broker.
import {spawn} from 'node:child_process';import fs from 'node:fs';import path from 'node:path';import {createHostWire} from './sdk-host-wire.mjs';
import {exact,hostCall,prepareReply,streamReply} from './sdk-host-schema.mjs';
const FINANCIAL_UID=972;
function refusal(){return Error('adapter-host-refused');}
function trustedFile(root,file){if(typeof root!=='string'||typeof file!=='string'||!path.isAbsolute(root)||!path.isAbsolute(file)||root==='/'||path.normalize(root)!==root)throw refusal();for(let parent=root;parent!=='/';parent=path.dirname(parent)){const st=fs.lstatSync(parent);if(st.uid!==0||(st.mode&0o022)||st.isSymbolicLink())throw refusal();}if(!path.isAbsolute(root)||!path.isAbsolute(file)||!file.startsWith(root+'/')||fs.realpathSync(file)!==file)throw refusal();let p=root;for(const part of path.relative(root,file).split('/')){const st=fs.lstatSync(p);if(st.uid!==0||(st.mode&0o022)||st.isSymbolicLink())throw refusal();p=path.join(p,part);}const st=fs.lstatSync(file);if(!st.isFile()||st.uid!==0||(st.mode&0o022))throw refusal();}
export async function createSDKChildHost({trustedRoot,nodePath,childEntry,wrapperPath,sdkLoaderPath,verifyRuntime,lease,chargePolicy,admissionPolicy,permitRawPost,deadlineMs=60000}={}) {
 if(process.getuid()!==FINANCIAL_UID||!chargePolicy||typeof verifyRuntime!=='function'||typeof admissionPolicy!=='function'||typeof permitRawPost!=='function'||!lease||!Number.isInteger(lease.fd)||typeof lease.assertCurrent!=='function'||typeof lease.release!=='function'||!Number.isSafeInteger(deadlineMs)||deadlineMs<100||deadlineMs>600000)throw refusal();
 for(const p of [nodePath,childEntry,wrapperPath,sdkLoaderPath])trustedFile(trustedRoot,p);
 const startup=new AbortController();let startupTimer;try{await Promise.race([(async()=>{if(await verifyRuntime(startup.signal)!==true||startup.signal.aborted||await lease.assertCurrent(startup.signal)!==true||startup.signal.aborted)throw refusal();})(),new Promise((_,reject)=>{startupTimer=setTimeout(()=>{startup.abort();reject(refusal());},deadlineMs);})]);}finally{clearTimeout(startupTimer);startup.abort();}
 const stat=fs.fstatSync(lease.fd),flags=Number.parseInt(fs.readFileSync('/proc/self/fdinfo/'+lease.fd,'utf8').match(/^flags:\s+(\d+)/m)[1],8);
 if(!stat.isFile()||stat.uid!==FINANCIAL_UID||(stat.mode&0o077)||stat.size>16384||(flags&3)!==0)throw refusal();
 const identity={dev:stat.dev,ino:stat.ino};const abort=new AbortController();let phase='new',handle=null,logicalId=null,requestDigest=null,docDigest=null,permitUsed=false,closing=null,docParts=null,docBytes=0,closed=false;
 const child=spawn('/usr/bin/python3',['-I',wrapperPath,String(process.pid),nodePath,childEntry],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe','pipe',lease.fd]});
 let exitResolve;const exited=new Promise(resolve=>exitResolve=resolve);child.once('exit',()=>exitResolve());child.once('error',()=>exitResolve());
 let outputBytes=0;for(const out of [child.stdout,child.stderr])out.on('data',b=>{outputBytes+=b.length;if(outputBytes>65536)void close();});
 const wire=createHostWire(child.stdio[3],async(op,data)=>{
  if(closed)throw refusal();hostCall(op,data);
  if(op==='admission-begin'&&phase==='preparing'&&docParts===null){docParts=[];docBytes=0;return {};}
  if(op==='admission-chunk'&&phase==='preparing'&&docParts!==null){if(Object.keys(data).some(k=>k!=='chunk')||typeof data.chunk!=='string'||data.chunk.length>45000)throw refusal();const b=Buffer.from(data.chunk,'base64');docBytes+=b.length;if(b.length>32768||docBytes>4*1024*1024)throw refusal();docParts.push(b);return {};}
  if(op==='admission-end'&&phase==='preparing'&&docParts!==null){const doc=JSON.parse(Buffer.concat(docParts).toString('utf8'));docParts=null;return {allowed:await admissionPolicy(doc,abort.signal)===true};}
  if(op==='permit'&&phase==='posting'&&!permitUsed){permitUsed=true;
   if(!data||Object.keys(data).some(k=>!['logicalId','requestDigest','bound','policyEvidenceId','admissionDigest'].includes(k))||data.logicalId!==logicalId||data.requestDigest!==requestDigest||data.admissionDigest!==docDigest)throw refusal();
   if(abort.signal.aborted||await lease.assertCurrent(abort.signal)!==true)throw refusal();const now=fs.fstatSync(lease.fd);if(now.dev!==identity.dev||now.ino!==identity.ino)throw refusal();
   const permission=await permitRawPost(Object.freeze({...data}),abort.signal);if(abort.signal.aborted)throw refusal();return permission;
  }
  throw refusal();
 },{deadlineMs});
 wire.onClosed(()=>{if(!closed)void close();});
 const timer=setTimeout(()=>void close(),deadlineMs);timer.unref?.();
 async function close(){if(closing)return closing;closed=true;abort.abort();clearTimeout(timer);wire.close();closing=(async()=>{child.kill('SIGTERM');let t;await Promise.race([exited,new Promise(r=>t=setTimeout(r,100))]);clearTimeout(t);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;await lease.release();})();return closing;}
 function signal(s){if(!s||typeof s.addEventListener!=='function')throw refusal();if(s.aborted){void close();throw refusal();}s.addEventListener('abort',()=>void close(),{once:true,signal:abort.signal});}
 async function prepare({logicalId:id,body,signal:requestSignal}={}){try{if(phase!=='new'||closed)throw refusal();signal(requestSignal);phase='preparing';logicalId=id;const bytes=Buffer.from(JSON.stringify(body));if(bytes.length>4*1024*1024)throw refusal();exact(await wire.call('initialize',{sdkLoaderPath,chargePolicy,logicalId}),[]);for(let n=0;n<bytes.length;n+=32768)exact(await wire.call('body',{chunk:bytes.subarray(n,n+32768).toString('base64')}),[]);const reply=await wire.call('prepare',{});prepareReply(reply);handle=Object.freeze({token:reply.token});requestDigest=reply.requestDigest;docDigest=reply.documentDigest;phase='prepared';return {handle,requestDigest,documentDigest:docDigest};}catch{await close();throw refusal();}}
 async function post({handle:ticket,signal:requestSignal}={}){try{if(closed||phase!=='prepared'||ticket!==handle)throw refusal();signal(requestSignal);phase='posting';exact(await wire.call('post',{token:handle.token}),[]);phase='stream';let bytes=0;return {stream:new ReadableStream({async pull(out){try{const data=streamReply(await wire.call('pull',{}));if(data.done===true){await close();out.close();return;}if(typeof data.chunk!=='string'||data.chunk.length>45000)throw refusal();const b=Buffer.from(data.chunk,'base64');bytes+=b.length;if(b.length>32768||bytes>8*1024*1024)throw refusal();out.enqueue(b);}catch{await close();out.error(refusal());}},async cancel(){await close();}},{highWaterMark:0})};}catch{await close();throw refusal();}}
 return Object.freeze({prepare,post,close,pid:child.pid});
}
