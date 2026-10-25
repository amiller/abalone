// SPDX-License-Identifier: MIT
// Composition tests substitute dependencies only in a test-owned module copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
let serial=0;
async function load(t, hooks, times){
 const name='__nearSession'+serial++;globalThis[name]=hooks;t.after(()=>delete globalThis[name]);
 let source=await fs.readFile(new URL('./near-session.mjs',import.meta.url),'utf8');
 source=source.replace(/^import .*;$/gm,'');
 if(times){const fixed=/const LIFETIME=300000,MARGIN=60000,SLACK=5000;/;assert.match(source,fixed);source=source.replace(fixed,`const LIFETIME=${times.lifetime},MARGIN=${times.margin},SLACK=${times.slack};`);}
 return import('data:text/javascript;base64,'+Buffer.from(`const {openCouponNearAdapter,createNearAdmissionTransport,createNearPinnedTransport,createNearToolBridge}=globalThis[${JSON.stringify(name)}];\n`+source).toString('base64'));
}
const DOMAIN='glm-5-3-flash.completions.near.ai';
const settle=(ms=5)=>new Promise(r=>setTimeout(r,ms));
const readKey=async()=>'synthetic';
const session=(m,options={})=>m.createNearSession({signal:new AbortController().signal,readKey,onFirmwareAdvisories:()=>true,onRefused:()=>{},...options});
const send=(tr,signal=new AbortController().signal)=>tr({}, {signal,getApiKey:async()=>'synthetic'});
function fixture(count={domain:DOMAIN,requested_domain:DOMAIN,healthy:1,total:1}){const events=[],opened=[];return {events,opened,hooks:{createNearPinnedTransport(){},createNearAdmissionTransport:()=>({fetch:async url=>{events.push('discover');assert.equal(url,'https://completions.near.ai/backends/count?domain='+DOMAIN);return Response.json(count)},close:async()=>events.push('admission-close')}),openCouponNearAdapter:options=>{assert.equal(options.model,'z-ai/glm-5.3-flash');assert.equal(options.firmwareWarningMode,'portable-authorized-real');
 assert.deepEqual(options.policy,{gatewayTcb:'UpToDate',modelTcb:'UpToDate',gpuSignature:'required',composeRegistry:{rpc:'https://base-rpc.publicnode.com',chainId:8453}});assert.equal(options.maxTokens,16384);assert.equal(options.timeoutMs,2410000);assert.equal(options.maxBytes,8*1024*1024);
 opened.push(options.baseUrl);return {profile:{baseUrl:options.baseUrl},admit:async()=>{assert.equal(options.signal.aborted,false);assert.equal(options.onFirmwareAdvisories({state:'admitted'}),true);events.push('admit')},close:async()=>events.push('adapter-close')}},createNearToolBridge:()=>async()=>{events.push('prompt');return new Response('buffered')}}}}
// Adapters numbered in admission order; bridge(n) answers through adapter n. gate(n) holds admission n open.
function numbered(f){
 const original=f.hooks.openCouponNearAdapter,gates={};let n=0;
 f.hooks.openCouponNearAdapter=o=>{const id=++n,a=original(o);return {...a,id,admit:async()=>{f.events.push('admitting-'+id);await gates[id];await a.admit();f.events.push('admitted-'+id)},close:async()=>f.events.push('close-'+id)}};
 f.hooks.createNearToolBridge=adapter=>async()=>{f.events.push('prompt-'+adapter.id);await f.reply;return new Response('ok')};
 return {gate(id){let open;gates[id]=new Promise(r=>open=r);return open},count:()=>n};
}

