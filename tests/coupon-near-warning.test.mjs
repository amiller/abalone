// MIT. Synthetic attestation verdict only; actual production ECDH/HKDF/AES-GCM.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { registerHooks } from 'node:module';
const data=s=>'data:text/javascript,'+encodeURIComponent(s);
const real=new URL('../lib/near.mjs',import.meta.url).href;
const fixture=data(`export {encrypt,decrypt,OUT_OF_DATE_TRIAL_POLICY} from ${JSON.stringify(real)}; let result; export const configure=v=>result=v; export const verifyNearModel=async()=>result;`);
const hook=registerHooks({resolve(s,c,next){
 if(s==='./near.mjs'&&c.parentURL?.endsWith('/lib/coupon-near.mjs'))return {url:fixture,shortCircuit:true};
 if(c.parentURL===real){
  if(s==='node:module')return {url:data(`export function createRequire(){const r=()=>({INTEL_PCS_URL:'synthetic-unused'});r.cache={};return r}`),shortCircuit:true};
  if(s==='@noble/curves/secp256k1.js')return {url:data('export const secp256k1={};'),shortCircuit:true};
  if(s.endsWith('/dist/index.js'))return {url:data('export const verifyComposeMeasurement=()=>{throw Error("unused")};'),shortCircuit:true};
  if(s.endsWith('/dist/node/transport.js'))return {url:data('export const createPinnedTransport=()=>{throw Error("unused")};'),shortCircuit:true};
 }return next(s,c)
}});
const {openCouponNearAdapter,OUT_OF_DATE_TRIAL_POLICY,OUT_OF_DATE_TRIAL_NOTICE,couponNearFirmwareAdvisories}=await import('../lib/coupon-near.mjs');
const {configure,encrypt,decrypt}=await import(fixture);hook.deregister();
const base='https://cloud-api.near.ai/v1';
const options=()=>({baseUrl:base,model:'selected/model',maxTokens:128,credential:'warning-test-credential',policy:{gatewayTcb:OUT_OF_DATE_TRIAL_POLICY,modelTcb:OUT_OF_DATE_TRIAL_POLICY,gpuSignature:'required',composeRegistry:{rpc:'https://mainnet.base.org',chainId:8453}}});
function setup(headers={},status='OutOfDate',skip=false,emptyIds=false){
 const key=crypto.createECDH('secp256k1');key.generateKeys();const state={order:[],closed:0};
 configure({signingPublicKey:key.getPublicKey('hex'),profile:{gateway_tcb_status:status,gateway_tcb_advisory_ids:emptyIds?[]:['INTEL-SA-01111'],model_tcb_statuses:['UpToDate'],model_tcb_advisory_ids:[[]],gpu:'GPU: 8× verified locally (HOPPER driver 595.58.03 VBIOS 96.00.CF.00.02)'+(skip?'; certificate revocation NOT checked (ABALONE_GPU_REVOCATION=skip)':''),gpu_revocation:skip?'not checked':'checked'},transport:{close:async()=>{state.closed++},fetch:async(_url,init)=>{
  state.order.push('prompt');const body=JSON.parse(init.body);assert.equal(decrypt(body.messages[0].content,key),'fixture prompt');assert.ok(!init.body.includes('fixture prompt'));
  const encrypted=encrypt('fixture answer',new Headers(init.headers).get('x-client-pub-key'));
  return new Response('data: '+JSON.stringify({choices:[{delta:{content:encrypted},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n',{headers:{'content-type':'text/event-stream',...headers}});
 }}});return state;
}
const request=()=>({method:'POST',headers:{authorization:'Bearer coupon-session'},body:JSON.stringify({model:'selected/model',messages:[{role:'user',content:'fixture prompt'}],stream:true,max_tokens:128})});
test('portable warning acknowledged before actual encrypted prompt; IDs retained only after decryption',async()=>{
 const s=setup({'inference-id':'request-123','x-inference-id':'request-123','x-private-unknown':'not forwarded'});const events=[];
 const a=openCouponNearAdapter({...options(),firmwareWarningMode:'portable-authorized-real',onFirmwareAdvisories:e=>{events.push(e);assert.ok(Object.isFrozen(e.advisoryIds));s.order.push(e.state);return true}});
 try{const r=await a.fetch(base+'/chat/completions',request());assert.match(await r.text(),/fixture answer/);assert.equal(r.headers.get('x-inference-id'),'request-123');assert.equal(r.headers.get('inference-id'),null);assert.equal(r.headers.get('x-private-unknown'),null);assert.deepEqual(s.order,['admitted','prompt']);assert.equal(events[0].firmware,'out-of-date');assert.deepEqual(events[0].advisoryIds,['INTEL-SA-01111']);assert.equal(couponNearFirmwareAdvisories(),null)}finally{await a.close()}
 assert.equal(a.advisoryState.state,'closed');assert.equal(events.at(-1).state,'closed');assert.equal(s.closed,1);
});
test('missing, false, throwing or async warning acknowledgement cannot send a prompt',async()=>{
 assert.throws(()=>openCouponNearAdapter({...options(),firmwareWarningMode:'portable-authorized-real'}));
 for(const cb of [()=>false,()=>{throw Error('display failed')},async()=>true]){
  const s=setup();const a=openCouponNearAdapter({...options(),firmwareWarningMode:'portable-authorized-real',onFirmwareAdvisories:cb});
  await assert.rejects(a.fetch(base+'/chat/completions',request()),{code:'provider_admission_refused'});assert.equal(s.order.length,0);assert.equal(s.closed,1);await a.close();
 }
});
test('closed callback failure cannot prevent transport close; unknown TCB still refused',async()=>{
 const s=setup();const a=openCouponNearAdapter({...options(),firmwareWarningMode:'portable-authorized-real',onFirmwareAdvisories:e=>{if(e.state==='closed')throw Error('display');return true}});await a.admit();await a.close();assert.equal(s.closed,1);
 const bad=setup({},'Revoked');const b=openCouponNearAdapter({...options(),firmwareWarningMode:'portable-authorized-real',onFirmwareAdvisories:()=>true});await assert.rejects(b.admit());assert.equal(bad.closed,1);await b.close();
});
test('invalid or conflicting inference IDs refuse, absent ID remains unknown',async()=>{
 for(const h of [{'inference-id':'one','x-inference-id':'two'},{'inference-id':'bad, duplicated'},{'inference-id':'x'.repeat(129)},{'inference-id':'warning-test-credential'}]){
  setup(h);const a=openCouponNearAdapter({...options(),firmwareWarningMode:'portable-authorized-real',onFirmwareAdvisories:()=>true});try{await assert.rejects(a.fetch(base+'/chat/completions',request()),{code:'provider_response_refused'})}finally{await a.close()}
 }
 setup();const a=openCouponNearAdapter({...options(),firmwareWarningMode:'portable-authorized-real',onFirmwareAdvisories:()=>true});try{const r=await a.fetch(base+'/chat/completions',request());assert.equal(r.headers.get('x-inference-id'),null)}finally{await a.close()}
});
test('legacy default still prints synthetic-input warning and preserves legacy global accessor',async()=>{
 setup();const a=openCouponNearAdapter(options());let text='';const write=process.stderr.write;process.stderr.write=(chunk)=>{text+=chunk;return true};
 try{await a.admit();assert.match(text,/synthetic input only/);assert.match(OUT_OF_DATE_TRIAL_NOTICE,/Synthetic input only/);assert.deepEqual(couponNearFirmwareAdvisories(),['INTEL-SA-01111'])}finally{process.stderr.write=write;await a.close()}
});
test('lease abort clears portable advisories; next instance does not inherit legacy or prior warning',async()=>{
 const controller=new AbortController();const events=[];setup();
 const a=openCouponNearAdapter({...options(),signal:controller.signal,firmwareWarningMode:'portable-authorized-real',onFirmwareAdvisories:e=>{events.push(e);return true}});
 await a.admit();controller.abort();await a.close();assert.equal(events.at(-1).state,'closed');assert.deepEqual(a.advisoryState.advisoryIds,[]);
 setup({},'UpToDate');const seen=[];const b=openCouponNearAdapter({...options(),firmwareWarningMode:'portable-authorized-real',onFirmwareAdvisories:e=>{seen.push(e);return true}});
 try{await b.admit();assert.equal(seen[0].firmware,'up-to-date');assert.deepEqual(seen[0].advisoryIds,[])}finally{await b.close()}
});

test('portable revocation skip is a separate verified warning even with UpToDate firmware',async()=>{
 const s=setup({},'UpToDate',true),events=[];const a=openCouponNearAdapter({...options(),firmwareWarningMode:'portable-authorized-real',onFirmwareAdvisories:e=>{events.push(e);s.order.push(e.state);return true}});
 try{await a.fetch(base+'/chat/completions',request());assert.equal(events[0].firmware,'up-to-date');assert.equal(events[0].gpuRevocation,'not checked');assert.ok(events[0].advisoryIds.includes('NVIDIA-GPU-REVOCATION-NOT-CHECKED'));assert.deepEqual(s.order,['admitted','prompt']);}finally{await a.close();}assert.equal(events.at(-1).gpuRevocation,null);
});

test('OutOfDate without Intel IDs remains warned independently of revocation state',async()=>{
 for(const skip of [false,true]){const s=setup({},'OutOfDate',skip,true),events=[];const a=openCouponNearAdapter({...options(),firmwareWarningMode:'portable-authorized-real',onFirmwareAdvisories:e=>{events.push(e);s.order.push(e.state);return true}});
 try{await a.fetch(base+'/chat/completions',request());assert.equal(events[0].firmware,'out-of-date');assert.equal(events[0].gpuRevocation,skip?'not checked':'checked');assert.deepEqual(events[0].advisoryIds,skip?['NVIDIA-GPU-REVOCATION-NOT-CHECKED']:[]);assert.deepEqual(s.order,['admitted','prompt']);}finally{await a.close();}}
});

test('empty advisory array retains legacy firmware warning text',async()=>{
 const {couponNearFirmwareWarning,couponNearAdmissionAdvisories}=await import('../lib/coupon-near.mjs');
 const result={gpu:'GPU: 8× verified locally (fixture)',gpu_revocation:'checked',gateway_tcb_status:'OutOfDate',gateway_tcb_advisory_ids:[],model_tcb_statuses:['UpToDate'],model_tcb_advisory_ids:[[]]};
 const ids=couponNearAdmissionAdvisories(result,options().policy);assert.deepEqual(ids,[]);assert.match(couponNearFirmwareWarning(ids),/firmware out of date/);
});
