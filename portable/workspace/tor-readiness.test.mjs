// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceServer} from './server.mjs';

test('service broker refuses starting/stopped/unknown/expired Tor without admitting a job;100 admits', async()=>{
 let desktop={tor:{state:'starting',progress:0},validForMs:1000},starts=0;
 const app=await createWorkspaceServer({workspace:'/run/test-workspace',readDesktopProjection:async()=>desktop,backend:{request:async(op)=>{
  if(op==='status')return{agent:{available:true,mode:'broker'},terminalAvailable:true};
  if(op==='agents.start'){starts++;return{id:'admitted'};}
  if(op==='terminals.list')return{sessions:[]};
  if(op==='files.list')return{entries:[]};
  throw Error(op);
 },close:async()=>{}}});
 try {
  const status=await(await fetch(app.origin+'/api/status')).json();
  const send=()=>fetch(app.origin+'/api/agents',{method:'POST',headers:{'content-type':'application/json','x-workspace-token':status.csrfToken},body:JSON.stringify({prompt:'hello',mode:'scripted',tor:{state:'bootstrapped',progress:100}})});
  for(const next of [desktop,{tor:{state:'starting',progress:95},validForMs:1000},{tor:{state:'stopped',progress:null},validForMs:1000},{tor:{state:'unknown',progress:null},validForMs:0},{tor:{state:'bootstrapped',progress:100},validForMs:0}]){
   desktop=next;const reply=await send();assert.equal(reply.status,503);assert.equal((await reply.json()).code,'tor-not-ready');assert.equal(starts,0);
  }
  assert.equal((await fetch(app.origin+'/api/terminals')).status,200);assert.equal((await fetch(app.origin+'/api/files')).status,200);
  desktop={tor:{state:'bootstrapped',progress:100},validForMs:1000};assert.equal((await send()).status,201);assert.equal(starts,1);
 }finally{await app.close();}
});
test('scripted service remains usable without Tor',async()=>{
 let starts=0;
 const app=await createWorkspaceServer({workspace:'/run/test-workspace',readDesktopProjection:async()=>({tor:{state:'unknown'},validForMs:0}),backend:{request:async op=>op==='status'?{agent:{available:true,mode:'scripted'}}:(starts++,{id:'scripted'}),close:async()=>{}}});
 try{const status=await(await fetch(app.origin+'/api/status')).json();const reply=await fetch(app.origin+'/api/agents',{method:'POST',headers:{'content-type':'application/json','x-workspace-token':status.csrfToken},body:JSON.stringify({prompt:'hello'})});assert.equal(reply.status,201);assert.equal(starts,1);}finally{await app.close();}
});
test('browser gate uses fresh service broker projection and keeps scripted/direct modes',async()=>{
 const {readFile}=await import('node:fs/promises');const {runInNewContext}=await import('node:vm');
 const source=await readFile(new URL('./ui/app.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('function torBlocksAgent()'),source.indexOf('function render()'));
 const state={service:true,agent:{mode:'broker'},desktop:{tor:{state:'starting',progress:30}},desktopDeadline:200};
 const context={state,performance:{now:()=>100}};
 runInNewContext(code,context);assert.equal(context.torBlocksAgent(),true);assert.equal(context.torWaitingLabel(),'Connecting to Tor · 30%');
 state.desktop.tor={state:'bootstrapped',progress:100};assert.equal(context.torBlocksAgent(),false);
 state.desktopDeadline=99;assert.equal(context.torBlocksAgent(),true);assert.equal(context.torWaitingLabel(),'Connecting to Tor');
 state.agent.mode='scripted';assert.equal(context.torBlocksAgent(),false);state.agent.mode='broker';state.service=false;assert.equal(context.torBlocksAgent(),false);
});
