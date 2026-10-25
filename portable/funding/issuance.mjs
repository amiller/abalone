// Funding instruction issuance — durable intent before a non-idempotent call.
//
// This adapter records a validated issuance intent in an owned private
// directory BEFORE invoking an injected, non-idempotent quote transport, then
// saves the validated response or an uncertain outcome before any public
// success. The transport is called at most once per attempt and is never
// retried automatically: a timeout, a transport error, or a quote that fails
// validation is ambiguous (the provider may already have acted), so it is
// recorded as `uncertain` and every later load reports needs-reconciliation
// without another provider POST. Reopening the journal resumes the same
// accepted instruction idempotently.
//
// Quote failures are validated conservatively: receiving an invalid or
// mismatched quote does not establish that the provider did nothing, so it can
// never by itself yield a definitive refusal or permit an automatic new
// attempt. `refused` — the only resolved outcome that allows a new attempt —
// requires the injected refusal validator to return positively validated
// provider no-side-effect evidence; without that evidence the reconciliation
// obligation stays.
//
// Settlement stages are distinct: `bridge-success` (a bridge receipt) and
// `invoice-settled` (an invoice receipt) never become spendable credit by
// themselves, and an account balance total is display information only —
// funding success is never inferred from a balance. `provider-credit-ready`
// is reachable only through `recordCreditProof` with an injected, positively
// validated offline proof that explicitly correlates the invoice receipt with
// the exact credited account/reference, the credited amount, and an
// observation that is not older than the settlement it proves, not forged
// from the future, and sufficiently recent on the supervisor clock. If that
// provenance cannot be supplied, the attempt stays `invoice-settled`; no
// spendable-ready claim is fabricated. Wallet seeds, provider credentials and
// raw transport responses are never stored or projected: the journal keeps
// only validated recovery references and payment instruction fields.
//
// Durability reuses the shared persistent kernel lock primitive
// (`holdJournalLock` from portable/credit-journal): a kernel-held flock on the
// persistent payment.flock inode whose lifetime equals the writer's, an
// atomic fsynced rename of a freshly created private temporary file, and a
// 1MiB size cap enforced identically on read and before every commit. Reads
// open O_NOFOLLOW|O_NONBLOCK and validate that the state file is an owned
// private regular file with no hard links. A missing journal directory is an
// error, never an empty journal: only a missing state file inside a validated
// directory means no instruction has been recorded. Existence locks with
// age/PID deletion are not used anywhere.

