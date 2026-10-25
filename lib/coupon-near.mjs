// Host-side NEAR inference for a delivered coupon credential. This does not admit an issuer.
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { styleText } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { verifyNearModel, encrypt, decrypt, OUT_OF_DATE_TRIAL_POLICY } from "./near.mjs";
import { NEAR_DIRECT_HOST } from "./near-direct.mjs";
export { OUT_OF_DATE_TRIAL_POLICY };
export const OUT_OF_DATE_TRIAL_NOTICE = "WARNING: Synthetic input only: this profile accepts cryptographically verified OutOfDate NEAR firmware/advisories. Private guarantees are not qualified. All signature, freshness, binding, allowlist, TLS and NVIDIA checks remain required.";

const diagnostics = new WeakSet();
const ADMISSION_STAGES = new Set(["attestation-report-request", "attestation-report-response", "gateway-binding", "gateway-quote", "gateway-measurement", "model-binding", "model-quote", "boot-measurement", "nvidia-attestation", "model-measurement", "compose-registry", "transport-binding", "admission-warning"]);
const TRANSPORT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);
export const couponNearAdmissionDiagnostic = (error) => diagnostics.has(error?.admissionDiagnostic) ? error.admissionDiagnostic : null;
const fail = (code = "provider_admission_refused", diagnostic) => {
  const safe = diagnostics.has(diagnostic) ? diagnostic : null;
  const suffix = safe ? ` (${safe.stage}; ${safe.errorCode}${safe.httpStatus === null ? "" : `; HTTP ${safe.httpStatus}`})` : "";
  return Object.assign(new Error(`coupon provider: ${code}${suffix}`), { code, ...(safe ? { admissionDiagnostic: safe } : {}) });
};
function admissionDiagnostic(context, error) {
  const code = error?.cause?.code ?? error?.code;
  const value = Object.freeze({ stage: ADMISSION_STAGES.has(context.stage) ? context.stage : "attestation-report-request",
    errorCode: context.httpStatus !== null && context.httpStatus !== 200 ? "http_status" : TRANSPORT_CODES.has(code) ? code
      : error?.name === "AbortError" || error?.name === "TimeoutError" ? "deadline_or_cancelled" : error instanceof SyntaxError ? "response_decode"
        : error?.code === "provider_response_refused" ? "response_bounds_or_read"
        : context.stage === "attestation-report-request" ? "transport_error" : "verification_refused",
    httpStatus: Number.isInteger(context.httpStatus) && context.httpStatus >= 100 && context.httpStatus <= 599 ? context.httpStatus : null });
  diagnostics.add(value); return value;
}
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
  && Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const freeze = (v) => { if (v && typeof v === "object") { for (const child of Object.values(v)) freeze(child); Object.freeze(v); } return v; };
const FIELDS = ["content", "reasoning_content", "reasoning"];
const PROVIDER_BASE = "https://cloud-api.near.ai/v1";
const COLLATERAL_HOSTS = new Set(["api.trustedservices.intel.com", "certificates.trustedservices.intel.com", "rim.attestation.nvidia.com", "ocsp.ndis.nvidia.com"]);

