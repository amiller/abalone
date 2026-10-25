// Run with --experimental-test-module-mocks. No production injection knob.
import test,{mock} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('failed file cleanup still drains both other owners and preserves shared rejection',async()=>{
 const called=[];let releaseTerminal,releaseAgent;
 const terminalGate=new Promise(r=>releaseTerminal=r),agentGate=new Promise(r=>releaseAgent=r);
 mock.module('./workspace-files.mjs',{namedExports:{createWorkspaceFiles:()=>({start:async()=>{},close:async()=>{called.push('files');throw Object.assign(Error('synthetic file reap failure'),{code:'cleanup_failed'});}})}});
 mock.module('../workspace/terminal-manager.mjs',{namedExports:{createTerminalManager:()=>({close:async()=>{called.push('terminals');await terminalGate;}})}});
 mock.module('../workspace/agent-manager.mjs',{namedExports:{createAgentManager:()=>({close:async()=>{called.push('agents');await agentGate;}})}});
 const {createAgentService}=await import('./agent-service.mjs');
 const dir=await mkdtemp(join(tmpdir(),'service-cleanup-failure-'));await mkdir(dir+'/ws');
 const service=createAgentService({workspace:dir+'/ws',socketPath:dir+'/run/ipc.sock',allowedUids:[process.getuid()],testingAllowSameUid:true});
 try {
  await service.start();let settled=false;
  const stopped=service.stop();const observed=stopped.then(()=>{settled=true;throw Error('false clean');},error=>{settled=true;return error;});
  assert.equal(service.stop(),stopped);
  await new Promise(r=>setTimeout(r,20));assert.deepEqual(called.sort(),['agents','files','terminals']);assert.equal(settled,false);
  releaseTerminal();await new Promise(r=>setTimeout(r,20));assert.equal(settled,false);
  releaseAgent();const error=await observed;assert.ok(error instanceof AggregateError);assert.equal(error.errors[0].code,'cleanup_failed');
  assert.equal(service.stop(),stopped);await assert.rejects(service.stop(),/cleanup failed/);
 } finally {releaseTerminal();releaseAgent();await service.stop().catch(()=>{});mock.restoreAll();await rm(dir,{recursive:true,force:true});}
});
