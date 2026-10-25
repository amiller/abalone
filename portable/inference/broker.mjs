// Portable private-inference broker (offline-qualified SDK-host prototype).
//
// A separate broker process owns the only credential-bearing egress path and
// listens on a Unix domain socket. Worker-side callers (the portable
// workspace agent worker; a real Pi SDK provider registration is the next
// task and will use client.mjs as its fetch seam) present only a dummy
// authorization token on a scoped socket: they cannot choose endpoint, model,
// key or headers, and no account or management API exists on this socket.
//
// Prototype guarantees exercised by broker.test.mjs; actual target service
// accounts, transport and Tor egress still require runtime qualification:
//   • Authority comes from a separate UID, not the working directory: the
//     broker refuses to start when it runs as the caller's uid (unless an
//     explicit testing flag is set), its state lives in an owned private
//     directory outside cwd, and every connection is checked against the
//     kernel's SO_PEERCRED (fail closed when the check cannot run) BEFORE the
//     HTTP parser attaches. A separate-uid peer reaches the socket only
//     through an operator-provisioned shared IPC group (socketGroup): the
//     socket is created 0660 with that group on a parent directory that is
//     group-searchable but never group- or other-writable.
//   • Lifetime exclusive state ownership: before any recovery or sweep, the
//     broker takes a kernel flock on <stateDir>/broker.flock and holds it for
//     its entire life. A second live broker — same socket or not — cannot
//     start against the same state directory, so it can never sweep another
//     live broker's outstanding reservations. The lock is released only after
//     stop() has drained in-flight handlers and their terminal settlements.
//   • Per logical request exactly one raw encrypted POST: the sealed
//     transport is called once, a duplicate logical id is refused forever
//     (durably, including after restarts), a key mismatch is refused (never
//     re-keyed, never retried), and an endpoint redirect is refused (the
//     endpoint is exact).
//   • Reservation-before-transmission with a durable integer-base-unit
//     budget journal, where the reserved amount is a reviewed maximum
//     charge bound covering the full model input ceiling and all billed
//     output/reasoning under a current trusted provider contract — never a caller-claimed price and never a flat constant.
//     A request without a derivable bound (missing max_tokens, unpriced
//     model, bound beyond journal range) is refused before transmission.
//     Restart never resets the cap; post-transmission loss or cancel is
//     outcome-unknown, consumes the reservation and cannot be retried, so a
//     caller can never translate a failure into an uncharged request. If an
//     actual settlement exceeds its reservation, the journal records a
//     truthful discrepancy event, the overspend stays recorded, and spending
//     is suspended until operator reconciliation — an overspend is never
//     normalized away as an ordinary settlement. Any journal or log write
//     failure fails closed: no transmission, and a settlement that cannot be
//     recorded durably is reported as a terminal failure, never ended as a
//     successful response.
//   • Whole-lifecycle bounds from request entry: the client-disconnect
//     handler, the idle bound (including time to first byte) and the total
//     deadline attach before any await; the abort signal is checked before
//     reservation and before transmission, so a cancellation observed at any
//     point can never still trigger the POST. The upstream reader is retained
//     once and cancelled on every failure path, and backpressure waits
//     settle on close, error or abort instead of only on drain.
//   • The fixed external model `private/gpt-oss-120b` maps to `gpt-oss-120b`
//     inside the sealed body while the private id is preserved on the
//     `x-private-model` header; native OpenAI tool definitions and tool
//     results pass through in their original shape, and an empty tools array
//     is normalized away.
//   • No fallback: either an explicitly injected per-request SDK host verifies
//     its real document/key binding, or the legacy offline ABIF1 fixture uses
//     a stub verifier/key release. These interfaces are mutually exclusive;
//     an SDK admission is never converted into a fabricated ABIF1 release.
//
// No deployment/live qualification follows from these offline tests. SDK host
// construction requires a trusted financial-store lease capability; the real
// vault identity-to-state-directory binding remains separately unqualified.
// The broker itself performs no provider fetch or account-management calls.
import { createHash } from 'node:crypto';
import { hostCall, prepareReply } from './sdk-host-schema.mjs';
import { deriveTrustedChargeBound } from './charge-bound.mjs';
import http from 'node:http';
import net from 'node:net';
import { unlink, mkdir, lstat, realpath, chmod, chown } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { BudgetJournal, BudgetDuplicateError, BudgetExhaustedError, BudgetDiscrepancyError } from './budget-journal.mjs';
import { RequestLog } from './request-log.mjs';
import { acquireStoreLock, StoreLockedError } from './lock.mjs';
import { TransportError } from './sealed-transport.mjs';
import { INFERENCE_DUMMY_AUTH } from './client.mjs';

export const INFERENCE_MODEL = 'private/gpt-oss-120b';
export const SEALED_MODEL = 'gpt-oss-120b';
export const MAX_OUTPUT_TOKENS = 32768;
const ROUTE = '/v1/chat/completions';
function freezeTree(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeTree(child); Object.freeze(value); }
  return value;
}
// Independently reproduce canonical request binding, without accepting the
// child-provided digest as the authority for what the worker actually requested.
function requestDigest(value) {
  const canonical = item => item === null || typeof item !== 'object' ? JSON.stringify(item)
    : Array.isArray(item) ? '[' + item.map(canonical).join(',') + ']'
    : '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + canonical(item[key])).join(',') + '}';
  return createHash('sha256').update(canonical(value)).digest('hex');
}