// Explicit selected profile; no inheritance of providers.json's reported-TCB defaults.
// A NEAR direct instance (https://<model>-i<N>.completions.near.ai/v1) admits only UpToDate firmware.
const directBase = (baseUrl) => { try { const u = new URL(baseUrl); return u.href === `https://${u.hostname}/v1` && NEAR_DIRECT_HOST.test(u.hostname); } catch { return false; } };
export function validateCouponNearProfile({ baseUrl, model, policy, maxTokens } = {}) {
  if (!(baseUrl === PROVIDER_BASE || (directBase(baseUrl) && policy?.gatewayTcb === "UpToDate")) || typeof model !== "string" || !/^[A-Za-z0-9_./-]{1,160}$/.test(model)
      || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 16384
      // gpuSignature remains required for profile-schema compatibility; GPU evidence is always locally verified.
      || !exact(policy, ["gatewayTcb", "modelTcb", "gpuSignature", "composeRegistry"])
      || !["UpToDate", OUT_OF_DATE_TRIAL_POLICY].includes(policy.gatewayTcb) || policy.modelTcb !== policy.gatewayTcb || policy.gpuSignature !== "required"
      || !exact(policy.composeRegistry, ["rpc", "chainId"]) || !Number.isSafeInteger(policy.composeRegistry.chainId) || policy.composeRegistry.chainId !== 8453) throw fail();
  let rpc;
  try { rpc = new URL(policy.composeRegistry.rpc); } catch { throw fail(); }
  if (rpc.protocol !== "https:" || rpc.username || rpc.password || rpc.hash || rpc.search || rpc.port || !["mainnet.base.org", "base-rpc.publicnode.com"].includes(rpc.hostname) || rpc.pathname !== "/") throw fail();
  return freeze({ provider: "nearai", offerProvider: "near", baseUrl, model, policy: structuredClone(policy), maxTokens });
}

// Applied only to a result from the normal cryptographic verifier; no injected verdict path.
// The Intel advisory IDs behind OutOfDate components, plus GPU_REVOCATION_ADVISORY when the GPU evidence was admitted
// without revocation checks (ABALONE_GPU_REVOCATION=skip); null when there is neither. The GPU verdict must be exactly
// one of the local verifier's two forms (lib/nvidia-gpu.mjs), consistent with the profile's gpu_revocation.
export const GPU_REVOCATION_ADVISORY = "NVIDIA-GPU-REVOCATION-NOT-CHECKED";
const GPU_PASS = /^GPU: \d+× verified locally \([^()]*\)$/;
const GPU_SKIP = /^GPU: \d+× verified locally \([^()]*\); certificate revocation NOT checked \(ABALONE_GPU_REVOCATION=skip\)$/;
export function couponNearAdmissionAdvisories(result, policy) {
  const skipped = result.gpu_revocation === "not checked";
  if (!(skipped ? GPU_SKIP.test(result.gpu) : result.gpu_revocation === "checked" && GPU_PASS.test(result.gpu))
      || !["UpToDate", OUT_OF_DATE_TRIAL_POLICY].includes(policy.gatewayTcb) || policy.modelTcb !== policy.gatewayTcb
      || !Array.isArray(result.model_tcb_statuses) || !result.model_tcb_statuses.length || result.model_tcb_statuses.length > 64
      || !Array.isArray(result.model_tcb_advisory_ids) || result.model_tcb_advisory_ids.length !== result.model_tcb_statuses.length) throw fail();
  const advisories = new Set(); let outOfDate = false;
  for (const [status, ids] of [...(result.route === "direct" ? [] : [[result.gateway_tcb_status, result.gateway_tcb_advisory_ids]]), ...result.model_tcb_statuses.map((status, i) => [status, result.model_tcb_advisory_ids[i]])]) {
    if (!["UpToDate", ...(policy.gatewayTcb === OUT_OF_DATE_TRIAL_POLICY ? ["OutOfDate"] : [])].includes(status)
        || !Array.isArray(ids) || ids.length > 64 || !ids.every((id) => typeof id === "string" && /^INTEL-SA-[0-9]{5}$/.test(id))) throw fail();
    if (status === "OutOfDate") { outOfDate = true; ids.forEach((id) => advisories.add(id)); }
  }
  const out = outOfDate ? [...advisories].sort() : [];
  if (skipped) out.push(GPU_REVOCATION_ADVISORY);
  return outOfDate || skipped ? Object.freeze(out) : null;
}
export const couponNearFirmwareWarning = (ids) => {
  const intel = ids.filter((id) => id !== GPU_REVOCATION_ADVISORY);
  return [intel.length || ids.length === 0 ? `⚠ NEAR firmware out of date (${intel.length} Intel advisor${intel.length === 1 ? "y" : "ies"}); synthetic input only` : null,
    ids.includes(GPU_REVOCATION_ADVISORY) ? "⚠ NVIDIA GPU certificate revocation NOT checked (ABALONE_GPU_REVOCATION=skip): a revoked GPU or RIM signing key would still be admitted" : null].filter(Boolean).join("\n");
};
// Warned once per process; /coupon lists the IDs.
let firmwareAdvisories = null;
export const couponNearFirmwareAdvisories = () => firmwareAdvisories;

