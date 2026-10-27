// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { feedAction, posts, memo } from './zecpublish.mjs';

const A = '03bb05e9a53248af4397aff82fd77a28831d4403', B = '7061bd1e519bde10840b4b5c9309e95cceb678c3';
// Shape of the minified actions module in the site's chunk (Next.js 14).
const chunk = `{9923:function(e,t,n){var r=n(8064),i=(0,r.$)("${B}");t.ZP=(0,r.$)("${A}")}}`;

test('feedAction finds the default-export action and refuses none or several', () => {
  assert.equal(feedAction(['x', chunk, chunk]), A);
  assert.throws(() => feedAction(['x']), /found 0/);
  assert.throws(() => feedAction([chunk, chunk.replace(A, B)]), /found 2/);
});

test('posts reads the RSC answer', () => {
  const rsc = `0:["$@1",["build",null]]\n1:{"posts":[{"id":62,"memo":"hi MSG u1x","datetime":"1793141543000","amount":5000,"txid":"aa","likes":0,"reply_zaddr":"u1x","reply_to_post":null,"reply_count":0}]}\n`;
  assert.deepEqual(posts(rsc), [{ id: 62, time: '2026-10-27T22:52:23.000Z', zats: 5000, txid: 'aa', likes: 0, replies: 0, replyTo: null, memo: 'hi MSG u1x' }]);
  assert.throws(() => posts('0:["$@1"]'), /no posts/);
});

test('memos follow the board format', () => {
  assert.equal(memo('post', 'hello'), 'hello');
  assert.equal(memo('reply', 'ab', 'yes'), 'REPLY::ab yes');
  assert.equal(memo('like', 'ab'), 'LIKE::ab');
});
