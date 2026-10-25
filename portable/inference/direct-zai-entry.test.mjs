import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('fixed entry refuses argv without account discovery or raw errors',()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('./direct-zai-entry.mjs',import.meta.url)),'--endpoint=synthetic'],{encoding:'utf8',timeout:3000,env:{PATH:'/usr/bin:/bin'}});
 assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr,'Inference unavailable\n');
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
for(const owned of [false,true])test(`actual entry fixture ${owned?'after':'before'} broker release ownership`,async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'zai-entry-'));
 try{
  const entry=await fs.readFile(new URL('./direct-zai-entry.mjs',import.meta.url),'utf8');
  // Only dependency import locations change; execute actual entry body as CLI.
  await fs.writeFile(path.join(dir,'entry.mjs'),entry.replace("'../funding/inherited-lease.mjs'","'./lease.mjs'").replace("'./direct-zai-broker.mjs'","'./broker.mjs'").replace("'./zai-curl-transport.mjs'","'./transport.mjs'"));
  await fs.writeFile(path.join(dir,'lease.mjs'),`import fs from 'node:fs';let released;export const lease={signal:{aborted:true},release(){return released??=(async()=>{fs.appendFileSync(${JSON.stringify(path.join(dir,'released'))},'release\\n');})();}};export async function inheritedLease(){return lease;}`);
  await fs.writeFile(path.join(dir,'broker.mjs'),`export async function startBroker({lease}){${owned?'await lease.release();':''}throw Error('SYNTHETIC_PRIVATE_FAILURE');}`);
  await fs.writeFile(path.join(dir,'transport.mjs'),'export function transport(){throw Error("must not run");}');
  const result=spawnSync(process.execPath,[path.join(dir,'entry.mjs')],{encoding:'utf8',timeout:3000,env:{PATH:'/usr/bin:/bin'}});
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr,'Inference unavailable\n');assert.equal(await fs.readFile(path.join(dir,'released'),'utf8'),'release\n');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
