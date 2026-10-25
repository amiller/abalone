import test from 'node:test';
import assert from 'node:assert/strict';
import {renderLine, startStatusLine} from './status-line.mjs';

const balance = {provider:'ppq', scope:'account', currency:'USD', amountDecimal:'2.5',
  observedAt:'2026-10-15T12:00:00.000Z', providerAsOf:null, freshness:'fresh', source:'provider-reported'};
const fresh = () => ({state:'configured',validForMs:30,accountBalance:{...balance}});
test('account balance is distinct from allowance; stale and malicious values are not amounts', () => {
  assert.match(renderLine(null, fresh()), /Account USD 2\.5/);
  for (const value of [null, {state:'unavailable',accountBalance:balance},
      {state:'configured',accountBalance:{...balance,amountDecimal:'2\u001b[31m'}},
      {state:'configured',accountBalance:{...balance,scope:'spendable'}}]) {
    assert.match(renderLine(null,value), /Credit unknown/);
    assert.doesNotMatch(renderLine(null,value), /\u001b|spendable/);
  }
  assert.match(renderLine(null,{...fresh(),accountBalance:{...balance,freshness:'stale'}}), /Credit stale/);
});
test('expired credit disappears while the next status request is stalled', async () => {
  const lines = []; let calls = 0, release;
  const stalled = new Promise(resolve => { release = resolve; });
  const client = {status:() => ++calls === 1 ? fresh() : stalled, close:async () => { release(null); }};
  const close = startStatusLine({client,readTor:async()=>({tor:{state:'bootstrapped',progress:100},validForMs:1000}),
    write:line=>lines.push(line),intervalMs:5});
  try {
    await new Promise(resolve=>setTimeout(resolve,80));
    assert.ok(lines.some(line=>line.includes('Account USD 2.5')));
    assert.match(lines.at(-1), /Credit unknown/);
    assert.match(lines.at(-1), /Tor 100%/);
    assert.equal(calls,2, 'stalled reads do not accumulate');
  } finally { await close(); }
});

test('trusted NEAR profile notes unchecked GPU revocation before any credit or Tor result; strict admission has no firmware caveat',()=>{assert.match(renderLine(null,null,false,true),/^NEAR GPU revocation not checked \| /);assert.doesNotMatch(renderLine(null,null,false,true),/firmware/);assert.doesNotMatch(renderLine(null,null),/NEAR/);});
