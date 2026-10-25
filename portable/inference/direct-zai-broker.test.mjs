import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import fsp from 'node:fs/promises';import os from 'node:os';import http from 'node:http';import net from 'node:net';import {spawn} from 'node:child_process';import {pathToFileURL} from 'node:url';
import {peerCredential} from '../workspace-service/syscred.mjs';
const source=await fsp.readFile(new URL('./direct-zai-broker.mjs',import.meta.url),'utf8');let serial=0;
const request={model:'glm-5.3',messages:[{role:'user',content:'synthetic'}],stream:true,max_tokens:1024,reasoning_effort:'low',thinking:{type:'enabled',clear_thinking:false}};
async function fixture(t,{peer=970,transport,profileName="zai",authFailure}={}) {
 const dir=await fsp.mkdtemp(os.tmpdir()+'/zai-broker-'),socket=dir+'/'+profileName+'.sock',record=dir+'/record';await fsp.writeFile(record,JSON.stringify({version:1,provider:profileName,model:profileName==='near'?'z-ai/glm-5.3-flash':'glm-5.3',apiKey:'SYNTHETIC_KEY'}),{mode:0o600});const fd=fs.openSync(record,'r');
 const originalStat=fs.fstatSync.bind(fs),lstat=fsp.lstat.bind(fsp),chown=fsp.chown.bind(fsp);const uid=process.getuid();let released=0,calls=0,seen=false;
 t.mock.method(process,'getuid',()=>972);t.mock.method(process,'getgroups',()=>[974]);
 const project=(s,fields)=>Object.assign(Object.create(Object.getPrototypeOf(s)),s,fields);
 t.mock.method(fs,'fstatSync',n=>project(originalStat(n),n===fd?{uid:972,gid:972}:{}));
 t.mock.method(fsp,'lstat',async p=>project(await lstat(p),p===dir?{uid:972,gid:974,mode:0o42750}:(p===socket || String(p).endsWith('/'+profileName+'.sock'))?{uid:972,gid:974}:{}));
 t.mock.method(fsp,'chown',async(p,a,b)=>{assert.equal(p,socket);assert.equal(a,972);assert.equal(b,974);});
 const s=source.replace("'../../lib/coupon-near.mjs'",JSON.stringify('data:text/javascript,export const couponNearAdmissionDiagnostic=()=>null;')).replace("'../../lib/near-tool-codec.mjs'",JSON.stringify(new URL('../../lib/near-tool-codec.mjs',import.meta.url).href)).replace("'../../lib/near-tool-bridge.mjs'",JSON.stringify(new URL('../../lib/near-tool-bridge.mjs',import.meta.url).href)).replace("'../workspace-service/syscred.mjs'",JSON.stringify(new URL('../workspace-service/syscred.mjs',import.meta.url).href)).replaceAll('/run/portable-inference/zai.sock',socket).replaceAll('/run/portable-inference',dir);
 const m=await import('data:text/javascript;base64,'+Buffer.from(s+'\nexport {prepareEndpoint};\n//'+serial++).toString('base64'));
 const controller=new AbortController(),lease={fd,signal:controller.signal,assertCurrent:async()=>true,release:async()=>{released++;}};
 const authenticate=async(fd,options)=>{assert.equal(options.timeoutMs,5000);if(authFailure)throw new Error(authFailure);const real=await peerCredential(fd,options);assert.equal(real.uid,uid);seen=true;return {...real,uid:peer};};
 const server=await m.startBroker({lease,authenticate,profileName,transport:async(...args)=>{calls++;return transport?transport(...args):{status:200,body:(async function*(){yield Buffer.from('data: [DONE]\n\n');})(),finished:Promise.resolve()};}});
 t.after(async()=>{await server.stop();fs.closeSync(fd);await fsp.rm(dir,{recursive:true,force:true});});
 return {server,lease,controller,m,socket,dir,get released(){return released;},get calls(){return calls;},get seen(){return seen;},send:(id,body=request,auth='Bearer inference-broker-session')=>new Promise((resolve,reject)=>{const r=http.request({socketPath:socket,path:'/v1/chat/completions',method:'POST',headers:{authorization:auth,'content-type':'application/json','x-inference-request-id':id}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,text}));});r.on('error',reject);r.end(JSON.stringify(body));})};
}
test('native peer credential helper then streaming HTTP; three logical IDs only',async t=>{const f=await fixture(t);for(let n=0;n<3;n++){const r=await f.send('logical_request_'+n);assert.equal(r.status,200);assert.match(r.text,/DONE/);}assert.equal((await f.send('logical_request_0')).status,409);assert.equal((await f.send('logical_request_9')).status,429);assert.equal(f.calls,3);assert(f.seen);});
test('actual peer checked before HTTP attachment; projected wrong UID970 rejected',async t=>{const f=await fixture(t,{peer:971});await assert.rejects(f.send('logical_request_0'));assert.equal(f.calls,0);assert(f.seen);});
test('dummy auth and fixed model contract refuse before transport',async t=>{const f=await fixture(t);assert.equal((await f.send('logical_request_0',request,'Bearer SYNTHETIC_WRONG')).status,503);assert.equal((await f.send('logical_request_1',{...request,model:'other'})).status,503);assert.equal((await f.send('logical_request_2',{...request,apiKey:'LEAK'})).status,503);assert.equal(f.calls,0);});
test('busy refusal and stop waits transport reap before releasing lease',async t=>{let entered,finish;const ready=new Promise(r=>entered=r);let drained=false;const f=await fixture(t,{transport:async(body,{signal,getApiKey})=>{assert.equal(await getApiKey(),'SYNTHETIC_KEY');const finished=new Promise(r=>finish=()=>{drained=true;r();});entered();return {status:200,body:(async function*(){await new Promise(r=>signal.addEventListener('abort',r,{once:true}));})(),finished};}});const pending=f.send('logical_request_0').catch(()=>{});await ready;assert.equal((await f.send('logical_request_1')).status,409);const stopping=f.server.stop();await new Promise(r=>setTimeout(r,15));assert.equal(f.released,0);finish();await stopping;await pending;assert(drained);assert.equal(f.released,1);});
test('record schema strict and request output tokens bound',async t=>{const f=await fixture(t);assert.throws(()=>f.m.validateRequest({...request,max_tokens:1025}));assert.throws(()=>f.m.validateRequest({...request,reasoning_effort:'high'}));await fsp.writeFile('/proc/self/fd/'+f.lease.fd,'{}').catch(()=>{});await assert.rejects(f.m.readCredential(f.lease));});
test('oversized body never transmits; consumed malformed ID cannot be retried',async t=>{const f=await fixture(t);const bad={...request,messages:[{role:'user',content:'x'.repeat(4*1024*1024)}]};assert.equal((await f.send('logical_request_big',bad)).status,503);assert.equal((await f.send('logical_request_big')).status,409);assert.equal(f.calls,0);});
test('lease abort waits transport finished and releases once',async t=>{let enter,finish;const ready=new Promise(r=>enter=r);const f=await fixture(t,{transport:async(body,{signal})=>{const finished=new Promise(r=>finish=r);enter();return{status:200,body:(async function*(){await new Promise(r=>signal.addEventListener('abort',r,{once:true}));})(),finished};}});const response=f.send('logical_abort_000').catch(()=>{});await ready;f.controller.abort();await new Promise(r=>setTimeout(r,15));assert.equal(f.released,0);finish();await f.server.stop();await response;assert.equal(f.released,1);});
test('tool stream profile allows actual SDK tool request and rejects override',async t=>{const f=await fixture(t);assert.equal(f.m.validateRequest({...request,tools:[{type:'function',function:{name:'synthetic',parameters:{type:'object'}}}],tool_stream:true}).tool_stream,true);assert.throws(()=>f.m.validateRequest({...request,tools:[],tool_stream:false}));assert.throws(()=>f.m.validateRequest({...request,base_url:'https://evil.invalid'}));});

