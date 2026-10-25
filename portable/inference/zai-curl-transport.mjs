// SPDX-License-Identifier: MIT
import {spawn} from 'node:child_process';
const fail=()=>Error('zai-transport-unavailable');
export const endpoint='https://api.z.ai/api/coding/paas/v4/chat/completions';
export const curlArgs=Object.freeze(['-q','--silent','--show-error','--no-buffer','--include','--http1.1','--proxy','socks5h://127.0.0.1:9050','--noproxy','','--proto','=https','--proto-redir','=https','--tlsv1.2','--max-time','120','--connect-timeout','15','--max-filesize','2097152','--request','POST','--header','content-type: application/json','--header','accept: text/event-stream','--header','Expect:','--data-binary','@/dev/fd/3','--config','-',endpoint]);
const bodyShim=`import os,sys
body=bytearray()
while True:
 chunk=os.read(3,min(65536,262145-len(body)))
 if not chunk:break
 body.extend(chunk)
 if len(body)>262144:raise SystemExit(2)
fd=os.memfd_create('zai-request',0)
view=memoryview(body)
while view:
 n=os.write(fd,view);view=view[n:]
os.lseek(fd,0,0)
os.dup2(fd,3,inheritable=True)
os.set_inheritable(3,True)
if fd!=3:os.close(fd)
os.execve('/usr/bin/curl',['/usr/bin/curl',*sys.argv[1:]],{'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
`;
export function transport(body,options){return runCurl(body,options,spawn);}
// Trusted private fixture seam. Never take spawn/executable/URL from worker data.
export async function runCurl(body,{signal,getApiKey}={},spawnProcess){
 let encoded;
 try {
  if(!body || Array.isArray(body) || body.model!=='glm-5.3' || body.stream!==true || body.reasoning_effort!=='low' || !Number.isSafeInteger(body.max_tokens) || body.max_tokens<1 || body.max_tokens>1024 || typeof getApiKey!=='function' || signal?.aborted)throw fail();
  encoded=JSON.stringify(body);if(Buffer.byteLength(encoded)>262144)throw fail();
  const wire=JSON.parse(encoded);if(wire.model!=='glm-5.3' || wire.stream!==true || wire.reasoning_effort!=='low' || !Number.isSafeInteger(wire.max_tokens) || wire.max_tokens<1 || wire.max_tokens>1024)throw fail();
 }catch{throw fail();}
 const credentialAbort=new AbortController();
 let child,stopped=false,closed=false,timer,killTimer,resolveFinished,rejectFinished;
 const finished=new Promise((resolve,reject)=>{resolveFinished=resolve;rejectFinished=reject;});finished.catch(()=>{});
 const stop=()=>{
  stopped=true;credentialAbort.abort();
  if(child && !closed){child.kill('SIGTERM');child.stdout.destroy(fail());child.stdin.destroy();child.stdio[3].destroy();if(!killTimer)killTimer=setTimeout(()=>{if(!closed)child.kill('SIGKILL');},100);}
 };
 let credentialTask;
 let rejectAdmission;
 const admission=new Promise((_,reject)=>{rejectAdmission=reject;});admission.catch(()=>{});
 const abort=()=>{stop();rejectAdmission(fail());};
 timer=setTimeout(abort,120000);signal?.addEventListener('abort',abort,{once:true});
 const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);};
 try {
  credentialTask=Promise.resolve().then(()=>getApiKey({signal:credentialAbort.signal}));
  let key=await Promise.race([credentialTask,admission]);
  if(stopped || signal?.aborted || typeof key!=='string' || !/^[A-Za-z0-9._-]{1,512}$/.test(key))throw fail();
  child=spawnProcess('/usr/bin/python3',['-I','-S','-c',bodyShim,...curlArgs],{env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe','pipe']});
  child.once('error',()=>{stopped=true;});
  child.once('close',code=>{closed=true;cleanup();if(stopped || code!==0)rejectFinished(fail());else resolveFinished();});
  child.stdout.on('error',()=>{});let errorBytes=0;
  child.stderr.on('data',b=>{errorBytes+=b.length;if(errorBytes>8192)stop();});
  child.stdin.on('error',stop);
  child.stdio[3].on('error',stop);
  child.stdin.end(`header = "Authorization: Bearer ${key}"\n`);key=null;
  child.stdio[3].end(encoded);encoded=null;
  if(signal?.aborted)abort();
  const iterator=child.stdout[Symbol.asyncIterator]();let pending=Buffer.alloc(0),status;
  while(true){
   const next=await iterator.next();if(next.done)throw fail();pending=Buffer.concat([pending,next.value]);
   const end=pending.indexOf('\r\n\r\n');if(end<0){if(pending.length>16384)throw fail();continue;}
   if(end+4>16384)throw fail();const header=pending.subarray(0,end).toString('latin1');
   const lines=header.split('\r\n');const match=/^HTTP\/1\.[01] ([0-9]{3})(?: [\x20-\x7e]*)?$/.exec(lines.shift());if(!match)throw fail();status=Number(match[1]);
   let type;
   for(const line of lines){const h=/^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([\x20-\x7e\t]*)$/.exec(line);if(!h)throw fail();if(h[1].toLowerCase()==='content-type'){if(type!==undefined)throw fail();type=h[2];}}
   if(status<200 || status>=300 || !/^text\/event-stream(?:\s*;|$)/i.test(type??''))throw fail();
   pending=pending.subarray(end+4);break;
  }
  let consumed=false;
  const stream={async *[Symbol.asyncIterator](){
   if(consumed)throw fail();consumed=true;let complete=false,total=0;
   try{
    if(pending.length){total+=pending.length;if(total>2097152)throw fail();yield pending;}pending=null;
    while(true){const n=await iterator.next();if(n.done)break;total+=n.value.length;if(total>2097152)throw fail();yield n.value;}
    await finished;complete=true;
   }catch{throw fail();}finally{if(!complete){stop();await finished.catch(()=>{});}}
  }};
  return {status,body:stream,finished};
 }catch{
  stop();
  // Lease ownership cannot drain while its credential/assert callback still runs.
  // A callback ignoring abort keeps this operation pending, never falsely drained.
  if(credentialTask)await credentialTask.catch(()=>{});credentialTask=null;
  if(child)await finished.catch(()=>{});else {cleanup();rejectFinished(fail());}
  throw fail();
 }
}
