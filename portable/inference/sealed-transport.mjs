// Sealed-transport seam for the portable inference broker.
//
// The broker performs inference egress only through an injected object
// implementing `post({ release, headers, body, signal })`, where `release` is
// the key release returned by the injected reviewed verifier, `headers` and
// `body` are the plaintext provider request (the inference key travels inside
// the sealed envelope, never on any plaintext channel), and the return value
// is `{ status, contentType, stream }` with `stream` a web ReadableStream of
// plaintext bytes the transport has itself sealed-opened. There is no ordinary
// fetch anywhere in this subsystem and no live mode; a production deployment
// injects its own reviewed implementation. The previous source pinned for
// provenance (ppq private-mode 0.7.0 + tinfoil 1.1.11) is historical context
// only: its one-time qualification does not eternally admit any provider, and
// this transport never re-admits anything on its own — admission and key
// release come from the injected verifier per deployment.
//
// This file provides `createLoopbackSealedTransport`, an offline loopback
// implementation of that contract used by the fixtures: it seals with an
// ephemeral X25519 → HKDF-SHA256 → AES-256-GCM envelope to the released key
// and POSTs over an actual Unix domain socket to the fixture TEE
// (testing.mjs). Exactly one POST is made per call. Redirects are never
// followed: any 3xx is refused as `endpoint-redirect`. A response that is not
// a valid sealed record is refused as `unsealed-response` with no fallback.
// The endpoint is snapshotted into immutable primitives at construction:
// mutating the caller's endpoint object afterwards can never redirect the
// next POST, and nothing writable is exposed back. A production HTTP
// transport must use the same fixed-origin closure. Note the credential
// shape is deployment-specific: in the actual EHBP HTTP relay the provider
// credential is a visible relay header; the fixture's sealed-envelope key
// handling is fixture-only and is not a transferable production promise.
import http from 'node:http';
import crypto from 'node:crypto';
import { isAbsolute } from 'node:path';

export class TransportError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'TransportError';
    this.code = code; // 'endpoint-redirect' | 'key-mismatch' | 'unsealed-response' | 'connection-lost' | 'aborted' | 'transport-failed'
  }
}

const MAGIC = Buffer.from('ABIF1', 'ascii');
const hkdfSalt = Buffer.from('abalone-inference-loopback-seal-v1', 'ascii');
const rawPrefix = Buffer.from('302a300506032b656e032100', 'hex');
const rawPublic = key => key.export({ type: 'spki', format: 'der' }).subarray(-32);
const x25519FromRaw = raw => crypto.createPublicKey({ key: Buffer.concat([rawPrefix, raw]), format: 'der', type: 'spki' });
const validKeyId = keyId => typeof keyId === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(keyId);

export function generateLoopbackKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { publicKey, privateKey, publicKeyBase64: rawPublic(publicKey).toString('base64') };
}

// Both sides derive the same AES-256-GCM key from one X25519 exchange:
// the broker side holds the ephemeral private key, the endpoint side holds its
// static private key, and each uses the other side's public half.
function deriveKey(privateKey, peerPublicRaw, keyId) {
  const shared = crypto.diffieHellman({ privateKey, publicKey: x25519FromRaw(peerPublicRaw) });
  return Buffer.from(crypto.hkdfSync('sha256', shared, hkdfSalt, Buffer.from(`seal\0${keyId}`, 'ascii'), 32));
}

// Request envelope: ABIF1 | keyId length | keyId | ephemeral public (32 raw) | nonce (12) | ciphertext || tag(16)
// Returns the envelope bytes plus the ephemeral private key holder, which the
// caller keeps only in memory to open the sealed response records.
export function sealEnvelope(release, plaintext) {
  if (!validKeyId(release?.keyId)) throw new TransportError('transport-failed', 'invalid key release id');
  const peerRaw = Buffer.from(release.publicKeyBase64 ?? '', 'base64');
  if (peerRaw.length !== 32) throw new TransportError('transport-failed', 'invalid released public key');
  const ephemeral = crypto.generateKeyPairSync('x25519');
  const key = deriveKey(ephemeral.privateKey, peerRaw, release.keyId);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const keyIdBytes = Buffer.from(release.keyId, 'ascii');
  const envelope = Buffer.concat([MAGIC, Buffer.from([keyIdBytes.length]), keyIdBytes, rawPublic(ephemeral.publicKey), nonce, ciphertext]);
  return { envelope, ephemeralPrivate: ephemeral.privateKey };
}

// Fixture-endpoint side: open a request envelope with the static private key.
// Returns the plaintext plus the response key derived from the exchange.
export function openEnvelope(staticPrivate, envelope) {
  if (!Buffer.isBuffer(envelope) || envelope.length < MAGIC.length + 1 + 32 + 12 + 16 || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new TransportError('unsealed-response', 'not a sealed envelope');
  }
  const keyIdLength = envelope[MAGIC.length];
  const keyId = envelope.subarray(MAGIC.length + 1, MAGIC.length + 1 + keyIdLength).toString('ascii');
  if (!validKeyId(keyId)) throw new TransportError('unsealed-response', 'invalid sealed key id');
  const offset = MAGIC.length + 1 + keyIdLength;
  const ephemeralRaw = envelope.subarray(offset, offset + 32);
  const nonce = envelope.subarray(offset + 32, offset + 44);
  const tagged = envelope.subarray(offset + 44);
  const key = deriveKey(staticPrivate, ephemeralRaw, keyId);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tagged.subarray(tagged.length - 16));
    const plaintext = Buffer.concat([decipher.update(tagged.subarray(0, tagged.length - 16)), decipher.final()]);
    return { keyId, key, plaintext };
  } catch {
    throw new TransportError('unsealed-response', 'envelope failed authentication');
  }
}

