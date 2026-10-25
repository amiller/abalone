// Private inherited capability channel; no socket path, credentials or UID claims.
// Root creates the socketpair: SO_PEERCRED would name that creator, not UID972.
import fs from 'node:fs';
import net from 'node:net';
// Five seconds tolerates local scheduler stalls; authority checks are unchanged.
const ACK_TIMEOUT_MS=5000;
const FAILURE='/run/portable-credit/lease-first-failure.json';
function recordFailure(phase,reason){let fd;try{
 const text=fs.readFileSync('/proc/self/stat','utf8'),startTicks=text.slice(text.lastIndexOf(')')+2).split(' ')[19];
 const bootId=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
 if(!/^\d+$/.test(startTicks)||!/^[a-f0-9-]{36}$/.test(bootId))return;
 fd=fs.openSync(FAILURE,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 fs.writeSync(fd,JSON.stringify({version:1,bootId,pid:process.pid,startTicks,phase,reason})+'\n');
 }catch{}finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}}
const refuse=()=>Error('vault-lease-unavailable');
const exact=(v,names)=>v && Object.getPrototypeOf(v)===Object.prototype && Object.keys(v).sort().join(',')===names.split(',').sort().join(',');
export async function inheritedLease() {
  if(process.getuid()!==972 || !/^CapEff:\s+0{16}$/m.test(fs.readFileSync('/proc/self/status','utf8')))throw refuse();
  const record=fs.fstatSync(4),flags=fs.readFileSync('/proc/self/fdinfo/4','utf8');
  const flagText=flags.match(/^flags:\s+([0-7]+)$/m)?.[1];
  const accessFlags=flagText===undefined?NaN:Number.parseInt(flagText,8);
  if(!Number.isSafeInteger(accessFlags) || !record.isFile() || record.uid!==972 || record.gid!==972 || (record.mode&0o777)!==0o600 || record.nlink!==1 || record.size<1 || record.size>16384 || (accessFlags&3)!==0 || !fs.fstatSync(3).isSocket())throw refuse();
  const socket=new net.Socket({fd:3,readable:true,writable:true}),controller=new AbortController();
  let buffer=Buffer.alloc(0),waiting=null,metadata=null,rid=0,closed=false,releasing=null,phase='handshake',failed=false;
  const fail=(reason='frame-invalid')=>{if(!failed&&!closed){failed=true;recordFailure(phase,reason);}controller.abort();socket.destroy();if(waiting){clearTimeout(waiting.timer);waiting.reject(refuse());waiting=null;}};
  socket.on('error',()=>fail('socket-error'));socket.on('end',()=>fail('socket-end'));socket.on('close',()=>fail('socket-close'));
  socket.on('data',chunk=>{try {
    buffer=Buffer.concat([buffer,chunk]);if(buffer.length>2048)throw refuse();
    const index=buffer.indexOf(10);if(index<0)return;
    if(index!==buffer.length-1 || !waiting)throw refuse();
    const value=JSON.parse(buffer.subarray(0,index).toString('utf8'));buffer=Buffer.alloc(0);
    const slot=waiting;waiting=null;clearTimeout(slot.timer);slot.resolve(value);
  }catch{fail();}});
  const receive=()=>new Promise((resolve,reject)=>{
    if(waiting || controller.signal.aborted)return reject(refuse());
    const slot={resolve,reject,timer:null};waiting=slot;
    // A CPU stall can leave a valid ACK queued in the kernel while timers run
    // before socket polling. Give exactly one poll/check turn to consume it;
    // never revoke a later operation because this slot already completed.
    slot.timer=setTimeout(()=>setImmediate(()=>{if(waiting===slot)fail('ack-timeout');}),ACK_TIMEOUT_MS);
  });
  try {
    metadata=await receive();
    if(!exact(metadata,'version,nonce,bootId,mountId,device,recordDev,recordIno') || metadata.version!==1 || !/^[0-9a-f-]{36}$/.test(metadata.nonce) || !/^[0-9a-f-]{36}$/.test(metadata.bootId) || !Number.isSafeInteger(metadata.mountId) || metadata.mountId<1 || !/^\d+:\d+$/.test(metadata.device) || metadata.recordDev!==record.dev || metadata.recordIno!==record.ino || Number(flags.match(/^mnt_id:\s+(\d+)/m)?.[1])!==metadata.mountId || fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()!==metadata.bootId)throw refuse();
  }catch(e){fail('metadata-invalid');fs.closeSync(4);throw e;}
  phase='idle';
  let chain=Promise.resolve();
  const operation=op=>{
    const task=chain.then(async()=>{
      if(closed || controller.signal.aborted)throw refuse();phase=op;
      const current=fs.fstatSync(4);
      if(['dev','ino','mode','uid','gid','nlink','size','mtimeMs','ctimeMs'].some(k=>current[k]!==record[k])){fail('record-changed');throw refuse();}
      const id=++rid,pending=receive();socket.write(JSON.stringify({op,rid:id,nonce:metadata.nonce})+'\n');
      const reply=await pending;if(!exact(reply,'rid,ok') || reply.rid!==id || reply.ok!==true){fail('reply-invalid');throw refuse();}
      phase='idle';return true;
    });chain=task.catch(()=>{});return task;
  };
  return {fd:4,signal:controller.signal,async assertCurrent(signal){
    if(signal?.aborted)throw refuse();const aborted=()=>fail('request-aborted');signal?.addEventListener('abort',aborted,{once:true});
    try{return await operation('assert');}finally{signal?.removeEventListener('abort',aborted);}
  },release(){
    if(!releasing)releasing=(async()=>{try{await operation('release');}finally{closed=true;fail();fs.closeSync(4);}})();return releasing;
  }};
}
