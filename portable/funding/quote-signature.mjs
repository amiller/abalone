// Signed-field projection adapted from @defuse-protocol/one-click-sdk-typescript
// 0.1.26. Copyright (c) 2025 NEAR Foundation. ISC: see quote-signature.LICENSE.
// Provenance and deliberately limited coverage: quote-signature.PROVENANCE.md.
import { createHash, createPublicKey, verify } from 'node:crypto';

const MANAGER_KEY = 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const REQUIRED_REQUEST = ['dry', 'swapType', 'slippageTolerance', 'originAsset', 'depositType', 'destinationAsset', 'amount', 'refundTo', 'refundType', 'recipient', 'recipientType', 'deadline'];
const OPTIONAL_REQUEST = ['quoteWaitingTimeMs', 'referral', 'virtualChainRecipient', 'virtualChainRefundRecipient', 'customRecipientMsg'];
const AMOUNTS = ['amountIn', 'amountInFormatted', 'amountInUsd', 'minAmountIn', 'amountOut', 'amountOutFormatted', 'amountOutUsd', 'minAmountOut'];
const EXECUTION = ['depositAddress', 'depositMemo', 'deadline', 'timeWhenInactive', 'timeEstimate', 'refundFee', 'withdrawFee'];

function decode58(text, length) {
  if (typeof text !== 'string') throw new Error('encoding');
  const value = text.startsWith('ed25519:') ? text.slice(8) : text;
  if (!value.length || value.length > 100) throw new Error('encoding');
  let n = 0n;
  for (const char of value) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error('encoding');
    n = n * 58n + BigInt(digit);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const bytes = Buffer.concat([Buffer.alloc(value.match(/^1*/)[0].length), n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex')]);
  if (bytes.length !== length) throw new Error('length');
  return bytes;
}
function encode58(bytes) {
  let n = BigInt('0x' + bytes.toString('hex')), result = '';
  while (n) { result = ALPHABET[Number(n % 58n)] + result; n /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; result = '1' + result; }
  return result;
}
function primitive(value) {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new Error('unsupported projected value');
}
function project(response) {
  const request = response?.quoteRequest, quote = response?.quote;
  if (!request || Array.isArray(request) || typeof request !== 'object' || typeof request.dry !== 'boolean' || !quote || typeof quote !== 'object' || Array.isArray(quote)) throw new Error('shape');
  const fields = {};
  for (const key of REQUIRED_REQUEST) fields[key] = primitive(request[key]);
  for (const key of OPTIONAL_REQUEST) fields[key] = primitive(request[key] || undefined);
  for (const key of AMOUNTS) fields[key] = primitive(quote[key]);
  // Match SDK spread ordering: returned quote.deadline replaces request.deadline,
  // including removal when absent. Independent request validation is mandatory.
  if (!request.dry) for (const key of EXECUTION) fields[key] = primitive(quote[key] || undefined);
  fields.timestamp = primitive(response.timestamp);
  return fields;
}
function signedMessage(response) {
  const fields = project(response);
  // For primitive-valued projected JSON this is json-stable-stringify's exact
  // lexicographic key order and JSON.stringify value encoding, without deps.
  const canonical = '{' + Object.keys(fields).sort().filter(key => fields[key] !== undefined).map(key => JSON.stringify(key) + ':' + JSON.stringify(fields[key])).join(',') + '}';
  return Buffer.from(encode58(createHash('sha256').update(canonical, 'utf8').digest()), 'utf8');
}
const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), decode58(MANAGER_KEY, 32)]), format: 'der', type: 'spki' });

/** Authenticate only the SDK 0.1.26 projected fields against its pinned signer.
 * Input is bounded JSON text, never an object with executable getters/toJSON.
 * No freshness, payment approval, status or credit proof is established here.
 */
export function verifyOneClickQuoteSignature(responseJson) {
  try {
    if (typeof responseJson !== 'string' || Buffer.byteLength(responseJson, 'utf8') > 131072) throw new Error('input');
    const response = JSON.parse(responseJson);
    const message = signedMessage(response);
    const authenticated = verify(null, message, key, decode58(response.signature, 64));
    return { authenticated, coverage: authenticated ? (response.quoteRequest.dry ? 'oneclick-0.1.26-dry-projection' : 'oneclick-0.1.26-issued-projection') : null };
  } catch { return { authenticated: false, coverage: null }; }
}
