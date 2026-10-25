// Actual SecureClient admission core. ONLY for a dedicated adapter process:
// it owns global fetch for its lifetime. No broker integration/default policy.
import { createHash, randomUUID } from 'node:crypto';
import { deriveTrustedChargeBound } from './charge-bound.mjs';
export const SDK_ROUTE = 'https://api.ppq.ai/private/v1/chat/completions';
export const SDK_ATC = 'https://api.ppq.ai/private/attestation';
const BASE = 'https://api.ppq.ai/private/';
const MODEL = 'private/gpt-oss-120b';
const REPO = 'tinfoilsh/confidential-model-router';
const owner = Symbol.for('portable.sdk-adapter.fetch-owner');
const codes = new Set(['adapter-closed','aborted','deadline','policy-refused','admission-refused','invalid-request','invalid-handle','route-refused','attempt-limit','permit-refused','response-limit','sdk-failed','secret-unavailable']);
const refusal = code => Object.assign(new Error(code), {code});
const cleanError = error => refusal(codes.has(error?.code) ? error.code : 'sdk-failed');
function canonical(value, depth=0) {
  if (depth>16) throw refusal('invalid-request');
  if (value===null || typeof value==='string' || typeof value==='boolean') return JSON.stringify(value);
  if (typeof value==='number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '['+value.map(v=>canonical(v,depth+1)).join(',')+']';
  if (value && typeof value==='object' && [Object.prototype,null].includes(Object.getPrototypeOf(value))) return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k],depth+1)).join(',')+'}';
  throw refusal('invalid-request');
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function freeze(value) { if(value && typeof value==='object'){ for(const v of Object.values(value)) freeze(v);Object.freeze(value); }return value; }

