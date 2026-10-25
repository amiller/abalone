import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {createAgentManager} from './agent-manager.mjs';

async function fixture(probeRunner) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'broker-readiness-'));
 const socket=path.join(dir,'inference.sock');
 let server=null;
 return {dir,socket,
  manager:createAgentManager({workspace:dir,inferenceSocket:socket,probeRunner,probeMaxAttempts:1}),
  async open(){server=net.createServer(conn=>conn.end());await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});},
  async lock(){if(server){await new Promise(resolve=>server.close(resolve));server=null;}},
  async close(){await this.manager.close();await this.lock();await fs.rm(dir,{recursive:true,force:true});},
 };
}
const ready={available:true,kind:'sdk',mode:'broker'};
async function waitReady(manager) {
 const deadline=performance.now()+1000;
 while(performance.now()<deadline){if((await manager.status()).available)return;await new Promise(resolve=>setImmediate(resolve));}
 assert.fail('broker did not become ready after directory notification');
}

test('locked boot, unlock, lock and unlock requalify without restarting the manager',async()=>{
 let calls=0;const f=await fixture(async()=>{calls++;return ready;});
 try {
  assert.equal((await f.manager.status()).available,false);assert.equal(calls,0);
  await f.open();await waitReady(f.manager);const first=calls;assert.ok(first>=1 && first<=2);
  await f.lock();assert.equal((await f.manager.status()).available,false);assert.equal(calls,first);
  await f.open();await waitReady(f.manager);assert.ok(calls>first && calls<=first+2);
 }finally{await f.close();}
});

test('unchanged failed socket retains the bounded attempt limit; replacement gets a new probe',async()=>{
 let calls=0;const f=await fixture(async()=>{calls++;return {available:false,kind:'missing'};});
 try {
  await f.open();await f.manager.status();assert.equal(calls,1);
  for(let i=0;i<10;i++)assert.equal((await f.manager.status()).available,false);
  assert.equal(calls,1);
  await f.lock();await f.open();
  // Directory notifications are asynchronous, including on filesystems that
  // reuse both inode and timestamp during this immediate replacement.
  const deadline=performance.now()+1000;
  while(calls<2 && performance.now()<deadline){await f.manager.status();await new Promise(resolve=>setImmediate(resolve));}
  assert.equal(calls,2);
 }finally{await f.close();}
});

test('socket removed during an outstanding probe cannot publish stale readiness',async()=>{
 let release;const f=await fixture(()=>new Promise(resolve=>{release=resolve;}));
 try {
  await f.open();const pending=f.manager.status();
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  await f.lock();release(ready);
  assert.equal((await pending).available,false);
  assert.equal((await f.manager.status()).available,false);
 }finally{release?.(ready);await f.close();}
});

test('regular files and symlinks cannot trigger a broker probe; close prevents further probes',async()=>{
 let calls=0;const f=await fixture(async()=>{calls++;return ready;});
 try {
  await fs.writeFile(f.socket,'not a socket');assert.equal((await f.manager.status()).available,false);
  await fs.unlink(f.socket);await f.open();await fs.symlink(f.socket,path.join(f.dir,'alias'));
  await f.lock();await fs.unlink(path.join(f.dir,'alias'));
  await fs.symlink('/dev/null',f.socket);assert.equal((await f.manager.status()).available,false);assert.equal(calls,0);
  await fs.unlink(f.socket);await f.open();await f.manager.close();
  assert.equal((await f.manager.status()).state,'closed');assert.equal(calls,0);
 }finally{await f.close();}
});
