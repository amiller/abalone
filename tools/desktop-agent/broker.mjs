// Private desktop DEVELOPMENT prototype; no custody, Tor or sandbox claim.
// Credential JSON arrives only on inherited FD4. Never argv, env or a key file.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {once} from 'node:events';
const ENDPOINT='https://api.z.ai/api/coding/paas/v4/chat/completions';
const MODEL='glm-5.3';
const MAX_REQUESTS=8; // Request bound, not a dollar cap.
const MAX_TOKENS=2048; // Trusted desktop profile, independent of provider dollar caps.
const root=path.resolve(process.argv[2]??'');
if(process.argv.length!==3 || root===process.cwd() || root==='/')throw Error('Private runtime directory required');
const metadata=fs.lstatSync(root);
if(!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid!==process.getuid() || (metadata.mode&0o777)!==0o700)throw Error('Unsafe runtime directory');
const socket=path.join(root,'inference.sock');
if(Buffer.byteLength(socket)>100 || fs.existsSync(socket))throw Error('New socket path required');
const chunks=[];let keyBytes=0;
for(;;){const chunk=Buffer.alloc(1024);const n=fs.readSync(4,chunk,0,chunk.length,null);if(!n)break;keyBytes+=n;if(keyBytes>16384)throw Error('Credential record too large');chunks.push(chunk.subarray(0,n));}
fs.closeSync(4);
const encoded=Buffer.concat(chunks);let record;
try{record=JSON.parse(encoded.toString('utf8'));}catch{throw Error('Credential refused');}finally{encoded.fill(0);for(const chunk of chunks)chunk.fill(0);}
if(record.provider!=='zai'||record.model!==MODEL||typeof record.apiKey!=='string'||!/^[A-Za-z0-9._-]{1,512}$/.test(record.apiKey))throw Error('Credential refused');
let apiKey=record.apiKey;record=null;
const consumed=new Set();let active=null,closing=false;
const server=http.createServer((req,res)=>{
 const run=async()=>{
  let timer,controller;
  const refuse=(code,status=503)=>{if(!res.headersSent)res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:{code,message:'Desktop inference refused; outcome may be unknown. No automatic retry.'}}));};
  try{
   if(closing||req.method!=='POST'||req.url!=='/v1/chat/completions'||req.headers.authorization!=='Bearer inference-broker-session'||req.headers['content-type']!=='application/json')return refuse('request-refused',400);
   for(const name of ['authorization','x-inference-request-id'])if(req.rawHeaders.filter((h,i)=>i%2===0&&h.toLowerCase()===name).length!==1)return refuse('request-refused',400);
   const id=req.headers['x-inference-request-id'];
   if(typeof id!=='string'||!/^[A-Za-z0-9_-]{16,64}$/.test(id))return refuse('request-refused',400);
   if(consumed.has(id))return refuse('duplicate',409);
   if(active)return refuse('busy',409);
   if(consumed.size>=MAX_REQUESTS)return refuse('session-limit',429);
   consumed.add(id);controller=new AbortController();active=controller;
   timer=setTimeout(()=>controller.abort(),120000);
   req.once('aborted',()=>controller.abort());res.once('close',()=>{if(!res.writableFinished)controller.abort();});
   const parts=[];let bytes=0;
   for await(const part of req){bytes+=part.length;if(bytes>262144)throw Error();parts.push(part);}
   const body=JSON.parse(Buffer.concat(parts).toString('utf8'));
   const allowed=new Set(['model','messages','tools','tool_choice','stream','stream_options','max_tokens','reasoning_effort','temperature','top_p','stop','presence_penalty','frequency_penalty','store','tool_stream','thinking']);
   if(!body||Array.isArray(body)||Object.keys(body).some(k=>!allowed.has(k))||body.model!==MODEL||body.stream!==true||body.reasoning_effort!=='low'||!Array.isArray(body.messages)||!Number.isInteger(body.max_tokens)||body.max_tokens<1||body.max_tokens>MAX_TOKENS)return refuse('request-refused',400);
   if(body.store!==undefined&&body.store!==false)return refuse('request-refused',400);
   if(body.tool_stream!==undefined&&body.tool_stream!==true)return refuse('request-refused',400);
   if(body.stream_options!==undefined&&(Object.keys(body.stream_options).join(',')!=='include_usage'||body.stream_options.include_usage!==true))return refuse('request-refused',400);
   if(body.thinking!==undefined&&(!body.thinking||Object.keys(body.thinking).sort().join(',')!=='clear_thinking,type'||body.thinking.type!=='enabled'||body.thinking.clear_thinking!==false))return refuse('request-refused',400);
   // Fixed origin/model. Native fetch has no application retry or redirect path.
   const upstream=await fetch(ENDPOINT,{method:'POST',redirect:'error',signal:controller.signal,headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json',accept:'text/event-stream'},body:JSON.stringify(body)});
   if(upstream.status!==200||!/^text\/event-stream(?:;|$)/i.test(upstream.headers.get('content-type')??'')){await upstream.body?.cancel();return refuse('upstream-http',upstream.status>=400&&upstream.status<=599?upstream.status:502);}
   res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
   let total=0;
   for await(const part of upstream.body){if(controller.signal.aborted)throw Error();total+=part.length;if(total>2097152)throw Error();if(!res.write(part))await once(res,'drain',{signal:controller.signal});}
   if(controller.signal.aborted)throw Error();res.end();
  }catch{if(res.headersSent)res.destroy();else refuse('transport-unavailable');}
  finally{clearTimeout(timer);if(active===controller)active=null;}
 };
 void run();
});
server.requestTimeout=125000;server.headersTimeout=10000;server.maxHeadersCount=20;
server.listen(socket);await once(server,'listening');fs.chmodSync(socket,0o600);
const identity=fs.lstatSync(socket);process.stdout.write('desktop-broker-ready\n');
async function stop(){if(closing)return;closing=true;active?.abort();server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));apiKey=null;try{const s=fs.lstatSync(socket);if(s.ino===identity.ino&&s.dev===identity.dev)fs.unlinkSync(socket);}catch{}}
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