import { open, rename, unlink, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { holdJournalLock } from '../credit-journal/journal.mjs';

const maxStateBytes = 1048576;
const stateFileName = 'issuance.json';
// No legitimate asset amount in integer base units needs more digits than
// 2^256 (~1.16e77); the bound is checked BEFORE BigInt() so an abusive
// digit string is refused cheaply instead of being parsed into a giant value.
const maxAmountDigits = 78;

const outcomeReasons = {
  uncertain: new Set(['timeout', 'transport-error', 'interrupted', 'mismatched-quote', 'invalid-quote']),
  // Positive definitive refusal only: the injected refusal validator supplied
  // validated provider evidence that the request was refused with no side
  // effects. Nothing else may resolve an attempt as refused.
  refused: new Set(['no-side-effect-refusal']),
};
// A new funding attempt may start only after a definitively resolved one.
const newAttemptAllowed = new Set(['refused', 'provider-credit-ready']);
// Receipts alone are not spendable credit; `uncertain` (and a reopened
// `intent`/`requested` mark, which cannot prove the POST never happened), plus
// every invalid or mismatched quote, blocks every automatic reissue until an
// operator reconciles.
const needsReconciliation = new Set(['intent', 'requested', 'uncertain']);
const instructionPhases = new Set(['quoted', 'bridge-success', 'invoice-settled', 'provider-credit-ready']);
const plainDecimal = /^\d+(?:\.\d+)?$/;
// A credited amount must be strictly positive: zero credit never proves a
// funded invoice, whatever the surrounding shape looks like.
const positiveDecimal = value => plainDecimal.test(value) && /[1-9]/.test(value);
const bounded = value => typeof value === 'string' && value.length > 0 && value.length <= 2048;

// Intent projection: exactly the expected assets in integer base units plus
// refund/recipient references. Extra fields are dropped; callers must not put
// credentials or wallet seeds inside these allowed reference strings.
function intentFields(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid issuance intent');
  for (const name of ['id', 'refundRef', 'recipientRef']) {
    if (!bounded(value[name])) throw new Error(`Invalid issuance intent ${name}`);
  }
  if (!Array.isArray(value.assets) || value.assets.length === 0 || value.assets.length > 16) {
    throw new Error('Invalid issuance intent assets');
  }
  const assets = value.assets.map(entry => {
    if (!entry || typeof entry !== 'object' || !bounded(entry.asset)
      || typeof entry.amountBaseUnits !== 'string' || !/^\d+$/.test(entry.amountBaseUnits)
      || entry.amountBaseUnits.length > maxAmountDigits
      || BigInt(entry.amountBaseUnits) <= 0n) throw new Error('Invalid issuance intent amount (positive integer base units required)');
    return { asset: entry.asset, amountBaseUnits: entry.amountBaseUnits };
  });
  if (new Set(assets.map(a => a.asset)).size !== assets.length) throw new Error('Duplicate asset in issuance intent');
  return { id: value.id, assets, refundRef: value.refundRef, recipientRef: value.recipientRef };
}

// Payment instruction projection: only these bounded fields may ever be
// persisted or exposed from a validated quote — never the raw provider
// response, which may contain secrets.
function instructionFields(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid payment instruction');
  const allowed = ['address', 'asset', 'amount', 'uri', 'memo', 'expiresAt'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error('Payment instruction carries unexpected fields');
  for (const key of ['address', 'asset', 'amount']) if (!bounded(value[key])) throw new Error(`Invalid payment instruction ${key}`);
  for (const key of ['uri', 'memo', 'expiresAt']) if (value[key] !== undefined && !bounded(value[key])) throw new Error(`Invalid payment instruction ${key}`);
  if (value.expiresAt !== undefined && !Number.isFinite(Date.parse(value.expiresAt))) throw new Error('Invalid payment instruction expiry');
  return Object.fromEntries(allowed.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
}

// Credit-provenance projection: exactly the explicit correlation fields the
// injected proof validator may return — the exact credited account/reference,
// a strictly positive credited amount, the observation timestamp and a bounded
// evidence reference. This shape is deliberately incompatible with the public
// balance snapshot of lib/provider-balance.mjs: an account balance total
// is display information and can never be accepted as funding evidence.
//
// The invariants here are timeless so event replay stays a pure function of
// the journal (a committed proof must never stop replaying as it ages). The
// clock-dependent checks — the observation must not be forged from the future
// and must be sufficiently recent on the supervisor clock — are enforced at
// commit time in verifyCreditProof.
function creditProvenanceFields(value, settledAtMs) {
  if (!value || typeof value !== 'object') throw new Error('Invalid funding credit provenance');
  if (!bounded(value.accountRef) || !bounded(value.evidenceRef)) throw new Error('Invalid funding credit provenance reference');
  if (typeof value.creditedAmountDecimal !== 'string' || !positiveDecimal(value.creditedAmountDecimal)) {
    throw new Error('Funding credit provenance requires a strictly positive credited amount');
  }
  if (typeof value.observedAt !== 'string' || !bounded(value.observedAt)) throw new Error('Invalid funding credit provenance timestamp');
  const observedAtMs = Date.parse(value.observedAt);
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(settledAtMs)) throw new Error('Invalid funding credit provenance timestamp');
  if (observedAtMs < settledAtMs) throw new Error('Credit provenance observation predates the invoice settlement it claims to prove');
  return {
    accountRef: value.accountRef,
    creditedAmountDecimal: value.creditedAmountDecimal,
    observedAt: value.observedAt,
    evidenceRef: value.evidenceRef,
  };
}

// Event replay: the single source of truth for the snapshot's attempt object.
export function replayEvents(events) {
  let attempt = null;
  const ids = new Set();
  for (const event of events) {
    if (!event || !bounded(event.at) || !Number.isFinite(Date.parse(event.at))) throw new Error('Invalid issuance event');
    switch (event.kind) {
      case 'record-intent': {
        const intent = intentFields(event.intent);
        if (ids.has(intent.id) || (attempt && !newAttemptAllowed.has(attempt.phase))) throw new Error('Conflicting issuance attempt');
        ids.add(intent.id);
        attempt = { id: intent.id, intent, phase: 'intent' };
        break;
      }
      case 'mark-requested': {
        if (!attempt || attempt.id !== event.id || attempt.phase !== 'intent' || !bounded(event.id)) throw new Error('Invalid issuance transition');
        attempt = { ...attempt, phase: 'requested' };
        break;
      }
      case 'mark-outcome': {
        if (!attempt || attempt.id !== event.id || attempt.phase !== 'requested' || !bounded(event.id)) throw new Error('Invalid issuance transition');
        const outcome = event.outcome;
        if (!outcome || typeof outcome !== 'object') throw new Error('Invalid issuance outcome');
        if (outcome.kind === 'quoted') {
          attempt = { ...attempt, phase: 'quoted', instruction: instructionFields(outcome.instruction) };
        } else if (outcome.kind === 'uncertain') {
          if (!outcomeReasons.uncertain.has(outcome.reason)) throw new Error('Invalid issuance outcome reason');
          attempt = { ...attempt, phase: 'uncertain', reason: outcome.reason };
        } else if (outcome.kind === 'refused') {
          // A definitive refusal always carries its validated no-side-effect
          // evidence reference; replay refuses anything else.
          if (!outcomeReasons.refused.has(outcome.reason) || !bounded(outcome.evidenceRef)) throw new Error('Invalid issuance outcome reason');
          attempt = { ...attempt, phase: 'refused', reason: outcome.reason, evidenceRef: outcome.evidenceRef };
        } else throw new Error('Invalid issuance outcome kind');
        break;
      }
      case 'observe-bridge':
      case 'observe-invoice': {
        if (!attempt || attempt.id !== event.id || !bounded(event.id) || !bounded(event.evidenceRef)) throw new Error('Invalid issuance evidence event');
        const from = event.kind === 'observe-bridge' ? 'quoted' : 'bridge-success';
        const to = event.kind === 'observe-bridge' ? 'bridge-success' : 'invoice-settled';
        if (attempt.phase !== from) throw new Error(`Invalid issuance transition ${attempt.phase} -> ${to}`);
        attempt = event.kind === 'observe-bridge'
          ? { ...attempt, phase: to }
          : { ...attempt, phase: to, invoiceEvidenceRef: event.evidenceRef, settledAt: event.at };
        break;
      }
      case 'record-credit-proof': {
        if (!attempt || attempt.id !== event.id || !bounded(event.id) || attempt.phase !== 'invoice-settled') {
          throw new Error('Provider credit requires an invoice-settled instruction and a verified credit proof');
        }
        attempt = {
          ...attempt,
          phase: 'provider-credit-ready',
          provenance: creditProvenanceFields(event.provenance, Date.parse(attempt.settledAt)),
        };
        break;
      }
      default: throw new Error('Invalid issuance event kind');
    }
  }
  return attempt;
}

function validate(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.events)
    || !Number.isSafeInteger(state.revision) || state.revision < 0
    || state.revision !== state.events.length) throw new Error('Invalid issuance journal');
  if (JSON.stringify(replayEvents(state.events)) !== JSON.stringify(state.attempt)) {
    throw new Error('Issuance snapshot disagrees with history');
  }
  return state;
}

