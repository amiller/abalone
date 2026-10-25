// SPDX-License-Identifier: MIT
// Offline packaged SDK request proof; only a private Unix HTTP fixture is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {encodeRequest} from '../../lib/near-tool-codec.mjs';
import {brokerProfile,createBrokerProvider} from './broker-provider.mjs';
const sdk=process.env.PORTABLE_PI_SDK;
const zaiSocket='/run/portable-inference/zai.sock';
test('only the exact trusted socket selects Zai; profiles are immutable',()=>{
 assert.deepEqual(brokerProfile(zaiSocket),{model:'glm-5.3',thinkingLevel:'low',development:true});
 for(const s of ['/tmp/zai.sock',zaiSocket+'/',zaiSocket+'?provider=zai',undefined])assert.equal(brokerProfile(s).model,'private/gpt-oss-120b');
 assert.ok(Object.isFrozen(brokerProfile(zaiSocket)));
});
test('packaged SDK Zai low/1024 and PPQ unchanged emit real Unix requests with dummy auth', {skip:!sdk||!fs.existsSync(sdk),timeout:30000},async(t)=>{
 const coding=path.dirname(path.dirname(fs.realpathSync(sdk)));
 const ai=path.join(path.dirname(coding),path.basename(coding)==='pi-coding-agent'?'pi-ai':'ai');
 const {normalizeContext}=await import(pathToFileURL(path.join(ai,'dist/utils/transcript.js')).href);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'broker-profile-'));const socket=path.join(dir,'fixture.sock');const requests=[];
 const server=http.createServer((req,res)=>{
  let body='';req.on('data',b=>body+=b);req.on('end',()=>{
   requests.push({body:JSON.parse(body),headers:req.headers,url:req.url});
   res.writeHead(200,{'content-type':'text/event-stream'});
   const chunk={id:'fixture',object:'chat.completion.chunk',created:1,model:JSON.parse(body).model,choices:[{index:0,delta:{role:'assistant',content:'synthetic fixture'},finish_reason:null}]};
   const end={...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}]};
   res.end('data: '+JSON.stringify(chunk)+'\n\ndata: '+JSON.stringify(end)+'\n\ndata: [DONE]\n\n');
  });
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
 const original=http.request;const selected=[];
 // Test-only routing shim: preserve/assert the production selected socket; only
 // substitute its filesystem location so this test needs no host /run writes.
 http.request=function(options,...rest){selected.push(options.socketPath);return original.call(this,{...options,socketPath:socket},...rest);};
 try {
  for(const [selectedSocket,method] of [[zaiSocket,'streamSimple'],[zaiSocket,'stream'],['/tmp/ppq.sock','streamSimple'],['/run/portable-inference/near.sock','streamSimple']]){
   const p=await createBrokerProvider(sdk,selectedSocket);const model=p.getModels()[0];
   assert.equal(model.provider,'portable-broker');
   const stream=p[method](model,normalizeContext({messages:[{role:'user',content:'Return synthetic fixture.',timestamp:1}],tools:[{name:'read',description:'Read a fixture file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path']}},{name:'write',description:'Write fixture',parameters:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']}},{name:'edit',description:'Edit fixture',parameters:{type:'object',properties:{path:{type:'string'},oldText:{type:'string'},newText:{type:'string'}},required:['path','oldText','newText']}},{name:'bash',description:'Bash fixture',parameters:{type:'object',properties:{command:{type:'string'}},required:['command']}}]}),{apiKey:'inference-broker-session',reasoning:'max',reasoningEffort:'max',maxTokens:7777,maxRetries:9});
   const result=await stream.result();assert.equal(result.stopReason,'stop',result.errorMessage);
  }
  t.diagnostic('synthetic Zai request keys: '+Object.keys(requests[0].body).sort().join(','));
  assert.deepEqual(selected,[zaiSocket,zaiSocket,'/tmp/ppq.sock','/run/portable-inference/near.sock']);assert.equal(requests.length,4);
  for(const r of requests){assert.equal(r.url,'/v1/chat/completions');assert.equal(r.headers.authorization,'Bearer inference-broker-session');assert.match(r.headers['x-inference-request-id'],/^[A-Za-z0-9_-]{16,64}$/);}
  assert.equal(new Set(requests.map(r=>r.headers['x-inference-request-id'])).size,4);
  for(const r of requests.slice(0,2)){assert.equal(r.body.model,'glm-5.3');assert.equal(r.body.reasoning_effort,'low');assert.equal(r.body.max_tokens,1024);assert.equal(r.body.thinking.type,'enabled');assert.equal(r.body.thinking.clear_thinking,false);}
  assert.equal(requests[2].body.model,'private/gpt-oss-120b');assert.equal(requests[2].body.max_tokens,7777);assert.equal(requests[2].body.reasoning_effort,undefined);assert.equal(requests[2].body.thinking,undefined);
  assert.equal(requests[3].body.model,'z-ai/glm-5.3-flash');assert.equal(requests[3].body.max_tokens,16384);assert.doesNotThrow(()=>encodeRequest(requests[3].body));
 }finally{http.request=original;server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});

test('NEAR is selected only by the fixed trusted socket',()=>{assert.equal(brokerProfile('/run/portable-inference/near.sock').model,'z-ai/glm-5.3-flash');assert.equal(brokerProfile('/run/portable-inference/near.sock').thinkingLevel,'off');assert.equal(brokerProfile('/tmp/near.sock').model,'private/gpt-oss-120b');});