function inferenceBody(bytes, profile, modelPublicKey) {
  let body;
  try { body = JSON.parse(bytes); } catch { throw fail("request_refused"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail("request_refused");
  // Tools are carried in encrypted text by the existing in-content protocol.
  for (const key of ["tools", "tool_choice", "parallel_tool_calls"]) delete body[key];
  const keys = ["model", "messages", "stream", ...["max_tokens", "temperature", "top_p", "chat_template_kwargs", "stream_options"].filter((key) => Object.hasOwn(body, key))];
  if (!exact(body, keys) || body.model !== profile.model || body.stream !== true || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 8192) throw fail("request_refused");
  if (body.max_tokens !== undefined && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > profile.maxTokens)) throw fail("request_refused");
  body.max_tokens ??= profile.maxTokens;
  for (const key of ["temperature", "top_p"]) if (body[key] !== undefined && (typeof body[key] !== "number" || !Number.isFinite(body[key]) || body[key] < 0 || body[key] > (key === "top_p" ? 1 : 2))) throw fail("request_refused");
  if (body.stream_options !== undefined && (!exact(body.stream_options, ["include_usage"]) || body.stream_options.include_usage !== true)) throw fail("request_refused");
  if (body.chat_template_kwargs !== undefined && (!exact(body.chat_template_kwargs, ["enable_thinking"]) || typeof body.chat_template_kwargs.enable_thinking !== "boolean")) throw fail("request_refused");
  for (const message of body.messages) {
    if (!exact(message, ["role", "content", ...FIELDS.slice(1).filter((key) => Object.hasOwn(message, key))]) || !["system", "user", "assistant"].includes(message.role)) throw fail("request_refused");
    if (Array.isArray(message.content)) {
      if (!message.content.every((part) => exact(part, ["type", "text"]) && part.type === "text" && typeof part.text === "string")) throw fail("request_refused");
      message.content = message.content.map((part) => part.text).join("");
    }
    for (const key of FIELDS) {
      if (message[key] !== undefined && typeof message[key] !== "string") throw fail("request_refused");
      if (message[key] && modelPublicKey) message[key] = encrypt(message[key], modelPublicKey);
    }
  }
  return body;
}

async function boundedBytes(response, maxBytes, signal) {
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body ?? []) {
      if (signal.aborted || (size += chunk.length) > maxBytes) throw fail("provider_response_refused");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch { await response.body?.cancel().catch(() => {}); throw fail("provider_response_refused"); }
}

function plaintextSse(bytes, responseKey) {
  const lines = bytes.toString("utf8").split("\n"); let done = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, "");
    if (line === "data: [DONE]") { done = true; continue; }
    if (!line || line.startsWith(":")) continue;
    if (!line.startsWith("data: ") || done) throw fail("provider_response_refused");
    let value;
    try { value = JSON.parse(line.slice(6)); } catch { throw fail("provider_response_refused"); }
    if (value.error || !Array.isArray(value.choices)) throw fail("provider_response_refused");
    for (const choice of value.choices) {
      if (choice.delta?.tool_calls || choice.delta?.function_call) throw fail("provider_response_refused");
      for (const field of FIELDS) if (choice.delta?.[field]) {
        if (typeof choice.delta[field] !== "string" || !/^(?:[0-9a-f]{2})+$/.test(choice.delta[field])) throw fail("provider_response_refused");
        try { choice.delta[field] = decrypt(choice.delta[field], responseKey); } catch { throw fail("provider_response_refused"); }
      }
    }
    lines[index] = "data: " + JSON.stringify(value);
  }
  if (!done) throw fail("provider_response_refused");
  return lines.join("\n");
}

