// Streaming Unix HTTP client for a supervisor-selected inference broker.
//
// This is the seam a future real Pi SDK provider registration will use (the
// pattern of agents/pi/coupon-provider.ts + lib/coupon-socket.mjs, with no
// coupon-admission dependency): `inferenceSocketFetch(socketPath, options)`
// returns a fetch-compatible function the SDK's OpenAI completions API can be
// driven with (`{ ...options, fetch: send, maxRetries: 0 }`).
//
// The caller holds no credential: it presents only the fixed dummy
// authorization token the broker expects, plus a logical request id used for
// at-most-once transmission and duplicate refusal. The response body is a
// genuine incremental stream (not buffered) so delayed upstream chunks arrive
// delayed, with pull-based backpressure: the broker only relays while this
// side keeps reading. Aborting the caller's signal cancels the request; the
// broker treats any post-transmission cancel as outcome-unknown and the
// reservation stays consumed, so a cancel can never be retried for free.
import http from 'node:http';

// Dummy credential: the raw inference key exists only inside the broker.
export const INFERENCE_DUMMY_AUTH = 'Bearer inference-broker-session';
export const INFERENCE_REQUEST_HEADER = 'x-inference-request-id';

const fail = () => new Error('The private inference broker is unavailable. Do not retry the same logical request id.');

export function inferenceSocketFetch(socketPath, { requestId, signal, timeoutMs = 600_000, maxResponseBytes = 8 * 1024 * 1024 } = {}) {
  if (typeof socketPath !== 'string' || !socketPath) throw new Error('socketPath is required');
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(requestId)) throw new Error('requestId must match ^[A-Za-z0-9_-]{16,64}$');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) throw new Error('timeoutMs out of range');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1024) throw new Error('maxResponseBytes out of range');
  const requestPath = '/v1/chat/completions';
  return async (url, init) => {
    if (init?.signal?.aborted || signal?.aborted) throw fail();
    const pathname = new URL(url ?? requestPath, 'http://inference-broker.invalid').pathname;
    if (pathname !== requestPath) throw new Error(`The scoped inference socket serves only ${requestPath}`);
    const body = init?.body;
    if (typeof body !== 'string' || body.length === 0) throw new Error('A JSON request body is required');
    const response = await new Promise((resolve, reject) => {
      const request = http.request({
        socketPath, path: requestPath, method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: INFERENCE_DUMMY_AUTH,
          accept: 'text/event-stream',
          [INFERENCE_REQUEST_HEADER]: requestId,
        },
      }, r => resolve(r));
      const abort = () => { try { request.destroy(fail()); } catch {} };
      const timer = setTimeout(abort, timeoutMs); timer.unref();
      const callerAbort = () => abort();
      init?.signal?.addEventListener('abort', callerAbort, { once: true });
      signal?.addEventListener('abort', callerAbort, { once: true });
      request.on('error', () => reject(fail()));
      request.on('close', () => {
        clearTimeout(timer);
        init?.signal?.removeEventListener('abort', callerAbort);
        signal?.removeEventListener('abort', callerAbort);
      });
      request.end(body);
    });
    let bytes = 0, destroyed = false;
    // Incremental, pull-based relay of the broker's SSE stream: the broker's
    // socket is only read while this side keeps consuming, so a paused caller
    // applies backpressure through the whole chain.
    let drainRef = null;
    const stream = new ReadableStream({
      start(controller) {
        let drain;
        const backlog = [];
        let ended = false;
        drain = () => {
          while (backlog.length > 0 && (controller.desiredSize ?? 0) > 0) {
            const chunk = backlog.shift();
            bytes += chunk.length;
            if (bytes > maxResponseBytes) {
              destroyed = true;
              try { response.destroy(); } catch {}
              controller.error(new Error('The inference broker response exceeded its bound'));
              return;
            }
            controller.enqueue(chunk);
          }
          if (backlog.length >= 8) response.pause();
          else if (backlog.length <= 4) response.resume();
          if (ended && backlog.length === 0) { try { controller.close(); } catch {} }
        };
        response.on('data', chunk => { backlog.push(chunk); drain(); });
        response.on('end', () => {
          ended = true;
          drain();
        });
        response.on('error', () => { try { controller.error(fail()); } catch {} });
        response.on('close', () => {
          if (!destroyed && !response.complete && !ended) { try { controller.error(fail()); } catch {} }
          else if (ended && backlog.length === 0) { try { controller.close(); } catch {} }
        });
        drainRef = drain;
      },
      pull() { drainRef?.(); },
      cancel() { try { response.destroy(); } catch {} },
    });
    // HTTP errors remain HTTP responses so SDKs preserve safe API messages.
    const contentType = String(response.headers['content-type'] ?? 'text/event-stream');
    return new Response(stream, { status: response.statusCode ?? 502, headers: { 'content-type': contentType } });
  };
}

// Fixture/test helper: decode an SSE response into its data payloads in
// arrival order (with timestamps), so delayed streams are observable.
export async function readSseEvents(response) {
  const text = await response.text();
  const events = [];
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { events.push({ done: true }); continue; }
        try { events.push(JSON.parse(payload)); } catch { events.push({ raw: payload }); }
      }
    }
  }
  return events;
}
