// SPDX-License-Identifier: MIT
// Trusted adapter composition only: verification/encryption remain adapter-owned.
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {encodeRequest,decodeResponse} from './near-tool-codec.mjs';
import {NEAR_DIRECT_HOST} from './near-direct.mjs';
// Decrypted SSE as bounded by the adapter (maxBytes) and the Tor transport; request = the broker's body bound.
const LIMIT=8*1024*1024,REQUEST_LIMIT=4*1024*1024;
const OUTPUT_LIMIT_NOTICE='[Output limit reached; this answer is incomplete.]';
const WITHHELD_LIMIT_NOTICE='[Output limit reached. The unfinished response was withheld because it may contain tool-request markup. No tool calls were released.]';
// A length stop never enters the tool decoder. Even a complete tool block is
// unfinished provider output; suppress the whole response if it may carry markup.
function partialResponse(content,reasoning) {
 const markup=value=>/[<>]|&(?:lt|gt);/i.test(value);
 if(markup(content)||markup(reasoning))return {text:WITHHELD_LIMIT_NOTICE,calls:[],reasoning:''};
 return {text:(content?content+'\n\n':'')+OUTPUT_LIMIT_NOTICE,calls:[],reasoning};
}
const diagnosticRecords=new WeakSet();
export const nearToolBridgeDiagnostic=error=>diagnosticRecords.has(error?.bridgeDiagnostic)?error.bridgeDiagnostic:null;
const CAUSES=new Set(['provider_admission_expired','provider_admission_refused','provider_closed','request_refused','credit_exhausted','access_revoked_or_expired','transport_refused','upstream_idle','upstream_deadline','provider_response_refused','provider_unavailable','NEAR_TOR_TRANSPORT','ABORT_ERR','ETIMEDOUT','ECONNRESET','EPIPE']);
const ATTEMPTS=3,FINAL=new Set(['credit_exhausted','request_refused','provider_closed','provider_admission_expired']);
// The keeper discards stderr; retried failures go to the journal like the broker's final ones.
const journal=value=>spawn('/usr/bin/logger',['-t','dsmack-inference','--',JSON.stringify(value)],{stdio:'ignore'});
const refused=()=>Object.assign(new Error('NEAR tool bridge refused'),{code:'near_tool_bridge_refused'});
const need=v=>{if(!v)throw refused();};
function usageOkay(v,depth=0) {
 need(v && typeof v==='object' && !Array.isArray(v) && depth<3 && Object.keys(v).length<=16);
 for(const [key,value] of Object.entries(v)) {
  need(/^[a-z_]{1,48}$/.test(key));
  if(typeof value==='number')need(Number.isSafeInteger(value)&&value>=0);
  else if(value===null)need(key.endsWith('_details'));
  else usageOkay(value,depth+1);
 }
 return v;
}
function monotonicUsage(previous,next) {
 for(const [key,value] of Object.entries(previous??{})) {
  if(typeof value==='number')need(typeof next[key]==='number' && next[key]>=value);
  else if(value!==null){need(next[key] && typeof next[key]==='object');monotonicUsage(value,next[key]);}
 }
 return next;
}
function parseSse(raw,model,trace) {
 trace.reason='framing';
 const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);need(text.endsWith('\n'));
 let id=null,created=null,lastCreated=null,done=false,finished=false,content='',reasoning='',usage=null;
 for(const line of text.replaceAll('\r\n','\n').split('\n')) {
  if(!line||line.startsWith(':'))continue;
  trace.reason='framing';need(!done && line.startsWith('data: '));
  if(line==='data: [DONE]'){trace.reason='done';need(finished);done=true;continue;}
  trace.reason='json';const v=JSON.parse(line.slice(6));trace.reason='chunk-shape';need(v && !v.error && v.object==='chat.completion.chunk');
  trace.reason='chunk-model';need(v.model===model);
  trace.reason='chunk-identity';need(typeof v.id==='string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v.id) && Number.isSafeInteger(v.created) && v.created>=0);
  if(id===null){id=v.id;created=v.created;}need(v.id===id && (lastCreated===null || v.created>=lastCreated));lastCreated=v.created;
  trace.reason='choices';need(Array.isArray(v.choices) && v.choices.length<=1);
  if(v.usage!==undefined && v.usage!==null){trace.reason='usage';usage=monotonicUsage(usage,usageOkay(v.usage));}
  trace.reason='choices';if(!v.choices.length){need(finished && usage!==null);continue;}
  trace.reason='delta';const c=v.choices[0];need(!finished && c.index===0 && c.delta && typeof c.delta==='object' && !Array.isArray(c.delta));
  need(Object.keys(c).every(k=>['index','delta','finish_reason','logprobs','matched_stop'].includes(k)) && (c.logprobs===undefined||c.logprobs===null) && (c.matched_stop===undefined||c.matched_stop===null||(c.finish_reason==='stop'&&Number.isSafeInteger(c.matched_stop)&&c.matched_stop>=0)));
  need(Object.keys(c.delta).every(k=>['role','content','reasoning_content','reasoning'].includes(k)));
  if(c.delta.role!==undefined)need(c.delta.role==='assistant');
  for(const key of ['content','reasoning_content','reasoning'])if(c.delta[key]!==undefined && c.delta[key]!==null){need(typeof c.delta[key]==='string');if(key==='content')content+=c.delta[key];else reasoning+=c.delta[key];}
  trace.reason='content-bound';need(Buffer.byteLength(content)<=262144 && Buffer.byteLength(reasoning)<=262144);
  if(c.finish_reason!==undefined && c.finish_reason!==null){trace.reason='finish-reason';trace.finishReason=['stop','length','content_filter','tool_calls','function_call'].includes(c.finish_reason)?c.finish_reason:'other';need(c.finish_reason==='stop'||c.finish_reason==='length');finished=true;}
 }
 trace.reason='done';need(done&&finished&&id!==null);return {id,created,content,reasoning,usage,finishReason:trace.finishReason};
}
async function bounded(response,signal) {
 need(response.body);const reader=response.body.getReader(),chunks=[];let size=0;
 const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 try {
  while(true){need(!signal.aborted);const r=await reader.read();need(!signal.aborted);if(r.done)break;size+=r.value.byteLength;need(size<=LIMIT);chunks.push(r.value);}
  return Buffer.concat(chunks);
 } finally {signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
/** Adapter must be the trusted admitted content adapter, never a job-supplied object.
 * A provider/transport/admission failure at adapter-fetch is retried (ATTEMPTS in all) unless out of credit,
 * refused locally, expired or aborted; a refused response is never retried. No tool output is released before complete stop.
 * The caller owns adapter admission/expiry/close and the credential lifecycle.
 */
export function createNearToolBridge(adapter) {
 const base=URL.canParse(adapter?.profile?.baseUrl)?new URL(adapter.profile.baseUrl):null;
 need(base && base.href===`https://${base.hostname}/v1` && (base.hostname==='cloud-api.near.ai' || NEAR_DIRECT_HOST.test(base.hostname)) && typeof adapter.profile.model==='string' && typeof adapter.fetch==='function');
 const endpoint=adapter.profile.baseUrl+'/chat/completions',model=adapter.profile.model,seen=new Set();
 return async function fetch(input,init={}) {
  for(let attempt=1;;attempt++){
   try{return await fetchOnce(input,init,attempt);}
   catch(error){
    const d=nearToolBridgeDiagnostic(error);
    if(attempt>=ATTEMPTS || d?.stage!=='adapter-fetch' || FINAL.has(d.causeCode) || d.deadlineAborted || d.callerAborted || init.signal?.aborted)throw error;
    journal({version:1,stage:'retrying',attempt,bridge:d});
    await delay(1500*attempt,undefined,init.signal?{signal:init.signal}:undefined);
   }
  }
 };
 async function fetchOnce(input,init,attempt) {
  let response,deadline,signal,stage='encode';const started=performance.now(),sseTrace={reason:null,finishReason:null};
  try {
   need(String(input)===endpoint && init.method==='POST' && typeof init.body==='string' && Buffer.byteLength(init.body)<=REQUEST_LIMIT);
   const headers=new Headers(init.headers);need(headers.get('authorization')==='Bearer coupon-session');
   const requestId=headers.get('x-inference-request-id')??randomUUID();need(/^[A-Za-z0-9_-]{16,128}$/.test(requestId));
   const body=encodeRequest(JSON.parse(init.body));need(body.model===model);
   // Backstop only: the Tor transport cuts an idle upstream (60 s) or a 2400 s turn first, as upstream_idle/upstream_deadline.
   deadline=AbortSignal.timeout(2420000);signal=AbortSignal.any([deadline,...(init.signal?[init.signal]:[])]);need(!signal.aborted);
   // Fixed dummy auth only; neither arbitrary headers nor ambient keys cross.
   stage='adapter-fetch';response=await adapter.fetch(endpoint,{method:'POST',headers:{authorization:'Bearer coupon-session','content-type':'application/json','x-inference-request-id':requestId},body:JSON.stringify(body),signal});
   stage='headers';need(!signal.aborted && response.ok && /^text\/event-stream(?:;|$)/i.test(response.headers.get('content-type')??''));
   stage='body';const raw=await bounded(response,signal);
   stage='sse-parse';const result=parseSse(raw,model,sseTrace);sseTrace.reason='replay-or-abort';need(!signal.aborted && !seen.has(result.id) && seen.size<256);
   stage='decode';const limited=result.finishReason==='length';
   const decoded=limited?partialResponse(result.content,result.reasoning):{...decodeResponse(result.content,{finishReason:'stop'}),reasoning:result.reasoning};seen.add(result.id);
   stage='build';const namespace='near_'+randomUUID().replaceAll('-','');
   const calls=decoded.calls.map((c,index)=>({index,id:namespace+'_'+index,type:'function',function:{name:c.name,arguments:JSON.stringify(c.arguments)}}));
   const base={id:result.id,object:'chat.completion.chunk',created:result.created,model};
   const frame=(delta,finish_reason=null)=>'data: '+JSON.stringify({...base,choices:[{index:0,delta,finish_reason}]})+'\n\n';
   let output=frame({role:'assistant',...(decoded.text?{content:decoded.text}:{}),...(decoded.reasoning?{reasoning_content:decoded.reasoning}:{}),...(calls.length?{tool_calls:calls}:{})});
   output+=frame({},limited?'length':calls.length?'tool_calls':'stop');
   if(result.usage)output+='data: '+JSON.stringify({...base,choices:[],usage:result.usage})+'\n\n';
   output+='data: [DONE]\n\n';
   const inferenceId=response.headers.get('x-inference-id');if(inferenceId!==null)need(/^[A-Za-z0-9_.:-]{1,128}$/.test(inferenceId));
   return new Response(output,{headers:{'content-type':'text/event-stream','x-inference-request-id':requestId,...(inferenceId?{'x-inference-id':inferenceId}:{})}});
  } catch(error) {
   const d=Object.freeze({stage,attempt,httpStatus:Number.isInteger(error?.upstreamStatus)?error.upstreamStatus:null,upstreamBody:typeof error?.upstreamBody==='string'?error.upstreamBody:null,upstreamError:typeof error?.upstreamError==='string'?error.upstreamError:null,...(stage==='sse-parse'?{sseReason:sseTrace.reason,finishReason:sseTrace.finishReason}:{}),causeCode:CAUSES.has(error?.code)?error.code:null,
    errorName:['Error','TypeError','RangeError','SyntaxError','AbortError','TimeoutError'].includes(error?.name)?error.name:null,
    elapsedMs:Math.max(0,Math.floor(performance.now()-started)),deadlineAborted:deadline?.aborted===true,callerAborted:init.signal?.aborted===true});
   diagnosticRecords.add(d);
   await response?.body?.cancel().catch(()=>{});
   const out=refused();if(['provider_admission_expired','provider_admission_refused','provider_closed','request_refused'].includes(error?.code))out.code=error.code;
   out.bridgeDiagnostic=d;throw out;
  }
 }
}
