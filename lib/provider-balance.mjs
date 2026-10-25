// Fixed PPQ/NEAR provider account observations — display information only.
//
// The success schema handled here — a JSON object whose single key `balance`
// holds a number — comes from a prior sanitized observation of the documented
// POST https://api.ppq.ai/credits/balance endpoint (request body
// {"credit_id": ...}). It is an observation-derived schema, not a provider
// stability guarantee: anything else is rejected, never guessed at.
//
// This module performs no network access and holds no credentials. Both the
// credential getter and the HTTP transport are injected seams; there is no
// default fetch yet. The reported balance is not a spend cap, key allowance
// or proof of spendable credit — it is provider-reported display information.
// A failed refresh never fabricates a value: the previous observation is kept
// (reported stale) or the state stays unknown, and errors are sanitized so no
// credential or raw transport response can reach a caller.

export const ppqBalanceEndpoint = 'https://api.ppq.ai/credits/balance';

const maxCredentialLength = 512;
const maxBodyBytes = 65536;
const plainDecimal = /^\d+(?:\.\d+)?$/;
const unknownSnapshot = (provider='ppq') => ({
  provider, scope: 'account', currency: 'USD', amountDecimal: null,
  observedAt: null, providerAsOf: null, freshness: 'unknown', source: 'provider-reported',
});

// Only a short classifier (and, for HTTP, the numeric status) escapes; the
// original error, its message and the response body are deliberately dropped.
function sanitized(code, httpStatus) {
  const error = new Error(`Provider balance refresh failed (${code})`);
  error.code = code;
  if (Number.isInteger(httpStatus)) error.httpStatus = httpStatus;
  return error;
}

