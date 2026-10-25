// SPDX-License-Identifier: MIT
// One fixed seed-free helper, supervised by the existing leased credit monitor.
import {spawn} from 'node:child_process';
const unavailable=()=>Error('Account refresh unavailable');
export function createAccountRefresh({spawnProcess=spawn,timeoutMs=27000,killDelayMs=6000}={}){
 let active=null,closed=false;
 function refresh(){
  if(closed)return Promise.reject(unavailable());
  if(active)return active.promise;
  let child,timer,killTimer,failed=false,output='',bytes=0;
  const stop=()=>{failed=true;if(child && child.exitCode===null && child.signalCode===null){child.kill('SIGTERM');if(!killTimer)killTimer=setTimeout(()=>child.kill('SIGKILL'),killDelayMs);}};
  const operation={stop,promise:null};active=operation;
  operation.promise=new Promise((resolve,reject)=>{
   try{
    child=spawnProcess('/usr/bin/python3',['-I','-B','/opt/portable/portable/funding/account-refresh.py'],{cwd:'/',stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}});
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>512)stop();else output+=chunk.toString('utf8');});
    child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024)stop();});
    child.once('error',()=>{failed=true;});
    child.once('close',code=>{clearTimeout(timer);clearTimeout(killTimer);active=null;if(!failed && code===0 && output==='ACCOUNT_REFRESHED\n')resolve();else reject(unavailable());});
    timer=setTimeout(stop,timeoutMs);
   }catch{active=null;reject(unavailable());}
  });
  return operation.promise;
 }
 async function close(){closed=true;const job=active;if(job){job.stop();await job.promise.catch(()=>{});}}
 return {refresh,close};
}
