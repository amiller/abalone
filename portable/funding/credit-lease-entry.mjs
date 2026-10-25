// Optional installed consumer. No account creation, funding or inference.
import {pathToFileURL} from 'node:url';
import {inheritedLease} from './inherited-lease.mjs';
import {readPPQCredit} from './ppq-record.mjs';
import {ppqBalanceTransport} from './ppq-balance-curl.mjs';
import {createBalanceMonitor} from '../../lib/provider-balance.mjs';
import {startCreditService} from './credit-service.mjs';
export async function startLeasedCredit({lease,transport=ppqBalanceTransport,socketPath='/run/portable-credit/credit.sock',recoverStaleSocket=false}={}) {
  let balance,service;
  try {
    if(!lease || lease.signal.aborted)throw Error('lease');
    await readPPQCredit(lease,lease.signal);
    balance=createBalanceMonitor({getCredential:({signal})=>readPPQCredit(lease,signal),transport,requestTimeoutMs:12000});
    service=await startCreditService({socketPath,recoverStaleSocket,lease,balance,timeoutMs:15000});
  } catch {
    await balance?.close();await lease?.release();throw Error('credit-service-unavailable');
  }
  let closed=false,stopping=null;
  const refresh=()=>{if(!closed)service.refresh().catch(()=>{});};
  const timer=setInterval(refresh,60000);refresh();
  const stop=()=>{
    if(!stopping){closed=true;clearInterval(timer);stopping=service.stop();}
    return stopping;
  };
  lease.signal.addEventListener('abort',()=>{void stop().catch(()=>{});},{once:true});
  if(lease.signal.aborted)await stop();
  return {stop};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    if(process.argv.length!==2)throw Error('arguments');
    const service=await startLeasedCredit({lease:await inheritedLease(),recoverStaleSocket:true});
    let closing=false;
    const stop=()=>{if(closing)return;closing=true;service.stop().then(()=>process.exit(0),()=>process.exit(1));};
    process.on('SIGTERM',stop);process.on('SIGINT',stop);
  } catch {process.exitCode=1;}
}
