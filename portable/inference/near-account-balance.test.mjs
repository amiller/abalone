// SPDX-License-Identifier: MIT
// Offline seams only. File ownership projected; no real account/provider calls.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {registerHooks} from 'node:module';
import {readCredential,readNearAccount} from './direct-zai-broker.mjs';
import {createBalanceMonitor} from '../../lib/provider-balance.mjs';import {createCreditProjection,projectAccountBalance} from '../../lib/provider-credit-projection.mjs';import {validateCredit} from '../workspace/credit-client.mjs';
const hook=registerHooks({resolve(s,c,next){if(s==='./near-session.mjs'&&c.parentURL?.endsWith('/direct-near-entry.mjs'))return {shortCircuit:true,url:'data:text/javascript,export const createNearSession=()=>{throw Error("unused")};'};return next(s,c)}});
const {startNearComputer}=await import('./direct-near-entry.mjs');hook.deregister();
const organizationId='12345678-1234-4234-8234-123456789abc',accessToken='SYNTHETIC_MANAGEMENT_TOKEN',account={organizationId,accessToken};
const record=()=>({version:1,provider:'near',model:'z-ai/glm-5.3-flash',apiKey:'SYNTHETIC_INFERENCE_KEY'});
function fixture(t,value){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'near-account-')),file=dir+'/record';fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});const fd=fs.openSync(file,'r'),stat=fs.fstatSync.bind(fs),ctl=new AbortController();let releases=0;
 t.mock.method(fs,'fstatSync',n=>Object.assign(Object.create(Object.getPrototypeOf(stat(n))),stat(n),n===fd?{uid:972,gid:972}:{}));
 t.after(()=>{fs.closeSync(fd);fs.rmSync(dir,{recursive:true,force:true});});return {fd,signal:ctl.signal,assertCurrent:async s=>!s?.aborted,release:async()=>{releases++},ctl,get releases(){return releases}};}
