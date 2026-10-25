import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {zats, zec, approvalReason, promptText, jwtSigner, wallet} from './agent-wallet.mjs';

const cap = {mode:'cap', perSpendZec:'0.001', sessionZec:'0.0025'};
const roomy = {mode:'cap', perSpendZec:'1', sessionZec:'1'};
const TXID = 'ab'.repeat(32);

test('amounts are exact zatoshis', () => {
  assert.equal(zats('1'), 1e8);
  assert.equal(zats('0.00010000'), 10000);
  assert.equal(zec(10000), '0.0001');
  assert.equal(zec(1e8), '1');
  for (const bad of ['1e-4', '-1', '0.123456789', '', '.5']) assert.throws(() => zats(bad), /not a ZEC amount/);
});

test('approval policy', () => {
  assert.equal(approvalReason({mode:'approve'}, 0, 1), 'every payment needs approval');
  assert.equal(approvalReason(cap, 0, 100000), null);
  assert.match(approvalReason(cap, 0, 100001), /per-payment cap of 0.001/);
  assert.match(approvalReason(cap, 200000, 60000), /session cap of 0.0025 ZEC \(0.002 ZEC already sent\)/);
  assert.throws(() => approvalReason({mode:'auto'}, 0, 1), /unknown approval mode: auto/);
});

test('prompt shows amount, fee, destination, memo and reason', () => {
  const text = promptText({amount:'0.002', fee:'0.0001', address:'utest1abc', memo:'coffee', reason:'every payment needs approval'});
  for (const part of ['Amount  0.002 ZEC', 'Fee     0.0001 ZEC', 'To      utest1abc', 'Memo    coffee', 'Why     every payment needs approval', 'y = send']) assert.ok(text.includes(part), part);
  assert.ok(/^[\x00-\x7e]+$/.test(text), 'ASCII only for the console font');
});

test('JWT is ES256 over the published key', () => {
  const s = jwtSigner();
  const [h, p, sig] = s.token().split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), {alg:'ES256', typ:'JWT'});
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).sub, 0);
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), {key:s.publicPem, dsaEncoding:'ieee-p1363'}, Buffer.from(sig, 'base64url')));
});

function fakeZkool({fee = '0.0001', payTo, broadcast = TXID} = {}) {
  const calls = [];
  const gql = async (query, vars) => {
    const name = query.match(/\{(\w+)/)[1];
    calls.push(name);
    return {
      synchronizeAccount: {synchronizeAccount: 100},
      prepareSend: {prepareSend: 'pczt-hex'},
      decodePczt: {decodePczt: {fee, recipients: [{address: payTo ?? vars?.p?.recipients?.[0]?.address ?? 'utest1dest', value: '0.00100000'}, {address:'utest1change', value:'0.5'}]}},
      signTx: {signTx: 'tx-hex'},
      broadcastTx: {broadcastTx: broadcast},
      balanceByAccount: {balanceByAccount: {height:100, total:'0.5'}},
    }[name];
  };
  return {gql, calls};
}
const approver = answers => {
  const shown = [];
  return {shown, approve: async text => { shown.push(text); const ok = answers.shift(); return {ok, why: ok ? null : 'the operator refused this payment', finish: async line => shown.push(line)}; }};
};
const pay = {op:'send', address:'utest1dest', amount:'0.001', memo:'hi'};

test('approve mode: sends only after the operator says yes, refuses on no', async () => {
  const z = fakeZkool(), a = approver([false, true]);
  const w = wallet({gql:z.gql, id:1, policy:{mode:'approve'}, approve:a.approve});
  await assert.rejects(w(pay), /operator refused/);
  assert.ok(!z.calls.includes('signTx'), 'refused payment is never signed');
  assert.deepEqual(await w(pay), {txid:TXID, amount:'0.001', fee:'0.0001', approvedBy:'operator'});
  assert.match(a.shown[0], /Amount  0.001 ZEC[\s\S]*To      utest1dest[\s\S]*Memo    hi/);
  assert.deepEqual(a.shown.filter(s => !s.includes('===')), ['Not sent: the operator refused this payment', `Sent. txid ${TXID}`]);
});

test('cap mode: below cap goes without prompt, above per-payment or session cap prompts', async () => {
  const z = fakeZkool(), a = approver([true, true]);
  const w = wallet({gql:z.gql, id:1, policy:{mode:'cap', perSpendZec:'0.0011', sessionZec:'0.0025'}, approve:a.approve});
  assert.equal((await w(pay)).approvedBy, 'cap');
  assert.equal((await w(pay)).approvedBy, 'cap');
  assert.equal(a.shown.length, 0);
  assert.equal((await w(pay)).approvedBy, 'operator');
  assert.match(a.shown[0], /session cap of 0.0025 ZEC \(0.0022 ZEC already sent\)/);
  assert.equal((await w({...pay, amount:'0.002'}).catch(e => e.message)), 'the planned transaction does not pay 0.002 ZEC to utest1dest: {"fee":"0.0001","recipients":[{"address":"utest1dest","value":"0.00100000"},{"address":"utest1change","value":"0.5"}]}');
  assert.equal((await w({op:'balance'})).policy.sessionSentZec, '0.0033');
});

test('rejected broadcasts and mismatched plans are errors, not sends', async () => {
  const w = wallet({gql:fakeZkool({broadcast:'tx unpaid action limit exceeded'}).gql, id:1, policy:roomy, approve:null});
  await assert.rejects(w(pay), /lightwalletd rejected the transaction: tx unpaid action limit exceeded/);
  const w2 = wallet({gql:fakeZkool({payTo:'utest1evil'}).gql, id:1, policy:roomy, approve:null});
  await assert.rejects(w2(pay), /does not pay 0.001 ZEC to utest1dest/);
  await assert.rejects(w2({op:'send', address:'utest1dest', amount:0.001}), /send needs address and amount/);
  await assert.rejects(w2({op:'seed'}), /unknown op: seed/);
});