test('real abandoned kernel socket is recovered and live listener is preserved',async t=>{
 const f=await fixture(t);const prior=await fsp.lstat(f.socket);await assert.rejects(f.m.prepareEndpoint());assert.equal((await fsp.lstat(f.socket)).ino,prior.ino);
 await f.server.stop();
 const child=spawn(process.execPath,['-e',`require('net').createServer().listen(${JSON.stringify(f.socket)},()=>process.exit(0))`]);assert.equal(await new Promise(r=>child.once('exit',r)),0);await fsp.chmod(f.socket,0o660);
 const stale=await fsp.lstat(f.socket);assert(stale.isSocket());const endpoint=await f.m.prepareEndpoint();await endpoint.close();await assert.rejects(fsp.lstat(f.socket),{code:'ENOENT'});
});
test('malformed endpoint is never unlinked',async t=>{const f=await fixture(t);await f.server.stop();await fsp.writeFile(f.socket,'SYNTHETIC_CANARY');await assert.rejects(f.m.prepareEndpoint());assert.equal(await fsp.readFile(f.socket,'utf8'),'SYNTHETIC_CANARY');await fsp.unlink(f.socket);await fsp.symlink('missing',f.socket);await assert.rejects(f.m.prepareEndpoint());assert((await fsp.lstat(f.socket)).isSymbolicLink());});