test('admission starts at unlock: the first request waits on no admission',async t=>{
 const f=fixture(),m=await load(t,f.hooks),tr=session(m);
 await settle();assert.deepEqual(f.events,['discover','admit']);
 await send(tr);assert.deepEqual(f.events,['discover','admit','prompt']);
 await tr.close();assert.deepEqual(f.events,['discover','admit','prompt','adapter-close','admission-close']);
});
test('a request whose credential differs from the admitted one is refused before any prompt',async t=>{
 const f=fixture(),m=await load(t,f.hooks),tr=session(m);
 await assert.rejects(tr({}, {signal:new AbortController().signal,getApiKey:async()=>'other'}),/Inference unavailable/);
 assert.ok(!f.events.includes('prompt'));await tr.close();
});
test('renewal starts MARGIN before expiry; the replaced adapter closes at once when idle',async t=>{
 const f=fixture(),n=numbered(f),m=await load(t,f.hooks,{lifetime:400,margin:200,slack:20}),tr=session(m);
 await settle();await send(tr);
 await settle(150);assert.equal(n.count(),1);
 await settle(100);assert.equal(n.count(),2);assert.deepEqual(f.events.slice(-4),['admitting-2','admit','admitted-2','close-1']);
 await send(tr);assert.equal(f.events.at(-1),'prompt-2');await tr.close();
});
test('renewal during a running request: the request finishes on the old adapter, which closes only after it drains',async t=>{
 const f=fixture(),n=numbered(f),m=await load(t,f.hooks,{lifetime:400,margin:250,slack:20}),tr=session(m);
 await settle();let reply;f.reply=new Promise(r=>reply=r);
 const running=send(tr);await settle(200);
 assert.equal(n.count(),2);assert.ok(f.events.includes('admitted-2'));assert.ok(!f.events.includes('close-1'));
 reply();await running;await settle();assert.equal(f.events.at(-1),'close-1');
 f.reply=undefined;await send(tr);assert.deepEqual(f.events.filter(e=>e.startsWith('prompt')),['prompt-1','prompt-2']);await tr.close();
});
test('a request during renewal uses the still-valid adapter instead of waiting',async t=>{
 const f=fixture(),n=numbered(f),m=await load(t,f.hooks,{lifetime:400,margin:300,slack:20}),tr=session(m);
 await settle();const open=n.gate(2);await settle(150);
 assert.equal(f.events.at(-1),'admitting-2');
 await send(tr);assert.equal(f.events.at(-1),'prompt-1');
 open();await settle();assert.deepEqual(f.events.slice(-2),['admitted-2','close-1']);await tr.close();
});
test('a request after the adapter lapsed waits for the renewal in flight; no second admission',async t=>{
 const f=fixture(),n=numbered(f),m=await load(t,f.hooks,{lifetime:400,margin:300,slack:20}),tr=session(m);
 await settle();const open=n.gate(2);await settle(400);
 const request=send(tr);await settle();assert.ok(!f.events.includes('prompt-1'));
 open();await request;assert.equal(n.count(),2);assert.deepEqual(f.events.filter(e=>e.startsWith('prompt')),['prompt-2']);await tr.close();
});
test('idle: renewal stops once nothing has used the session for a lifetime; the next request admits',async t=>{
 const f=fixture(),n=numbered(f),m=await load(t,f.hooks,{lifetime:300,margin:100,slack:20}),tr=session(m);
 await settle(900);assert.equal(n.count(),2,'unlock counts as use: one renewal, then none');
 await send(tr);assert.equal(n.count(),3);assert.equal(f.events.at(-1),'prompt-3');await tr.close();
});
test('a failed background renewal is reported; the old adapter serves while valid, then a request admits afresh',async t=>{
 const f=fixture(),original=f.hooks.openCouponNearAdapter,refused=[];let n=0;
 f.hooks.openCouponNearAdapter=o=>{const id=++n,a=original(o);return id===2?{...a,admit:async()=>{throw Object.assign(Error('renewal refused'),{code:'provider_admission_refused'})}}:a};
 const m=await load(t,f.hooks,{lifetime:400,margin:300,slack:20}),tr=session(m,{onRefused:(where,e)=>refused.push([where,e.message])});
 await settle(150);assert.deepEqual(refused,[['glm-5-3-flash-i0.completions.near.ai','renewal refused']]);
 await send(tr);assert.equal(n,2,'old adapter used while valid');
 await settle(300);assert.equal(n,2,'no background retry');
 await send(tr);assert.equal(n,3);assert.equal(f.events.filter(e=>e==='prompt').length,2,'no turn replayed');await tr.close();
});
test('failed admission is not replayed and a new explicit request readmits',async t=>{
 const f=fixture(),original=f.hooks.openCouponNearAdapter;let opened=0;
 const refusal=Object.assign(Error('fixed'),{code:'provider_admission_refused'});
 f.hooks.openCouponNearAdapter=o=>{const k=++opened,a=original(o);return {...a,admit:async()=>{if(k<=2){f.events.push('refused');throw refusal}await a.admit()},close:async()=>{f.events.push('candidate-close')}}};
 const m=await load(t,f.hooks),tr=session(m);
 await settle();await assert.rejects(send(tr),e=>e===refusal);
 assert.equal(opened,2);assert.ok(!f.events.includes('prompt'));
 await send(tr);assert.equal(opened,3);
 assert.deepEqual(f.events,['discover','refused','candidate-close','discover','refused','candidate-close','discover','admit','prompt']);
 await tr.close();
});
test('abort while waiting for admission rejects at once; the admission completes and serves the next request',async t=>{
 const f=fixture(),n=numbered(f),open=n.gate(1),m=await load(t,f.hooks),tr=session(m),a=new AbortController();
 const request=send(tr,a.signal);await settle();a.abort();await assert.rejects(request,/Inference unavailable/);
 open();await settle();await send(tr);assert.equal(n.count(),1);assert.deepEqual(f.events.filter(e=>e.startsWith('prompt')),['prompt-1']);await tr.close();
});
test('close during a background admission aborts it and closes everything',async t=>{
 const f=fixture(),original=f.hooks.openCouponNearAdapter;let admitSignal;
 f.hooks.openCouponNearAdapter=o=>({...original(o),admit:()=>new Promise((_,reject)=>{admitSignal=o.signal;o.signal.addEventListener('abort',()=>reject(Error('aborted')))})});
 const m=await load(t,f.hooks),refused=[],tr=session(m,{onRefused:w=>refused.push(w)});
 await settle();await tr.close();assert.equal(admitSignal.aborted,true);assert.deepEqual(f.events,['discover','adapter-close','admission-close']);
 await assert.rejects(send(tr));
});
test('abort during owned credential callback drains without prompt',async t=>{const f=fixture(),m=await load(t,f.hooks),a=new AbortController();let resolve;const wait=new Promise(r=>resolve=r);const transport=m.createNearSession({signal:a.signal,readKey,onFirmwareAdvisories:()=>true,onRefused:()=>{}});await settle();const request=transport({}, {signal:a.signal,getApiKey:()=>wait});const rejected=assert.rejects(request);a.abort();let closed=false;const close=transport.close().then(()=>closed=true);await settle();assert.equal(closed,false);resolve('late-synthetic');await rejected;await close;assert.deepEqual(f.events,['discover','admit','adapter-close','admission-close']);});

