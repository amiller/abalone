// MIT. Synthetic QVL/compose/noble dependencies; exercises real NEAR routing/check order,
// not cryptographic attestation. No external fetch or inference.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { registerHooks } from 'node:module';
import { keccak256 } from '../lib/keccak.mjs';
const data=s=>'data:text/javascript,'+encodeURIComponent(s);
const hook=registerHooks({resolve(s,c,next){
  if(c.parentURL?.endsWith('/lib/near.mjs')){
    if(s==='./nvidia-gpu.mjs')return {shortCircuit:true,url:data(`export async function verifyGpuEvidence(payload,nonce,http){const p=JSON.parse(payload);if(p.rejectGPU)throw Error('local GPU verification refused');if(p.nonce!==nonce)throw Error('GPU nonce refused');await http('https://rim.attestation.nvidia.com/v1/rim/synthetic');return 'GPU: 8× verified locally (fixture)';}`)};
    if(s==='node:module')return {shortCircuit:true,url:data(`export function createRequire(){ const req=()=>{const http=globalThis.fetch;return {INTEL_PCS_URL:'https://api.trustedservices.intel.com/',getCollateralAndVerify:async(bytes)=>{await http('https://api.trustedservices.intel.com/');const j=JSON.parse(bytes);globalThis.__quotes=(globalThis.__quotes??0)+1;return {status:j.status,advisory_ids:[],report:{asTd10:()=>({reportData:Buffer.from(j.rd,'hex'),...Object.fromEntries(['mrTd','rtMr0','rtMr1','rtMr2'].map(k=>[k,Buffer.from(j.boot?.[k]??'','hex')]))})}}}}};req.cache={};return req}`)};
    if(s==='@noble/curves/secp256k1.js')return {shortCircuit:true,url:data('export const secp256k1={};')};
    if(s.endsWith('/dist/index.js'))return {shortCircuit:true,url:data(`export const verifyComposeMeasurement=async()=>({ok:true,checks:[],composeHash:'a'.repeat(64)});`)};
    if(s.endsWith('/dist/node/transport.js'))return {shortCircuit:true,url:data(`export const createPinnedTransport=()=>{throw Error('default transport forbidden in routing fixture')};`)};
  }return next(s,c)
}});
const {verifyNearModel,checkReport}=await import('../lib/near.mjs');hook.deregister();
const model='selected/model',base='https://cloud-api.near.ai/v1',pin='a'.repeat(64),pub='b'.repeat(128);
const address='0x'+keccak256(Buffer.from(pub,'hex')).subarray(12).toString('hex');
function report(nonce,status='UpToDate'){
 const quote=(first)=>Buffer.from(JSON.stringify({status,rd:first.toString('hex')+nonce})).toString('hex');
 const info={tcb_info:JSON.stringify({event_log:[{event:'app-id',event_payload:'c'.repeat(40)}],app_compose:'{}'}),os_image_hash:'fixture'};
 const gw={signing_algo:'ecdsa',signing_address:address,tls_cert_fingerprint:pin,info,intel_quote:quote(crypto.createHash('sha256').update(Buffer.from(address.slice(2),'hex')).update(Buffer.from(pin,'hex')).digest())};
 const token=[{alg:'ES384'},{iss:'https://nras.attestation.nvidia.com',iat:Date.now()/1000,nbf:Date.now()/1000,exp:Date.now()/1000+60,eat_nonce:nonce,'x-nvidia-overall-att-result':true},'unused'].map((v,i)=>i===2?v:Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
 return {gateway_attestation:gw,model_attestations:[{signing_public_key:pub,signing_address:address,model_name:model,info,intel_quote:quote(Buffer.concat([Buffer.from(address.slice(2),'hex'),Buffer.alloc(12)])),nvidia_payload:JSON.stringify({nonce}),_token:token}]};
}
const policy={composeRegistry:{rpc:'https://mainnet.base.org',chainId:8453}};
function fixture(status='UpToDate'){
 let rep;const seen=[];return {seen,getReport:async(p)=>{const nonce=new URL(p,base).searchParams.get('nonce');seen.push(nonce);rep=report(nonce,status);return Response.json(rep)},http:async(u,init={})=>{
  u=String(u);if(u.includes('jwks'))return new Response(null,{status:503});
  if(u.includes('/attest/gpu'))return Response.json([['fixture',rep.model_attestations[0]._token]]);
  if(u.includes('mainnet.base.org')){const {method}=JSON.parse(init.body);return Response.json({result:method==='eth_chainId'?'0x2105':method==='eth_blockNumber'?'0x10':'0x1'})}
  return Response.json({});
 }};
}
test('real verifier propagates factory exact binding after checks, with fresh nonce per admission',async()=>{
 const f=fixture();let closed=0,bindings=[];const factory=b=>{bindings.push(b);return {close:async()=>closed++,fetch:async()=>new Response('fixture')}};
 for(let i=0;i<2;i++){const r=await verifyNearModel(base,model,f.getReport,policy,f.http,()=>{},factory);await r.transport.close()}
 assert.equal(closed,2);assert.notEqual(f.seen[0],f.seen[1]);assert.deepEqual(bindings,[0,1].map(()=>({hostname:'cloud-api.near.ai',origin:'https://cloud-api.near.ai',spkiPins:[pin]})));
});
test('default strict TCB refuses before custom factory, no fallback on factory failure',async()=>{
 let called=0;const bad=fixture('OutOfDate');await assert.rejects(verifyNearModel(base,model,bad.getReport,policy,bad.http,()=>{},()=>{called++}),/not UpToDate/);assert.equal(called,0);
 const good=fixture();await assert.rejects(verifyNearModel(base,model,good.getReport,policy,good.http,()=>{},()=>{throw Error('custom factory failed')}),/custom factory failed/);
});
test('invalid factory rejected before report fetch or report processing',async()=>{
 await assert.rejects(verifyNearModel(base,model,()=>{throw Error('must not fetch')},{},undefined,undefined,null),/factory is not a function/);
 await assert.rejects(checkReport(null,'',base,model,{},undefined,undefined,null),/factory is not a function/);
});
test('local GPU verification failure refuses before routed transport construction',async()=>{
 const f=fixture();const get=f.getReport;f.getReport=async p=>{const r=await get(p),v=await r.json();v.model_attestations[0].nvidia_payload=JSON.stringify({...JSON.parse(v.model_attestations[0].nvidia_payload),rejectGPU:true});return Response.json(v)};let called=false;
 await assert.rejects(verifyNearModel(base,model,f.getReport,{...policy,gpuSignature:'required'},f.http,()=>{},()=>{called=true}),/local GPU verification refused/);
 assert.equal(called,false);
});
test('custom SPKI refusal keeps existing non-retryable 403 mapping',async()=>{
 const f=fixture();const r=await verifyNearModel(base,model,f.getReport,policy,f.http,()=>{},()=>({close:async()=>{},fetch:async()=>{throw Error('SPKI pin mismatch')}}));
 const response=await r.transport.fetch(base+'/chat/completions',{});assert.equal(response.status,403);await r.transport.close();
});

const {DIRECT_BOOT_IMAGES}=await import('../lib/near.mjs');
const directBase='https://glm-5-3-flash-i0.completions.near.ai/v1';
function directReport(nonce,{status='UpToDate',boot=DIRECT_BOOT_IMAGES[0],tls=pin}={}){
 const r=report(nonce,status).model_attestations[0];
 const first=crypto.createHash('sha256').update(Buffer.from(address.slice(2),'hex')).update(Buffer.from(tls??'','hex')).digest();
 return {...r,signing_algo:'ecdsa',tls_cert_fingerprint:tls,intel_quote:Buffer.from(JSON.stringify({status,rd:first.toString('hex')+nonce,boot})).toString('hex')};
}
function directFixture(options){
 const f=fixture(),stages=[];let rep;
 return {stages,onStage:s=>stages.push(s),getReport:async p=>{const nonce=new URL(p,directBase).searchParams.get('nonce');rep=directReport(nonce,options);return Response.json(rep)},http:async(u,init={})=>u.includes('mainnet.base.org')?f.http(u,init):Response.json({})};
}
test('direct instance: its own quote binds the TLS key that is pinned; one quote, no gateway stages',async()=>{
 const f=directFixture(),bindings=[];globalThis.__quotes=0;
 const r=await verifyNearModel(directBase,model,f.getReport,{...policy,gatewayTcb:'UpToDate',modelTcb:'UpToDate'},f.http,f.onStage,b=>{bindings.push(b);return {close:async()=>{},fetch:async()=>new Response('x')}});
 assert.deepEqual(bindings,[{hostname:'glm-5-3-flash-i0.completions.near.ai',origin:'https://glm-5-3-flash-i0.completions.near.ai',spkiPins:[pin]}]);
 assert.equal(globalThis.__quotes,1);assert.ok(!f.stages.some(s=>s.startsWith('gateway-')&&s!=='gateway-binding'));assert.ok(f.stages.includes('boot-measurement'));
 assert.equal(r.profile.route,'direct');assert.equal(r.profile.instance,'glm-5-3-flash-i0.completions.near.ai');assert.equal(r.profile.boot_image,'dstack-nvidia-0.5.11');
 assert.equal(r.profile.gateway_tcb_status,undefined);assert.deepEqual(r.profile.model_tcb_statuses,['UpToDate']);assert.equal(r.profile.tls_spki,pin);
 await r.transport.close();
});
test('direct instance with unreviewed firmware (MRTD) is refused at boot-measurement, before any transport',async()=>{
 const f=directFixture({boot:{...DIRECT_BOOT_IMAGES[0],mrTd:'00'.repeat(48)}});let called=false;
 await assert.rejects(verifyNearModel(directBase,model,f.getReport,{...policy,gatewayTcb:'UpToDate',modelTcb:'UpToDate'},f.http,f.onStage,()=>{called=true}),/firmware is not a reviewed dstack image \(MRTD 0000000000000000/);
 assert.equal(f.stages.at(-1),'boot-measurement');assert.equal(called,false);
});
test('direct instance with reviewed firmware and an unreviewed kernel is admitted and labelled by RTMR1/RTMR2, without os_image_hash',async()=>{
 const f=directFixture({boot:{...DIRECT_BOOT_IMAGES[0],rtMr1:'11'.repeat(48),rtMr2:'22'.repeat(48)}});const get=f.getReport;
 f.getReport=async p=>{const v=await (await get(p)).json();delete v.info.os_image_hash;return Response.json(v)};
 const r=await verifyNearModel(directBase,model,f.getReport,{...policy,gatewayTcb:'UpToDate',modelTcb:'UpToDate'},f.http,f.onStage,()=>({close:async()=>{},fetch:async()=>new Response('x')}));
 assert.equal(r.profile.boot_image,`unreviewed kernel (RTMR1 ${'11'.repeat(8)}…, RTMR2 ${'22'.repeat(8)}…)`);await r.transport.close();
});
test('direct instance refuses OutOfDate under the default strict policy and a report without a TLS binding',async()=>{
 for(const [options,reason] of [[{status:'OutOfDate'},/model TCB status OutOfDate is not UpToDate/],[{tls:null},/direct instance attestation has no TLS binding/]]){
  const f=directFixture(options);let called=false;
  await assert.rejects(verifyNearModel(directBase,model,f.getReport,policy,f.http,f.onStage,()=>{called=true}),reason);assert.equal(called,false);
 }
});
test('a gateway-shaped report sent to a direct instance URL is refused',async()=>{
 const f=fixture();let called=false;
 await assert.rejects(verifyNearModel(directBase,model,f.getReport,policy,f.http,()=>{},()=>{called=true}),/direct instance attestation has no TLS binding/);assert.equal(called,false);
});
