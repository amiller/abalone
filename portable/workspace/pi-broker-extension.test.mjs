import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {statusText, waitingText, answerText, usageText, admissionText, sessionText, filesText} from './pi-broker-extension.mjs';

const vaultMount = '36 25 0:40 / /run/portable-vault rw - ext4 /dev/mapper/vault rw\n';
const otherMount = '24 1 0:22 / /run rw - tmpfs tmpfs rw\n';
const status = (tor, credit) => ({desktop:{tor}, credit});
const balance = freshness => ({state:'configured', accountBalance:{amountDecimal:'3.994669068', freshness}});

test('status line shows Tor, vault and credit in ASCII', () => {
  assert.equal(statusText(status({state:'bootstrapped',progress:100}, balance('fresh')), otherMount + vaultMount), 'Tor ok | Vault unlocked | Credit $3.99');
  assert.equal(statusText(status({state:'starting',progress:45}, {state:'unknown'}), otherMount), 'Tor 45% | Vault locked | Credit unknown');
  assert.equal(statusText(status({state:'stopped',progress:null}, balance('stale')), otherMount), 'Tor stopped | Vault locked | Credit $3.99 (stale)');
  assert.throws(() => statusText({agent:{}}, otherMount), TypeError);
});

test('waiting and answer text', () => {
  assert.equal(waitingText(12), 'Waiting for the encrypted answer over Tor | 12s');
  assert.equal(answerText(41, {usage:{input:2104, output:312}}), 'Last answer 41s, 312 tokens');
});

const assistant = (input, output) => ({type:'message', message:{role:'assistant', usage:{input, output, cacheRead:5000}}});
test('usage line in plain words, without cache figures', () => {
  assert.equal(usageText([assistant(9000, 2000), {type:'message', message:{role:'user'}}, assistant(400, 800)], {percent:11.4, contextWindow:32768}), 'Tokens: 9.4k sent, 2.8k received | context 11% of 33k');
  assert.equal(usageText([], {percent:null, contextWindow:32768}), 'Tokens: 0 sent, 0 received | context ? of 33k');
  assert.equal(usageText([], undefined), 'Tokens: 0 sent, 0 received | context ? of ?');
});

test('session line comes from the session file pi reports', () => {
  const file = '/run/portable-vault/agent/sessions/2026-10-23T18-30-00-000Z_019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5b.jsonl';
  assert.equal(sessionText({getSessionFile: () => undefined}), 'Session: NOT SAVED (RAM only, gone at exit)');
  assert.equal(sessionText({getSessionFile: () => file}), 'Session: SAVED to vault: 2026-10-23T18-30-00-000Z_019a1b2c-3d4e-7f00-8a9b-0c1d2e3f4a5b.jsonl');
  assert.ok(sessionText({getSessionFile: () => file}).length <= 100);
  for (const other of ['/run/portable-pi-x/agent/sessions/a.jsonl', '/run/portable-vault/agent/a.jsonl', '/run/portable-vault/agent/sessions/sub/a.jsonl'])
    assert.equal(sessionText({getSessionFile: () => other}), `Session: SAVED to ${other} (NOT the vault)`);
});

test('files line says whether the working directory is on the vault', () => {
  assert.equal(filesText('/run/portable-vault/agent/files'), 'Files: KEPT in vault, /run/portable-vault/agent/files');
  assert.equal(filesText('/run/portable-workspace'), 'Files: NOT KEPT, /run/portable-workspace is not the vault');
});

const admitted = {route:'direct', instance:'glm-5-3-flash-i0.completions.near.ai', firmware:'up-to-date', gpuRevocation:'not checked', advisoryIds:['NVIDIA-GPU-REVOCATION-NOT-CHECKED']};
test('TEE wording comes only from the recorded admission', () => {
  assert.deepEqual(admissionText({admission:admitted}), {route:'direct i0, attested', tee:'TEE: model firmware up to date | GPU revocation not checked'});
  assert.deepEqual(admissionText({admission:{...admitted, firmware:'out-of-date', gpuRevocation:'checked', advisoryIds:['INTEL-SA-01313', 'INTEL-SA-01192']}}).tee, 'TEE: model firmware OUT OF DATE (2 Intel advisories) | GPU revocation checked');
  assert.deepEqual(admissionText({}), {route:'not admitted', tee:'TEE: no admission yet'});
  assert.deepEqual(admissionText({error:'EACCES'}), {route:'not admitted', tee:'TEE: admission record unreadable (EACCES)'});
  for (const bad of [{...admitted, route:'gateway'}, {...admitted, firmware:'fine'}, {...admitted, gpuRevocation:undefined}, {...admitted, instance:'cloud-api.near.ai'}])
    assert.deepEqual(admissionText({admission:bad}), {route:'not admitted', tee:'TEE: unrecognized admission record'});
});

