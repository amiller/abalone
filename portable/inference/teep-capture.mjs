// SPDX-License-Identifier: MIT
// After each NEAR admission, teep (separate AGPL executable) independently re-attests the admitted direct instance through
// Tor and leaves its capture where UID970 (GID974) can replay it offline. Never gates or delays inference. status.json also
// carries our own admission result, which the agent's footer shows.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
export function createTeepCapture({readKey,signal,teep='/opt/portable/vendor/teep/teep',dir='/run/portable-inference/attestation',timeoutMs=240000}) {
 const out=path.join(dir,'latest'),stop=new AbortController();let running=null;
 const status=value=>{const file=path.join(out,'status.json');fs.writeFileSync(file,JSON.stringify(value)+'\n');fs.chmodSync(file,0o640);};
 // teep writes 0600/0700 under the service umask 0077; the setgid parent supplies GID974. RestrictSUIDSGID=yes
 // refuses any chmod naming S_ISGID, and a chmod without it clears the bit, so subdirectories end 0750.
 const share=()=>{for(const name of fs.readdirSync(out,{recursive:true})){const p=path.join(out,name);fs.chmodSync(p,fs.lstatSync(p).isDirectory()?0o750:0o640);}};
 const verify=async admission=>{
  // The key lives only in this short-lived UID972 child's environment; teep reads it from env or a config file.
  const key=await readKey(),log=fs.openSync(path.join(out,'teep.log'),'w'),config=path.join(out,'teep.toml');
  fs.writeFileSync(config,`[providers.neardirect]\nbase_url = "https://${admission.instance}"\ne2ee = true\n`);
  try {
   const child=spawn(teep,['verify','neardirect','--model','z-ai/glm-5.3-flash','--capture',out],{stdio:['ignore',log,log],killSignal:'SIGKILL',signal:AbortSignal.any([signal,stop.signal,AbortSignal.timeout(timeoutMs)]),
    env:{PATH:'/usr/bin:/bin',NEARAI_API_KEY:key,TEEP_CONFIG:config,HTTPS_PROXY:'socks5h://127.0.0.1:9050',HTTP_PROXY:'socks5h://127.0.0.1:9050',NO_PROXY:'127.0.0.1,localhost'}});
   let error=null;child.on('error',e=>error=e.cause?`${e.message}: ${e.cause.message}`:e.message);
   const [exit,killed]=await new Promise(resolve=>child.on('close',(...x)=>resolve(x)));
   return {exit,signal:killed,error};
  } finally {fs.closeSync(log)}
 };
 const run=async event=>{
  const startedAt=new Date().toISOString(),start=performance.now(),admission={route:event.route,instance:event.instance,firmware:event.firmware,gpuRevocation:event.gpuRevocation,advisoryIds:event.advisoryIds};
  // mkdir inherits S_ISGID from the setgid parent; only the umask decides the permission bits.
  fs.rmSync(dir,{recursive:true,force:true});const umask=process.umask(0o027);
  try{fs.mkdirSync(out,{recursive:true})}finally{process.umask(umask)}
  status({state:'running',startedAt,admission});
  let result;try{result=await verify(admission)}catch(e){result={error:e.message}}
  try{share()}catch(e){result.shareError=e.message}
  status({state:'finished',startedAt,admission,seconds:Math.round((performance.now()-start)/1000),...result});
 };
 return {
  // The keeper discards consumer stderr, so a failure that cannot reach status.json must crash the session
  // (the keeper then journals portableLeaseFailure) instead of vanishing.
  start(event){if(!running && !signal.aborted && !stop.signal.aborted)running=run(event).finally(()=>running=null);return running;},
  close(){stop.abort();return running??Promise.resolve();},
 };
}
