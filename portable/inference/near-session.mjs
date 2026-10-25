// SPDX-License-Identifier: MIT
// Fixed trusted portable composition: NEAR direct only, strict UpToDate policy. Only the instance index is discovered
// (NEAR's healthy count for the fixed model domain); each candidate must pass full admission. No gateway or plain fallback.
// The first admission starts at unlock. An admission lasts LIFETIME (attestation freshness); MARGIN before it lapses the
// next one starts in the background, but only while a request is in flight or ended (or the session began) within the
// last LIFETIME. Admission sends no model request. A request uses the newest admission still valid for SLACK more, else
// waits for one; a renewal never moves a running request, and the adapter it replaced closes once that request drains.
import {openCouponNearAdapter} from '../../lib/coupon-near.mjs';
import {createNearAdmissionTransport,createNearPinnedTransport} from './near-tor-transport.mjs';
import {createNearToolBridge} from '../../lib/near-tool-bridge.mjs';
const DOMAIN='glm-5-3-flash.completions.near.ai';
// Admission over Tor measured 15-25 s; MARGIN leaves room for one more than twice the slowest seen.
const LIFETIME=300000,MARGIN=60000,SLACK=5000;
export function createNearSession({signal,readKey,onFirmwareAdvisories,onRefused}={}) {
 if(!signal || signal.aborted || typeof readKey!=='function' || typeof onFirmwareAdvisories!=='function' || typeof onRefused!=='function')throw Error('Inference unavailable');
 const admission=createNearAdmissionTransport(),stop=new AbortController(),live=AbortSignal.any([signal,stop.signal]);
 let current,inUse,admitting,key,timer,lastUse=performance.now(),closed=false,closing;
 const jobs=new Set(),closings=new Set();
 const drop=entry=>{if(!entry || entry===inUse)return;const p=entry.adapter.close();closings.add(p);p.then(()=>closings.delete(p))};
 const usable=entry=>entry && !entry.dead && entry.adapter.advisoryState?.state!=='closed' && performance.now()<entry.until-SLACK;
 const renew=()=>{if(!closed && (jobs.size || performance.now()-lastUse<LIFETIME))admit().catch(()=>{})};
 const run=async()=>{
  let refusal;
  try {
   key??=await readKey();
   if(closed)throw Error('Inference unavailable');
   const r=await admission.fetch('https://completions.near.ai/backends/count?domain='+DOMAIN,{signal:live}),count=await r.json();
   if(r.status!==200 || count.domain!==DOMAIN || count.requested_domain!==DOMAIN || !Number.isSafeInteger(count.healthy) || count.healthy<1 || count.healthy>count.total || count.healthy>16)
    throw Object.assign(Error(`NEAR direct: no healthy instance of ${DOMAIN} (HTTP ${r.status})`),{code:'provider_admission_refused'});
   let adapter;
   for(let i=0;i<count.healthy && !adapter;i++){
    const candidate=openCouponNearAdapter({baseUrl:`https://${DOMAIN.replace('.',`-i${i}.`)}/v1`,model:'z-ai/glm-5.3-flash',maxTokens:16384,credential:key,
     policy:{gatewayTcb:'UpToDate',modelTcb:'UpToDate',gpuSignature:'required',composeRegistry:{rpc:'https://base-rpc.publicnode.com',chainId:8453}},
     timeoutMs:2410000,sessionLifetimeMs:LIFETIME,maxBytes:8*1024*1024,signal:live,admissionFetch:admission.fetch,pinnedTransportFactory:createNearPinnedTransport,
     firmwareWarningMode:'portable-authorized-real',onFirmwareAdvisories});
    try{await candidate.admit();adapter=candidate;}
    catch(error){await candidate.close();onRefused(new URL(candidate.profile.baseUrl).hostname,error);refusal=error;if(live.aborted)throw error;}
   }
   if(!adapter)throw refusal;
   if(closed){await adapter.close();throw Error('Inference unavailable');}
   const previous=current;current={adapter,bridge:createNearToolBridge(adapter),until:performance.now()+LIFETIME};drop(previous);
   clearTimeout(timer);timer=setTimeout(renew,LIFETIME-MARGIN);timer.unref();
   return current;
  } catch(error) {if(error!==refusal && !live.aborted)onRefused(DOMAIN,error);throw error;}
 };
 const admit=()=>admitting??=run().finally(()=>admitting=undefined);
 const abortable=(promise,operation)=>new Promise((resolve,reject)=>{
  const abort=()=>reject(Error('Inference unavailable'));operation.addEventListener('abort',abort,{once:true});
  promise.then(resolve,reject).finally(()=>operation.removeEventListener('abort',abort));
 });
 const transport=async(body,{signal:operation,getApiKey})=>{
  if(closed || signal.aborted || operation.aborted || jobs.size)throw Error('Inference unavailable');
  let entry;
  const task=(async()=>{
   // Credential callback remains owned until settled; no detached reads on abort.
   const supplied=await getApiKey();
   if(closed || signal.aborted || operation.aborted)throw Error('Inference unavailable');
   // A failed admission has sent no model request; this request's own admission is a fresh attempt, never a replay.
   entry=usable(current)?current:await abortable(admit(),operation);
   if(supplied!==key || closed || signal.aborted || operation.aborted)throw Error('Inference unavailable');
   inUse=entry;
   const response=await entry.bridge(entry.adapter.profile.baseUrl+'/chat/completions',{method:'POST',headers:{authorization:'Bearer coupon-session','content-type':'application/json'},body:JSON.stringify(body),signal:operation});
   // Bridge consumes/decrypts the complete upstream response; all curl children
   // are already reaped before the returned buffered stream becomes available.
   return {status:response.status,body:response.body,finished:Promise.resolve()};
  })();jobs.add(task);
  try{return await task}
  catch(error){if(entry && ['provider_admission_expired','provider_closed'].includes(error?.code))entry.dead=true;throw error}
  finally{jobs.delete(task);lastUse=performance.now();inUse=undefined;if(entry!==current)drop(entry)}
 };
 transport.close=()=>{
  if(!closing){closed=true;clearTimeout(timer);stop.abort();closing=(async()=>{await Promise.allSettled([...jobs,admitting]);try{drop(current);await Promise.all(closings)}finally{key=undefined;await admission.close()}})()}
  return closing;
 };
 admit().catch(()=>{});
 return transport;
}