export function openCouponNearAdapter({ baseUrl, model, policy, maxTokens, credential, timeoutMs = 60_000, sessionLifetimeMs = 60_000, maxBytes = 2 * 1024 * 1024, signal, admissionFetch, pinnedTransportFactory, firmwareWarningMode = "legacy-synthetic", onFirmwareAdvisories } = {}) {
  return couponNearAdapter({ baseUrl, model, policy, maxTokens, credential, timeoutMs, sessionLifetimeMs, maxBytes, signal, admissionFetch, pinnedTransportFactory, firmwareWarningMode, onFirmwareAdvisories });
}

// Separately named testing factory: the admission verdict is supplied by the caller and must be
// explicitly synthetic (its exact shape cannot even carry a genuine verification result). Every
// runtime bound — endpoint/model/auth pins, encryption, bounded lifetime, expiry, sanitization —
// stays fully enforced, so only the attestation verdict itself is synthetic.
const SYNTHETIC_ONLY = "synthetic-only-not-hardware";
export function openCouponNearAdapterForTesting({ verifiedForTesting, ...options } = {}) {
  if (!exact(verifiedForTesting, ["profile", "signingPublicKey", "transport"])
      || typeof verifiedForTesting.signingPublicKey !== "string" || !/^(?:04)?[0-9a-f]{128}$/.test(verifiedForTesting.signingPublicKey)
      || !exact(verifiedForTesting.profile, ["gateway_tcb", "model_tcb", "gpu"]) || verifiedForTesting.profile.gateway_tcb !== SYNTHETIC_ONLY
      || !Array.isArray(verifiedForTesting.profile.model_tcb) || !verifiedForTesting.profile.model_tcb.length
      || !verifiedForTesting.profile.model_tcb.every((status) => status === SYNTHETIC_ONLY)
      || verifiedForTesting.profile.gpu !== `GPU: NVIDIA verdict (${SYNTHETIC_ONLY})`
      || typeof verifiedForTesting.transport?.fetch !== "function" || typeof verifiedForTesting.transport?.close !== "function") throw fail();
  return couponNearAdapter({ ...options, __syntheticVerified: { ...verifiedForTesting, profile: freeze(structuredClone(verifiedForTesting.profile)) } });
}

