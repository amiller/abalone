import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createWorkspaceServer} from './server.mjs';

test('PTY persists shell state, accepts interrupt, and refuses foreign commands', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-workspace-'));
  const app = await createWorkspaceServer({workspace});
  try {
    const status = await (await fetch(app.origin + '/api/status')).json();
    const headers = {'Content-Type':'application/json','X-Workspace-Token':status.csrfToken};
    const request = (url, method = 'GET', data, extra = {}) => fetch(app.origin + url, {method, headers:{...headers,...extra}, ...(data === undefined ? {} : {body:JSON.stringify(data)})});
    assert.equal((await request('/api/terminals','POST',{}, {Origin:'https://evil.example'})).status,403);
    assert.equal((await request('/api/terminals','POST',{}, {'X-Workspace-Token':'wrong'})).status,403);
    const rebound = await new Promise(resolve => http.get(app.origin + '/api/status', {headers:{Host:'evil.example'}}, res => { res.resume(); resolve(res.statusCode); }));
    assert.equal(rebound,403);
    assert.equal((await request('/api/status','GET',undefined, {'Sec-Fetch-Site':'cross-site'})).status,403);
    assert.equal((await request('/api/terminals','POST',{input:'x'.repeat(17000)})).status,400);
    const {id} = await (await request('/api/terminals','POST',{})).json();
    const input = value => request(`/api/terminals/${id}/input`,'POST',{input:value});
    let output = '', offset = 0;
    const until = async pattern => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await (await request(`/api/terminals/${id}/output?after=${offset}`)).json();
        output += result.output; offset = result.offset;
        if (pattern.test(output)) return;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.fail(`Expected ${pattern}: ${output}`);
    };
    await until(/workspace \$/);
    await input("printf 'proof' > proof.txt\nexport DEMO_PERSIST=held\n");
    await input("printf '\\nSTATE:%s\\n' \"$DEMO_PERSIST\"\npwd\n");
    await until(/STATE:held/);
    assert.equal(await fs.readFile(path.join(workspace,'proof.txt'),'utf8'),'proof');
    await input('sleep 30\n');
    await new Promise(resolve => setTimeout(resolve,100));
    await input('\u0003');
    await input("printf '\\nINTERRUPTED_OK\\n'\n");
    await until(/\r?\nINTERRUPTED_OK\r?\n/);
    assert.equal((await request(`/api/terminals/${id}`,'DELETE',{})).status,200);
    assert.equal((await request(`/api/terminals/${id}/output`)).status,404);
    assert.equal((await request('/server.mjs')).status,404);
  } finally { await app.close(); await fs.rm(workspace,{recursive:true,force:true}); }
});
