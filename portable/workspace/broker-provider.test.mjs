// Actual SDK + actual broker/journal, synthetic SDK-host responses only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInferenceBroker } from '../inference/broker.mjs';
import { toolCallDelta, finishChunk, assistantTextDelta } from '../inference/testing.mjs';
const worker = fileURLToPath(new URL('./agent-worker.mjs', import.meta.url));
const sdk = process.env.PORTABLE_PI_SDK ?? fileURLToPath(new URL('../../vendor/pi/packages/coding-agent/dist/index.js', import.meta.url));
const canonical = v => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : '{' + Object.keys(v).sort().map(k => JSON.stringify(k)+':'+canonical(v[k])).join(',') + '}';
const digest = v => createHash('sha256').update(canonical(v)).digest('hex');
const policy = {endpoint:'https://api.ppq.ai/private/v1/chat/completions',externalModel:'private/gpt-oss-120b',sealedModel:'gpt-oss-120b',validFromMs:90,validUntilMs:110,evidenceId:'synthetic_contract',billing:'input-output-tokens-only',ledgerUnit:'synthetic',maxBillableInputTokens:32768,maxRequestedOutputTokens:4096,reasoningEfforts:['default'],outputBound:'request-max-includes-all-billed-reasoning',pricePerInputToken:'1',pricePerOutputToken:'1'};
async function fixture({ stall = false, recover = false, truncated = false } = {}) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'worker-broker-')); await fs.mkdir(path.join(dir,'state'),{mode:0o700}); await fs.mkdir(path.join(dir,'work'));
 const calls=[]; let closed=0, entered; const reachedPost = new Promise(resolve => entered = resolve);
 const broker=createInferenceBroker({socketPath:path.join(dir,'broker.sock'),stateDir:path.join(dir,'state'),peerUid:process.getuid(),testingAllowSameUid:true,authorizedBudget:'200000',chargePolicy:policy,clock:()=>100,sdkHostFactory:async trusted=>{
  let req; const handle={token:'00000000-0000-0000-0000-000000000000'};
  return {async prepare(request){req=request;calls.push(request);return {handle,requestDigest:digest(request.body),documentDigest:'a'.repeat(64)};},async post(){
   await trusted.permitRawPost({logicalId:req.logicalId,requestDigest:digest(req.body),admissionDigest:'a'.repeat(64),bound:'36864',policyEvidenceId:'synthetic_contract'},trusted.signal);
   entered();
   if (stall) await new Promise((resolve,reject)=>{trusted.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});});
   const chunks=recover && calls.length===1 ? [toolCallDelta('read_bad','read',JSON.stringify({path:'missing-proof-file'})),finishChunk()] : calls.length===(recover?2:1) ? [toolCallDelta('write_1','write',JSON.stringify({path:'broker-proof.txt',content:'actual SDK tool via synthetic broker\n'})),finishChunk()] : [assistantTextDelta('Finished synthetic broker tool proof.'),finishChunk(truncated?'length':'stop')];
   const bytes=new TextEncoder().encode(chunks.map(v=>'data: '+JSON.stringify(v)+'\n\n').join('')+'data: [DONE]\n\n');
   return {stream:new ReadableStream({start(c){c.enqueue(bytes);c.close();}})};
  },async close(){closed++;}};
 }}); await broker.start();
 return {dir,calls,broker,reachedPost,get closed(){return closed;},async cleanup(){await broker.stop();await fs.rm(dir,{recursive:true,force:true});}};
}
async function run(f,socket,cancel = false) {
 const child=spawn(process.execPath,[worker,'--inference-socket',socket],{env:{PATH:process.env.PATH,LANG:'C.UTF-8',PORTABLE_PI_SDK:sdk,HOME:path.join(f.dir,'poison-home'),OPENAI_API_KEY:'ambient-canary-never-admit'},stdio:['pipe','pipe','pipe']});
 let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
 const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
 child.stdin.end(JSON.stringify({prompt:'Write broker-proof.txt using the write tool.',cwd:path.join(f.dir,'work')}));
 if(cancel) void f.reachedPost.then(()=>child.kill('SIGTERM'));
 const code=await new Promise(resolve=>child.once('close',resolve));clearTimeout(timer);
 return {code,events:out.trim().split('\n').filter(Boolean).map(JSON.parse),err};
}
test('actual SDK broker tool loop uses fresh IDs and isolated auth, missing broker refuses', {skip:!existsSync(sdk),timeout:120000},async()=>{
 const f=await fixture();try{
  const result=await run(f,path.join(f.dir,'broker.sock'));
  assert.equal(result.code,0,JSON.stringify(result));assert.equal(f.calls.length,2);assert.notEqual(f.calls[0].logicalId,f.calls[1].logicalId);
  assert.equal(await fs.readFile(path.join(f.dir,'work/broker-proof.txt'),'utf8'),'actual SDK tool via synthetic broker\n');
  assert.ok(f.calls[1].body.messages.some(m=>m.role==='tool'));await f.broker.stop();assert.equal(f.closed,2);
  assert.deepEqual(result.events.find(e=>e.type==='sdk_diag').credentialProviders,['portable-broker']);
  assert.ok(result.events.some(e=>e.type==='done'));assert.ok(!JSON.stringify(f.calls).includes('ambient-canary'));
  const absent=await run(f,path.join(f.dir,'absent.sock'));assert.equal(absent.code,1);assert.ok(!absent.events.some(e=>e.type==='done'));assert.equal(f.calls.length,2);
 }finally{await f.cleanup();}
});

for (const mode of ['cancel', 'recover', 'truncated']) test(`actual SDK broker ${mode}`, {skip:!existsSync(sdk),timeout:70000},async()=>{
 const f=await fixture({stall:mode==='cancel',recover:mode==='recover',truncated:mode==='truncated'});try{
  const result=await run(f,path.join(f.dir,'broker.sock'),mode==='cancel');
  await f.broker.stop();
  assert.equal(f.closed,f.calls.length);
  if(mode==='cancel'){assert.ok(result.events.some(e=>e.type==='aborted'));assert.ok(!result.events.some(e=>e.type==='done'));assert.equal(f.calls.length,1);}
  if(mode==='recover'){assert.equal(result.code,0,JSON.stringify(result));assert.equal(f.calls.length,3);assert.equal(new Set(f.calls.map(c=>c.logicalId)).size,3);assert.ok(result.events.some(e=>e.event==='tool_end'&&e.isError));assert.ok(result.events.some(e=>e.type==='done'));}
  if(mode==='truncated'){assert.equal(result.code,1);assert.ok(!result.events.some(e=>e.type==='done'));assert.equal(f.calls.length,2);}
 }finally{await f.cleanup();}
});

test('provider refuses ambient ancestor package fallback', async()=>{
 const {createBrokerProvider}=await import('./broker-provider.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'provider-layout-'));
 try {
  const entry=path.join(dir,'packages/coding-agent/dist/index.js');await fs.mkdir(path.dirname(entry),{recursive:true});await fs.writeFile(entry,'');
  const ambient=path.join(dir,'node_modules/@earendil-works/pi-ai');await fs.mkdir(ambient,{recursive:true});await fs.writeFile(path.join(ambient,'package.json'),JSON.stringify({name:'@earendil-works/pi-ai'}));
  await assert.rejects(createBrokerProvider(entry,'/tmp/no-socket'));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
