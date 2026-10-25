// SPDX-License-Identifier: MIT
// Fixed UID972 entry. Root selected the warned profile; jobs cannot choose policy.
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {inheritedLease} from '../funding/inherited-lease.mjs';
import {startBroker,readNearAccount,readCredential} from './direct-zai-broker.mjs';
import {createNearSession} from './near-session.mjs';
import {createNearAdmissionTransport} from './near-tor-transport.mjs';
import {createBalanceMonitor} from '../../lib/provider-balance.mjs';
import {startCreditService} from '../funding/credit-service.mjs';
import {createAccountRefresh} from './near-account-refresh.mjs';
import {createTeepCapture} from './teep-capture.mjs';

// One inherited lease owner for both services. Delegates may stop themselves,
// but cannot release the vault until every owned operation has drained.
export async function startNearComputer({lease,transport,startInference=startBroker,startCredit=startCreditService,balanceHTTP=createNearAdmissionTransport(),accountRefresh=createAccountRefresh()}={}) {
 let broker,credit,balance,timer,stopping,refreshTask,needsAccountRefresh=false,recoveryFailed=false,starting=true,requested=false;
 const delegate={fd:lease.fd,signal:lease.signal,assertCurrent:s=>lease.assertCurrent(s),release:async()=>{}};
 const stop=()=>{
  requested=true;if(starting)return Promise.resolve();
  if(!stopping)stopping=(async()=>{
   clearInterval(timer);lease.signal.removeEventListener('abort',revoked);
   const results=await Promise.allSettled([()=>broker?.stop(),()=>credit?.stop(),()=>balance?.close(),()=>transport?.close(),()=>balanceHTTP.close(),()=>accountRefresh.close(),()=>refreshTask].map(fn=>Promise.resolve().then(fn)));
   // A failed drain must not be presented as graceful completion. Release is
   // still owned here; all promises have settled before it can run.
   if(results.some(x=>x.status==='rejected'))throw Error('Inference unavailable');await lease.release();
  })();return stopping;
 };
 const revoked=()=>{void stop().catch(()=>{});};lease.signal.addEventListener('abort',revoked,{once:true});
 try{
  if(lease.signal.aborted)throw Error('lease');
  balance=createBalanceMonitor({provider:'near',getCredential:({signal})=>readNearAccount(delegate,signal),transport:async(request,{signal})=>{
   const response=await balanceHTTP.fetch(request.url,{method:'GET',headers:request.headers,signal});
   if(response.status===401)needsAccountRefresh=true;
   return {status:response.status,body:await response.text()};
  },requestTimeoutMs:12000});
  credit=await startCredit({socketPath:'/run/portable-credit/credit.sock',recoverStaleSocket:true,provider:'near',lease:delegate,balance,timeoutMs:15000});
  broker=await startInference({lease:delegate,transport,profileName:'near'});
  const refresh=()=>{
   if(requested)return Promise.resolve();if(refreshTask)return refreshTask;
   refreshTask=(async()=>{
    needsAccountRefresh=false;
    try{await credit.refresh();return;}catch{}
    if(requested || recoveryFailed || !needsAccountRefresh)return;
    try{await accountRefresh.refresh();if(!requested){needsAccountRefresh=false;await credit.refresh();}}
    catch{recoveryFailed=true;} // one ambiguous attempt per unlock; durable generation intent also prevents replay
   })().finally(()=>{refreshTask=null;});return refreshTask;
  };timer=setInterval(refresh,60000);void refresh();
  starting=false;if(requested||lease.signal.aborted)await stop();return {stop};
 }catch{starting=false;await stop();throw Error('Inference unavailable');}
}

// The keeper discards stderr: admission outcomes go to the journal next to the broker's failure lines.
const journal=value=>{spawn('/usr/bin/logger',['-t','dsmack-inference','--',JSON.stringify({version:1,...value})],{stdio:'ignore'}).on('error',()=>{});};
export function presentFirmwareWarning(event) {
 if(event.state==='admitted')journal({stage:'admitted',route:event.route,instance:event.instance,firmware:event.firmware,gpuRevocation:event.gpuRevocation,advisoryIds:event.advisoryIds});
 return true;
}
export const presentRefusal=(where,error)=>journal({stage:'refused',where,causeCode:typeof error?.code==='string'?error.code:null,message:String(error?.message).slice(0,300)});
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 let lease,transport,computer,capture,requested=false,stopping,transferred=false;
 const stop=()=>{requested=true;if(computer&&!stopping)stopping=Promise.all([capture.close(),computer.stop()]).catch(()=>{process.exitCode=1});return stopping};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 try{
  if(process.argv.length!==2)throw Error('arguments');
  process.env.ABALONE_GPU_REVOCATION='skip';
  lease=await inheritedLease();
  if(requested)await lease.release();
  else{const readKey=()=>readCredential(lease,'near');capture=createTeepCapture({readKey,signal:lease.signal});
   transport=createNearSession({signal:lease.signal,readKey,onRefused:presentRefusal,onFirmwareAdvisories:e=>{if(e.state==='admitted')capture.start(e);return presentFirmwareWarning(e)}});transferred=true;computer=await startNearComputer({lease,transport});if(requested)await stop()}
 }catch{if(!transferred){try{await transport?.close();await lease?.release();}catch{}}process.stderr.write('Inference unavailable\n');process.exitCode=1}
}