// loadSDK, rawFetch, privateCreditReader, admissionPolicy and permitRawPost are
// root-injected capabilities, never HTTP/request fields. permitRawPost is the
// bounded private IPC bridge to the existing broker journal, not another ledger.
export function createSDKAdapterChild({loadSDK, rawFetch, privateCreditReader, admissionPolicy,
  chargePolicy, clock=Date.now, permitRawPost, lifetimeMs=60000, maxResponseBytes=8*1024*1024,
  maxRequestBytes=4*1024*1024, maxAttestationBytes=4*1024*1024, permitTimeoutMs=2000}={}) {
  for(const fn of [loadSDK,rawFetch,privateCreditReader,admissionPolicy,permitRawPost,clock]) if(typeof fn!=='function') throw refusal('policy-refused');
  if(!chargePolicy) throw refusal('policy-refused');
  for(const n of [lifetimeMs,maxResponseBytes,maxRequestBytes,maxAttestationBytes,permitTimeoutMs]) if(!Number.isSafeInteger(n)||n<1||n>128*1024*1024)throw refusal('policy-refused');
  if(globalThis[owner])throw refusal('adapter-closed');
  const policy=freeze(JSON.parse(JSON.stringify(chargePolicy))), controller=new AbortController();
  const instance={};globalThis[owner]=instance;
  let closed=false, context=null, client=null, authorization=null, postAttempts=0, getAttempts=0, prepared=false, used=false;
  const readers=new Set();
  const timer=setTimeout(()=>controller.abort(refusal('deadline')),lifetimeMs);timer.unref?.();
  const abortError=()=>refusal(codes.has(controller.signal.reason?.code)?controller.signal.reason.code:'aborted');
  function check() {if(closed)throw refusal('adapter-closed');if(controller.signal.aborted)throw abortError();}
  function tariff() {try{return deriveTrustedChargeBound({request:context.body,policy,nowMs:clock()});}catch{throw refusal('policy-refused');}}
  async function bounded(promise,timeout=0) {
    check();let listener,t;
    const abort=new Promise((_,reject)=>{listener=()=>reject(abortError());controller.signal.addEventListener('abort',listener,{once:true});});
    const deadline=new Promise((_,reject)=>{if(timeout)t=setTimeout(()=>{reject(refusal('permit-refused'));controller.abort(refusal('permit-refused'));},timeout);});
    try{return await Promise.race([promise,abort,...(timeout?[deadline]:[])]);}finally{clearTimeout(t);controller.signal.removeEventListener('abort',listener);}
  }
  function bindSignal(signal) {if(!signal || typeof signal.addEventListener!=='function')throw refusal('invalid-request');if(signal.aborted)controller.abort();else signal.addEventListener('abort',()=>controller.abort(),{once:true,signal:controller.signal});check();}
  function documentBinding() {
    const doc=client.getVerificationDocument();
    if(!doc || doc.securityVerified!==true || doc.configRepo!==REPO || !/^[a-f0-9]{64}$/.test(doc.releaseDigest) || typeof doc.hpkePublicKey!=='string' || !doc.hpkePublicKey.length)throw refusal('admission-refused');
    if(client.getBaseURL()!==BASE || typeof client.getEnclaveURL()!=='string' || !client.getEnclaveURL().startsWith('https://'))throw refusal('admission-refused');
    // Fingerprint is explicitly our digest of the exposed verified HPKE key,
    // not an SDK-provided release ID or an invented X25519 key structure.
    return freeze({document:JSON.parse(canonical(doc)),documentDigest:hash(doc),releaseDigest:doc.releaseDigest,
      configRepo:doc.configRepo,hpkeKeyDigest:createHash('sha256').update(doc.hpkePublicKey).digest('hex'),
      baseURL:client.getBaseURL(),enclaveURL:client.getEnclaveURL(),transport:'ehbp'});
  }
  function assertBinding() {if(!context?.binding || hash(documentBinding())!==hash(context.binding))throw refusal('admission-refused');}
  async function cancelBounded(reader) {
    let cancelTimer;
    try { await Promise.race([Promise.resolve().then(()=>reader?.cancel()).catch(()=>{}),new Promise(resolve=>{cancelTimer=setTimeout(resolve,100);})]); }
    finally { clearTimeout(cancelTimer); }
  }
  function limited(stream,limit) {
    if(!stream)throw refusal('sdk-failed');const reader=stream.getReader();readers.add(reader);let bytes=0,ended=false;
    async function cancel(){if(!ended){ended=true;readers.delete(reader);await cancelBounded(reader);}}
    return new ReadableStream({async pull(out){try{const item=await bounded(reader.read());if(item.done){ended=true;readers.delete(reader);out.close();return;}bytes+=item.value.byteLength;if(bytes>limit)throw refusal('response-limit');out.enqueue(item.value);}catch(error){controller.abort(cleanError(error));await cancel();out.error(cleanError(error));}},async cancel(){controller.abort();await cancel();}});
  }
  async function guardedFetch(input,init) {
    try {
      check();const req=new Request(input,init);
      if(req.signal.aborted)throw refusal('aborted');
      if(req.method==='GET' && req.url===SDK_ATC) {
        if(postAttempts || ++getAttempts>2)throw refusal('attempt-limit');
        const response=await bounded(rawFetch(new Request(req,{redirect:'error',signal:controller.signal})));
        if(response.status>=300&&response.status<400){controller.abort(refusal('route-refused'));await cancelBounded(response.body);throw refusal('route-refused');}
        return new Response(limited(response.body,maxAttestationBytes),{status:response.status,headers:response.headers});
      }
      if(req.method!=='POST'||req.url!==SDK_ROUTE)throw refusal('route-refused');
      if(!used || ++postAttempts!==1)throw refusal('attempt-limit');
      assertBinding();const bound=tariff();
      const permit=await bounded(Promise.resolve().then(()=>permitRawPost(freeze({logicalId:context.logicalId,requestDigest:context.requestDigest,
        bound:bound.bound,policyEvidenceId:bound.evidenceId,admissionDigest:context.binding.documentDigest}),controller.signal)),permitTimeoutMs);
      if(permit?.allowed!==true || permit.logicalId!==context.logicalId || permit.requestDigest!==context.requestDigest || permit.reservedBound!==bound.bound)throw refusal('permit-refused');
      // Last synchronous checks: SDK sealing + private IPC may cross expiry or
      // cancellation. No await between these checks and the native fetch call.
      assertBinding();check();if(tariff().bound!==bound.bound)throw refusal('policy-refused');
      const response=await bounded(rawFetch(new Request(req,{redirect:'error',signal:controller.signal})));
      if(response.status>=300&&response.status<400){controller.abort(refusal('route-refused'));await cancelBounded(response.body);throw refusal('route-refused');}
      return new Response(limited(response.body,maxResponseBytes),{status:response.status,headers:response.headers});
    }catch(error){throw cleanError(error);}
  }
  globalThis.fetch=guardedFetch;
  async function prepare({logicalId,body,signal}={}) {
    try{
      check();if(prepared)throw refusal('invalid-handle');prepared=true;bindSignal(signal);
      if(typeof logicalId!=='string'||!/^[A-Za-z0-9_-]{16,64}$/.test(logicalId)||body?.model!==MODEL)throw refusal('invalid-request');
      const text=canonical(body);if(Buffer.byteLength(text)>maxRequestBytes)throw refusal('invalid-request');
      const immutable=freeze(JSON.parse(text));context={logicalId,body:immutable,requestDigest:hash(immutable)};tariff();
      const secret=await bounded(Promise.resolve().then(privateCreditReader));
      if(typeof secret?.authorization!=='string'||!secret.authorization.trim()||secret.authorization.length>4096||/[\r\n]/.test(secret.authorization)||typeof secret?.userCacheSecret!=='string'||!secret.userCacheSecret.trim()||secret.userCacheSecret.length>4096)throw refusal('secret-unavailable');
      authorization=secret.authorization;
      const {SecureClient}=await bounded(Promise.resolve().then(loadSDK));
      client=new SecureClient({baseURL:BASE,attestationBundleURL:'https://api.ppq.ai/private',transport:'ehbp',userCacheSecret:secret.userCacheSecret});
      await bounded(client.ready());check();context.binding=documentBinding();
      const accepted=await bounded(Promise.resolve().then(()=>admissionPolicy(context.binding)));
      if(accepted!==true)throw refusal('admission-refused');assertBinding();tariff();
      const handle=Object.freeze({token:randomUUID()});context.handle=handle;
      return Object.freeze({handle,requestDigest:context.requestDigest,binding:context.binding});
    }catch(error){throw cleanError(error);}
  }
  async function post({handle,body,signal}={}) {
    try{
      check();bindSignal(signal);if(!context?.handle||handle!==context.handle||used||hash(body)!==context.requestDigest)throw refusal('invalid-handle');used=true;
      assertBinding();tariff();
      // Broker owns validation/normalization; this core does only fixed model
      // translation, preserving every other admitted native request field.
      const payload={...context.body,model:'gpt-oss-120b'};
      const response=await bounded(client.fetch(SDK_ROUTE,{method:'POST',redirect:'error',signal:controller.signal,
        headers:{'Content-Type':'application/json',Authorization:authorization,'X-Private-Model':MODEL,'x-query-source':'api'},body:JSON.stringify(payload)}));
      if(!response.ok){controller.abort(refusal('sdk-failed'));await cancelBounded(response.body);throw refusal('sdk-failed');}
      return {stream:limited(response.body,maxResponseBytes)};
    }catch(error){throw cleanError(error);}
  }
  async function close(){if(closed)return;closed=true;controller.abort();clearTimeout(timer);let cleanupTimer;try{await Promise.race([Promise.allSettled([...readers].map(cancelBounded)),new Promise(resolve=>{cleanupTimer=setTimeout(resolve,1000);})]);}finally{clearTimeout(cleanupTimer);}readers.clear();authorization=null;client=null;context=null;if(globalThis[owner]===instance)globalThis.fetch=async()=>{throw refusal('adapter-closed');};}
  return Object.freeze({prepare,post,close});
}
