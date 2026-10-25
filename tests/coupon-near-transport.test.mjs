// MIT. Routing fixtures only: synthetic verifier, no attestation or provider qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const synthetic = `
export const OUT_OF_DATE_TRIAL_POLICY='UpToDate-or-OutOfDate-with-warning';
export const encrypt=()=>{throw Error('no inference in routing fixture')}, decrypt=encrypt;
export async function verifyNearModel(base,model,getReport,policy,http,onStage,factory) {
  await getReport('/v1/attestation/report?model='+encodeURIComponent(model));
  for(const url of ['https://api.trustedservices.intel.com/collateral','https://certificates.trustedservices.intel.com/cert','https://rim.attestation.nvidia.com/v1/rim/synthetic',policy.composeRegistry.rpc]) await http(url,{method:'POST',body:'{}'});
  const transport=factory ? factory({hostname:new URL(base).hostname,origin:new URL(base).origin,spkiPins:['a'.repeat(64)]}) : {close:async()=>{},fetch:async()=>{throw Error('unused')}};
  return {transport,profile:{gateway_tcb_status:'UpToDate',gateway_tcb_advisory_ids:[],model_tcb_statuses:['UpToDate'],model_tcb_advisory_ids:[[]],gpu:'GPU: 8× verified locally (HOPPER driver 595.58.03 VBIOS 96.00.CF.00.02)',gpu_revocation:'checked'}};
}`;
const fixture='data:text/javascript,'+encodeURIComponent(synthetic);
const hook=registerHooks({resolve(s,c,next){return s==='./near.mjs'&&c.parentURL?.endsWith('/lib/coupon-near.mjs')?{url:fixture,shortCircuit:true}:next(s,c)}});
const {openCouponNearAdapter}=await import('../lib/coupon-near.mjs');
hook.deregister();
const options=()=>({baseUrl:'https://cloud-api.near.ai/v1',model:'selected/model',maxTokens:128,credential:'routing-fixture',policy:{gatewayTcb:'UpToDate',modelTcb:'UpToDate',gpuSignature:'required',composeRegistry:{rpc:'https://mainnet.base.org',chainId:8453}}});

test('custom routing requires both trusted functions before any requests',()=>{
  for(const extra of [{admissionFetch:()=>{}},{pinnedTransportFactory:()=>{}},{admissionFetch:null,pinnedTransportFactory:()=>{}},{admissionFetch:()=>{},pinnedTransportFactory:{}}]) assert.throws(()=>openCouponNearAdapter({...options(),...extra}),/provider_admission_refused/);
});
test('all admission routes use trusted fetch, only report has auth, exact factory forwarded and closed',async()=>{
  const ambient=globalThis.fetch;globalThis.fetch=()=>{throw Error('ambient forbidden')};
  const calls=[];let bound,closed=0;let adapter;
  try {
    adapter=openCouponNearAdapter({...options(),admissionFetch:async(url,init)=>{calls.push([String(url),init]);return new Response('{}')},pinnedTransportFactory:(binding)=>{bound=binding;return {close:async()=>{closed++},fetch:async()=>{throw Error('unused')}}}});
    await adapter.admit();assert.equal(calls.length,5);
    assert.equal(new Headers(calls[0][1].headers).get('authorization'),'Bearer routing-fixture');
    for(const [,init] of calls.slice(1))assert.equal(new Headers(init.headers).has('authorization'),false);
    for(const [,init] of calls){assert.equal(init.redirect,'manual');assert.ok(init.signal instanceof AbortSignal)}
    assert.deepEqual(bound,{hostname:'cloud-api.near.ai',origin:'https://cloud-api.near.ai',spkiPins:['a'.repeat(64)]});
    await adapter.close();assert.equal(closed,1);
  }finally{await adapter?.close();globalThis.fetch=ambient}
});
test('injected admission and factory failures never fall back to ambient transport',async()=>{
  let ambientCalls=0;const ambient=globalThis.fetch;globalThis.fetch=()=>{ambientCalls++;throw Error('ambient')};
  try{for(const failAt of ['admission','factory']){
    const adapter=openCouponNearAdapter({...options(),admissionFetch:async()=>{if(failAt==='admission')throw Error('private transport failure');return new Response('{}')},pinnedTransportFactory:()=>{throw Error('private factory failure')}});
    await assert.rejects(adapter.admit(),{code:'provider_admission_refused'});await adapter.close();
  }assert.equal(ambientCalls,0)}finally{globalThis.fetch=ambient}
});
test('omitted custom pair preserves existing default fetch route',async()=>{
  const ambient=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('{}')};
  const adapter=openCouponNearAdapter(options());try{await adapter.admit();assert.equal(calls,5)}finally{await adapter.close();globalThis.fetch=ambient}
});
test('close aborts and drains injected admission',async()=>{
  let entered;const started=new Promise(r=>entered=r);let drained=false;
  const adapter=openCouponNearAdapter({...options(),admissionFetch:async(_u,{signal})=>{entered();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));drained=true;throw Error('cancelled')},pinnedTransportFactory:()=>{throw Error('must not construct')}});
  const admission=assert.rejects(adapter.admit(),{code:'provider_closed'});await started;await adapter.close();await admission;assert.equal(drained,true);
});
