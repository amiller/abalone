// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import inspect from './fixtures/scripts/intools.mjs';
const result = (introduction) => inspect([
  {role:'system',content:`${introduction}\n\nWorkspace folder: /data/portable-pi/project.\n<tool_call>OP\nSession usage, from abalone's accounting\n"sent to" line from measured state\nNever describe yourself as Pi`},
  {role:'user',content:'who are you'},
]).text;
test('workspace Pi spelling is not a persona assertion', () => {
  assert.equal(result('You are abalone, a private research agent.'), 'system prompt: abalone=true protocol=true usage=true sentto=true pi=false');
});
test('fixture still detects Pi self-description', () => {
  assert.match(result('You are Pi, a coding agent.'), /abalone=false .*pi=true$/);
});
