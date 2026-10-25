// Pure ownership/projection core. No filesystem, credential reader or fetch.
import { randomUUID } from 'node:crypto';
const codeError = code => Object.assign(new Error(code), { code });
const fields = ['provider','scope','currency','amountDecimal','observedAt','providerAsOf','freshness','source'];
export function projectAccountBalance(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== fields.length || fields.some(k => !Object.hasOwn(value,k))) throw codeError('invalid-observation');
  if (!['ppq','near'].includes(value.provider) || value.scope !== 'account' || value.currency !== 'USD' || value.source !== 'provider-reported' || value.providerAsOf !== null) throw codeError('invalid-observation');
  if (!['unknown','fresh','stale'].includes(value.freshness)) throw codeError('invalid-observation');
  if (value.freshness === 'unknown') {
    if (value.amountDecimal !== null || value.observedAt !== null) throw codeError('invalid-observation');
  } else if (typeof value.amountDecimal !== 'string' || value.amountDecimal.length > 64 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value.amountDecimal) || typeof value.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt))) throw codeError('invalid-observation');
  return Object.fromEntries(fields.map(k => [k,value[k]]));
}
const unknown = (provider='ppq') => ({provider,scope:'account',currency:'USD',amountDecimal:null,observedAt:null,providerAsOf:null,freshness:'unknown',source:'provider-reported'});

export function createCreditProjection({ provider='ppq', lease = null, balance = null, timeoutMs = 1000, maxAgeMs = 300000, elapsed = () => performance.now() } = {}) {
  if (!['ppq','near'].includes(provider))throw codeError('invalid-configuration');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 3600000 || typeof elapsed !== 'function') throw codeError('invalid-configuration');
  const configured = lease !== null && balance !== null;
  if ((lease === null) !== (balance === null)) throw codeError('invalid-configuration');
  if (configured && (typeof lease.assertCurrent !== 'function' || typeof lease.release !== 'function' || !(lease.signal instanceof AbortSignal) || ['refresh','snapshot','close'].some(k => typeof balance[k] !== 'function'))) throw codeError('invalid-configuration');
  const session = randomUUID(), controller = new AbortController(), owned = new Set();
  let closed = false, closePromise = null, refreshSlot = null, statusSlot = null, lastRefresh = null, lastElapsed = null, observation = unknown(provider);
  const stamp = () => {
    const t = elapsed();
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || (lastElapsed !== null && t < lastElapsed)) throw codeError('invalid-clock');
    lastElapsed = t; return t;
  };
  const valid = () => { if (closed || controller.signal.aborted || lease?.signal.aborted) throw codeError('unavailable'); };
  async function validateLease() {
    try { valid(); if (await lease.assertCurrent(controller.signal) !== true) throw codeError('unavailable'); valid(); }
    catch { close().catch(()=>{}); throw codeError('unavailable'); }
  }
  function envelope(state, account = unknown(provider)) {
    return {version:1,session,state,validForMs:Math.min(timeoutMs,5000),accountBalance:account,allowance:{state:'unknown',reason:'journal-not-bound'},funding:{state:'not-configured'}};
  }
  function operation(fn) {
    let timer, fail;
    const publicResult = new Promise((resolve,reject) => {
      fail = reject;
      timer = setTimeout(() => { reject(codeError('timeout')); close().catch(()=>{}); },timeoutMs);
      const work = Promise.resolve().then(fn);
      owned.add(work);
      work.then(resolve, () => reject(codeError('unavailable'))).finally(() => {clearTimeout(timer);owned.delete(work);});
    });
    const abort = () => fail(codeError('unavailable'));
    controller.signal.addEventListener('abort',abort,{once:true});
    publicResult.then(()=>controller.signal.removeEventListener('abort',abort),()=>controller.signal.removeEventListener('abort',abort));
    // drain remains pending after public timeout; the caller retains its slot.
    const drain = [...owned].at(-1).then(()=>{},()=>{});
    return {public:publicResult,drain};
  }
  function refresh() {
    if (!configured || closed) return Promise.reject(codeError('unavailable'));
    if (refreshSlot) return refreshSlot.public;
    let expired = false;
    const slot = operation(async () => {
      await validateLease();
      await balance.refresh(); valid();
      await validateLease();
      if (!expired) { observation = projectAccountBalance(balance.snapshot()); lastRefresh = stamp(); }
    });
    refreshSlot = slot;
    slot.public.catch(() => { expired = true; observation = {...observation,freshness:observation.amountDecimal === null ? 'unknown':'stale'}; });
    slot.drain.then(()=>{if(refreshSlot === slot) refreshSlot=null;});
    return slot.public;
  }
  function status() {
    if (!configured) return Promise.resolve(envelope('unconfigured'));
    if (closed) return Promise.resolve(envelope('unavailable'));
    if (statusSlot) return statusSlot.public;
    const slot = operation(async () => {
      await validateLease();
      const now = stamp(), account = projectAccountBalance(observation);
      if (account.freshness === 'fresh' && (lastRefresh === null || now-lastRefresh > maxAgeMs)) account.freshness='stale';
      return envelope('configured',account);
    });
    statusSlot = {public:slot.public.catch(()=>{close().catch(()=>{});return envelope('unavailable');}),drain:slot.drain};
    const current = statusSlot;
    slot.drain.then(()=>{if(statusSlot === current) statusSlot=null;});
    return current.public;
  }
  function close() {
    if (closePromise) return closePromise;
    closed = true; observation = unknown(provider); lastRefresh = null;
    closePromise = Promise.resolve().then(async () => {
      controller.abort();
      if (!configured) return;
      // Start monitor abort/drain even if a lease assertion is still pending.
      const results = await Promise.allSettled([Promise.resolve().then(()=>balance.close()),...owned]);
      if (results[0].status === 'rejected') throw codeError('cleanup-failed');
      try { await lease.release(); } catch { throw codeError('cleanup-failed'); }
      lease.signal.removeEventListener('abort',revoked);
    });
    return closePromise;
  }
  const revoked = () => { close().catch(()=>{}); };
  if (configured) { lease.signal.addEventListener('abort',revoked,{once:true}); if(lease.signal.aborted) revoked(); }
  return {status,refresh,close};
}
