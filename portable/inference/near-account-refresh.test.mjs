// SPDX-License-Identifier: MIT
// Actual child processes only; no account credentials or network operations.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';
import {createAccountRefresh} from './near-account-refresh.mjs';
test('fixed helper runs once concurrently and returns no account contents',async()=>{
 let calls=0;const recovery=createAccountRefresh({spawnProcess:(command,args,options)=>{calls++;assert.equal(command,'/usr/bin/python3');assert.deepEqual(args,['-I','-B','/opt/portable/portable/funding/account-refresh.py']);return spawn(process.execPath,['-e',"process.stdout.write('ACCOUNT_REFRESHED\\n')"],options);}});
 const first=recovery.refresh();assert.equal(recovery.refresh(),first);await first;assert.equal(calls,1);await recovery.close();await assert.rejects(recovery.refresh());
});
test('close cancels and waits actual delayed helper cleanup/reap before resolving',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'account-drain-')),ready=dir+'/ready',drained=dir+'/drained';t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let child;
 const code=`const fs=require('fs');process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(${JSON.stringify(drained)},'yes');process.exit(1)},100));fs.writeFileSync(${JSON.stringify(ready)},'yes');setInterval(()=>{},1000);`;
 const recovery=createAccountRefresh({spawnProcess:(c,a,o)=>(child=spawn(process.execPath,['-e',code],o))});const job=recovery.refresh();job.catch(()=>{});
 const end=Date.now()+5000;while(!fs.existsSync(ready)){assert(Date.now()<end);await new Promise(r=>setTimeout(r,5));}
 let done=false;const closing=recovery.close().then(()=>{done=true});await new Promise(r=>setTimeout(r,30));assert.equal(done,false);await closing;assert(fs.existsSync(drained));assert(!fs.existsSync('/proc/'+child.pid));await assert.rejects(job,{message:'Account refresh unavailable'});
});
test('unexpected/oversized child output is drained and never echoed in failure',async()=>{
 let child;const recovery=createAccountRefresh({spawnProcess:(c,a,o)=>(child=spawn(process.execPath,['-e',"process.stdout.write('SYNTHETIC_SECRET_CANARY'.repeat(100));setInterval(()=>{},1000)"],o)),killDelayMs:100});
 await assert.rejects(recovery.refresh(),error=>error.message==='Account refresh unavailable'&&!error.message.includes('CANARY'));assert(!fs.existsSync('/proc/'+child.pid));await recovery.close();
});