const allowedBodyKeys = new Set(['model', 'messages', 'tools', 'tool_choice', 'temperature', 'top_p', 'max_tokens', 'stream', 'stream_options', 'reasoning_effort', 'response_format', 'stop', 'seed', 'parallel_tool_calls']);
const allowedHeaders = new Set(['host', 'content-type', 'authorization', 'accept', 'content-length', 'connection', 'transfer-encoding', 'x-inference-request-id']);
const idPattern = /^[A-Za-z0-9_-]{16,64}$/;
const hex64 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const integerString = (value, min, max) => typeof value === 'string' && new RegExp(`^\\d{1,${max === undefined ? 19 : String(max).length}}$`).test(value) && BigInt(value) >= BigInt(min);
const requestIdFormat = value => typeof value === 'string' && idPattern.test(value);

// Transport error codes are trusted only after enum normalization: an
// injected transport's error `code` is an arbitrary bounded string, so it is
// projected onto this fixed set before it reaches a client response or the
// durable request log. (The log's per-field whitelist is shape validation,
// not general secret sanitization; never log raw injected strings.)
const transportCodes = new Set(['endpoint-redirect', 'key-mismatch', 'unsealed-response', 'connection-lost', 'aborted', 'transport-failed', 'response-limit', 'client-cancel', 'request-deadline']);
const normalizeTransportCode = code => (typeof code === 'string' && transportCodes.has(code) ? code : 'transport-failed');

// There is no default admitted tariff or byte-count fallback. Root-owned
// configuration must supply a reviewed ceiling covering template and reasoning
// charges; unknown/stale contracts refuse before reservation or transmission.
export { deriveTrustedChargeBound as deriveChargeBound };

const peerCredHelper = `
import socket, struct, sys
try:
    data = socket.socket(fileno=3).getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
except OSError:
    sys.exit(3)
sys.stdout.write("%d %d %d" % struct.unpack("3i", data))
`;

// Kernel peer credentials for one accepted connection. Fail closed: any
// failure to run the check destroys the connection rather than skipping it.
// The helper's stdout is accumulated under a small bound and settled exactly
// once on close (exit code 0 with a valid three-integer line): exiting 0
// without output, writing garbage, or overrunning the bound all reject, and
// no path clears the timeout without settling.
async function peerUid(fd) {
  const child = spawn('python3', ['-I', '-c', peerCredHelper], { stdio: ['ignore', 'pipe', 'ignore', fd] });
  try {
    return await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error('peer credential check timed out')), 5000);
      let out = '';
      let settled = false;
      const settle = fn => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      child.stdout.on('data', chunk => {
        if (settled) return;
        out += chunk;
        if (out.length > 128) settle(() => { try { child.kill('SIGKILL'); } catch {} rejectPromise(new Error('peer credential helper output exceeds its bound')); });
      });
      child.once('error', error => settle(() => rejectPromise(error.code === 'ENOENT' ? new Error('python3 is required for peer credential checks') : error)));
      child.once('close', code => settle(() => {
        if (code !== 0) return rejectPromise(new Error(`peer credential check failed (exit ${code})`));
        const parts = out.trim().split(' ');
        if (parts.length !== 3 || parts.some(p => !/^\d+$/.test(p))) return rejectPromise(new Error('peer credential protocol error'));
        resolvePromise(Number(parts[1]));
      }));
    });
  } finally {
    try { child.kill('SIGKILL'); } catch {}
  }
}