test('successful request cleanup does not revoke the adapter for the next model turn',async t=>{const f=fixture();let adapterSignal;const original=f.hooks.openCouponNearAdapter;f.hooks.openCouponNearAdapter=o=>{adapterSignal=o.signal;return original(o)};const m=await load(t,f.hooks),first=new AbortController();const tr=session(m);await send(tr,first.signal);first.abort();assert.equal(adapterSignal.aborted,false);await send(tr);assert.equal(f.events.filter(x=>x==='prompt').length,2);await tr.close();assert.equal(adapterSignal.aborted,true);});

test('expired adapter is replaced only on a new explicit request; a failed turn is not replayed',async t=>{
 const f=fixture();let count=0,state={state:'admitted'},fail=false;const original=f.hooks.openCouponNearAdapter;
 f.hooks.openCouponNearAdapter=o=>{count++;state={state:'admitted'};const a=original(o);return {...a,get advisoryState(){return state}}};
 f.hooks.createNearToolBridge=()=>async()=>{f.events.push('prompt');if(fail)throw Object.assign(Error('fixed'),{code:'provider_admission_expired'});return new Response('ok')};
 const m=await load(t,f.hooks),tr=session(m);
 await send(tr);state={state:'closed'};await send(tr);assert.equal(count,2);
 fail=true;await assert.rejects(send(tr));assert.equal(count,2,'failed inference is not replayed');fail=false;await send(tr);assert.equal(count,3);await tr.close();
});

