import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAgentManager} from './agent-manager.mjs';
import {createWorkspaceServer} from './server.mjs';

test('HTTP status and terminals remain available while SDK probe is pending; starts refuse explicitly',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'readiness-'));let release;
 const manager=createAgentManager({workspace:dir,probeRunner:()=>new Promise(r=>release=r)});
 const app=await createWorkspaceServer({workspace:dir,agentManager:manager});
 try {
  const before=performance.now();const status=await fetch(app.origin+'/api/status').then(r=>r.json());
  assert.ok(performance.now()-before<1000);assert.equal(status.agent.state,'warming');assert.equal(status.agent.available,false);
  const request=(url,body)=>fetch(app.origin+url,{method:'POST',headers:{'content-type':'application/json','x-workspace-token':status.csrfToken},body:JSON.stringify(body)});
  const terminal=await request('/api/terminals',{});assert.equal(terminal.status,201);
  const refused=await request('/api/agents',{prompt:'test'});assert.equal(refused.status,503);assert.equal((await refused.json()).code,'not-ready');
  release({available:true,kind:'sdk',detail:'synthetic probe'});await manager.status();
  const ready=await fetch(app.origin+'/api/status').then(r=>r.json());assert.equal(ready.agent.state,'ready');assert.equal(ready.agent.available,true);
 } finally {release?.({available:false});await app.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('failed probe retries only after backoff and has a hard attempt limit',async()=>{
 let now=0,calls=0;const manager=createAgentManager({workspace:'/tmp',probeClock:()=>now,probeRetryBaseMs:1000,probeMaxAttempts:3,probeRunner:async()=>{calls++;return {available:false,kind:'missing',detail:'synthetic failure'};}});
 try {
  assert.equal(manager.readiness().state,'warming');await manager.status();assert.equal(calls,1);
  now=999;assert.equal(manager.readiness().state,'unavailable');assert.equal(calls,1);
  now=1000;assert.equal(manager.readiness().state,'warming');await manager.status();assert.equal(calls,2);
  now=2999;manager.readiness();assert.equal(calls,2);
  now=3000;await manager.status();assert.equal(calls,3);
  now=999999;assert.equal(manager.readiness().state,'unavailable');await manager.status();assert.equal(calls,3);
 }finally{await manager.close();}
});

test('real timed-out probe is reaped and can recover after backoff',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'probe-recovery-')),worker=path.join(dir,'worker.mjs'),pidFile=path.join(dir,'pid');let now=0;
 await fs.writeFile(worker,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
 const manager=createAgentManager({workspace:dir,workerPath:worker,probeTimeoutMs:300,probeClock:()=>now,probeRetryBaseMs:1000});
 try{
  assert.equal((await manager.status()).available,false);const pid=Number(await fs.readFile(pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  await fs.writeFile(worker,`console.log(JSON.stringify({type:'ready',kind:'fixture'}));`);
  now=999;assert.equal(manager.readiness().state,'unavailable');now=1000;
  assert.equal(manager.readiness().state,'warming');assert.equal((await manager.status()).available,true);
 }finally{await manager.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('close before background task runs does not launch a probe',async()=>{let calls=0;const manager=createAgentManager({workspace:'/tmp',probeRunner:async()=>{calls++;return {available:true};}});manager.readiness();await manager.close();await Promise.resolve();assert.equal(calls,0);assert.equal(manager.readiness().state,'closed');});