function jsonError(res, status, code, message) {
  const body = JSON.stringify({ error: { code, message: message ?? code } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' });
  res.end(body);
}

function jsonDepth(value, depth = 0) {
  if (depth > 12) throw new Error('too deep');
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) jsonDepth(child, depth + 1);
}

export function createInferenceBroker(options) {
  if (!options || typeof options !== 'object') throw new Error('broker options are required');
  const expected = ['sdkHostFactory', 'chargePolicy', 'clock', 'socketPath', 'stateDir', 'peerUid', 'socketGroup', 'transport', 'verifier', 'authorizedBudget', 'pricePerInputToken', 'pricePerOutputToken', 'maxRequestBytes', 'maxResponseBytes', 'responseIdleTimeoutMs', 'responseDeadlineMs', 'testingAllowSameUid'];
  for (const key of Object.keys(options)) if (!expected.includes(key)) throw new Error(`Unknown broker option ${key}`);
  const socketPath = options.socketPath, stateDir = options.stateDir, peerUidOption = options.peerUid;
  const socketGroup = options.socketGroup;
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) throw new Error('socketPath must be absolute');
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new Error('stateDir must be absolute');
  if (!Number.isSafeInteger(peerUidOption) || peerUidOption < 0 || peerUidOption >= 2 ** 31) throw new Error('peerUid must be a uid');
  if (socketGroup !== undefined && (!Number.isSafeInteger(socketGroup) || socketGroup < 0 || socketGroup >= 2 ** 31)) throw new Error('socketGroup must be a gid');
  const sdkHostFactory = options.sdkHostFactory;
  if (sdkHostFactory !== undefined) {
    if (typeof sdkHostFactory !== 'function' || options.transport !== undefined || options.verifier !== undefined) {
      throw new Error('sdkHostFactory must be an explicit trusted factory, mutually exclusive with offline verifier/transport');
    }
  } else {
    // Legacy ABIF1 verifier/key-release interface is an offline fixture path.
    if (!options.transport || typeof options.transport.post !== 'function') throw new Error('an injected sealed transport with post() is required');
    if (!options.verifier || typeof options.verifier.verify !== 'function') throw new Error('an injected reviewed verifier with verify() is required');
  }
  if (!integerString(options.authorizedBudget, 1) || BigInt(options.authorizedBudget) > 9223372036854775807n) throw new Error('authorizedBudget must be an integer base-unit string');
  const chargePolicy = options.chargePolicy === undefined ? null : freezeTree(JSON.parse(JSON.stringify(options.chargePolicy)));
  const clock = options.clock ?? Date.now;
  if (typeof clock !== 'function') throw new Error('clock must be a trusted function');
  const priceIn = chargePolicy?.pricePerInputToken ?? '0', priceOut = chargePolicy?.pricePerOutputToken ?? '0';
  for (const [name, value] of [['pricePerInputToken', priceIn], ['pricePerOutputToken', priceOut]]) {
    if (options[name] !== undefined && options[name] !== value) throw new Error('Legacy prices must match the trusted charge policy');
  }
  if (!integerString(priceIn, 0) || !integerString(priceOut, 0) || BigInt(priceIn) > 9223372036854775807n || BigInt(priceOut) > 9223372036854775807n) {
    throw new Error('prices must be integer base-unit strings');
  }
  const maxRequestBytes = options.maxRequestBytes ?? 4 * 1024 * 1024;
  const maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
  const idleTimeoutMs = options.responseIdleTimeoutMs ?? 120_000;
  const deadlineMs = options.responseDeadlineMs ?? 600_000;
  for (const [value, min, max] of [[maxRequestBytes, 1024, 64 * 1024 * 1024], [maxResponseBytes, 1024, 128 * 1024 * 1024], [idleTimeoutMs, 1000, 3_600_000], [deadlineMs, idleTimeoutMs, 7_200_000]]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('broker bounds out of range');
  }
  const testingAllowSameUid = options.testingAllowSameUid === true;

  let server = null, journal = null, log = null, socketInode = null;
  let degraded = null;
  let hostCleanupFailed = false;
  let stopPromise = null;
  let releaseStateLock = null;
  const sockets = new Set();
  const activeControllers = new Set();
  const inFlight = new Set();
  // Connections whose kernel peer credentials have been verified. A net-level
  // gate checks every connection before the HTTP parser attaches; the request
  // handler re-checks membership so that even a slipped, unverified request
  // is refused before any journal, log or transport action.
  const verified = new WeakSet();
  let httpServerRef = null;

  async function checkStateDir() {
    if (resolve(stateDir) === resolve(process.cwd()) || resolve(stateDir).startsWith(resolve(process.cwd()) + '/')) {
      throw new Error('Broker authority comes from a separate uid and private state directory, never from cwd; move stateDir outside the working directory');
    }
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const info = await lstat(stateDir);
    const real = await realpath(stateDir);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) || real !== resolve(stateDir)) {
      throw new Error('stateDir must be an owned private directory without symlinks');
    }
  }

  async function checkSocketParent() {
    // The socket's parent directory is the root-provisioned scope directory.
    // Group members must be able to search it, but nobody but the owner may
    // write it — a group-writable parent would let any IPC-group member
    // replace the socket out from under the broker.
    const parent = dirname(socketPath);
    const info = await lstat(parent).catch(error => { if (error.code === 'ENOENT') throw new Error('the socket parent directory must be provisioned before the broker starts'); throw error; });
    if (!info.isDirectory() || (info.mode & 0o022) !== 0 || (info.mode & 0o010) === 0) {
      throw new Error('socketPath parent must be a directory that is not group- or other-writable and is group-searchable for the shared IPC group');
    }
  }

  async function probeStaleSocket() {
    const info = await lstat(socketPath).then(s => s, e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (!info) return;
    if (!info.isFile() && !info.isSocket()) throw new Error('socketPath exists and is not a socket');
    const live = await new Promise(resolvePromise => {
      const probe = net.connect(socketPath);
      const done = value => { probe.destroy(); resolvePromise(value); };
      probe.on('connect', () => done(true));
      probe.on('error', e => done(e.code === 'ECONNREFUSED' ? false : true));
      setTimeout(() => done(true), 250).unref?.();
      void probe.setTimeout?.(250, () => done(true));
    });
    if (live) throw new Error('socketPath is already served by a live broker; refusing to take it over');
    await unlink(socketPath);
  }

  async function start() {
    if (server) throw new Error('broker already started');
    if (hostCleanupFailed) throw new Error('SDK host cleanup failed; process exit required');
    // The broker must not share the caller's uid: separation of authority is a
    // uid property. Tests running as a single user say so explicitly.
    if (process.getuid() === peerUidOption && !testingAllowSameUid) {
      throw new Error('The inference broker must run under a uid separate from the worker; refusing to start as the caller');
    }
    // A separate-uid peer can only reach a broker-owned 0660 socket through a
    // shared IPC group the operator provisioned; refuse the unusable
    // configuration up front instead of starting a socket nobody may connect
    // to. (The SO_PEERCRED gate stays authoritative regardless.)
    if (!testingAllowSameUid && socketGroup === undefined) {
      throw new Error('A separate-uid peer needs the operator-provisioned shared IPC group (socketGroup gid) to reach the socket; refusing to start an unreachable broker');
    }
    if (socketGroup !== undefined) await checkSocketParent();
    await checkStateDir();
    // Lifetime exclusive ownership of the state directory, taken BEFORE any
    // recovery: ensureAuthorized/sweepUnresolved/probeStaleSocket only ever
    // run while this process holds the kernel lock, and a second live broker
    // — even on a different socket path — cannot start against the same
    // state, so it can never sweep this broker's outstanding reservations.
    // The lock is held for the broker's whole life and released only after
    // stop() has drained in-flight handlers and their terminal settlements.
    try {
      releaseStateLock = await acquireStoreLock(resolve(stateDir), 'broker.flock');
    } catch (error) {
      if (error instanceof StoreLockedError) throw new Error('another live broker already owns this state directory; refusing to start a second owner');
      throw error;
    }
    try {
      journal = new BudgetJournal(resolve(stateDir, 'budget'));
      log = new RequestLog(resolve(stateDir, 'requests'));
      // Restart never resets the budget: an existing durable cap is enforced,
      // and a different cap is refused. Unresolved reservations from a
      // previous life are outcome-unknown and consumed at their actual
      // reserved amounts, never refunded.
      await journal.ensureAuthorized(options.authorizedBudget);
      for (const entry of await journal.sweepUnresolved()) {
        await log.append({ id: entry.id, model: INFERENCE_MODEL, outcome: 'abandoned', code: 'restart-sweep', charged: entry.amount });
      }
      const snap = await journal.snapshot();
      if (snap.discrepancies.length > 0) degraded = 'settlement-discrepancy'; // spending stays suspended across restarts
      await probeStaleSocket();
      const httpServer = http.createServer({ insecureHTTPParser: false });
      httpServer.headersTimeout = 10_000;
      httpServer.requestTimeout = 60_000;
      httpServer.keepAliveTimeout = 1000;
      httpServer.maxHeadersCount = 32;
      httpServer.maxRequestsPerConnection = 1;
      httpServer.on('request', handleRequest);
      httpServerRef = httpServer;
      // A plain net gate owns the socket first: the kernel peer credentials are
      // checked BEFORE the HTTP parser ever attaches, so an unverified or
      // wrong-uid connection is destroyed before any request is parsed, and the
      // handler re-checks the verified set in depth.
      const gate = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.pause();
        const fd = socket._handle?.fd;
        if (!Number.isInteger(fd)) { socket.destroy(); return; }
        peerUid(fd).then(uid => {
          if (uid !== peerUidOption) socket.destroy();
          else {
            verified.add(socket);
            httpServer.emit('connection', socket); // parser attaches synchronously
            socket.resume(); // then let the buffered request flow into it
          }
        }).catch(() => socket.destroy()); // fail closed on any check failure
      });
      stopPromise = null;
      server = gate;
      await new Promise((resolvePromise, rejectPromise) => {
        gate.once('error', rejectPromise);
        gate.listen(socketPath, async () => {
          try {
            if (socketGroup === undefined) {
              await chmod(socketPath, 0o600);
            } else {
              // Root-provisioned shared IPC group: group-owned 0660 so the
              // separate-uid peer may connect, with the kernel SO_PEERCRED
              // gate still deciding admission. The broker attaches the group
              // itself only when it is a member (or root provisioned it);
              // the result is verified, never assumed.
              const initial = await lstat(socketPath);
              if (initial.gid !== socketGroup) {
                await chown(socketPath, -1, socketGroup).catch(error => {
                  throw new Error(`cannot attach the socket to the shared IPC group ${socketGroup}; the operator must provision it or make the broker a member: ${error.message}`);
                });
              }
              await chmod(socketPath, 0o660);
              const done = await lstat(socketPath);
              if (done.gid !== socketGroup || (done.mode & 0o777) !== 0o660) throw new Error('the inference socket must end up owned by the shared IPC group with mode 0660');
            }
            socketInode = (await lstat(socketPath)).ino;
            resolvePromise();
          } catch (error) { rejectPromise(error); }
        });
      });
      return { socketPath, journal, log };
    } catch (error) {
      const release = releaseStateLock;
      releaseStateLock = null;
      if (release) await release().catch(() => {});
      throw error;
    }
  }

  function stop() {
    if (stopPromise) return stopPromise;
    if (!server) return Promise.resolve();
    // Publish ownership before abort listeners can synchronously reenter stop().
    stopPromise = Promise.resolve().then(drain);
    return stopPromise;
  }

  async function drain() {
    const closing = server, closingHttp = httpServerRef;
    server = null; httpServerRef = null;
    // Bound every in-flight request, then destroy the connections before
    // awaiting anything: no handler can outlive stop() waiting on a socket,
    // a drain or an upstream read.
    for (const controller of activeControllers) controller.abort();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await Promise.allSettled([...inFlight]); // handlers drain and reach their terminal settlement
    await new Promise(resolvePromise => closing.close(() => resolvePromise()));
    closingHttp?.close();
    const info = await lstat(socketPath).then(s => s, e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (info && info.isSocket() && info.ino === socketInode) await unlink(socketPath);
    socketInode = null;
    if (hostCleanupFailed) throw new Error('SDK host cleanup failed; retaining state lock until process exit');
    // Lifetime state ownership is released only after draining and terminal
    // settlement of everything this broker had in flight.
    const release = releaseStateLock;
    releaseStateLock = null;
    if (release) await release();
  }

  // Per-request SSE usage parser: each request owns its own TextDecoder,
  // because a shared decoder would carry UTF-8 partial state across
  // concurrent streams.
  function createUsageParser() {
    const decoder = new TextDecoder();
    const state = { buffer: '', usage: null, invalid: false };
    // Track the newest SSE `data:` JSON object carrying OpenAI usage; bounded
    // line buffer. The final usage chunk (if the upstream sends one) wins.
    const push = bytes => {
      state.buffer += decoder.decode(bytes, { stream: true });
      let index;
      while ((index = state.buffer.indexOf('\n')) >= 0) {
        const line = state.buffer.slice(0, index);
        state.buffer = state.buffer.slice(index + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'usage') && parsed.usage !== null) {
            const value = parsed.usage;
            const valid = value && typeof value === 'object' && !Array.isArray(value)
              && Number.isSafeInteger(value.prompt_tokens) && value.prompt_tokens >= 0
              && Number.isSafeInteger(value.completion_tokens) && value.completion_tokens >= 0;
            if (!valid) state.invalid = true; // permanent unknown; never reuse earlier valid usage
            else state.usage = { prompt_tokens:value.prompt_tokens, completion_tokens:value.completion_tokens };
          }
        } catch { state.invalid = true; } // malformed SSE data cannot authorize a refund
      }
      if (state.buffer.length > 65536) { state.invalid = true; state.buffer = state.buffer.slice(-65536); }
    };
    return { push, get usage() { return state.invalid || state.buffer.trim() ? null : state.usage; } };
  }

  function handleRequest(req, res) {
    res.on('error', () => {});
    // Whole-lifecycle bounds attach at request entry, before any await: the
    // disconnect handler, the idle bound (including time to first byte) and
    // the total deadline all cover the verifier wait, the POST, the first
    // upstream byte and the whole relay.
    const controller = new AbortController();
    activeControllers.add(controller);
    const handler = runRequest(req, res, controller).finally(() => { activeControllers.delete(controller); inFlight.delete(handler); });
    inFlight.add(handler);
    handler.catch(() => {});
  }

  async function runRequest(req, res, controller) {
    const peer = req.socket;
    if (!verified.has(peer)) {
      // Unverified (gate still running, or lost its race with the parser):
      // fail closed before touching any durable state or the transport.
      res.destroy();
      peer.destroy();
      return;
    }
    let sdkHost = null, sdkCreating = null, sdkLive = false, sdkPosting = false;
    let reservationOwned = false, settlementAttempted = false, requestId = null, reservedBound = null;
    let clientGone = false;
    res.on('close', () => { if (!res.writableEnded) { clientGone = true; controller.abort(); } });
    const abortBody = () => { try { req.destroy(); } catch {} };
    controller.signal.addEventListener('abort', abortBody, { once: true });
    const abortCode = () => (clientGone ? 'client-cancel' : 'request-deadline');
    // A cancellation observed at any checkpoint refuses without reserving or
    // transmitting; a deadline reports 504 to a still-connected client.
    const refuseIfAborted = () => {
      if (!controller.signal.aborted) return false;
      if (clientGone || res.destroyed) { res.destroy(); return true; }
      jsonError(res, 504, 'request-deadline', 'The whole-request deadline or idle bound was exceeded before transmission');
      return true;
    };
    let idleTimer = null;
    const deadlineTimer = setTimeout(() => controller.abort(), deadlineMs);
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs);
    };
    armIdle(); // the idle bound starts at entry: a stalled first byte cannot hold a reservation indefinitely
    // A trusted transport must honor abort at its raw POST gate. Independently
    // bound its promises here so a stalled stream cannot retain journal ownership.
    const abortable = work => new Promise((resolvePromise, rejectPromise) => {
      const abort = () => { cleanup(); rejectPromise(new TransportError(abortCode())); };
      const cleanup = () => controller.signal.removeEventListener('abort', abort);
      if (controller.signal.aborted) { abort(); return; }
      controller.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new TransportError(abortCode());
        return work();
      }).then(value => { cleanup(); resolvePromise(value); }, error => { cleanup(); rejectPromise(error); });
    });
    const cancelReader = async reader => {
      let timer;
      try {
        await Promise.race([
          Promise.resolve().then(() => reader.cancel()).catch(() => {}),
          new Promise(resolvePromise => { timer = setTimeout(resolvePromise, 1000); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    try {
      if (req.method !== 'POST' || req.url !== ROUTE) {
        // No account, model-listing or management route exists on this socket.
        jsonError(res, 404, 'no-such-route', 'The scoped inference socket serves only POST /v1/chat/completions');
        return;
      }
      if (req.headers.authorization !== INFERENCE_DUMMY_AUTH) {
        jsonError(res, 401, 'unauthorized', 'Only the fixed session token is accepted; this socket holds no credential');
        return;
      }
      for (const name of Object.keys(req.headers)) {
        if (!allowedHeaders.has(name)) {
          jsonError(res, 403, 'header-refused', `Header ${name} is not accepted; the caller cannot override broker authority`);
          return;
        }
      }
      const id = req.headers['x-inference-request-id'];
      requestId = id;
      if (!requestIdFormat(id)) {
        jsonError(res, 400, 'invalid-request', `x-inference-request-id must match ${idPattern}`);
        return;
      }
      if (String(req.headers['content-type'] ?? '') !== 'application/json') {
        jsonError(res, 400, 'invalid-request', 'content-type must be application/json');
        return;
      }
      if (degraded) {
        jsonError(res, 503, degraded, 'The broker failed closed on a durable-state failure; inference is suspended');
        return;
      }
      const chunks = [];
      let bytes = 0, tooLarge = false;
      try {
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > maxRequestBytes) { tooLarge = true; break; }
          chunks.push(chunk);
        }
      } catch {
        if (refuseIfAborted()) return;
        jsonError(res, 400, 'invalid-request', 'Request body could not be read');
        return;
      }
      if (tooLarge) { jsonError(res, 413, 'frame-too-large', `Request exceeds the ${maxRequestBytes}-byte bound`); peer.destroy(); return; }
      if (refuseIfAborted()) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        jsonDepth(body);
      } catch {
        jsonError(res, 400, 'invalid-request', 'Request body must be bounded JSON');
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { jsonError(res, 400, 'invalid-request', 'Request body must be a JSON object'); return; }
      for (const key of Object.keys(body)) {
        if (!allowedBodyKeys.has(key)) {
          jsonError(res, 400, 'override-refused', `Field ${key} is not accepted; endpoint, model, key and headers are broker authority`);
          return;
        }
      }
      if (body.model !== INFERENCE_MODEL) {
        jsonError(res, 400, 'unknown-model', `The only admitted model is ${INFERENCE_MODEL}`);
        return;
      }
      if (body.stream !== true) { jsonError(res, 400, 'invalid-request', 'stream must be true'); return; }
      if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 512) {
        jsonError(res, 400, 'invalid-request', 'messages must be a non-empty array of at most 512 entries');
        return;
      }
      if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 128)) {
        jsonError(res, 400, 'invalid-request', 'tools must be an array of at most 128 native OpenAI definitions');
        return;
      }
      // The output cap is REQUIRED: without an enforceable maximum the
      // trusted charge bound cannot be derived, and an unknown bound refuses.
      if (body.max_tokens === undefined) {
        jsonError(res, 400, 'invalid-request', 'max_tokens is required: the broker must derive an enforceable maximum charge before transmission');
        return;
      }
      if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > MAX_OUTPUT_TOKENS) {
        jsonError(res, 400, 'invalid-request', 'max_tokens out of range');
        return;
      }
      // Native OpenAI shapes pass through untouched: only the model id is
      // mapped (private id preserved on x-private-model) and an empty tools
      // array is normalized away.
      // Normalize native tools once before hashing, preparing or deriving the
      // charge bound. Orphan tool controls have no meaning without definitions.
      if (!body.tools?.length) {
        delete body.tools;
        delete body.tool_choice;
        delete body.parallel_tool_calls;
      }
      body = freezeTree(body);
      const sealedBody = { ...body, model: SEALED_MODEL };
      const expectedDigest = requestDigest(body);

      // Trusted maximum-charge bound from the validated request itself,
      // derived BEFORE the POST and reserved as-is. A caller cannot enlarge
      // the charge beyond it without triggering a recorded discrepancy.
      let bound;
      try {
        ({ bound } = deriveTrustedChargeBound({ request: body, policy: chargePolicy, nowMs: clock() }));
      } catch {
        jsonError(res, 503, 'charge-bound-refused', 'No current reviewed billing contract bounds this request; nothing is transmitted');
        return;
      }
      if (bound === '0') {
        jsonError(res, 400, 'invalid-request', 'The admitted model is unpriced; no enforceable charge bound can be derived');
        return;
      }
      if (!/^\d{1,19}$/.test(bound) || BigInt(bound) > 9223372036854775807n) {
        jsonError(res, 400, 'invalid-request', 'The derived charge bound exceeds the budget journal range');
        return;
      }

      let admission, release, permitUsed = false, permitGranted = false;
      if (sdkHostFactory) {
        // Only this trusted constructor-selected capability may acquire a
        // financial-store lease. Worker data cannot select credentials or paths.
        const permitRawPost = async (details, permitSignal) => {
          if (permitUsed) throw new Error('permit already consumed');
          permitUsed = true; // latch before any await, including journal reads
          hostCall('permit', details);
          if (!permitSignal || typeof permitSignal.addEventListener !== 'function') throw new Error('permit signal required');
          const check = () => {
            if (!sdkLive || !sdkPosting || !sdkHost || !admission || !reservationOwned || settlementAttempted
                || controller.signal.aborted || permitSignal?.aborted || degraded
                || details.logicalId !== id || details.requestDigest !== expectedDigest
                || details.admissionDigest !== admission.documentDigest || details.bound !== bound
                || details.policyEvidenceId !== chargePolicy.evidenceId) throw new Error('permit refused');
            const current = deriveTrustedChargeBound({request:body,policy:chargePolicy,nowMs:clock()});
            if (current.bound !== bound || current.evidenceId !== details.policyEvidenceId) throw new Error('permit refused');
          };
          check();
          const snapshot = await journal.snapshot();
          const entry = snapshot.entries.find(event => event.kind === 'reserve' && event.id === id);
          if (!entry || entry.amount !== bound || entry.resolved !== null || snapshot.discrepancies.length) throw new Error('unresolved reservation required');
          check(); // cancellation/expiry may have happened during durable read
          permitGranted = true;
          return Object.freeze({allowed:true,logicalId:id,requestDigest:expectedDigest,reservedBound:bound});
        };
        try {
          sdkCreating = Promise.resolve().then(() => sdkHostFactory(Object.freeze({
            chargePolicy, stateDir, signal:controller.signal, permitRawPost,
          }))).then(host => {
            sdkHost = host;
            if (!host || !['prepare','post','close'].every(key => typeof host[key] === 'function')) throw new Error('invalid SDK host');
            sdkLive = !controller.signal.aborted;
            return host;
          });
          await abortable(() => sdkCreating);
          admission = await abortable(() => sdkHost.prepare({logicalId:id,body,signal:controller.signal}));
          prepareReply({token:admission?.handle?.token,requestDigest:admission?.requestDigest,documentDigest:admission?.documentDigest});
          if (admission.requestDigest !== expectedDigest) throw new Error('request digest mismatch');
          admission = Object.freeze({handle:admission.handle,requestDigest:admission.requestDigest,documentDigest:admission.documentDigest});
        } catch {
          if (refuseIfAborted()) return;
          jsonError(res,503,'attestation-refused','The trusted SDK host did not admit this request; there is no fallback');
          return;
        }
      } else {
      // Injected reviewed verifier gate: attestation plus key release, per
      // logical request, before anything is reserved or transmitted. The
      // wait races the abort signal, so a cancellation during the verifier
      // can never still be followed by a POST.
      try {
        admission = await Promise.race([
          options.verifier.verify({ model: SEALED_MODEL, logicalId: id }),
          new Promise((_, rejectPromise) => controller.signal.addEventListener('abort', () => rejectPromise(new Error('aborted')), { once: true })),
        ]);
      } catch {
        admission = null;
      }
      if (refuseIfAborted()) return;
      if (!admission || admission.admitted !== true || !hex64(admission.measurement)) {
        jsonError(res, 503, 'attestation-refused', 'The injected verifier did not admit this route; there is no fallback');
        return;
      }
      release = admission.release;
      if (!release || typeof release.keyId !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(release.keyId)
        || typeof release.publicKeyBase64 !== 'string' || !/^[A-Za-z0-9+/]{16,128}={0,2}$/.test(release.publicKeyBase64)) {
        jsonError(res, 503, 'release-missing', 'The verifier admitted the route but released no key; there is no fallback');
        return;
      }

      }

      if (refuseIfAborted()) return;

      // Fail closed on the outcome log before reserving: if accountability
      // cannot be recorded, nothing is transmitted.
      try {
        await log.append({ id, model: INFERENCE_MODEL, outcome: 'reserved', amount: bound, uid: peerUidOption });
      } catch (error) {
        degraded = 'log-failure';
        jsonError(res, 503, 'log-failure', 'The broker failed closed on its request log');
        return;
      }

      if (refuseIfAborted()) return;

      // Durable reservation before transmission, at the derived bound.
      // Duplicate logical ids are refused forever (the journal is the
      // serialization point, also across restarts); exhaustion, a recorded
      // discrepancy and journal failure refuse without transmitting.
      try {
        await journal.reserve({ id, amount: bound });
        reservationOwned = true; reservedBound = bound;
      } catch (error) {
        if (error instanceof BudgetDuplicateError) {
          await log.append({ id, model: INFERENCE_MODEL, outcome: 'refused', code: 'duplicate-request' }).catch(() => { degraded = 'log-failure'; });
          jsonError(res, 409, 'duplicate-request', 'This logical request id was already used; at-most-once transmission is enforced');
          return;
        }
        if (error instanceof BudgetExhaustedError) {
          await log.append({ id, model: INFERENCE_MODEL, outcome: 'refused', code: 'budget-exhausted' }).catch(() => { degraded = 'log-failure'; });
          jsonError(res, 429, 'budget-exhausted', 'The durable authorized budget cannot cover this reservation');
          return;
        }
        if (error instanceof BudgetDiscrepancyError) {
          degraded = 'settlement-discrepancy';
          await log.append({ id, model: INFERENCE_MODEL, outcome: 'refused', code: 'settlement-discrepancy' }).catch(() => { degraded = 'log-failure'; });
          jsonError(res, 503, 'settlement-discrepancy', 'A previous settlement exceeded its reserved bound; spending is suspended pending operator reconciliation');
          return;
        }
        degraded = 'journal-failure';
        await log.append({ id, model: INFERENCE_MODEL, outcome: 'refused', code: 'journal-failure' }).catch(() => { degraded = 'log-failure'; });
        jsonError(res, 503, 'journal-failure', 'The broker failed closed on its budget journal');
        return;
      }
      if (refuseIfAborted()) return;

      // Post-transmission outcomes are terminal and always charged; a lost
      // or canceled stream is outcome-unknown and never retried here.
      const consume = async (code, amount) => {
        settlementAttempted = true;
        try {
          await journal.abandon({ id });
        } catch { degraded = 'journal-failure'; }
        await log.append({ id, model: INFERENCE_MODEL, outcome: 'abandoned', code: normalizeTransportCode(code), charged: amount }).catch(() => { degraded = 'log-failure'; });
      };

      // Recheck immediately before the trusted transport boundary: attestation
      // and durable writes may have crossed the tariff validity deadline.
      try {
        deriveTrustedChargeBound({request:body,policy:chargePolicy,nowMs:clock()});
      } catch {
        settlementAttempted = true;
        try { await journal.settle({id,amount:'0'}); }
        catch { degraded='journal-failure'; }
        await log.append({id,model:INFERENCE_MODEL,outcome:'refused',code:'charge-bound-refused',charged:'0'}).catch(() => { degraded='log-failure'; });
        jsonError(res,503,'charge-bound-refused','The reviewed billing contract expired before transmission; nothing was transmitted');
        return;
      }
      // Exactly one raw encrypted POST for this logical request. The production
      // transport must also enforce its signal/tariff at the final raw POST gate.
      let upstream;
      try {
        sdkPosting = Boolean(sdkHostFactory);
        upstream = sdkHostFactory
          ? await abortable(() => sdkHost.post({handle:admission.handle,signal:controller.signal}))
          : await abortable(() => options.transport.post({
          release,
          headers: { 'x-private-model': INFERENCE_MODEL },
          body: sealedBody,
          signal: controller.signal,
        }));
        if (sdkHostFactory && !permitGranted) throw new Error('SDK host returned without a durable raw permit');
      } catch (error) {
        const code = controller.signal.aborted ? abortCode() : normalizeTransportCode(error instanceof TransportError ? error.code : 'transport-failed');
        await consume(code, bound);
        if (controller.signal.aborted && !clientGone && !res.destroyed) jsonError(res, 504, 'request-deadline', 'The whole-request deadline or idle bound was exceeded');
        else if (!res.destroyed) jsonError(res, 502, `transport-failure:${code}`, 'The sealed transport refused this request; it is not retried');
        else res.destroy();
        return;
      }
      if (refuseIfAborted()) { await consume(abortCode(), bound); return; }

      // Read and validate the first sealed-opened chunk before committing
      // to a 200: an unsealable response must surface as a structured error,
      // never as a truncated stream and never as a fallback. The reader is
      // retained once and reused for the whole relay — no second getReader()
      // can ever leave a locked stream behind.
      const reader = upstream.stream.getReader();
      let first;
      try {
        first = await abortable(() => reader.read());
      } catch (error) {
        const wasAborted = controller.signal.aborted; // classify before any abort we cause ourselves
        const code = wasAborted ? abortCode() : normalizeTransportCode(error instanceof TransportError ? error.code : 'transport-failed');
        controller.abort();
        await cancelReader(reader);
        await consume(code, bound);
        if (wasAborted && !clientGone && !res.destroyed) jsonError(res, 504, 'request-deadline', 'The whole-request deadline or idle bound was exceeded');
        else if (!res.destroyed) jsonError(res, 502, `transport-failure:${code}`, 'The sealed transport refused this request; it is not retried');
        else res.destroy();
        return;
      }
      if (refuseIfAborted()) { controller.abort(); await cancelReader(reader); await consume(abortCode(), bound); return; }

      // Relay the sealed-opened stream with explicit bounds and backpressure.
      res.writeHead(200, { 'content-type': upstream.contentType ?? 'text/event-stream', 'cache-control': 'no-store', connection: 'close' });
      const usage = createUsageParser();
      let relayed = 0;
      // A backpressure wait settles on drain, close, error, abort or its own
      // bound — never only on drain, so a vanished or canceled consumer
      // cannot wedge the handler.
      const writeChunk = async value => {
        if (res.write(Buffer.from(value))) return;
        await new Promise((resolvePromise, rejectPromise) => {
          const onDrain = () => finish(resolvePromise);
          const onGone = () => finish(() => rejectPromise(new TransportError(clientGone ? 'client-cancel' : 'connection-lost')));
          const onAbort = () => finish(() => rejectPromise(new TransportError(abortCode())));
          const finish = fn => {
            res.off('drain', onDrain); res.off('close', onGone); res.off('error', onGone);
            controller.signal.removeEventListener('abort', onAbort);
            clearTimeout(guard);
            fn();
          };
          res.once('drain', onDrain); res.once('close', onGone); res.once('error', onGone);
          controller.signal.addEventListener('abort', onAbort, { once: true });
          const guard = setTimeout(onAbort, idleTimeoutMs);
        });
      };
      try {
        if (!first.done) {
          relayed += first.value.byteLength;
          if (relayed > maxResponseBytes) throw new TransportError('response-limit');
          usage.push(first.value);
          await writeChunk(first.value);
          armIdle();
        }
        for (;;) {
          const { done, value } = await abortable(() => reader.read());
          if (done) break;
          relayed += value.byteLength;
          if (relayed > maxResponseBytes) throw new TransportError('response-limit');
          usage.push(value);
          await writeChunk(value);
          armIdle();
        }
        // A valid counter pair does not itself prove that it covers reasoning,
        // templates and every other billed token. Refunds need explicit trusted
        // usage semantics; otherwise retain the full reviewed maximum bound.
        const settledUsage = chargePolicy?.settlementUsage === 'openai-prompt-completion-all-billed-tokens' ? usage.usage : null;
        const actual = settledUsage
          ? (BigInt(settledUsage.prompt_tokens) * BigInt(priceIn) + BigInt(settledUsage.completion_tokens) * BigInt(priceOut)).toString()
          : bound; // no usage reported: the full reserved bound is consumed
        try {
          settlementAttempted = true;
          await journal.settle({ id, amount: actual });
        } catch (error) {
          if (error instanceof BudgetDiscrepancyError) {
            // Actual spend exceeded the trusted bound: recorded truthfully in
            // the journal as a discrepancy; spending is suspended durably.
            // The response body itself was already delivered — the honest
            // state is the durable discrepancy, not a pretend success.
            degraded = 'settlement-discrepancy';
            await log.append({ id, model: INFERENCE_MODEL, outcome: 'completed', code: 'settlement-discrepancy', charged: actual, bytes: relayed.toString() }).catch(() => { degraded = 'log-failure'; });
            res.end();
            return;
          }
          // Terminal durable failure: the settlement could not be recorded,
          // so this is reported as a failure, never ended as a success.
          degraded = 'journal-failure';
          await log.append({ id, model: INFERENCE_MODEL, outcome: 'abandoned', code: 'settlement-failed', charged: bound, bytes: relayed.toString() }).catch(() => { degraded = 'log-failure'; });
          if (!res.destroyed) res.destroy();
          return;
        }
        await log.append({ id, model: INFERENCE_MODEL, outcome: 'completed', charged: actual, bytes: relayed.toString() }).catch(() => { degraded = 'log-failure'; });
        res.end();
      } catch (error) {
        const wasAborted = controller.signal.aborted; // classify before any abort we cause ourselves
        const code = wasAborted ? abortCode() : normalizeTransportCode(error instanceof TransportError ? error.code : 'connection-lost');
        controller.abort(); // stop the whole lifecycle
        await cancelReader(reader); // never leave the upstream reader running
        await consume(code, bound);
        if (!res.destroyed) res.destroy();
        return;
      }
    } catch (error) {
      try { jsonError(res, 500, 'internal', 'The broker refused this request'); } catch { /* socket already gone */ }
    } finally {
      // Reap before releasing request ownership. A factory that returns late
      // after cancellation still belongs to this request and stop()'s drain.
      sdkLive = false; sdkPosting = false;
      if (sdkCreating) await sdkCreating.catch(() => {});
      if (sdkHost?.close) {
        try { await sdkHost.close(); }
        catch { degraded = 'transport-failed'; hostCleanupFailed = true; }
      }
      if (sdkHostFactory && reservationOwned && !settlementAttempted) {
        settlementAttempted = true;
        try { await journal.abandon({id:requestId}); }
        catch { degraded = 'journal-failure'; }
        await log.append({id:requestId,model:INFERENCE_MODEL,outcome:'abandoned',code:'aborted',charged:reservedBound}).catch(() => { degraded='log-failure'; });
      }
      clearTimeout(deadlineTimer);
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      controller.signal.removeEventListener('abort', abortBody);
    }
  }

  return { start, stop, socketPath, get journalRef() { return journal; }, get logRef() { return log; } };
}
