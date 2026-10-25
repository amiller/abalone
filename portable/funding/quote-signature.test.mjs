import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyOneClickQuoteSignature } from './quote-signature.mjs';
const refused = { authenticated: false, coverage: null };
test('bounded JSON-only interface refuses malformed values without reflection', () => {
  for (const value of [undefined, null, {}, 'null', '{}', '[1]', '{', 'x'.repeat(131073), '{"quoteRequest":{"dry":false},"quote":{},"signature":"secret-canary"}']) {
    assert.deepEqual(verifyOneClickQuoteSignature(value), refused);
  }
});
test('no caller signer or status field creates authenticated credit evidence', () => {
  assert.deepEqual(verifyOneClickQuoteSignature(JSON.stringify({ quoteRequest: { dry: false }, quote: {}, signature: '1'.repeat(64), managerPublicKey: '1'.repeat(32), status: 'SUCCESS', creditReady: true })), refused);
});
test('projected nested values are outside the supported wire domain', () => {
  assert.deepEqual(verifyOneClickQuoteSignature(JSON.stringify({ quoteRequest: { dry: false, recipient: {} }, quote: {}, signature: '1'.repeat(64) })), refused);
});