test('lease release waits the actual server close callback',async t=>{const f=await fixture(t);const original=net.Server.prototype.close;let acknowledged=false;t.mock.method(net.Server.prototype,'close',function(callback){return original.call(this,error=>setTimeout(()=>{acknowledged=true;callback(error);},25));});const stopping=f.server.stop();await new Promise(r=>setTimeout(r,10));assert.equal(f.released,0);await stopping;assert(acknowledged);assert.equal(f.released,1);});

import {tlsFixture} from './tests/direct-zai-tls-fixture.mjs';
import {runCurl} from './zai-curl-transport.mjs';
test('joined real broker HTTP to curl TLS over SOCKS with projected UID and actual peer helper',async t=>{
 let providerCalls=0;
 const tls=await tlsFixture(t,(req,res)=>{
  providerCalls++;assert.equal(req.headers.authorization,'Bearer SYNTHETIC_KEY');
  let body='';req.on('data',b=>body+=b);req.on('end',()=>{assert.deepEqual(JSON.parse(body),request);res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"synthetic":true}\n\ndata: [DONE]\n\n');});
 });
 const f=await fixture(t,{transport:(body,options)=>runCurl(body,options,tls.launch)});
 const r=await f.send('joined_request_0001');assert.equal(r.status,200);assert.match(r.text,/DONE/);assert.equal(providerCalls,1);assert.deepEqual(tls.destinations,['api.z.ai']);
 assert.equal((await f.send('joined_request_0001')).status,409);assert.equal(providerCalls,1);
 await f.server.stop();assert.equal(f.released,1);assert.equal(tls.children[0].exitCode,0);
});

test('explicit NEAR profile accepts more requests than the old 256 bound while retaining bounded IDs and replay refusal',async t=>{
 const f=await fixture(t,{profileName:'near'});const body={model:'z-ai/glm-5.3-flash',messages:[{role:'user',content:'synthetic'}],stream:true,max_tokens:1024,tools:['read','write','edit','bash'].map(name=>({type:'function',function:{name,parameters:{type:'object'}}}))};
 assert.equal(f.m.directProfile('near').maxRequests,16384);assert.equal(f.m.directProfile('zai').maxRequests,3);assert(Object.isFrozen(f.m.directProfile('near')));
 for(let i=0;i<300;i++)assert.equal((await f.send('near_request_'+String(i).padStart(4,'0'),body)).status,200);
 assert.equal((await f.send('near_request_0000',body)).status,409);assert.equal(f.calls,300);
});

test('peer helper timeout remains fail-closed with existing five-second bound',async t=>{const f=await fixture(t,{authFailure:'peer credential check timed out'});await assert.rejects(f.send('logical_timeout_0'));assert.equal(f.calls,0);});

test('NEAR terminal SSE is withheld until final lease ACK, then DONE cancellation cannot revoke that completed turn',async t=>{
 let returned=false,validated=false;
 const f=await fixture(t,{profileName:'near',transport:async()=>{returned=true;return {status:200,body:new Response('data: [DONE]\n\n').body,finished:Promise.resolve()};}});
 f.lease.assertCurrent=async()=>{if(returned){await new Promise(r=>setTimeout(r,80));validated=true;}return true;};
 const body={model:'z-ai/glm-5.3-flash',messages:[{role:'user',content:'synthetic'}],stream:true,max_tokens:1024,tools:['read','write','edit','bash'].map(name=>({type:'function',function:{name,parameters:{type:'object'}}}))};
 const atDone=await new Promise((resolve,reject)=>{
  const req=http.request({socketPath:f.socket,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer inference-broker-session','content-type':'application/json','x-inference-request-id':'near_done_cancel_1'}},res=>{
   let text='';res.on('data',chunk=>{text+=chunk;if(text.includes('[DONE]')){const ready=validated;res.destroy();resolve(ready);}});res.on('error',reject);
  });req.on('error',reject);req.end(JSON.stringify(body));
 });
 assert.equal(atDone,true,'client saw terminal DONE before final lease ACK');
 assert.equal(f.calls,1);
});
test('NEAR final lease refusal releases no terminal SSE or model output',async t=>{
 let returned=false;const f=await fixture(t,{profileName:'near',transport:async()=>{returned=true;return {status:200,body:new Response('data: [DONE]\n\n').body,finished:Promise.resolve()};}});
 f.lease.assertCurrent=async()=>!returned;
 const body={model:'z-ai/glm-5.3-flash',messages:[{role:'user',content:'synthetic'}],stream:true,max_tokens:1024,tools:['read','write','edit','bash'].map(name=>({type:'function',function:{name,parameters:{type:'object'}}}))};
 const r=await f.send('near_final_refuse_1',body);assert.equal(r.status,503);assert.ok(!r.text.includes('[DONE]'));assert.equal(f.calls,1);
});
import {createNearToolBridge} from '../../lib/near-tool-bridge.mjs';
test('NEAR bridge failure stage reaches the agent-visible error text',async t=>{
 const bridge=createNearToolBridge({profile:{baseUrl:'https://cloud-api.near.ai/v1',model:'z-ai/glm-5.3-flash'},fetch:async()=>{throw Object.assign(Error('synthetic'),{code:'provider_unavailable',upstreamStatus:502});}});
 const f=await fixture(t,{profileName:'near',transport:body=>bridge('https://cloud-api.near.ai/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer coupon-session'},body:JSON.stringify(body)})});
 const r=await f.send('near_bridge_fail_0',{model:'z-ai/glm-5.3-flash',messages:[{role:'user',content:'synthetic'}],stream:true,max_tokens:1024,tools:['read','write','edit','bash'].map(name=>({type:'function',function:{name,parameters:{type:'object'}}}))});
 assert.equal(r.status,503);assert.match(JSON.parse(r.text).error.message,/^Inference unavailable after 3 attempts \(adapter-fetch; provider_unavailable; HTTP 502; \d+ ms\)\. A new prompt may retry\.$/);
});
test('near validator admits 4096-token multi-round tool history rendered in the emitted call syntax',async t=>{
 const f=await fixture(t,{profileName:'near'});const {encodeRequest,decodeResponse}=await import('../../lib/near-tool-codec.mjs');
 const tools=['read','write','edit','bash'].map(name=>({type:'function',function:{name,description:name,parameters:{type:'object'}}}));
 const messages=[{role:'system',content:'agent'},{role:'user',content:'find zec files'}];
 for(let i=0;i<3;i++)messages.push({role:'assistant',content:'',reasoning_content:'think',tool_calls:[{id:'near_'+i+'_0',type:'function',function:{name:'bash',arguments:JSON.stringify({command:'grep -ril zec ~ | head -'+(i+1),timeout:90})}}]},{role:'tool',tool_call_id:'near_'+i+'_0',content:'match '+i});
 messages.push({role:'user',content:'ok how did it go'});
 const body={model:'z-ai/glm-5.3-flash',messages,stream:true,stream_options:{include_usage:true},max_tokens:4096,tools,tool_choice:'auto',tool_stream:true};
 assert.equal(f.m.validateRequest(body,'near'),body);assert.equal(f.m.validateRequest({...body,max_tokens:16384},'near').max_tokens,16384);assert.throws(()=>f.m.validateRequest({...body,max_tokens:16385},'near'));
 const e=encodeRequest(body);assert.ok(!JSON.stringify(e).includes('Previous tool requests'));
 const prior=e.messages.filter(m=>m.role==='assistant').map(m=>decodeResponse(m.content,{finishReason:'stop'}).calls[0].arguments);
 assert.deepEqual(prior,[0,1,2].map(i=>({command:'grep -ril zec ~ | head -'+(i+1),timeout:90})));
});