function couponNearAdapter({ baseUrl, model, policy, maxTokens, credential, timeoutMs = 60_000, sessionLifetimeMs = 60_000, maxBytes = 2 * 1024 * 1024, signal, admissionFetch: trustedAdmissionFetch, pinnedTransportFactory, firmwareWarningMode = "legacy-synthetic", onFirmwareAdvisories, __syntheticVerified } = {}) {
  // Custom routing is a trusted pair: never silently send inference directly after routed admission.
  if ((trustedAdmissionFetch !== undefined || pinnedTransportFactory !== undefined)
      && (typeof trustedAdmissionFetch !== "function" || typeof pinnedTransportFactory !== "function")) throw fail();
  // Trusted embedding only. Real-use warning presentation must be acknowledged synchronously
  // before any prompt; an async/UI task cannot silently postpone that acknowledgement.
  const portableWarning = firmwareWarningMode === "portable-authorized-real";
  if (!["legacy-synthetic", "portable-authorized-real"].includes(firmwareWarningMode)
      || (portableWarning ? typeof onFirmwareAdvisories !== "function" || __syntheticVerified : onFirmwareAdvisories !== undefined)) throw fail();
  let advisoryState = freeze({ state: "checking", firmware: null, gpuRevocation: null, advisoryIds: [] });
  const clearAdvisories = () => {
    advisoryState = freeze({ state: "closed", firmware: null, gpuRevocation: null, advisoryIds: [] });
    if (portableWarning) {
      try { Promise.resolve(onFirmwareAdvisories(advisoryState)).catch(() => {}); } catch {}
    }
  };
  const profile = validateCouponNearProfile({ baseUrl, model, policy, maxTokens });
  if (typeof credential !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(credential) || credential.startsWith("synthetic-only-")
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_460_000 || !Number.isSafeInteger(sessionLifetimeMs) || sessionLifetimeMs < 1 || sessionLifetimeMs > 300_000
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024 || signal?.aborted) throw fail();
  let expiresAt = Infinity;
  const lifetime = new AbortController(); let closed = false, expired = false, closing, verified, admitting, lifetimeTimer;
  const pending = new Set();
  // A newly issued key may not authorize report GETs immediately. This one
  // activation budget belongs to the credential/adapter, not each admit call.
  // It never covers collateral, verifier failures or an inference POST.
  const activationBackoffMs = [1000, 2000, 4000, 8000, 8000];
  let activationAttempt = 0, activationDeadline, activationComplete = false;
  let admissionContext = { stage: "attestation-report-request", httpStatus: null };
  const checkOpen = () => {
    if (performance.now() >= expiresAt) { expired = true; if (!pending.size) void close(); }
    if (expired) throw fail("provider_admission_expired");
    if (closed || signal?.aborted) throw fail("provider_closed");
  };
  // The lease starts only after verification. Expiry prevents new effects; an already
  // authorized request drains under its original operation deadline, without a replay.
  const startLease = () => {
    expiresAt = performance.now() + sessionLifetimeMs;
    lifetimeTimer = setTimeout(() => { expired = true; if (!pending.size) void close(); }, sessionLifetimeMs);
    lifetimeTimer.unref();
  };
  const deadline = (external) => AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : []), ...(external ? [external] : [])]);
  const admit = async () => {
    checkOpen(); if (verified) return verified.profile;
    if (__syntheticVerified) { verified = __syntheticVerified; startLease(); return verified.profile; }
    if (!admitting) admitting = (async () => {
      admissionContext = { stage: "attestation-report-request", httpStatus: null };
      const verifySignal = deadline();
      // One shared retry for temporary DNS failure during this admission only. Both
      // callers validate their fixed report/collateral URL before reaching this helper.
      // The original verification deadline applies; POSTs and inference never use it.
      let getRetriesRemaining = 1;
      const admissionFetch = async (url, init, operationSignal = verifySignal) => {
        checkOpen(); operationSignal.throwIfAborted();
        const fetchOnce = () => { admissionContext.httpStatus = null; return (trustedAdmissionFetch ?? fetch)(url, { ...init, redirect: "manual", signal: operationSignal }); };
        try { return await fetchOnce(); }
        catch (error) {
          if ((init.method ?? "GET").toUpperCase() !== "GET" || (error?.cause?.code ?? error?.code) !== "EAI_AGAIN"
              || !getRetriesRemaining || operationSignal.aborted || closed) throw error;
          getRetriesRemaining--;
          await delay(200, undefined, { signal: operationSignal });
          checkOpen(); operationSignal.throwIfAborted();
          return fetchOnce();
        }
      };
      const http = async (input, init = {}) => {
        checkOpen(); const url = new URL(String(input));
        if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port || !(COLLATERAL_HOSTS.has(url.hostname) || url.href === new URL(profile.policy.composeRegistry.rpc).href)) throw fail();
        if (new Headers(init.headers).has("authorization")) throw fail();
        const response = await admissionFetch(url, init);
        admissionContext.httpStatus = response.status;
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw fail(); }
        return new Response(await boundedBytes(response, maxBytes, verifySignal), { status: response.status, headers: response.headers });
      };
      const getReport = async (requestPath) => {
        checkOpen(); const url = new URL(requestPath, profile.baseUrl);
        if (url.origin !== new URL(profile.baseUrl).origin || url.pathname !== "/v1/attestation/report") throw fail();
        activationDeadline ??= performance.now() + 30_000;
        const remainingMs = Math.ceil(activationDeadline - performance.now());
        // After this one budget expires, a later explicit admit may make one
        // report GET under its ordinary deadline, but cannot replenish retries.
        const reportSignal = !activationComplete && remainingMs > 0
          ? AbortSignal.any([verifySignal, AbortSignal.timeout(remainingMs)]) : verifySignal;
        for (;;) {
          const response = await admissionFetch(url, { headers: { authorization: `Bearer ${credential}` } }, reportSignal);
          admissionContext.httpStatus = response.status;
          if (response.status !== 401) activationComplete = true;
          if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw fail(); }
          const waitMs = activationBackoffMs[activationAttempt];
          if (response.status !== 401 || activationComplete || verified || waitMs === undefined || performance.now() + waitMs >= activationDeadline)
            return new Response(await boundedBytes(response, maxBytes, reportSignal), { status: response.status, headers: response.headers });
          activationAttempt++;
          await response.body?.cancel();
          await delay(waitMs, undefined, { signal: reportSignal });
          checkOpen(); reportSignal.throwIfAborted();
        }
      };
      const result = await verifyNearModel(profile.baseUrl, profile.model, getReport, profile.policy, http,
        (stage, status = null) => { admissionContext = { stage, httpStatus: status }; }, pinnedTransportFactory);
      if (closed || verifySignal.aborted) { await result.transport.close(); throw fail(); }
      let advisories;
      admissionContext = { stage: "admission-warning", httpStatus: null };
      try { advisories = couponNearAdmissionAdvisories(result.profile, profile.policy); } catch (e) { await result.transport.close(); throw e; }
      // stderr is host-visible and never enters model input or the RPC protocol. The first OutOfDate
      // admission in this process warns before any provider inference effect; renewals do not repeat it.
      if (portableWarning) {
        const event = freeze({ state: "admitted", route: result.profile.route, instance: new URL(profile.baseUrl).hostname, firmware: result.profile.gateway_tcb_status === "OutOfDate" || result.profile.model_tcb_statuses.includes("OutOfDate") ? "out-of-date" : "up-to-date", gpuRevocation: result.profile.gpu_revocation, advisoryIds: [...(advisories ?? [])] });
        try {
          const acknowledged = onFirmwareAdvisories(event);
          // Consume a mistakenly returned promise's rejection, but never accept it as presentation.
          if (acknowledged && typeof acknowledged.then === "function") Promise.resolve(acknowledged).catch(() => {});
          if (acknowledged !== true || closed || verifySignal.aborted) throw fail();
          advisoryState = event;
        } catch (error) { await result.transport.close(); throw error; }
      } else if (advisories && !firmwareAdvisories) { firmwareAdvisories = advisories; process.stderr.write(`${styleText("red", couponNearFirmwareWarning(advisories), { stream: process.stderr })}\n`); }
      verified = { ...result, profile: freeze(structuredClone(result.profile)) }; startLease(); return verified.profile;
    })();
    const current = admitting;
    try { return await current; }
    catch (error) { const code = expired ? "provider_admission_expired" : closed || signal?.aborted ? "provider_closed" : ["provider_admission_expired", "provider_closed", "provider_admission_refused"].includes(error?.code) ? error.code : "provider_admission_refused";
      throw fail(code, code === "provider_admission_refused" ? admissionDiagnostic(admissionContext, error) : undefined); }
    finally { if (admitting === current) admitting = undefined; }
  };
  const close = async () => {
    if (closing) return closing;
    closed = true; clearTimeout(lifetimeTimer); lifetime.abort(); credential = undefined; signal?.removeEventListener("abort", onAbort);
    closing = (async () => { try { await admitting?.catch(() => {}); await Promise.allSettled([...pending]); await verified?.transport.close(); } finally { verified = undefined; clearAdvisories(); } })();
    return closing;
  };
  const onAbort = () => { void close(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  return Object.freeze({ profile, sessionLifetimeMs, admit, close, get advisoryState() { return advisoryState; },
    async fetch(input, init = {}) {
      checkOpen(); if (init.signal?.aborted || pending.size >= 8) throw fail("request_refused");
      let url;
      try { url = new URL(String(input)); } catch { throw fail("request_refused"); }
      if (url.href !== `${profile.baseUrl}/chat/completions` || init.method !== "POST" || typeof init.body !== "string" || Buffer.byteLength(init.body) > maxBytes) throw fail("request_refused");
      // The provider-use socket supplies only placeholder auth; never use an ambient key.
      if (new Headers(init.headers).get("authorization") !== "Bearer coupon-session") throw fail("request_refused");
      // Reject a wrong model or unencrypted alternate payload before even a report request.
      inferenceBody(init.body, profile);
      const work = (async () => {
        await admit(); checkOpen();
        const requestSignal = deadline(init.signal); if (requestSignal.aborted) throw fail("request_refused");
        const body = inferenceBody(init.body, profile, verified.signingPublicKey);
        const responseKey = crypto.createECDH("secp256k1"); responseKey.generateKeys();
        const response = await verified.transport.fetch(url, { method: "POST", redirect: "manual", signal: requestSignal,
          headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", "X-Signing-Algo": "ecdsa",
            "X-Client-Pub-Key": responseKey.getPublicKey("hex").slice(2), "X-Model-Pub-Key": verified.signingPublicKey }, body: JSON.stringify(body) });
        if (!response.ok) {
          // The pinned transport reports a refused endpoint identity as a 403 carrying its own
          // stable marker; that is a transport refusal, not credential revocation, and its body
          // is never surfaced.
          const body = await boundedBytes(response, 4096, requestSignal).catch(() => undefined);
          if (response.status === 403 && body?.toString("utf8").includes("✗ refused:")) throw fail("transport_refused");
          throw Object.assign(fail(response.status === 402 || response.status === 429 ? "credit_exhausted" : response.status === 401 || response.status === 403 ? "access_revoked_or_expired" : "provider_unavailable"),
            { upstreamStatus: response.status, upstreamBody: (body?.toString("utf8") ?? "").split(credential).join("[private credential removed]").replace(/[^\x20-\x7e]/g, " ").slice(0, 300) });
        }
        if (!/^text\/event-stream(?:;|$)/i.test(response.headers.get("content-type") ?? "")) { await response.body?.cancel(); throw fail("provider_response_refused"); }
        const plaintext = plaintextSse(await boundedBytes(response, maxBytes, requestSignal), responseKey).split(credential).join("[private credential removed]");
        if (Buffer.byteLength(plaintext) > maxBytes || requestSignal.aborted || closed) throw fail("provider_response_refused");
        const headers = { "content-type": "text/event-stream" };
        const ids = [response.headers.get("inference-id"), response.headers.get("x-inference-id")].filter((v) => v !== null);
        if (ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id) || id.includes(credential))
            || new Set(ids).size > 1) throw fail("provider_response_refused");
        if (ids.length) headers["x-inference-id"] = ids[0];
        return new Response(plaintext, { headers });
      })();
      pending.add(work);
      try { return await work; }
      catch (error) { throw Object.assign(fail(["credit_exhausted", "access_revoked_or_expired", "transport_refused", "upstream_idle", "upstream_deadline", "provider_response_refused", "request_refused", "provider_admission_refused", "provider_admission_expired", "provider_closed"].includes(error.code) ? error.code : "provider_unavailable", couponNearAdmissionDiagnostic(error)),
        { upstreamStatus: error.upstreamStatus ?? null, upstreamBody: error.upstreamBody ?? null, upstreamError: error.upstreamStatus ? null : String(error?.code ?? error?.name ?? "").slice(0, 64) + ": " + String(error?.message ?? "").split(credential).join("[private credential removed]").replace(/[^\x20-\x7e]/g, " ").slice(0, 200) }); }
      finally { pending.delete(work); if (expired && !pending.size) void close(); }
    },
  });
}

