// SPDX-License-Identifier: MIT
// Fixed UID972 inherited-lease entry; no argv/env account or endpoint discovery.
import {pathToFileURL} from 'node:url';
import {inheritedLease} from '../funding/inherited-lease.mjs';
import {startBroker} from './direct-zai-broker.mjs';
import {transport} from './zai-curl-transport.mjs';
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 let broker,lease,requested=false,stopping;
 const stop=()=>{
  requested=true;
  if(broker && !stopping)stopping=broker.stop().catch(()=>{process.exitCode=1;});
  return stopping;
 };
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
 try {
  if(process.argv.length!==2)throw Error('arguments');
  lease=await inheritedLease();
  if(requested){await lease.release();}
  else {
   broker=await startBroker({lease,transport});
   if(requested)await stop();
  }
 } catch {
  await lease?.release().catch(()=>{});
  process.stderr.write('Inference unavailable\n');process.exitCode=1;
 }
}
