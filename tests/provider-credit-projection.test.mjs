import {test} from 'node:test';import assert from 'node:assert/strict';
import {createCreditProjection} from '../lib/provider-credit-projection.mjs';
import {createBalanceMonitor} from '../lib/provider-balance.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
function fixture(extra={}) {
  const revoke=new AbortController();let releases=0,posts=0;
  const balance=createBalanceMonitor({getCredential:async()=> 'SECRET_CANARY',transport:async()=>{posts++;return {status:200,body:'{"balance":7.5}'};}});
  const lease={signal:revoke.signal,assertCurrent:async()=>true,release:async()=>{releases++;}};
  const p=createCreditProjection({lease,balance,...extra});
  return {p,revoke,lease,balance,releases:()=>releases,posts:()=>posts};
}
test('unknown default; read status never acquires credit or creates account',async()=>{
 const p=createCreditProjection();const s=await p.status();assert.equal(s.state,'unconfigured');assert.equal(s.accountBalance.amountDecimal,null);assert.deepEqual(s.funding,{state:'not-configured'});await assert.rejects(p.refresh());await p.close();
});
test('real balance adapter only exposes account total and separate unknown allowance',async()=>{
 const f=fixture();assert.equal((await f.p.status()).accountBalance.freshness,'unknown');assert.equal(f.posts(),0);
 await f.p.refresh();const s=await f.p.status();assert.equal(s.accountBalance.amountDecimal,'7.5');assert.equal(s.accountBalance.scope,'account');assert.equal(s.allowance.state,'unknown');assert.equal(s.funding.state,'not-configured');assert.ok(!JSON.stringify(s).includes('SECRET'));await f.p.close();assert.equal(f.releases(),1);
});
test('revocation immediately removes cached amount; release follows actual monitor drain',async()=>{
 const f=fixture();await f.p.refresh();let drain;f.balance.close=()=>new Promise(r=>{drain=r;});f.revoke.abort();
 assert.equal((await f.p.status()).accountBalance.amountDecimal,null);await tick();assert.equal(f.releases(),0);const close=f.p.close();drain();await close;assert.equal(f.releases(),1);
});
test('lease loss during refresh never publishes and closes authority',async()=>{
 let checks=0;const revoke=new AbortController();let released=0;
 const f=fixture({lease:{signal:revoke.signal,assertCurrent:async()=>++checks===1,release:async()=>{released++;}}});
 await assert.rejects(f.p.refresh());assert.equal((await f.p.status()).state,'unavailable');await f.p.close();assert.equal(released,1);
});
test('deadline returns unavailable while retained assertion prevents release and overlap',async()=>{
 const f=fixture({timeoutMs:20});let release,checks=0;f.lease.assertCurrent=()=>{checks++;return new Promise(r=>{release=r;});};
 const s=await f.p.status();assert.equal(s.state,'unavailable');const close=f.p.close();let done=false;close.then(()=>done=true);await tick();assert.equal(done,false);assert.equal(f.releases(),0);assert.equal((await f.p.status()).state,'unavailable');assert.equal(checks,1);
 release(true);await close;assert.equal(f.releases(),1);
});
test('extra secret fields and malformed adapter schema cannot escape',async()=>{
 const f=fixture();f.balance.snapshot=()=>({SECRET:'CANARY'});await assert.rejects(f.p.refresh());const s=await f.p.status();assert.equal(s.accountBalance.amountDecimal,null);assert.ok(!JSON.stringify(s).includes('CANARY'));await f.p.close();
});
test('monotonic age downgrades cached balance and rollback refuses status',async()=>{
 let elapsed=0;const f=fixture({elapsed:()=>elapsed,maxAgeMs:10});await f.p.refresh();elapsed=11;assert.equal((await f.p.status()).accountBalance.freshness,'stale');elapsed=2;assert.equal((await f.p.status()).state,'unavailable');await f.p.close();
});
test('failed monitor cleanup retains lease and repeated close shares rejection',async()=>{
 const f=fixture();f.balance.close=async()=>{throw Error('SECRET');};const a=f.p.close(),b=f.p.close();assert.equal(a,b);await assert.rejects(a,{code:'cleanup-failed'});assert.equal(f.releases(),0);assert.equal((await f.p.status()).state,'unavailable');
});
test('status request coalesces assertion while trusted refresh stays off wire',async()=>{
 const f=fixture();let finish,n=0;f.lease.assertCurrent=()=>{n++;return new Promise(r=>finish=r);};const a=f.p.status(),b=f.p.status();assert.equal(a,b);await tick();assert.equal(n,1);finish(true);await a;assert.equal(f.posts(),0);await f.p.close();
});

for (const failure of ['false','throw']) test(`cached balance is irrevocably cleared on second lease assertion ${failure}`,async()=>{
 const f=fixture();await f.p.refresh();assert.equal((await f.p.status()).accountBalance.amountDecimal,'7.5');
 let assertions=0,drain,monitorClosed=0;
 f.balance.close=()=>{monitorClosed++;return new Promise(resolve=>{drain=resolve;});};
 f.lease.assertCurrent=async()=>{assertions++;if(assertions===2){if(failure==='throw')throw Error('SECRET_LEASE_ERROR');return false;}return true;};
 await assert.rejects(f.p.refresh());await tick();
 assert.equal(monitorClosed,1);assert.equal(f.releases(),0);
 f.lease.assertCurrent=async()=>true;
 for(let i=0;i<2;i++){const status=await f.p.status();assert.equal(status.state,'unavailable');assert.equal(status.accountBalance.amountDecimal,null);assert.ok(!JSON.stringify(status).includes('SECRET'));}
 await assert.rejects(f.p.refresh());
 const close=f.p.close();let finished=false;close.then(()=>{finished=true;});await tick();assert.equal(finished,false);
 drain();await close;assert.equal(f.releases(),1);assert.equal(monitorClosed,1);
 assert.equal((await f.p.status()).accountBalance.amountDecimal,null);
});