test('extension wires spinner, plain footer, guide and the waiting timer', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-ext-'));
  t.after(() => fs.rm(dir, {recursive:true}));
  for (const name of ['pi-broker-extension.mjs', 'agent-guide.md']) await fs.copyFile(new URL(name, import.meta.url), path.join(dir, name));
  await fs.writeFile(path.join(dir, 'broker-provider.mjs'), "export const createBrokerProvider = async (sdk, socket) => ({id:'portable-broker', socket});\n");
  // The admission record path is fixed; serve it through a mocked readFile.
  let record = null;
  const readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...rest) => {
    if (file !== '/run/portable-inference/attestation/latest/status.json') return readFile(file, ...rest);
    if (record === null) throw Object.assign(Error('missing'), {code:'ENOENT'});
    return JSON.stringify(record);
  });
  const fetches = [];
  t.mock.method(globalThis, 'fetch', async url => { fetches.push(url); return Response.json(status({state:'bootstrapped',progress:100}, balance('fresh'))); });
  t.mock.timers.enable({apis:['setInterval']});

  const handlers = {}, ui = {messages:[], notes:[]};
  let renders = 0;
  const entries = [assistant(9000, 2000)];
  const ctx = {model:{provider:'portable-broker', name:'NEAR GLM-5.3 Flash'}, sessionManager:{getEntries: () => entries, getSessionFile: () => undefined}, getContextUsage: () => ({percent:11, contextWindow:32768}), ui:{
    setWorkingIndicator: value => { ui.indicator = value; },
    setFooter: factory => { ui.footer = factory({requestRender: () => renders++}, {}, {}); },
    setWorkingMessage: text => ui.messages.push(text),
    notify: text => ui.notes.push(text),
  }};
  const pi = {registerProvider: p => { ui.provider = p; }, on: (name, fn) => { handlers[name] = fn; }};
  await (await import(path.join(dir, 'pi-broker-extension.mjs'))).default(pi);
  const footer = (width = 100) => ui.footer.render(width);

  assert.deepEqual(ui.provider, {id:'portable-broker', socket:'/run/portable-inference/near.sock'});
  await handlers.session_start({}, ctx);
  assert.deepEqual(ui.indicator.frames, ['|', '/', '-', '\\']);
  assert.deepEqual(fetches, ['http://127.0.0.1:8765/api/status']);
  assert.deepEqual(ui.notes, [], 'no startup warning: the footer carries the admitted status');
  assert.ok(renders > 0);
  const lines = footer();
  assert.equal(lines.length, 5);
  assert.equal(lines.shift(), filesText(process.cwd()));
  assert.equal(lines.shift(), 'Session: NOT SAVED (RAM only, gone at exit)');
  assert.equal(lines[0], 'Tokens: 9.0k sent, 2.0k received | context 11% of 33k');
  assert.match(lines[1], /^Tor ok \| Vault (un)?locked \| Credit \$3\.99 \| NEAR GLM-5\.3 Flash \(not admitted\)$/);
  assert.equal(lines[2], 'No answer yet | TEE: no admission yet');
  assert.deepEqual(footer(20).map(l => l.length <= 20), [true, true, true, true, true]);

  const {systemPrompt} = handlers.before_agent_start({systemPrompt:'BASE'}, ctx);
  assert.match(systemPrompt, /^BASE\n[\s\S]*Zkool[\s\S]*\/run\/portable-vault\/agent\/sessions[\s\S]*\n- This run: Files: [^;]+; Session: NOT SAVED \(RAM only, gone at exit\)\n$/);

  handlers.before_provider_request({}, ctx);
  t.mock.timers.tick(1000);
  assert.equal(ui.messages.length, 2);
  for (const message of ui.messages) assert.match(message, /^Waiting for the encrypted answer over Tor \| \d+s$/);
  handlers.tool_execution_start({toolName:'bash'}, ctx);
  assert.equal(ui.messages.at(-1), 'Running bash on the Pi');
  record = {state:'finished', admission:admitted};
  entries.push(assistant(400, 312));
  handlers.message_end({message:{role:'assistant', usage:{input:400, output:312}}}, ctx);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.messages.at(-1), undefined);
  const after = footer().slice(2);
  assert.equal(after[0], 'Tokens: 9.4k sent, 2.3k received | context 11% of 33k');
  assert.match(after[1], /\| NEAR GLM-5\.3 Flash \(direct i0, attested\)$/);
  assert.match(after[2], /^Last answer \d+s, 312 tokens \| TEE: model firmware up to date \| GPU revocation not checked$/);
  for (const line of after) assert.ok(/^[\x20-\x7e]*$/.test(line) && line.length <= 100, line);
  const count = ui.messages.length;
  t.mock.timers.tick(3000);
  assert.equal(ui.messages.length, count, 'timer stops after the answer');

  t.mock.method(globalThis, 'fetch', async () => new Response('', {status:503}));
  t.mock.timers.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(footer()[3], /^Status error: status service HTTP 503 \| /);
  handlers.session_shutdown();
});
