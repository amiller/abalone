// SPDX-License-Identifier: MIT
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import net from 'node:net';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';
const source=fs.readFileSync(new URL('./inherited-lease.mjs',import.meta.url),'utf8');let serial=0;
async function actualChannel(mode){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lease-scheduling-')),sock=path.join(dir,'socket');const events=[];
 const boot='11111111-1111-1111-1111-111111111111',record={dev:1,ino:2,uid:972,gid:972,mode:0o100600,nlink:1,size:4,mtimeMs:1,ctimeMs:1,isFile:()=>true};
 const metadata={version:1,nonce:boot,bootId:boot,mountId:7,device:'1:2',recordDev:1,recordIno:2};
 const server=spawn(process.execPath,['--input-type=module','-e',`import net from 'node:net';const mode=process.argv[2],metadata=JSON.parse(process.argv[3]);net.createServer(c=>{c.on('error',()=>{});c.write(JSON.stringify(metadata)+'\\n');c.on('data',b=>{const r=JSON.parse(b);if(mode==='missing'&&r.op==='assert')return;c.write(JSON.stringify({rid:mode==='wrong-rid'?r.rid+1:r.rid,ok:true})+'\\n');process.stdout.write('ACK_WRITTEN\\n');});}).listen(process.argv[1],()=>process.stdout.write('READY\\n'));`,sock,mode,JSON.stringify(metadata)],{stdio:['ignore','pipe','inherit']});
 let serverLog='';server.stdout.on('data',b=>serverLog+=b);await once(server.stdout,'data');let socket,stalled=false;
 class Socket extends net.Socket {constructor(){super();socket=this;this.connect(sock);}}
 const mock={fstatSync:n=>n===4?record:{isSocket:()=>true},readFileSync:p=>p==='/proc/self/status'?'CapEff: 0000000000000000':p==='/proc/self/fdinfo/4'?'flags: 0100000\nmnt_id: 7\n':p==='/proc/self/stat'?'1 (node) '+Array(19).fill('0').join(' ')+' 42':boot,openSync:()=>10,writeSync:(_fd,s)=>events.push(JSON.parse(s)),closeSync:()=>{},constants:fs.constants};
 const key='actualLeaseScheduling'+(++serial);globalThis[key]={fs:mock,net:{Socket}};
 const body=source.replace("import fs from 'node:fs';",`const fs=globalThis.${key}.fs;`).replace("import net from 'node:net';",`const net=globalThis.${key}.net;`).replace('process.getuid()!==972','false');
 try{const m=await import('data:text/javascript;base64,'+Buffer.from(body).toString('base64')+'#'+serial);const l=await m.inheritedLease();
  if(mode==='queued'){const write=socket.write.bind(socket);socket.write=(...args)=>{const r=write(...args);if(!stalled){stalled=true;const start=performance.now();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5500);assert.ok(performance.now()-start>=5400);}return r;};assert.equal(await l.assertCurrent(),true);assert.equal(stalled,true);assert.equal(l.signal.aborted,false);await l.release();assert.equal(events.length,0);assert.match(serverLog,/ACK_WRITTEN/);}
  else{await assert.rejects(l.assertCurrent());assert.equal(l.signal.aborted,true);assert.equal(events[0].reason,mode==='missing'?'ack-timeout':'reply-invalid');await assert.rejects(l.release());}
 }finally{socket?.destroy();server.kill('SIGTERM');await once(server,'exit');delete globalThis[key];fs.rmSync(dir,{recursive:true});}
}
test('separate process queued ACK survives event-loop stall past unchanged 5000ms',()=>actualChannel('queued'));
test('separate process missing ACK still times out and revokes',()=>actualChannel('missing'));
test('queued wrong request ID remains refused',()=>actualChannel('wrong-rid'));