const payload=(remaining=2000000001)=>({organization_id:organizationId,remaining,total_spent:0,spend_limit:2000000000,unfunded_amount:0});
const monitor=(extra={})=>createBalanceMonitor({provider:'near',getCredential:async()=>account,transport:async()=>({status:200,body:JSON.stringify(payload())}),...extra});
test('optional account stays within lease reader; inference getter returns only API key',async t=>{
 const lease=fixture(t,{...record(),account});assert.equal(await readCredential(lease,'near'),record().apiKey);assert.deepEqual(await readNearAccount(lease),account);assert.equal(typeof await readCredential(lease,'near'),'string');
});
test('key-only record remains valid and has no management authority',async t=>{const lease=fixture(t,record());assert.equal(await readCredential(lease,'near'),record().apiKey);assert.equal(await readNearAccount(lease),null);});
test('wrong account shape/type/provider refuses with fixed error',async t=>{
 const bad=[{...account,refreshToken:'CANARY'},{...account,organizationId:'wrong'},{...account,accessToken:'bad\nheader'},{...account,accessToken:'x'.repeat(8193)}];
 for(const a of bad){const lease=fixture(t,{...record(),account:a});await assert.rejects(readCredential(lease,'near'),{message:'Inference unavailable'});t.mock.restoreAll();}
});
test('Zai record cannot acquire optional NEAR account authority',async t=>{const lease=fixture(t,{version:1,provider:'zai',model:'glm-5.3',apiKey:'SYNTHETIC',account});await assert.rejects(readCredential(lease,'zai'));});
test('NEAR nanos remain exact decimal; real projection/client validation accepts only explicit providers',async()=>{
 let request;const b=monitor({transport:async r=>{request=r;return {status:200,body:JSON.stringify(payload())}}});
 const lease={signal:new AbortController().signal,assertCurrent:async()=>true,release:async()=>{}};const p=createCreditProjection({provider:'near',lease,balance:b});
 await p.refresh();const wire=await p.status(),v=validateCredit(wire);assert.equal(v.accountBalance.amountDecimal,'2.000000001');assert.equal(v.accountBalance.provider,'near');assert.equal(request.method,'GET');assert.equal(request.url,'https://cloud-api.near.ai/v1/organizations/'+organizationId+'/usage/balance');assert.equal(request.headers.authorization,'Bearer '+accessToken);assert.ok(!JSON.stringify(wire).includes(accessToken));assert.throws(()=>projectAccountBalance({...v.accountBalance,provider:'arbitrary'}));await p.close();
});
test('schema mismatch/negative/unsafe nanos refuse; expired access makes prior balance stale',async()=>{
 for(const patch of [{organization_id:'other'},{remaining:-1},{remaining:1.5},{remaining:Number.MAX_SAFE_INTEGER+1},{remaining:'2000000000'}]){const b=monitor({transport:async()=>({status:200,body:JSON.stringify({...payload(),...patch})})});await assert.rejects(b.refresh());assert.equal(b.snapshot().freshness,'unknown');await b.close();}
 let expired=false;const b=monitor({transport:async()=>({status:expired?401:200,body:JSON.stringify(payload())})});await b.refresh();expired=true;await assert.rejects(b.refresh());assert.equal(b.snapshot().freshness,'stale');await b.close();
});
test('missing account remains unknown and never sends inference key to balance transport',async()=>{let calls=0;const b=monitor({getCredential:async()=>null,transport:async()=>{calls++}});await assert.rejects(b.refresh());assert.equal(b.snapshot().provider,'near');assert.equal(b.snapshot().freshness,'unknown');assert.equal(calls,0);await b.close();});
test('single lease owner waits both service drains and HTTP close; delegates cannot release',async t=>{
 const lease=fixture(t,record());let finish,started;const gate=new Promise(r=>finish=r),ready=new Promise(r=>started=r);let creditLease,brokerLease,httpClosed=false;
 const transport=Object.assign(async()=>{}, {close:async()=>{}});
 const computer=await startNearComputer({lease,transport,balanceHTTP:{fetch:async()=>{throw Error('unused')},close:async()=>{httpClosed=true}},startCredit:async opts=>{creditLease=opts.lease;return {refresh:async()=>{},stop:async()=>{await opts.lease.release();}}},startInference:async opts=>{brokerLease=opts.lease;return {stop:async()=>{await opts.lease.release();started();await gate}}}});
 const stopping=computer.stop();await ready;assert.equal(lease.releases,0);assert.notEqual(creditLease,lease);assert.equal(brokerLease,creditLease);finish();await stopping;assert.equal(lease.releases,1);assert(httpClosed);await computer.stop();assert.equal(lease.releases,1);
});
test('partial startup cleans prior service and releases once; failed drain withholds release',async t=>{
 const lease=fixture(t,record());let stopped=0;await assert.rejects(startNearComputer({lease,transport:Object.assign(async()=>{},{close:async()=>{}}),balanceHTTP:{close:async()=>{}},startCredit:async()=>({refresh:async()=>{},stop:async()=>{stopped++}}),startInference:async()=>{throw Error('startup')}}));assert.equal(stopped,1);assert.equal(lease.releases,1);
 const other=fixture(t,record());const c=await startNearComputer({lease:other,transport:Object.assign(async()=>{},{close:async()=>{}}),balanceHTTP:{close:async()=>{}},startCredit:async()=>({refresh:async()=>{},stop:async()=>{throw Error('drain')}}),startInference:async()=>({stop:async()=>{}})});await assert.rejects(c.stop());assert.equal(other.releases,0);
});

