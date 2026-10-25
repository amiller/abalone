// Explicit constructor only; no CLI, account discovery, service unit or fetch.
import net from 'node:net';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {peerCredential} from '../workspace-service/syscred.mjs';
import {createCreditProjection} from '../../lib/provider-credit-projection.mjs';
const refuse = () => {throw new Error('credit-service-refused');};
const FIXED_SOCKET='/run/portable-credit/credit.sock';
const same=(a,b)=>a.dev===b.dev && a.ino===b.ino;
function eligible(s) {
  return s.isSocket() && s.uid===972 && s.gid===972 && (s.mode&0o7777)===0o666 && s.nlink===1;
}
async function refusedProbe(socketPath) {
  // No request bytes. A connected listener, timeout or unknown error is refusal.
  return new Promise(resolve=>{
    let stale=false,decided=false;
    const socket=net.createConnection(socketPath);
    const timer=setTimeout(()=>{decided=true;socket.destroy();},250);
    socket.once('connect',()=>{decided=true;socket.destroy();});
    socket.once('error',e=>{if(!decided){decided=true;stale=e.code==='ECONNREFUSED';}socket.destroy();});
    socket.once('close',()=>{clearTimeout(timer);resolve(stale);});
  });
}
async function prepareEndpoint(socketPath,recoverStaleSocket) {
  if(recoverStaleSocket!==false && recoverStaleSocket!==true)refuse();
  if(recoverStaleSocket && socketPath!==FIXED_SOCKET)refuse();
  const parent=path.dirname(socketPath);
  const handle=await fs.open(parent,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {
    const pinned=await handle.stat();
    const checkParent=async()=>{
      const current=await fs.lstat(parent);
      if(!same(current,pinned) || !current.isDirectory() || current.uid!==972 || (recoverStaleSocket && current.gid!==972) || (current.mode&0o022))refuse();
    };
    await checkParent();
    const anchored=`/proc/self/fd/${handle.fd}/${path.basename(socketPath)}`;
    let prior;
    try {prior=await fs.lstat(anchored);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(prior) {
      if(!recoverStaleSocket || !eligible(prior))refuse();
      if(!await refusedProbe(socketPath))refuse();
      await checkParent();
      const current=await fs.lstat(anchored);
      if(!same(current,prior) || !eligible(current))refuse();
      // Fixed systemd unit serializes starts. Only this trusted UID972 entry
      // writes this endpoint; root/out-of-band UID972 code is in the TCB.
      // Identity checks are NOT an atomic unlink guarantee against that TCB.
      await fs.unlink(anchored);
    }
    await checkParent();
    try {await fs.lstat(anchored);refuse();}catch(e){if(e.code!=='ENOENT')throw e;}
    return {checkParent,close:()=>handle.close()};
  } catch(e) {await handle.close();throw e;}
}
export async function startCreditService({socketPath, recoverStaleSocket=false, ...trusted}) {
  if (process.getuid?.() !== 972 || typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || path.normalize(socketPath)!==socketPath) refuse();
  const parent=path.dirname(socketPath);
  for(let p=parent;;p=path.dirname(p)) {
    const s=await fs.lstat(p);
    if(!s.isDirectory() || s.isSymbolicLink() || (s.mode&0o022) || ![0,972].includes(s.uid)) refuse();
    if(p==='/') break;
  }
  if((await fs.stat(parent)).uid!==972) refuse();
  const endpoint=await prepareEndpoint(socketPath,recoverStaleSocket);
  let projection;
  try {projection=createCreditProjection(trusted);}catch(e){await endpoint.close();throw e;}
  const sockets=new Set(), checks=new Set();
  let closing=false,stopPromise=null,identity;
  const server=net.createServer(socket=>{
    if(closing || sockets.size>=4){socket.destroy();return;}
    sockets.add(socket);socket.pause();socket.on('error',()=>{});
    const deadline=setTimeout(()=>socket.destroy(),2000);socket.once('close',()=>clearTimeout(deadline));
    socket.on('close',()=>sockets.delete(socket));socket.setTimeout(2000,()=>socket.destroy());
    const auth=new AbortController();socket.once('close',()=>auth.abort());
    const task=(async()=>{
      const fd=socket._handle?.fd;
      if(!Number.isInteger(fd)) refuse();
      const peer=await peerCredential(fd,{timeoutMs:1000,python:'/usr/bin/python3',signal:auth.signal});
      if(peer.uid!==971 || closing || socket.destroyed) refuse();
      let buffer=Buffer.alloc(0),handled=false;
      socket.on('data',chunk=>{
        if(handled){socket.destroy();return;}
        buffer=Buffer.concat([buffer,chunk]);
        if(buffer.length>256){socket.destroy();return;}
        const end=buffer.indexOf(10);if(end<0)return;
        handled=true;
        if(end!==buffer.length-1){socket.destroy();return;}
        let req;
        try {req=JSON.parse(buffer.subarray(0,end).toString('utf8'));}catch{socket.destroy();return;}
        if(!req || Array.isArray(req) || Object.keys(req).sort().join(',')!=='op,rid' || req.op!=='status' || !Number.isSafeInteger(req.rid) || req.rid<0){socket.destroy();return;}
        projection.status().then(value=>{if(!socket.destroyed)socket.end(JSON.stringify({rid:req.rid,ok:true,credit:value})+'\n');},()=>socket.destroy());
      });
      socket.resume();
    })().catch(()=>socket.destroy());
    checks.add(task);task.finally(()=>checks.delete(task));
  });
  try {
    await endpoint.checkParent();
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
    await fs.chmod(socketPath,0o666);identity=await fs.lstat(socketPath);
  } catch(e) {server.close();await projection.close();throw e;} finally {await endpoint.close();}
  function stop() {
    if(stopPromise)return stopPromise;
    closing=true;
    stopPromise=Promise.resolve().then(async()=>{
      const stopped=new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
      for(const s of sockets)s.destroy();
      const result=await Promise.allSettled([stopped,...checks,projection.close()]);
      if(result.some(r=>r.status==='rejected'))throw new Error('credit-service-cleanup-failed');
      // Node may remove the socket on close. Never unlink a replacement.
      try {const s=await fs.lstat(socketPath);if(s.dev!==identity.dev || s.ino!==identity.ino || !s.isSocket())refuse();await fs.unlink(socketPath);}catch(e){if(e.code!=='ENOENT')throw e;}
    });
    return stopPromise;
  }
  return {stop,refresh:projection.refresh}; // refresh is trusted supervisor only.
}
