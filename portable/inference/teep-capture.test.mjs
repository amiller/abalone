// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createTeepCapture} from './teep-capture.mjs';
// The parent of the capture dir is setgid as on the Pi (a setgid TMPDIR supplies it under RestrictSUIDSGID=yes).
// Fake teep: records argv/env like the real one (0600 files in a 0750 timestamped subdir), then runs $1's tail.
function fixture(t,tail){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'teep-capture-'));if(!(fs.statSync(root).mode&0o2000))fs.chmodSync(root,0o2750);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const teep=path.join(root,'teep');
 fs.writeFileSync(teep,`#!/bin/sh\numask 077\nd="$6/neardirect_z-ai_glm-5.3-flash_1"; mkdir -p "$d/responses"\necho "$@" > "$d/report.txt"; env > "$d/responses/env"\necho "teep log line"\n${tail}\n`,{mode:0o755});
 return {teep,dir:path.join(root,'attestation')};
}
const event={state:'admitted',route:'direct',instance:'glm-5-3-flash-i0.completions.near.ai',firmware:'up-to-date',gpuRevocation:'not checked',advisoryIds:['NVIDIA-GPU-REVOCATION-NOT-CHECKED']};
const status=dir=>JSON.parse(fs.readFileSync(path.join(dir,'latest/status.json'),'utf8'));
const mode=p=>fs.statSync(p).mode&0o7777;
test('enforced failure is recorded with the capture shared for offline replay',async t=>{
 const {teep,dir}=fixture(t,'exit 1'),lease=new AbortController();
 const capture=createTeepCapture({readKey:async()=>'synthetic-key',signal:lease.signal,teep,dir});
 const first=capture.start(event);assert.equal(capture.start(event),first);await first;
 const s=status(dir);assert.equal(s.state,'finished');assert.equal(s.exit,1);assert.equal(s.signal,null);assert.equal(s.error,null);
 const sub=path.join(dir,'latest/neardirect_z-ai_glm-5.3-flash_1');
 assert.equal(fs.readFileSync(path.join(sub,'report.txt'),'utf8'),`verify neardirect --model z-ai/glm-5.3-flash --capture ${dir}/latest\n`);
 assert.equal(fs.readFileSync(path.join(dir,'latest/teep.toml'),'utf8'),'[providers.neardirect]\nbase_url = "https://glm-5-3-flash-i0.completions.near.ai"\ne2ee = true\n');
 const {state:_s,...admission}=event;assert.deepEqual(s.admission,admission);
 const env=fs.readFileSync(path.join(sub,'responses/env'),'utf8');
 for(const line of ['NEARAI_API_KEY=synthetic-key','HTTPS_PROXY=socks5h://127.0.0.1:9050','HTTP_PROXY=socks5h://127.0.0.1:9050','NO_PROXY=127.0.0.1,localhost',`TEEP_CONFIG=${dir}/latest/teep.toml`])assert.match(env,new RegExp('^'+line+'$','m'));
 assert.equal(fs.readFileSync(path.join(dir,'latest/teep.log'),'utf8'),'teep log line\n');
 for(const d of [dir,path.join(dir,'latest')])assert.equal(mode(d),0o2750);
 for(const d of [sub,path.join(sub,'responses')])assert.equal(mode(d),0o750);
 for(const f of [dir,sub,path.join(sub,'responses/env')])assert.equal(fs.statSync(f).gid,fs.statSync(path.dirname(dir)).gid);
 for(const f of ['status.json','teep.log','neardirect_z-ai_glm-5.3-flash_1/report.txt'])assert.equal(mode(path.join(dir,'latest',f)),0o640);
});
test('a new admission replaces the previous capture',async t=>{
 const {teep,dir}=fixture(t,'exit 0'),lease=new AbortController();
 const capture=createTeepCapture({readKey:async()=>'k',signal:lease.signal,teep,dir});
 await capture.start(event);fs.writeFileSync(path.join(dir,'latest/stale'),'x');
 const again=createTeepCapture({readKey:async()=>'k',signal:lease.signal,teep,dir});await again.start(event);
 assert.equal(status(dir).exit,0);assert.equal(fs.existsSync(path.join(dir,'latest/stale')),false);
});
test('lock kills a running teep and the kill is reported',async t=>{
 const {teep,dir}=fixture(t,'exec sleep 30'),lease=new AbortController();
 const capture=createTeepCapture({readKey:async()=>'k',signal:lease.signal,teep,dir});
 capture.start(event);await new Promise(r=>setTimeout(r,300));assert.equal(status(dir).state,'running');
 lease.abort();await capture.close();
 const s=status(dir);assert.equal(s.signal,'SIGKILL');assert.match(s.error,/aborted/);
 assert.equal(capture.start(event),null);
});
test('timeout, missing binary and credential failure are reported, not swallowed',async t=>{
 const {teep,dir}=fixture(t,'exec sleep 30'),lease=new AbortController();
 let c=createTeepCapture({readKey:async()=>'k',signal:lease.signal,teep,dir,timeoutMs:200});await c.start(event);
 assert.equal(status(dir).signal,'SIGKILL');assert.match(status(dir).error,/timeout/);
 c=createTeepCapture({readKey:async()=>'k',signal:lease.signal,teep:teep+'-missing',dir});await c.start(event);
 assert.match(status(dir).error,/ENOENT/);
 c=createTeepCapture({readKey:async()=>{throw Error('Inference unavailable')},signal:lease.signal,teep,dir});await c.start(event);
 assert.deepEqual([status(dir).error,status(dir).exit],['Inference unavailable',undefined]);
});
test('a capture that cannot record its status rejects instead of vanishing',async t=>{
 const {teep}=fixture(t,'exit 0'),lease=new AbortController();
 const capture=createTeepCapture({readKey:async()=>'k',signal:lease.signal,teep,dir:path.join(teep,'attestation')});
 await assert.rejects(capture.start(event),/ENOTDIR/);
});