function sidecarFixture(t,value){
 const lease=fixture(t,{...record(),account}),dir=fs.mkdtempSync(path.join(os.tmpdir(),'near-sidecar-'));fs.chmodSync(dir,0o700);fs.writeFileSync(dir+'/near-account.json',JSON.stringify(value),{mode:0o600});
 const open=fs.openSync.bind(fs),stat=fs.fstatSync.bind(fs),opened=[];
 t.mock.method(fs,'openSync',(p,...args)=>{if(p==='/run/portable-vault/credit')p=dir;const fd=open(p,...args);if(p===dir || /^\/proc\/self\/fd\/\d+\/near-account.json$/.test(String(p)))opened.push(fd);return fd;});
 t.mock.method(fs,'fstatSync',fd=>{const s=stat(fd);return Object.assign(Object.create(Object.getPrototypeOf(s)),s,{uid:972,gid:972});});
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {lease,opened,dir};
}
test('fixed access-only sidecar overrides same-org expired snapshot and closes actual descriptors',async t=>{
 const value={organizationId,accessToken:'SYNTHETIC_ROTATED_ACCESS'},f=sidecarFixture(t,value);
 assert.deepEqual(await readNearAccount(f.lease),value);assert.equal(await readCredential(f.lease,'near'),record().apiKey);
 for(const fd of f.opened)assert.throws(()=>fs.fstatSync(fd),{code:'EBADF'});
});
test('account B sidecar never displays while account A inference key is active',async t=>{
 const f=sidecarFixture(t,{organizationId:'23456789-1234-4234-8234-123456789abc',accessToken:'SYNTHETIC_B_ACCESS'});
 await assert.rejects(readNearAccount(f.lease),{message:'Inference unavailable'});assert.equal(await readCredential(f.lease,'near'),record().apiKey);
});
test('account request abort never forwards its signal into the inference lease assertion',async t=>{
 const f=sidecarFixture(t,account),request=new AbortController(),seen=[];
 f.lease.assertCurrent=async signal=>{seen.push(signal);request.abort();return true;};
 await assert.rejects(readNearAccount(f.lease,request.signal));assert(seen.length>0);assert(seen.every(signal=>signal===f.lease.signal));assert.equal(f.lease.signal.aborted,false);
});

test('existing background balance monitor recovers 401 without delaying inference startup',async t=>{
 const lease=fixture(t,{...record(),account});let renew,entered,credit,balance,helperCalls=0,gets=0,valid=false,inferenceStarted=false;
 const gate=new Promise(r=>renew=r),started=new Promise(r=>entered=r);
 const computer=await startNearComputer({lease,transport:Object.assign(async()=>{},{close:async()=>{}}),balanceHTTP:{fetch:async()=>{gets++;return {status:valid?200:401,text:async()=>JSON.stringify(payload())}},close:async()=>{}},accountRefresh:{refresh:async()=>{helperCalls++;entered();await gate;valid=true},close:async()=>{}},startCredit:async opts=>{balance=opts.balance;credit={refresh:()=>balance.refresh(),stop:()=>balance.close()};return credit},startInference:async()=>{inferenceStarted=true;return {stop:async()=>{}}}});
 await started;assert.equal(inferenceStarted,true);assert.equal(lease.releases,0);assert.equal(balance.snapshot().freshness,'unknown');renew();
 const end=Date.now()+2000;while(balance.snapshot().freshness!=='fresh'){assert(Date.now()<end);await new Promise(r=>setTimeout(r,5));}
 assert.equal(helperCalls,1);assert.equal(gets,2);await computer.stop();assert.equal(lease.releases,1);
});
test('stop joins account recovery before lease release and sends no post-stop balance request',async t=>{
 const lease=fixture(t,{...record(),account});let entered,finish,gets=0,completed=false;
 const started=new Promise(r=>entered=r),gate=new Promise(r=>finish=r);
 const computer=await startNearComputer({lease,transport:Object.assign(async()=>{},{close:async()=>{}}),balanceHTTP:{fetch:async()=>{gets++;return {status:401,text:async()=>''}},close:async()=>{}},accountRefresh:{refresh:async()=>{entered();await gate;completed=true},close:async()=>{assert.equal(lease.releases,0);finish();await gate}},startCredit:async opts=>({refresh:()=>opts.balance.refresh(),stop:()=>opts.balance.close()}),startInference:async()=>({stop:async()=>{}})});
 await started;await computer.stop();assert(completed);assert.equal(gets,1);assert.equal(lease.releases,1);
});