// The provider's own token count from the last usage chunk of a decrypted stream, or null when it reported none.
export function sseUsage(text) {
  const u = text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)).usage).findLast(Boolean);
  if (!u) return null;
  const count = (v) => { if (!Number.isSafeInteger(v) || v < 0) throw fail("provider_response_refused"); return v; };
  return { inputTokens: count(u.prompt_tokens), outputTokens: count(u.completion_tokens), reasoningTokens: u.completion_tokens_details?.reasoning_tokens === undefined ? 0 : count(u.completion_tokens_details.reasoning_tokens) };
}

// The sandbox child's credential broker: a private socket plus placeholder auth is the only thing
// that crosses into the child; the adapter (and with it the raw provider key) stays in this process.
// A socket is a scoped provider-use capability, not secret sealing from the host.
const ADMISSION_EXPIRED_TEXT = "The current provider admission lease expired. Keep this session open; a new request opens a fresh adapter admission using the same delivered credential. No failed inference request is automatically replayed; do not create another coupon or recipient key.";
export async function couponNearCredentialBroker({ socketPath, adapter, timeoutMs = 150_000, maxBytes = 2 * 1024 * 1024, onState = () => {}, onUsage = () => {} } = {}) {
  if (typeof socketPath !== "string" || !socketPath.includes("/") || !adapter || adapter.profile?.provider !== "nearai"
      || typeof adapter.fetch !== "function" || typeof adapter.close !== "function"
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw fail("broker_configuration");
  let dir;
  try { dir = fs.lstatSync(path.dirname(socketPath)); } catch { throw fail("broker_configuration"); }
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077) || fs.existsSync(socketPath)) throw fail("broker_configuration");
  const pending = new Set(), sockets = new Set(); let closed = false, closing;
  const answer = (res, status, code, diagnostic) => { if (!res.destroyed && !res.headersSent && !res.writableEnded) { const error = fail(code, diagnostic); res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: code === "provider_admission_expired" ? ADMISSION_EXPIRED_TEXT : error.message, type: code, ...(error.admissionDiagnostic ? { admissionDiagnostic: error.admissionDiagnostic } : {}) } })); } };
  const server = http.createServer(async (req, res) => {
    if (pending.size >= 8) return answer(res, 503, "broker_busy");
    const controller = new AbortController(); pending.add(controller);
    const timer = setTimeout(() => { controller.abort(); req.destroy(); res.destroy(); }, timeoutMs); timer.unref();
    res.once("close", () => controller.abort());
    try {
      if (closed || req.method !== "POST" || req.url !== "/v1/chat/completions" || req.headers.authorization !== "Bearer coupon-session") return answer(res, 403, "request_refused");
      const chunks = []; let count = 0;
      for await (const chunk of req) { count += chunk.length; if (count > maxBytes) { answer(res, 413, "request_too_large"); req.destroy(); return; } chunks.push(chunk); }
      // The adapter pins the endpoint, model and placeholder auth itself; it also encrypts,
      // decrypts, bounds and sanitizes everything that passes through this fixed path.
      const upstream = await adapter.fetch(`${adapter.profile.baseUrl}/chat/completions`,
        { method: "POST", headers: { authorization: "Bearer coupon-session", "content-type": "application/json" }, body: Buffer.concat(chunks).toString("utf8"), signal: controller.signal });
      const text = await upstream.text();
      if (closed || Buffer.byteLength(text) > maxBytes) throw fail("provider_response_refused");
      onState("installed");
      res.writeHead(200, { "content-type": upstream.headers.get("content-type") ?? "text/event-stream" });
      res.end(text);
      // The answer is already delivered: a failed usage write is a warning, never a session failure.
      try { onUsage(sseUsage(text)); } catch { onState("usage_not_recorded"); }
    } catch (error) {
      const code = error?.code ?? "provider_unavailable";
      onState(code);
      answer(res, code === "request_refused" ? 403 : code === "request_too_large" ? 413 : code === "provider_admission_expired" || code === "provider_closed" || code === "broker_busy" ? 503 : 502, code, couponNearAdmissionDiagnostic(error));
    } finally { clearTimeout(timer); pending.delete(controller); }
  });
  server.maxConnections = 32;
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600);
  return Object.freeze({ socketPath, async close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      for (const c of pending) c.abort();
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
      fs.rmSync(socketPath, { force: true });
      await adapter.close(); // aborts active work, closes the pinned transport and drops the credential
    })();
    return closing;
  } });
}