function project(attempt) {
  if (!attempt) return { id: null, phase: 'none', status: 'no-instruction', paymentInstruction: null };
  return {
    id: attempt.id,
    phase: attempt.phase,
    status: needsReconciliation.has(attempt.phase) ? 'needs-reconciliation' : attempt.phase,
    paymentInstruction: instructionPhases.has(attempt.phase) ? attempt.instruction : null,
  };
}

async function checkDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)
    || await realpath(directory) !== directory) throw new Error('Issuance journal requires an owned private directory without symlinks');
}

const timeoutMark = Symbol('quote-timeout');

export class FundingIssuance {
  constructor({
    directory, validator, refusalValidator, proofValidator, quoteTransport,
    now = () => Date.now(), quoteTimeoutMs = 30000, proofFreshAfterMs = 300000,
  }) {
    if (typeof validator !== 'function') throw new TypeError('FundingIssuance requires an injected pure quote validator');
    if (typeof refusalValidator !== 'function') throw new TypeError('FundingIssuance requires an injected refusal validator (there is no default definitive refusal)');
    if (typeof proofValidator !== 'function') throw new TypeError('FundingIssuance requires an injected credit-proof validator (there is no default funding proof)');
    if (typeof quoteTransport !== 'function') throw new TypeError('FundingIssuance requires an injected quote transport');
    if (!Number.isInteger(quoteTimeoutMs) || quoteTimeoutMs <= 0) throw new RangeError('quoteTimeoutMs must be a positive integer');
    if (!Number.isInteger(proofFreshAfterMs) || proofFreshAfterMs < 0) throw new RangeError('proofFreshAfterMs must be a nonnegative integer');
    this.directory = resolve(directory);
    this.validator = validator;
    this.refusalValidator = refusalValidator;
    this.proofValidator = proofValidator;
    this.quoteTransport = quoteTransport;
    this.now = now;
    this.quoteTimeoutMs = quoteTimeoutMs;
    this.proofFreshAfterMs = proofFreshAfterMs;
  }

