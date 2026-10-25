// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {EventEmitter} from 'node:events';
const original=fs.readFileSync(new URL('./inherited-lease.mjs',import.meta.url),'utf8');
let serial=0;
async function fixture({delay=0,reply='valid',handshake=true}={}){
 const events=[],timers=new Set();let socket;
 const record={dev:1,ino:2,uid:972,gid:972,mode:0o100600,nlink:1,size:4,mtimeMs:1,ctimeMs:1,isFile:()=>true};
 const boot='11111111-1111-1111-1111-111111111111';
 const metadata={version:1,nonce:boot,bootId:boot,mountId:7,device:'1:2',recordDev:1,recordIno:2};
 class Socket extends EventEmitter{
 constructor(){super();socket=this;if(handshake)setImmediate(()=>this.emit('data',Buffer.from(JSON.stringify(metadata)+'\n')));}
 write(text){const q=JSON.parse(text);const timer=setTimeout(()=>{timers.delete(timer);this.emit('data',Buffer.from(JSON.stringify({rid:q.rid,ok:reply==='valid'})+'\n'));},delay);timers.add(timer);}
 destroy(){for(const timer of timers)clearTimeout(timer);timers.clear();}
 }
 const mock={fstatSync:n=>n===4?record:{isSocket:()=>true},readFileSync:p=>p==='/proc/self/status'?'CapEff: 0000000000000000':p==='/proc/self/fdinfo/4'?'flags: 0100000\nmnt_id: 7\n':p==='/proc/self/stat'?'1 (node) '+Array(19).fill('0').join(' ')+' 42':boot,openSync:()=>10,writeSync:(_fd,s)=>events.push(JSON.parse(s)),closeSync:()=>{},constants:fs.constants};
 const key='leaseFixture'+(++serial);globalThis[key]={fs:mock,net:{Socket}};
 const source=original.replace("import fs from 'node:fs';",`const fs=globalThis.${key}.fs;`).replace("import net from 'node:net';",`const net=globalThis.${key}.net;`).replace('process.getuid()!==972','false');
 const module=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64')+'#'+serial);
 return {open:module.inheritedLease,events,dispose:()=>{socket?.destroy();delete globalThis[key];}};
}
test('delayed ACK beyond old1500ms remains valid under fixed5000ms',async()=>{const f=await fixture({delay:1600});try{const l=await f.open();assert.equal(await l.assertCurrent(),true);assert.equal(f.events.length,0);await l.release();assert.equal(f.events.length,0);}finally{f.dispose();}});
test('ACK timeout revokes and records first cause only',async()=>{const f=await fixture({delay:6000});try{const l=await f.open();await assert.rejects(l.assertCurrent());assert.equal(l.signal.aborted,true);assert.equal(f.events[0].reason,'ack-timeout');assert.equal(f.events.length,1);assert.equal(f.events[0].startTicks,'42');assert.deepEqual(Object.keys(f.events[0]).sort(),['bootId','phase','pid','reason','startTicks','version']);await assert.rejects(l.release());assert.equal(f.events.length,1);}finally{f.dispose();}});
test('request cancellation is a distinct revocation reason',async()=>{const f=await fixture({delay:200});try{const l=await f.open(),a=new AbortController();const job=l.assertCurrent(a.signal);a.abort();await assert.rejects(job);assert.equal(f.events[0].reason,'request-aborted');assert.equal(l.signal.aborted,true);await assert.rejects(l.release());}finally{f.dispose();}});
test('wrong acknowledgement refuses without echoing frame',async()=>{const f=await fixture({reply:'wrong'});try{const l=await f.open();await assert.rejects(l.assertCurrent());assert.equal(f.events[0].reason,'reply-invalid');assert.equal(l.signal.aborted,true);await assert.rejects(l.release());}finally{f.dispose();}});
