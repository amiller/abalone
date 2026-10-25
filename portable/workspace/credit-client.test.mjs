import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createCreditClient,validateCredit} from './credit-client.mjs';
import {createWorkspaceServer} from './server.mjs';
const envelope=()=>({version:1,session:randomUUID(),state:'configured',validForMs:5000,accountBalance:{provider:'ppq',scope:'account',currency:'USD',amountDecimal:'2.50',observedAt:'2026-10-15T00:00:00.000Z',providerAsOf:null,freshness:'fresh',source:'provider-reported'},allowance:{state:'unknown',reason:'journal-not-bound'},funding:{state:'not-configured'}});
test('strict public projection preserves decimal and separates balance from allowance',()=>{
 const p=validateCredit(envelope());assert.equal(p.accountBalance.amountDecimal,'2.50');assert.equal(p.allowance.state,'unknown');assert.equal(p.funding.state,'not-configured');
 for(const change of [v=>v.secret='canary',v=>v.allowance.amount=5,v=>v.accountBalance.extra='canary',v=>v.validForMs=Infinity,v=>v.session='bad',v=>v.accountBalance.amountDecimal='1e9',v=>v.accountBalance.currency='ZEC',v=>v.funding.state='ready',v=>v.state='unavailable']){const v=envelope();change(v);assert.throws(()=>validateCredit(v));}
});
test('absent configuration is honest; non-UI caller cannot access configured service',async()=>{
 const absent=createCreditClient();assert.equal((await absent.status()).state,'unconfigured');await absent.close();
 assert.notEqual(process.getuid(),971);const wrong=createCreditClient({socketPath:'/run/does-not-exist-credit.sock'});assert.equal((await wrong.status()).state,'unavailable');await wrong.close();
 assert.throws(()=>createCreditClient({socketPath:'relative.sock'}));
});
test('API carries strict credit even when agent backend unavailable; no refresh operation',async()=>{
 let calls=0;const app=await createWorkspaceServer({workspace:'/run/disposable-credit-test',backend:{request:async()=>{throw Error('offline');},close:async()=>{}},creditProjection:{status:async()=>{calls++;return envelope();},close:async()=>{}}});
 try{const v=await (await fetch(app.origin+'/api/status')).json();assert.equal(v.terminalAvailable,false);assert.equal(v.credit.accountBalance.amountDecimal,'2.50');assert.equal(v.credit.allowance.state,'unknown');assert.ok(v.credit.validForMs<5000);assert.equal(calls,1);}finally{await app.close();}
});
test('API rejects extra projection fields and bounds hanging credit without hiding terminal status',async()=>{
 let hanging=false;const app=await createWorkspaceServer({workspace:'/run/disposable-credit-test',backend:{request:async()=>({terminalAvailable:true}),close:async()=>{}},creditProjection:{status:()=>hanging?new Promise(()=>{}):Promise.resolve({...envelope(),secret:'CANARY'}),close:async()=>{}}});
 try {let v=await (await fetch(app.origin+'/api/status')).json();assert.equal(v.credit.state,'unavailable');assert.ok(!JSON.stringify(v).includes('CANARY'));hanging=true;const start=performance.now();v=await (await fetch(app.origin+'/api/status')).json();assert.equal(v.terminalAvailable,true);assert.equal(v.credit.state,'unavailable');assert.ok(performance.now()-start<2200);}finally{await app.close();}
});
test('backend wait after the credit observation expires a short lease',async()=>{
 // Deferred gate: the backend status reply only starts its delay once the
 // credit observation has resolved, so the wait deducted is deterministically
 // the post-observation tail (900ms) against a 400ms lease.
 let observedResolve;const creditObserved=new Promise(r=>observedResolve=r);
 const v=envelope();v.validForMs=400;
 const app=await createWorkspaceServer({workspace:'/run/disposable-credit-test',backend:{request:async op=>{if(op!=='status')return{};await creditObserved;await new Promise(r=>setTimeout(r,900));return {terminalAvailable:true};},close:async()=>{}},creditProjection:{status:async()=>{try{return v;}finally{observedResolve();}},close:async()=>{}}});
 try{const data=await(await fetch(app.origin+'/api/status')).json();assert.equal(data.terminalAvailable,true);assert.equal(data.credit.state,'unavailable');assert.equal(data.credit.accountBalance,null);}finally{await app.close();}
});
test('delayed credit read keeps its remaining lease; only the post-observation wait is deducted',async()=>{
 // The projection spends 600ms of its own read latency and then reports a
 // 3000ms lease remaining AFTER that read (what credit-client.status returns).
 // The server must not deduct the 600ms again: only the gated 150ms backend
 // tail plus the desktop read may come off the returned remainingTTL.
 const lease=3000,readLatency=600,backendTail=150;
 let observedResolve;const creditObserved=new Promise(r=>observedResolve=r);
 const app=await createWorkspaceServer({workspace:'/run/disposable-credit-test',backend:{request:async op=>{if(op!=='status')return{};await creditObserved;await new Promise(r=>setTimeout(r,backendTail));return {terminalAvailable:true};},close:async()=>{}},creditProjection:{status:async()=>{await new Promise(r=>setTimeout(r,readLatency));const v=envelope();v.validForMs=lease;observedResolve();return v;},close:async()=>{}}});
 try{const v=await(await fetch(app.origin+'/api/status')).json();assert.equal(v.terminalAvailable,true);assert.equal(v.credit.accountBalance.amountDecimal,'2.50');assert.ok(v.credit.validForMs>2550,`earlier read latency must survive; got remaining ${v.credit.validForMs} of ${lease}`);assert.ok(v.credit.validForMs<lease,`post-observation wait must still be deducted; got ${v.credit.validForMs} of ${lease}`);}finally{await app.close();}
 assert.throws(()=>createCreditClient({socketPath:'/run/bad\0socket'}));
});
test('credit cleanup rejection cannot skip backend/HTTP drain; close is shared',async()=>{
 let backendClosed=0,creditClosed=0;const app=await createWorkspaceServer({workspace:'/run/disposable-credit-test',backend:{request:async()=>({}),close:async()=>{backendClosed++;}},creditProjection:{status:async()=>envelope(),close:async()=>{creditClosed++;throw Error('failed');}}});
 const first=app.close();assert.equal(app.close(),first);await assert.rejects(first,/cleanup failed/);assert.equal(backendClosed,1);assert.equal(creditClosed,1);await assert.rejects(fetch(app.origin+'/api/status'));
});

test('HTTP status refuses a fractional remainder rounded down to zero',async t=>{
 let now=0, releaseCredit;
 const creditReleased=new Promise(resolve=>releaseCredit=resolve);
 t.mock.method(performance,'now',()=>now);
 const app=await createWorkspaceServer({workspace:'/run/disposable-credit-test',backend:{request:async()=>{
   await creditReleased;
   // Let readCredit capture its resolution timestamp before advancing the clock.
   await new Promise(resolve=>setImmediate(resolve));
   now=0.5;
   return {terminalAvailable:true};
 },close:async()=>{}},creditProjection:{status:async()=>{
   releaseCredit();return {...envelope(),validForMs:1};
 },close:async()=>{}}});
 try {
   const data=await(await fetch(app.origin+'/api/status')).json();
   assert.equal(data.terminalAvailable,true);
   assert.equal(data.credit.state,'unavailable');
   assert.equal(data.credit.accountBalance,null);
 }finally{await app.close();t.mock.restoreAll();}
});