// Response records are base64(nonce || ciphertext || tag) NDJSON lines sealed
// under the request's exchange key.
export function sealRecord(key, plaintext) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

function openRecord(key, line) {
  let record;
  try { record = Buffer.from(String(line), 'base64'); } catch { throw new TransportError('unsealed-response'); }
  if (record.length < 12 + 16 + 1) throw new TransportError('unsealed-response');
  const nonce = record.subarray(0, 12), tag = record.subarray(record.length - 16), ciphertext = record.subarray(12, record.length - 16);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new TransportError('unsealed-response');
  }
}

export function createLoopbackSealedTransport({ endpoint, inferenceKey }) {
  if (!endpoint || typeof endpoint !== 'object'
    || typeof endpoint.socketPath !== 'string' || !isAbsolute(endpoint.socketPath)
    || endpoint.route !== '/v1/chat/completions') {
    throw new Error('Loopback sealed transport requires an exact endpoint {socketPath, route:"/v1/chat/completions"}');
  }
  // Snapshot the endpoint as immutable primitives inside this closure: the
  // caller's object is never retained, so mutating it after construction
  // cannot redirect a later POST, and the public view is frozen read-only.
  const socketPath = endpoint.socketPath;
  const route = endpoint.route;
  if (typeof inferenceKey !== 'string' || inferenceKey.length < 16 || inferenceKey.length > 512) {
    throw new Error('Loopback sealed transport requires a bounded inference key (held only by the broker)');
  }
  const frozenEndpoint = Object.freeze({ socketPath, route });
  return {
    endpoint: frozenEndpoint,
    async post({ release, headers, body, signal }) {
      if (signal?.aborted) throw new TransportError('aborted');
      if (!release || typeof release !== 'object') throw new TransportError('transport-failed', 'missing key release');
      // The plaintext provider request, including the inference key, exists
      // only inside the sealed envelope. It is never logged or exposed.
      const plaintext = JSON.stringify({
        headers: {
          authorization: `Bearer ${inferenceKey}`,
          'content-type': 'application/json',
          ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => name !== 'authorization' && name !== 'content-type')),
        },
        body,
      });
      const { envelope, ephemeralPrivate } = sealEnvelope(release, Buffer.from(plaintext, 'utf8'));

      // Exactly one raw encrypted POST per logical request.
      const { response, key } = await new Promise((resolve, reject) => {
        let settled = false;
        const request = http.request(
          { socketPath, path: route, method: 'POST', headers: { 'content-type': 'application/octet-stream', 'content-length': String(envelope.length) } },
          response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
              response.resume();
              settled = true;
              try { request.destroy(); } catch {}
              reject(new TransportError('endpoint-redirect')); // exact endpoint only; never followed
              return;
            }
            if (response.statusCode === 409) {
              response.resume();
              settled = true;
              try { request.destroy(); } catch {}
              reject(new TransportError('key-mismatch')); // sealed to a key the endpoint does not hold; never re-keyed, never retried
              return;
            }
            if (response.statusCode !== 200) {
              response.resume();
              settled = true;
              try { request.destroy(); } catch {}
              reject(new TransportError('transport-failed', `endpoint status ${response.statusCode}`));
              return;
            }
            settled = true;
            resolve({ response, key: deriveKey(ephemeralPrivate, Buffer.from(release.publicKeyBase64, 'base64'), release.keyId) });
          },
        );
        request.on('error', error => {
          if (settled && !(error instanceof TransportError)) return;
          reject(error instanceof TransportError ? error : new TransportError('connection-lost'));
        });
        signal?.addEventListener('abort', () => {
          try { request.destroy(new TransportError('aborted')); } catch {}
          reject(new TransportError('aborted'));
        }, { once: true });
        request.end(envelope);
      });

      let drainRef = null;
      const stream = new ReadableStream({
        start(controller) {
          let drain;
          let buffer = '', backlog = [], upstreamDone = false, ended = false, failed = null;
          // Explicit bounded relay with backpressure: decrypted records enter a
          // small backlog only while the consumer keeps pulling; a full backlog
          // pauses the endpoint socket until the consumer drains it.
          drain = () => {
            if (failed) return;
            while (backlog.length > 0 && (controller.desiredSize ?? 0) > 0) {
              try { controller.enqueue(openRecord(key, backlog.shift())); }
              catch (error) {
                failed = error;
                try { response.destroy(); } catch {}
                controller.error(error);
                return;
              }
            }
            if (!upstreamDone) {
              if (backlog.length >= 8) response.pause();
              else if (backlog.length <= 4) response.resume();
            } else if (!backlog.length && !ended) {
              ended = true;
              try { controller.close(); } catch {}
            }
          };
          response.on('data', chunk => {
            buffer += chunk.toString('utf8');
            let index;
            while ((index = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, index);
              buffer = buffer.slice(index + 1);
              if (line) backlog.push(line);
            }
            drain();
          });
          response.on('end', () => { upstreamDone = true; drain(); });
          response.on('error', () => {
            if (!failed) { failed = new TransportError('connection-lost'); try { controller.error(failed); } catch {} }
          });
          response.on('close', () => {
            if (!upstreamDone && !failed) {
              failed = new TransportError('connection-lost');
              try { controller.error(failed); } catch {}
              return;
            }
            drain();
          });
          drainRef = drain;
        },
        pull() { drainRef?.(); },
        cancel() { try { response.destroy(); } catch {} },
      });
      return { status: 200, contentType: 'text/event-stream', stream };
    },
  };
}