test('instances are tried in index order; a refused one is closed and reported, the next admits',async t=>{
 const f=fixture({domain:DOMAIN,requested_domain:DOMAIN,healthy:3,total:3}),original=f.hooks.openCouponNearAdapter,refused=[];
 f.hooks.openCouponNearAdapter=o=>{const a=original(o);return o.baseUrl.includes('-i0.')?{...a,admit:async()=>{throw Object.assign(Error('coupon provider: provider_admission_refused (boot-measurement; verification_refused)'),{code:'provider_admission_refused'})},close:async()=>f.events.push('i0-close')}:a};
 const m=await load(t,f.hooks),tr=session(m,{onRefused:(where,e)=>refused.push([where,e.message])});
 await send(tr);
 assert.deepEqual(f.opened,['https://glm-5-3-flash-i0.completions.near.ai/v1','https://glm-5-3-flash-i1.completions.near.ai/v1']);
 assert.deepEqual(refused,[['glm-5-3-flash-i0.completions.near.ai','coupon provider: provider_admission_refused (boot-measurement; verification_refused)']]);
 assert.deepEqual(f.events,['discover','i0-close','admit','prompt']);await tr.close();
});
test('no admitted instance: reported at unlock, the request retries and fails with the last refusal, no gateway tried',async t=>{
 const f=fixture({domain:DOMAIN,requested_domain:DOMAIN,healthy:2,total:2}),original=f.hooks.openCouponNearAdapter,refused=[];
 f.hooks.openCouponNearAdapter=o=>({...original(o),admit:async()=>{throw Object.assign(Error('refused '+o.baseUrl),{code:'provider_admission_refused'})},close:async()=>{}});
 const m=await load(t,f.hooks),tr=session(m,{onRefused:w=>refused.push(w)});
 await settle();assert.deepEqual(refused,['glm-5-3-flash-i0.completions.near.ai','glm-5-3-flash-i1.completions.near.ai']);
 await assert.rejects(send(tr),/refused https:\/\/glm-5-3-flash-i1\.completions\.near\.ai\/v1/);
 assert.equal(refused.length,4);assert.ok(!f.events.includes('prompt'));await tr.close();
});
test('discovery that names another domain or no healthy instance opens no adapter',async t=>{
 for(const count of [{domain:'evil.near.ai',requested_domain:DOMAIN,healthy:1,total:1},{domain:DOMAIN,requested_domain:DOMAIN,healthy:0,total:1},{domain:DOMAIN,requested_domain:DOMAIN,healthy:2,total:1},{domain:DOMAIN,requested_domain:DOMAIN,healthy:17,total:20}]){
  const f=fixture(count),refused=[],m=await load(t,f.hooks),tr=session(m,{onRefused:w=>refused.push(w)});
  await settle();assert.deepEqual(refused,[DOMAIN]);
  await assert.rejects(send(tr),e=>e.code==='provider_admission_refused'&&/no healthy instance/.test(e.message));
  assert.deepEqual(f.opened,[]);assert.deepEqual(refused,[DOMAIN,DOMAIN]);await tr.close();
 }
});
test('a discovery transport failure is reported, not only thrown',async t=>{
 const f=fixture(),refused=[];f.hooks.createNearAdmissionTransport=()=>({fetch:async()=>{throw Object.assign(Error('NEAR Tor transport unavailable'),{code:'NEAR_TOR_TRANSPORT'})},close:async()=>{}});
 const m=await load(t,f.hooks),tr=session(m,{onRefused:(w,e)=>refused.push([w,e.code])});
 await settle();assert.deepEqual(refused,[[DOMAIN,'NEAR_TOR_TRANSPORT']]);await tr.close();
});
test('refusal callback and key reader are required',async t=>{const m=await load(t,fixture().hooks);
 assert.throws(()=>m.createNearSession({signal:new AbortController().signal,readKey,onFirmwareAdvisories:()=>true}),/Inference unavailable/);
 assert.throws(()=>m.createNearSession({signal:new AbortController().signal,onFirmwareAdvisories:()=>true,onRefused:()=>{}}),/Inference unavailable/);
});
