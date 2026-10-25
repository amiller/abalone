// Control-flow tests only: SDK factory is a stub, never attestation evidence.
import realTest from 'node:test';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
import {createSDKAdapterChild,SDK_ROUTE,SDK_ATC} from './sdk-adapter-child-core.mjs';
const cases=[];const test=(name,fn)=>cases.push({name,fn});
const policy={endpoint:SDK_ROUTE,externalModel:'private/gpt-oss-120b',sealedModel:'gpt-oss-120b',validFromMs:0,validUntilMs:10000,evidenceId:'synthetic-only',billing:'input-output-tokens-only',ledgerUnit:'test',maxBillableInputTokens:64,maxRequestedOutputTokens:16,reasoningEfforts:['default'],outputBound:'request-max-includes-all-billed-reasoning',pricePerInputToken:'1',pricePerOutputToken:'1'};
const body={model:'private/gpt-oss-120b',messages:[{role:'user',content:'synthetic'}],max_tokens:16,stream:true};
const doc={securityVerified:true,configRepo:'tinfoilsh/confidential-model-router',releaseDigest:'a'.repeat(64),hpkePublicKey:'fixture-key-NOT-attestation'};
function setup(options={}) {
 let posts=0,gets=0,now=1;const ac=new AbortController();
 class Stub {constructor(opts){assert.equal(opts.userCacheSecret,'synthetic-cache');this.doc=structuredClone(doc);}async ready(){await fetch(SDK_ATC);}
 getVerificationDocument(){return this.doc;}getBaseURL(){return 'https://api.ppq.ai/private/';}getEnclaveURL(){return 'https://fixture.invalid';}
 async fetch(url,init){if(options.mutate)this.doc.hpkePublicKey='changed';const r=await fetch(url,init);if(options.retry)await fetch(url,init);return r;}}
 const adapter=createSDKAdapterChild({chargePolicy:policy,clock:()=>now,loadSDK:async()=>({SecureClient:Stub}),privateCreditReader:async()=>({authorization:'Bearer synthetic-secret',userCacheSecret:'synthetic-cache'}),admissionPolicy:async()=>true,
 rawFetch:async req=>{assert.equal(req.redirect,'error');if(req.url===SDK_ATC){gets++;return new Response('{}');}assert.equal(req.url,SDK_ROUTE);posts++;return new Response('data: synthetic\n\n');},
 permitRawPost:async p=>({allowed:true,...p,reservedBound:p.bound}),...options.override});
 return {adapter,signal:ac.signal,ac,posts:()=>posts,gets:()=>gets,setNow:n=>now=n};
}
async function prepared(t){return t.adapter.prepare({logicalId:'synthetic_request_1',body,signal:t.signal});}
test('stub control: single-use handle and unchanged native body',async()=>{const t=setup();try{const p=await prepared(t);const r=await t.adapter.post({...p,body,signal:t.signal});assert.match(await new Response(r.stream).text(),/synthetic/);assert.equal(t.posts(),1);await assert.rejects(t.adapter.post({...p,body,signal:t.signal}),{code:'invalid-handle'});}finally{await t.adapter.close();}});
test('stub control: denied policy and absent charge policy have zero POST',async()=>{assert.throws(()=>createSDKAdapterChild({}),{code:'policy-refused'});const t=setup({override:{admissionPolicy:async()=>false}});try{await assert.rejects(prepared(t),{code:'admission-refused'});assert.equal(t.posts(),0);}finally{await t.adapter.close();}});
for(const mode of ['forged','body','key']) test('stub control: handle refusal '+mode,async()=>{const t=setup({mutate:mode==='key'});try{const p=await prepared(t);await assert.rejects(t.adapter.post({handle:mode==='forged'?{...p.handle}:p.handle,body:mode==='body'?{...body,max_tokens:15}:body,signal:t.signal}));assert.equal(t.posts(),0);}finally{await t.adapter.close();}});
test('stub control: SDK retry cannot send second raw POST',async()=>{const t=setup({retry:true});try{const p=await prepared(t);await assert.rejects(t.adapter.post({...p,body,signal:t.signal}),{code:'attempt-limit'});assert.equal(t.posts(),1);}finally{await t.adapter.close();}});
test('stub control: tariff expires during async permit, no POST',async()=>{let t;t=setup({override:{permitRawPost:async p=>{await Promise.resolve();t.setNow(10000);return {allowed:true,...p,reservedBound:p.bound};}}});try{const p=await prepared(t);await assert.rejects(t.adapter.post({...p,body,signal:t.signal}),{code:'policy-refused'});assert.equal(t.posts(),0);}finally{await t.adapter.close();}});
test('stub control: abort during async permit, no POST',async()=>{let t;t=setup({override:{permitRawPost:async p=>{t.ac.abort();return {allowed:true,...p,reservedBound:p.bound};}}});try{const p=await prepared(t);await assert.rejects(t.adapter.post({...p,body,signal:t.signal}),{code:'aborted'});assert.equal(t.posts(),0);}finally{await t.adapter.close();}});
test('stub control: credential reader errors projected without secrets',async()=>{const t=setup({override:{privateCreditReader:async()=>{throw Error('REAL_LOOKING_SECRET');}}});try{await assert.rejects(prepared(t),e=>e.message==='sdk-failed'&&!String(e.stack).includes('REAL_LOOKING_SECRET'));assert.equal(t.gets(),0);assert.equal(t.posts(),0);}finally{await t.adapter.close();}});
test('stub control: final fetch exact route guard',async()=>{const t=setup();try{for(const url of [SDK_ATC+'?x=1',SDK_ATC+'#fragment',SDK_ROUTE+'/','https://example.invalid'])await assert.rejects(globalThis.fetch(url),{code:'route-refused'});assert.equal(t.gets(),0);assert.equal(t.posts(),0);}finally{await t.adapter.close();}});
test('stub control: response bound',async()=>{const t=setup({override:{maxResponseBytes:2}});try{const p=await prepared(t);await assert.rejects(async()=>await new Response((await t.adapter.post({...p,body,signal:t.signal})).stream).text(),{code:'response-limit'});}finally{await t.adapter.close();}});
test('stub control: IPC permit deadline',async()=>{const t=setup({override:{permitTimeoutMs:15,permitRawPost:()=>new Promise(()=>{})}});try{const p=await prepared(t);await assert.rejects(t.adapter.post({...p,body,signal:t.signal}),{code:'permit-refused'});assert.equal(t.posts(),0);}finally{await t.adapter.close();}});
test('stub control: close keeps fetch denied and forbids process reuse',async()=>{const t=setup();await t.adapter.close();await assert.rejects(globalThis.fetch(SDK_ATC),{code:'adapter-closed'});assert.throws(()=>setup(),{code:'adapter-closed'});});

