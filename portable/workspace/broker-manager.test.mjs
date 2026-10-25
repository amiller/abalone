import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createAgentManager } from './agent-manager.mjs';

async function fixture(mode = 'broker') {
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'broker-manager-'));
 const socket = path.join(dir, 'trusted.sock');
 const listener = net.createServer(conn => conn.end());
 await new Promise((resolve,reject) => {listener.once('error',reject);listener.listen(socket,resolve);});
 const worker = path.join(dir, 'worker.mjs');
 await fs.writeFile(worker, `
 const args = process.argv.slice(2);
 const socket = args[args.indexOf('--inference-socket') + 1];
 if (socket !== ${JSON.stringify(socket)}) process.exit(9);
 if (args.includes('--probe')) console.log(JSON.stringify({type:'ready',kind:'fixture',mode:${JSON.stringify(mode)}}));
 else { let data=''; for await (const b of process.stdin) data+=b; if(Object.hasOwn(JSON.parse(data),'script')) process.exit(8); console.log(JSON.stringify({type:'done',socket})); }
 `);
 const manager = createAgentManager({workspace:dir,workerPath:worker,inferenceSocket:socket,probeMaxAttempts:1});
 return {dir,socket,manager,async close(){await manager.close();await new Promise(resolve=>listener.close(resolve));await fs.rm(dir,{recursive:true,force:true});}};
}

test('trusted broker socket reaches both probe and worker, never job-selected', async () => {
 const f = await fixture();
 try {
  assert.equal((await f.manager.status()).mode, 'broker');
  await assert.rejects(f.manager.start({prompt:'test',script:null}),/Scripted jobs/);
  await assert.rejects(f.manager.start({prompt:'test',script:{}}),/Scripted jobs/);
  const {id} = await f.manager.start({prompt:'test',inferenceSocket:'/tmp/request-selected.sock'});
  const deadline = Date.now()+5000;
  while (f.manager.get(id).state !== 'done' && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
  const events=f.manager.events(id).events;
  assert.equal(f.manager.get(id).state,'done');
  assert.equal(events.find(e=>e.type==='done').socket,f.socket);
 } finally {await f.close();}
});

for (const mode of ['scripted', null]) test(`broker configuration refuses ${mode ?? 'missing'} probe mode`, async () => {
 const f = await fixture(mode);
 try {
  assert.equal((await f.manager.status()).available,false);
  await assert.rejects(f.manager.start({prompt:'test'}),e=>e.code==='AGENT_UNAVAILABLE');
 } finally {await f.close();}
});

test('broker socket configuration rejects relative and invalid paths', () => {
 for(const inferenceSocket of ['relative','/tmp/x\0y','/'+ 'x'.repeat(108)]) assert.throws(()=>createAgentManager({workspace:'/tmp',inferenceSocket}),/absolute Unix socket/);
});

test('agent service rejects scripted admission with either trusted broker configuration', async () => {
 const {createAgentService}=await import('../workspace-service/agent-service.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'broker-service-'));
 try {
  const base={workspace:dir,socketPath:path.join(dir,'ui.sock'),allowedUids:[process.getuid()],testingAllowSameUid:true,allowScript:true};
  for(const config of [{inferenceSocket:path.join(dir,'broker.sock')},{managerOptions:{inferenceSocket:path.join(dir,'broker.sock')}}]) assert.throws(()=>createAgentService({...base,...config}),/cannot admit scripted jobs/);
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
