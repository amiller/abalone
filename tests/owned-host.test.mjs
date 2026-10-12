import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {memoryRoot,memoryRun,ownedHostEnvironment} from '../lib/owned-host.mjs';

test('owned-host refuses disk-backed and unsafe memory roots without fallback',()=>{
 assert.throws(()=>memoryRoot(os.tmpdir()),/tmpfs/);
 const base=fs.mkdtempSync('/dev/shm/owned-host-test-');
 try{
  const root=path.join(base,`abalone-${process.getuid()}`);
  fs.symlinkSync('/tmp',root);assert.throws(()=>memoryRoot(base),/owner-only/);fs.unlinkSync(root);
  fs.mkdirSync(root,{mode:0o755});fs.chmodSync(root,0o755);assert.throws(()=>memoryRoot(base),/owner-only/);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
test('ordinary owned-host child managed logs and crash writes stay on verified tmpfs',()=>{
 const run=memoryRun();
 try{
  const env=ownedHostEnvironment({PATH:process.env.PATH,HOME:os.homedir(),TMPDIR:path.join(run,'tmp'),ABALONE_DIR:path.join(run,'state'),PI_CODING_AGENT_DIR:path.join(run,'agent'),NEAR_API_KEY:'must-not-reach-child',ABALONE_COUPON_FD:'3'});
  const script=`const fs=require('node:fs'),path=require('node:path');for(const key of ['ABALONE_DIR','PI_CODING_AGENT_DIR','TMPDIR']){const d=process.env[key];if(fs.statfsSync(d).type!==0x01021994)process.exit(8);fs.writeFileSync(path.join(d,'synthetic-crash.log'),'synthetic-private-marker');}if(process.env.NEAR_API_KEY||process.env.ABALONE_COUPON_FD)process.exit(9);process.exit(7);`;
  const r=spawnSync(process.execPath,['-e',script],{env,encoding:'utf8'});assert.equal(r.status,7,r.stderr);
  for(const dir of ['state','agent','tmp'])assert.equal(fs.readFileSync(path.join(run,dir,'synthetic-crash.log'),'utf8'),'synthetic-private-marker');
  assert.equal(fs.statfsSync(run).type,0x01021994);assert.equal(fs.statSync(run).mode&0o777,0o700);
 }finally{fs.rmSync(run,{recursive:true,force:true});}
});
test('a launch removes run directories whose launcher is gone and keeps live or unmarked ones',async()=>{
 const base=fs.mkdtempSync('/dev/shm/owned-host-test-'),lib=JSON.stringify(path.resolve(import.meta.dirname,'../lib/owned-host.mjs'));
 const launch=(hold)=>spawn(process.execPath,['--input-type=module','-e',`import {memoryRun} from ${lib};console.log(memoryRun(process.argv[1]));${hold?'setInterval(()=>{},1000);':''}`,base],{stdio:['ignore','pipe','inherit']});
 const started=async(child)=>String((await once(child.stdout,'data'))[0]).trim();
 const live=launch(true);
 try{
  const liveRun=await started(live),dead=launch(false),deadRun=await started(dead);await once(dead,'exit');
  const unmarked=path.join(base,`abalone-${process.getuid()}`,'run-unmarked');fs.mkdirSync(unmarked);
  for(const run of [deadRun,liveRun])assert.ok(fs.existsSync(path.join(run,'alive')));
  const mine=memoryRun(base);
  assert.equal(fs.existsSync(deadRun),false,'dead launcher run removed');
  for(const run of [liveRun,unmarked,mine])assert.ok(fs.existsSync(run),run);
  live.kill('SIGKILL');await once(live,'exit');
  memoryRun(base);
  assert.equal(fs.existsSync(liveRun),false,'removed once its launcher was killed');
  assert.ok(fs.existsSync(mine),'this process still holds its own run');
 }finally{live.kill('SIGKILL');fs.rmSync(base,{recursive:true,force:true});}
});
