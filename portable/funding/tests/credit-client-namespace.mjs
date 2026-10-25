// Run ONLY under the mapped private mount/network namespace wrapper.
import fs from 'node:fs';import path from 'node:path';import {spawn,execFileSync} from 'node:child_process';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
assert.equal(process.getuid(),0);
assert.deepEqual(fs.readFileSync('/proc/self/net/dev','utf8').trim().split('\n').slice(2).map(l=>l.split(':')[0].trim()),['lo']);
execFileSync('/bin/mount',['-t','tmpfs','-o','size=256m,mode=0755','tmpfs','/run']);
const root='/run/credit-proof';fs.mkdirSync(root,{mode:0o755});
const source=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Keep application lib separate from the host /lib bind inside this chroot.
const app=root+'/app';fs.mkdirSync(app,{mode:0o755});
for(const [from,to] of [[process.execPath,root+'/node'],[source+'/credit-service.mjs',app+'/portable/funding/credit-service.mjs'],...['provider-credit-projection.mjs','provider-balance.mjs'].map(n=>[source+'/../../lib/'+n,app+'/lib/'+n]),[source+'/../workspace-service/syscred.mjs',app+'/portable/workspace-service/syscred.mjs'],[source+'/../workspace/credit-client.mjs',app+'/portable/workspace/credit-client.mjs']]){
 fs.mkdirSync(path.dirname(to),{recursive:true,mode:0o755});fs.copyFileSync(from,to);fs.chmodSync(to,to.endsWith('/node')?0o755:0o644);
}
fs.mkdirSync(root+'/socket',{mode:0o755});fs.chownSync(root+'/socket',972,972);
for(const name of ['usr','lib','lib64']) { if(!fs.existsSync('/'+name))continue;fs.mkdirSync(root+'/'+name,{mode:0o755});execFileSync('/bin/mount',['--bind','/'+name,root+'/'+name]); }
fs.mkdirSync(root+'/dev',{mode:0o755});fs.writeFileSync(root+'/dev/null','');execFileSync('/bin/mount',['--bind','/dev/null',root+'/dev/null']);
const address='/socket/credit.sock';
const daemon=`import {startCreditService} from './portable/funding/credit-service.mjs';import {createBalanceMonitor} from './lib/provider-balance.mjs';const revoke=new AbortController();let releases=0;const balance=createBalanceMonitor({getCredential:async()=> 'SYNTHETIC_SECRET',transport:async()=>({status:200,body:'{"balance":2.5}'})});const service=await startCreditService({socketPath:${JSON.stringify(address)},lease:{signal:revoke.signal,assertCurrent:async()=>!revoke.signal.aborted,release:async()=>{releases++;}},balance});process.send('ready');process.on('message',async op=>{if(op==='refresh'){await service.refresh();process.send('refreshed');}if(op==='revoke'){revoke.abort();process.send('revoked');}if(op==='stop'){await service.stop();process.send({stopped:true,releases});process.disconnect();}});`;
fs.writeFileSync(app+'/daemon.mjs',daemon,{mode:0o644});
const child=spawn('/usr/sbin/chroot',['--userspec=972:972',root,'/node','/app/daemon.mjs'],{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe','ipc']});let error='';child.stderr.on('data',b=>error+=b);child.stdout.resume();
const messages=[];let waiter;child.on('message',m=>{if(waiter){const w=waiter;waiter=null;w(m);}else messages.push(m);});
const next=()=>messages.length?Promise.resolve(messages.shift()):new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('daemon deadline '+error)),10000);waiter=m=>{clearTimeout(t);resolve(m);};});
const client=(uid,payload)=>new Promise((resolve,reject)=>{
 const code=`const net=require('node:net');const s=net.connect(${JSON.stringify(address)});let text='';s.on('connect',()=>s.write(${JSON.stringify(payload)}));s.on('data',b=>text+=b);s.on('error',()=>{});s.on('close',()=>process.stdout.write(text));setTimeout(()=>s.destroy(),1500).unref();`;
 const c=spawn('/usr/sbin/chroot',['--userspec='+uid+':'+uid,root,'/node','-e',code],{env:{},stdio:['ignore','pipe','pipe']});let out='';c.stdout.on('data',b=>out+=b);c.stderr.resume();c.on('error',reject);c.on('exit',()=>resolve(out));
});
try {
 assert.equal(await next(),'ready');
 const valid='{"rid":1,"op":"status"}\n';
 const before=JSON.parse(await client(971,valid));assert.equal(before.credit.accountBalance.amountDecimal,null);
 child.send('refresh');assert.equal(await next(),'refreshed');
 const realCode=`import {createCreditClient} from './portable/workspace/credit-client.mjs';const c=createCreditClient({socketPath:'/socket/credit.sock'});const values=await Promise.all([c.status(),c.status()]);if(values[0]!==values[1])throw Error('singleflight lost');console.log(JSON.stringify(values[0]));await c.close();`;
 fs.writeFileSync(app+'/real-client.mjs',realCode,{mode:0o644});
 const actualClient=uid=>new Promise((resolve,reject)=>{const c=spawn('/usr/sbin/chroot',['--userspec='+uid+':'+uid,root,'/node','/app/real-client.mjs'],{env:{},stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>{out+=b;if(out.length>8192)c.kill('SIGKILL');});c.stderr.on('data',b=>err+=b);const timer=setTimeout(()=>c.kill('SIGKILL'),10000);c.on('error',reject);c.on('close',code=>{clearTimeout(timer);code===0?resolve(JSON.parse(out)):reject(Error('actual client failed '+err.slice(0,1000)));});});
 const actual=await actualClient(971);assert.equal(actual.state,'configured');assert.equal(actual.accountBalance.amountDecimal,'2.5');assert.equal(actual.allowance.state,'unknown');assert.ok(actual.validForMs>0 && actual.validForMs<1000);
 assert.equal((await actualClient(970)).state,'unavailable');
 const text=await client(971,valid);assert.ok(!text.includes('SECRET'));assert.equal(JSON.parse(text).credit.accountBalance.amountDecimal,'2.5');
 for(const uid of [970,972,974,0])assert.equal(await client(uid,valid),'');
 for(const request of ['{"rid":1,"op":"refresh"}\n','{"rid":1,"op":"status","uid":971}\n','x'.repeat(257),'{}\n{}\n'])assert.equal(await client(971,request),'');
 const duration=await new Promise((resolve,reject)=>{
  const code=`const net=require('node:net');const start=performance.now();const s=net.connect(${JSON.stringify(address)});let drip;s.on('connect',()=>{drip=setInterval(()=>s.write(' '),100);});s.on('error',()=>{});s.on('close',()=>{clearInterval(drip);process.stdout.write(String(performance.now()-start));});setTimeout(()=>{s.destroy();process.exitCode=2;},4500).unref();`;
  const c=spawn('/usr/sbin/chroot',['--userspec=971:971',root,'/node','-e',code],{env:{},stdio:['ignore','pipe','pipe']});let out='';c.stdout.on('data',b=>out+=b);c.stderr.resume();c.on('error',reject);c.on('exit',code=>code===0?resolve(Number(out)):reject(Error('dribble exceeded deadline')));
 });assert.ok(duration>=1700 && duration<3500);
 child.send('revoke');assert.equal(await next(),'revoked');assert.equal(JSON.parse(await client(971,valid)).credit.state,'unavailable');
 child.send('stop');const stopped=await next();assert.deepEqual(stopped,{stopped:true,releases:1});
 assert.equal((await actualClient(971)).state,'unavailable');
 console.log('PASS real client authenticated UID972, UID971 decimal projection and singleflight, UID970 refusal, stopped service unavailable; actual UID972 owner; kernel UID971 read; UID970/972/974/root denied; malformed/oversize/mutation denied; dribble absolute deadline; synthetic adapter canary absent; revoke unavailable; drained release once.');
}finally {if(child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}}
