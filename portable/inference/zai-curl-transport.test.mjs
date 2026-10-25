import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import https from 'node:https';
import os from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {runCurl,curlArgs,endpoint} from './zai-curl-transport.mjs';
const request={model:'glm-5.3',stream:true,reasoning_effort:'low',max_tokens:1024,messages:[{role:'user',content:'synthetic \"quote\" \\ slash\nnewline'}]};
const key='SYNTHETIC_CANARY';
import {tlsFixture as fixture} from './tests/direct-zai-tls-fixture.mjs';

async function collect(response){let text='';for await(const b of response.body)text+=b.toString();await response.finished;return text;}
test('actual curl TLS through SOCKS remote hostname; streamed SSE and config secret',async t=>{
 const f=await fixture(t,(req,res)=>{assert.equal(req.url,'/api/coding/paas/v4/chat/completions');assert.equal(req.headers.authorization,'Bearer '+key);let body='';req.on('data',b=>body+=b);req.on('end',()=>{assert.deepEqual(JSON.parse(body),request);res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: one\n\n');setTimeout(()=>res.end('data: [DONE]\n\n'),25);});});
 const r=await runCurl(request,{getApiKey:async()=>key},f.launch);assert.equal(r.status,200);assert.equal(await collect(r),'data: one\n\ndata: [DONE]\n\n');assert.deepEqual(f.destinations,['api.z.ai']);assert.equal(f.children[0].exitCode,0);
});
test('actual TLS invalid trust refuses and reaps',async t=>{const f=await fixture(t,()=>assert.fail('TLS must refuse'),{trust:false});await assert.rejects(runCurl(request,{getApiKey:async()=>key},f.launch),/zai-transport-unavailable/);assert.notEqual(f.children[0].exitCode,null);});
test('redirect refuses without follow',async t=>{let n=0;const f=await fixture(t,(req,res)=>{n++;res.writeHead(302,{location:'https://evil.invalid','content-type':'text/event-stream'});res.end();});await assert.rejects(runCurl(request,{getApiKey:async()=>key},f.launch));assert.equal(n,1);});
test('abort streaming kills and reaps before finished rejects',async t=>{const f=await fixture(t,(req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: start\n\n');});const ctl=new AbortController();const r=await runCurl(request,{getApiKey:async()=>key,signal:ctl.signal},f.launch);ctl.abort();await assert.rejects(r.finished);assert(f.children[0].exitCode!==null || f.children[0].signalCode!==null);});
test('oversized response refuses',async t=>{const f=await fixture(t,(req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end('x'.repeat(2097153));});const r=await runCurl(request,{getApiKey:async()=>key},f.launch);await assert.rejects(collect(r));});
test('oversized headers refuse',async t=>{const f=await fixture(t,(req,res)=>{res.writeHead(200,{'content-type':'text/event-stream','x-test':'x'.repeat(17000)});res.end();});await assert.rejects(runCurl(request,{getApiKey:async()=>key},f.launch));});
test('key/header injection and request bounds refuse before spawn',async()=>{let calls=0;const fake=()=>{calls++;throw Error();};for(const secret of ['x\r\nX: bad','x"quote','x\\escape',''])await assert.rejects(runCurl(request,{getApiKey:async()=>secret},fake));await assert.rejects(runCurl({...request,max_tokens:1025},{getApiKey:async()=>key},fake));assert.equal(calls,0);});
test('aborted credential callback drains before rejection and never sends late key',async()=>{
 const c=new AbortController();let calls=0,resolveKey,settled=false,callbackSignal;
 const keyTask=new Promise(r=>resolveKey=r);
 const pending=runCurl(request,{getApiKey:({signal})=>{callbackSignal=signal;return keyTask;},signal:c.signal},()=>calls++);
 pending.then(()=>settled=true,()=>settled=true);await Promise.resolve();c.abort();
 await new Promise(r=>setImmediate(r));assert(callbackSignal.aborted);assert.equal(settled,false);assert.equal(calls,0);
 resolveKey('SYNTHETIC_LATE_KEY');await assert.rejects(pending);assert.equal(calls,0);assert.equal(settled,true);
});
test('actual curl exact 256KiB escaped config body and paused consumer backpressure',async t=>{
 const payload={...request,messages:[{role:'user',content:''}]};payload.messages[0].content='x'.repeat(262144-Buffer.byteLength(JSON.stringify(payload)));assert.equal(Buffer.byteLength(JSON.stringify(payload)),262144);
 let received=false;
 const f=await fixture(t,(req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{assert.equal(Buffer.byteLength(body),Buffer.byteLength(JSON.stringify(payload)),'request byte length');assert.deepEqual(JSON.parse(body),payload);received=true;res.writeHead(200,{'content-type':'text/event-stream'});res.end('x'.repeat(1048576));});});
 const r=await runCurl(payload,{getApiKey:async()=>key},f.launch);await new Promise(r=>setTimeout(r,40));assert(f.children[0].stdout.readableLength<=131072);assert.notEqual(f.children[0].stdout.readableFlowing,true);assert.equal((await collect(r)).length,1048576);assert(received);
 let spawned=false;await assert.rejects(runCurl({...payload,extra:'x'},{getApiKey:async()=>key},()=>{spawned=true;}));assert.equal(spawned,false);
});
test('serialized policy override refused',async()=>{await assert.rejects(runCurl({...request,toJSON:()=>({...request,model:'other'})},{getApiKey:async()=>key},()=>assert.fail('spawn')));});
test('refused SOCKS endpoint never falls back or retries',async()=>{
 const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));let count=0,child;
 const launch=(exe,args,opts)=>{count++;const a=[...args];a[a.indexOf('--proxy')+1]=`socks5h://127.0.0.1:${port}`;child=spawn(exe,a,opts);return child;};
 await assert.rejects(runCurl(request,{getApiKey:async()=>key},launch),/zai-transport-unavailable/);assert.equal(count,1);assert.notEqual(child.exitCode,null);
});
test('consumer return cancels and reaps unfinished stream',async t=>{
 const f=await fixture(t,(req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: chunk\n\n');});
 const r=await runCurl(request,{getApiKey:async()=>key},f.launch);for await(const b of r.body){assert(b.length);break;}await assert.rejects(r.finished);assert(f.children[0].exitCode!==null || f.children[0].signalCode!==null);
});