export function createBalanceMonitor({
  provider='ppq', getCredential, transport, now = () => Date.now(), staleAfterMs = 300000, requestTimeoutMs = 10000,
} = {}) {
  if (!['ppq','near'].includes(provider))throw new TypeError('unsupported balance provider');
  if (typeof getCredential !== 'function' || typeof transport !== 'function') {
    throw new TypeError('createBalanceMonitor requires injected getCredential and transport functions (no default fetch exists)');
  }
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0
    || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new RangeError('createBalanceMonitor requires a nonnegative staleAfterMs and a positive integer requestTimeoutMs');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  let inFlight = null;
  let closed = false;
  let closePromise = null;
  function clock() {
    try {
      const value = now();
      return typeof value === 'number' && Number.isFinite(value)
        && Number.isFinite(new Date(value).getTime()) ? value : NaN;
    } catch { return NaN; }
  }
  let observation = null; // { amountDecimal, observedAt } or null
  let refreshFailed = false;

  function snapshot() {
    if (!observation) return unknownSnapshot(provider);
    const age = clock() - Date.parse(observation.observedAt);
    if (!Number.isFinite(age) || age < 0) refreshFailed = true;
    const stale = refreshFailed || age > staleAfterMs;
    return {
      provider, scope: 'account', currency: 'USD',
      amountDecimal: observation.amountDecimal, observedAt: observation.observedAt,
      providerAsOf: null, freshness: stale ? 'stale' : 'fresh', source: 'provider-reported',
    };
  }

  async function performRefresh(signal) {
    const checkCancelled = () => { if (closed || signal.aborted) throw sanitized('cancelled'); };
    checkCancelled();
    const startedAt = clock();
    if (!Number.isFinite(startedAt) || (observation && startedAt < Date.parse(observation.observedAt))) {
      refreshFailed = true;
      throw sanitized('invalid-clock');
    }
    let request;
    try {
      const credential = await getCredential({ signal });
      checkCancelled();
      if(provider==='near') {
        if(!credential || Object.keys(credential).sort().join(',')!=='accessToken,organizationId' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(credential.organizationId) || typeof credential.accessToken!=='string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(credential.accessToken))throw new Error('account unavailable');
        request={url:'https://cloud-api.near.ai/v1/organizations/'+credential.organizationId+'/usage/balance',method:'GET',headers:{authorization:'Bearer '+credential.accessToken,accept:'application/json'},organizationId:credential.organizationId};
      } else {
      const creditId = typeof credential === 'string' ? credential
        : (credential && typeof credential === 'object' && typeof credential.creditId === 'string') ? credential.creditId : null;
      if (!creditId || creditId.length > maxCredentialLength) throw new Error('bad credential shape');
      request = {
        url: ppqBalanceEndpoint, method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ credit_id: creditId }),
      };
      }
    } catch {
      refreshFailed = true;
      throw sanitized('credential-unavailable'); // never echoes the credential
    }

    let response;
    try {
      checkCancelled();
      const call = transport(request, { signal });
      if (!call || typeof call.then !== 'function') throw new Error('transport must return a promise');
      response = await call;
      checkCancelled();
    } catch {
      refreshFailed = true;
      throw sanitized('transport-failed');
    }

    const fail = (code, status) => { refreshFailed = true; throw sanitized(code, status); };
    if (!response || typeof response !== 'object' || Array.isArray(response)
      || !Number.isInteger(response.status) || typeof response.body !== 'string') fail('invalid-response');
    if (response.status !== 200) fail('http-status', response.status);
    if (Buffer.byteLength(response.body) > maxBodyBytes) fail('invalid-schema');
    let parsed;
    try { parsed = JSON.parse(response.body); } catch { fail('invalid-schema'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid-schema');
    let amountDecimal;
    if(provider==='near') {
      if(parsed.organization_id!==request.organizationId || ['remaining','total_spent','spend_limit','unfunded_amount'].some(k=>!Number.isSafeInteger(parsed[k]) || parsed[k]<0))fail('invalid-schema');
      const nanos=BigInt(parsed.remaining);amountDecimal=(nanos/1000000000n).toString()+'.'+(nanos%1000000000n).toString().padStart(9,'0');
    } else {
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== 'balance') fail('invalid-schema');
    const balance = parsed.balance;
    // Strict nonnegative decimal: finite, >= 0, and representable as a plain
    // decimal string (JSON exponent forms like 1e+21 are refused, not coerced).
    if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0
      || !plainDecimal.test(String(balance))) fail('invalid-schema');

    amountDecimal=String(balance);
    }

    const observedAt = clock();
    if (!Number.isFinite(observedAt) || observedAt < startedAt) fail('invalid-clock');
    checkCancelled();
    observation = { amountDecimal, observedAt: new Date(observedAt).toISOString() };
    refreshFailed = false;
    return snapshot();
  }

  // Public deadline covers credential acquisition AND transport. Retain the
  // ownership slot until the underlying operation settles, even after timeout.
  // A transport must settle only after its owned I/O is closed/drained.
  function refresh() {
    if (closed) return Promise.reject(sanitized('closed'));
    if (inFlight) return inFlight.public;
    const controller = new AbortController();
    let resolve, reject;
    const visible = new Promise((yes, no) => { resolve = yes; reject = no; });
    const attempt = { controller, public: visible, reject, drain: null };
    inFlight = attempt; // Installed before trusted callbacks or abort listeners.
    const timer = setTimeout(() => {
      refreshFailed = true;
      // Reject first so synchronous abort callbacks cannot replace timeout.
      reject(sanitized('timeout'));
      controller.abort();
    }, requestTimeoutMs);
    const finish = () => {
      clearTimeout(timer);
      if (inFlight === attempt) inFlight = null;
    };
    attempt.drain = Promise.resolve().then(() => performRefresh(controller.signal)).then(
      value => { finish(); resolve(value); },
      error => { finish(); reject(error); },
    );
    return visible;
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    refreshFailed = true;
    const attempt = inFlight;
    // Memoize before abort dispatch: reentrant close sees the same drain.
    closePromise = Promise.resolve().then(async () => {
      if (!attempt) return;
      attempt.reject(sanitized('closed'));
      attempt.controller.abort();
      await attempt.drain;
    });
    return closePromise;
  }

  return { snapshot, refresh, close };
}