  async read() {
    // A missing or invalid directory is an error, never an empty journal: a
    // wrong path must not silently read as "no instruction was issued". Only
    // a missing state file inside a validated directory means that.
    await checkDirectory(this.directory);
    try {
      // O_NONBLOCK so a substituted FIFO cannot hang open(); fstat then refuses
      // it as a non-regular file. Reads are capped at 1MiB before parsing.
      const file = await open(join(this.directory, stateFileName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.nlink !== 1) {
          throw new Error('Issuance journal requires an owned private regular file');
        }
        if (info.size > maxStateBytes) throw new Error('Issuance journal exceeds the 1MiB read limit');
        const buffer = Buffer.alloc(maxStateBytes);
        const { bytesRead } = await file.read(buffer, 0, maxStateBytes, 0);
        return validate(JSON.parse(buffer.toString('utf8', 0, bytesRead)));
      } finally { await file.close(); }
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, revision: 0, attempt: null, events: [] };
      throw error; // Corruption must never be treated as an empty journal.
    }
  }

  // All writes happen under the shared kernel-held lock with the same
  // discipline as portable/credit-journal: synchronous boolean callback,
  // revalidate the complete serialized snapshot and its 1MiB cap before any
  // file is created, atomic rename of an fsynced private temporary, fsync of
  // the directory. A refused write leaves the previous committed file intact.
  async mutate(change) {
    const release = await holdJournalLock(this.directory);
    const temporary = join(this.directory, `.issuance-${randomUUID()}.tmp`);
    try {
      const state = await this.read();
      const before = state.events.length;
      const changed = change(state);
      if (changed !== null && typeof changed === 'object' && typeof changed.then === 'function') {
        throw new Error('mutate callback must return a synchronous boolean, not a promise or thenable');
      }
      if (typeof changed !== 'boolean') throw new Error('mutate callback must return a boolean');
      if (!changed) return state;
      // A claimed change must append at least one event; the revision always
      // equals the history length so a reopened journal can re-derive it.
      if (state.events.length <= before) throw new Error('A committed mutation must append at least one event');
      state.revision = state.events.length;
      const serialized = JSON.stringify(state) + '\n';
      if (Buffer.byteLength(serialized) > maxStateBytes) throw new Error('Mutation would exceed the 1MiB issuance journal limit');
      validate(JSON.parse(serialized));
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(serialized); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, join(this.directory, stateFileName));
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return state;
    } finally {
      try { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
      finally { await release(); }
    }
  }

  push(state, event) {
    state.events.push({ ...event, at: new Date(this.now()).toISOString() });
    state.attempt = replayEvents(state.events); // canonical; throws before any write on invalid history
  }

  async status() {
    return project((await this.read()).attempt);
  }

  // Issues a funding instruction. The validated intent is durably recorded
  // (with the single request mark) BEFORE the transport is invoked, and the
  // outcome is durably recorded before any public success. The transport is
  // non-idempotent and is called at most once per attempt, never retried.
  async issue(value) {
    const next = intentFields(value);
    let started = false;
    await this.mutate(state => {
      const current = state.attempt;
      if (current && current.id === next.id) {
        if (JSON.stringify(current.intent) !== JSON.stringify(next)) {
          throw new Error('Issuance ID reused with different intent details');
        }
        return false; // idempotent resume: never a second provider POST
      }
      if (current && !newAttemptAllowed.has(current.phase)) return false; // active or unresolved attempt blocks
      this.push(state, { kind: 'record-intent', intent: next });
      this.push(state, { kind: 'mark-requested', id: next.id });
      started = true;
      return true;
    });
    if (!started) {
      const current = (await this.read()).attempt;
      if (current && current.id !== next.id && !newAttemptAllowed.has(current.phase)) {
        throw new Error('An active or unresolved funding attempt must be reconciled before issuing another instruction');
      }
      return project(current); // same id: idempotent resume, refusal or needs-reconciliation
    }

    let outcome;
    try {
      const quote = await this.callTransportOnce(next);
      outcome = this.classifyQuote(next, quote);
    } catch (error) {
      // Ambiguous: the provider may or may not have acted. Record uncertainty
      // durably; automatic reissue is permanently blocked for this attempt.
      outcome = { kind: 'uncertain', reason: error === timeoutMark ? 'timeout' : 'transport-error' };
    }
    const committed = await this.mutate(state => {
      const current = state.attempt;
      if (!current || current.id !== next.id || current.phase !== 'requested') {
        throw new Error('Issuance attempt state changed unexpectedly');
      }
      this.push(state, { kind: 'mark-outcome', id: next.id, outcome });
      return true;
    });
    return project(committed.attempt);
  }

  // Exactly one call, raced against a timeout. The losing promise is already
  // handled, so a late rejection cannot surface as an unhandled rejection.
  async callTransportOnce(intent) {
    let call;
    try {
      call = this.quoteTransport({ intent });
      if (!call || typeof call.then !== 'function') throw new Error('quote transport must return a promise');
    } catch {
      throw new Error('transport-error');
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(timeoutMark), this.quoteTimeoutMs);
      Promise.resolve(call).then(
        value => { clearTimeout(timer); resolve(value); },
        () => { clearTimeout(timer); reject(new Error('transport-error')); }, // drop the transport's own error text
      );
    });
  }

  // Determines the durable outcome of a received quote, conservatively. A
  // quote is accepted only through the injected pure validator, grounded in
  // the exact expected intent, and whatever it returns is re-projected onto
  // the bounded payment instruction fields. The validator is trusted to keep
  // secrets and raw responses out of allowed strings. When validation
  // fails, that failure does NOT establish that the provider did nothing:
  // unless the injected refusal validator positively validates provider
  // no-side-effect evidence, the outcome stays uncertain and keeps the
  // reconciliation obligation (no automatic reissue).
  classifyQuote(intent, quote) {
    let instruction = null;
    try { instruction = this.validator(intent, quote); } catch { instruction = null; }
    const matched = instruction !== null && instruction !== undefined;
    if (matched) {
      try {
        return { kind: 'quoted', instruction: instructionFields(instruction) };
      } catch {
        return this.refuseOrUncertain(intent, quote, 'invalid-quote');
      }
    }
    return this.refuseOrUncertain(intent, quote, 'mismatched-quote');
  }

  refuseOrUncertain(intent, quote, uncertainReason) {
    // Positive definitive-refusal semantics only: `refused` requires the
    // injected validator to affirmatively return validated provider evidence
    // that this request was refused with no side effects (for example an
    // offline-verified signed refusal receipt). Anything else — null, a
    // throw, or a malformed verdict — is no evidence at all.
    let verdict = null;
    try { verdict = this.refusalValidator(intent, quote); } catch { return { kind: 'uncertain', reason: uncertainReason }; }
    if (!verdict || typeof verdict !== 'object' || !bounded(verdict.evidenceRef)) {
      return { kind: 'uncertain', reason: uncertainReason };
    }
    return { kind: 'refused', reason: 'no-side-effect-refusal', evidenceRef: verdict.evidenceRef };
  }

  async observe(id, evidenceRef, kind) {
    if (!bounded(id) || !bounded(evidenceRef)) throw new Error('Missing bounded identifiers or evidence reference');
    const state = await this.mutate(s => {
      const current = s.attempt;
      if (!current || current.id !== id) throw new Error('Unknown active issuance attempt');
      this.push(s, { kind, id, evidenceRef });
      return true;
    });
    return project(state.attempt);
  }

  recordBridgeReceipt({ id, evidenceRef }) { return this.observe(id, evidenceRef, 'observe-bridge'); }
  recordInvoiceSettled({ id, evidenceRef }) { return this.observe(id, evidenceRef, 'observe-invoice'); }

  // The correlation context handed to the injected proof validator: the exact
  // invoice the proof must reference (settlement evidence and payment
  // instruction) plus the settlement timestamp the observation is measured
  // against.
  async creditProofContext(id) {
    const attempt = (await this.read()).attempt;
    if (!attempt || attempt.id !== id || attempt.phase !== 'invoice-settled') {
      throw new Error('Credit proof requires an invoice-settled issuance attempt');
    }
    return {
      id: attempt.id,
      instruction: attempt.instruction,
      invoiceEvidenceRef: attempt.invoiceEvidenceRef,
      settledAt: attempt.settledAt,
    };
  }

  // The ONLY path to provider-credit-ready. The injected proof validator must
  // positively correlate the offline proof with this exact invoice evidence
  // and the exact credited account/reference and amount — a bare account
  // balance total (the public snapshot of lib/provider-balance.mjs) is
  // display information and can never satisfy this seam. The adapter then
  // enforces structural and clock invariants; authenticating and correlating
  // the proof remains the trusted validator's responsibility. When
  // provenance cannot be supplied, this throws and the attempt simply stays
  // invoice-settled; the account balance remains separately displayed and no
  // spendable-ready claim is fabricated.
  async recordCreditProof({ id, proof }) {
    if (!bounded(id)) throw new Error('Missing bounded identifier');
    const context = await this.creditProofContext(id);
    const provenance = this.verifyCreditProof(context, proof);
    const state = await this.mutate(s => {
      const current = s.attempt;
      if (!current || current.id !== id || current.phase !== 'invoice-settled' || current.settledAt !== context.settledAt) {
        throw new Error('Issuance attempt state changed unexpectedly');
      }
      this.push(s, { kind: 'record-credit-proof', id, provenance });
      return true;
    });
    return project(state.attempt);
  }

  verifyCreditProof(context, proof) {
    let correlated = null;
    try { correlated = this.proofValidator(context, proof); } catch { correlated = null; }
    if (correlated === null || correlated === undefined) {
      throw new Error('Credit provenance could not be verified: the instruction stays invoice-settled and the account balance stays separate display information');
    }
    const provenance = creditProvenanceFields(correlated, Date.parse(context.settledAt));
    const observedAtMs = Date.parse(provenance.observedAt);
    const nowMs = this.now();
    if (observedAtMs > nowMs) throw new Error('Credit provenance observation is forged from the future');
    if (nowMs - observedAtMs > this.proofFreshAfterMs) throw new Error('Credit provenance observation is not sufficiently recent');
    return provenance;
  }
}