let stalledCancelCalls=0;
function stalledBody(bytes=32) {return new ReadableStream({start(c){c.enqueue(new Uint8Array(bytes));},cancel(){stalledCancelCalls++;return new Promise(()=>{});}});}
async function mustSettle(promise) {let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('operation exceeded cancellation bound')),1500);})]);}finally{clearTimeout(timer);}}
for(const route of ['redirect-atc','redirect-post','non-ok','reader-error','caller-cancel'])test('stalled cancellation: '+route,async()=>{
 const t=setup({override:{maxResponseBytes:8,rawFetch:async req=>{
  if(req.url===SDK_ATC)return route==='redirect-atc'?new Response(stalledBody(),{status:302}):new Response('{}');
  return new Response(stalledBody(),{status:route==='redirect-post'?302:route==='non-ok'?503:200});
 }}});
 try {
  if(route==='redirect-atc')await assert.rejects(mustSettle(prepared(t)),{code:'route-refused'});
  else {const p=await prepared(t);
   if(['redirect-post','non-ok'].includes(route))await assert.rejects(mustSettle(t.adapter.post({...p,body,signal:t.signal})),{code:route==='non-ok'?'sdk-failed':'route-refused'});
   else {const r=await t.adapter.post({...p,body,signal:t.signal});if(route==='caller-cancel')await mustSettle(r.stream.cancel());else await assert.rejects(mustSettle(new Response(r.stream).text()));}
  }
 }finally{await mustSettle(t.adapter.close());assert.ok(stalledCancelCalls>0,'the underlying never-resolving cancellation was actually invoked');await assert.rejects(fetch(SDK_ATC),{code:'adapter-closed'});}
});
test('permit timeout aborts pending permission and cannot authorize a late POST',async()=>{
 let permitSignal,late=false;const t=setup({override:{permitTimeoutMs:15,permitRawPost:(p,signal)=>{permitSignal=signal;return new Promise(resolve=>setTimeout(()=>{late=true;resolve({allowed:true,...p,reservedBound:p.bound});},60));}}});
 try {const p=await prepared(t);await assert.rejects(t.adapter.post({...p,body,signal:t.signal}),{code:'permit-refused'});assert.equal(permitSignal.aborted,true);await new Promise(r=>setTimeout(r,90));assert.equal(late,true);assert.equal(t.posts(),0);await assert.rejects(t.adapter.post({...p,body,signal:t.signal}),{code:'permit-refused'});assert.equal(t.posts(),0);}finally{await t.adapter.close();}
});
if(process.argv[2]!==undefined)await cases[Number(process.argv[2])].fn();
else for(const [index,c] of cases.entries())realTest(c.name,async()=>{await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[new URL(import.meta.url).pathname,String(index)],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error(output)));});});
