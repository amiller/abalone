import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {walletTools} from './pi-wallet.mjs';

const Type = {Object: p => ({type:'object', properties:p}), String: o => ({type:'string', ...o}), Optional: s => s};

test('wallet tools send one JSON request per call and surface service errors', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-wallet-'));
  const socket = path.join(dir, 'wallet.sock'), seen = [];
  const server = net.createServer(c => c.on('data', d => {
    const req = JSON.parse(d);
    seen.push(req);
    c.end(JSON.stringify(req.op === 'send' ? {error:'the operator refused this payment'} : {ok:true, total:'0.5'}) + '\n');
  }));
  await new Promise(r => server.listen(socket, r));
  t.after(() => { server.close(); return fs.rm(dir, {recursive:true}); });
  const tools = Object.fromEntries(walletTools(Type, socket).map(tool => [tool.name, tool]));
  const balance = await tools.wallet_balance.execute('1', {});
  assert.deepEqual(balance.details, {ok:true, total:'0.5'});
  assert.equal(balance.content[0].text, '{"ok":true,"total":"0.5"}');
  await assert.rejects(tools.wallet_send.execute('2', {address:'u1x', amount:'0.1', op:'balance'}), /operator refused/);
  assert.deepEqual(seen, [{op:'balance'}, {address:'u1x', amount:'0.1', op:'send'}]);
  assert.deepEqual(Object.keys(tools.wallet_send.parameters.properties), ['address', 'amount', 'memo']);
});
