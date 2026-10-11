import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { openCouponNearAdapter, openCouponNearAdapterForTesting, couponNearCredentialBroker, validateCouponNearProfile, couponNearAdmissionDiagnostic } from "../lib/coupon-near.mjs";
import { encrypt, decrypt } from "../lib/near.mjs";
import { couponSocketFetch } from "../lib/coupon-socket.mjs";
import { NEAR_COUPON_PI_COMPAT } from "../lib/coupon-attested-session.mjs";

const options = () => ({ baseUrl: "https://cloud-api.near.ai/v1", model: "selected/model", maxTokens: 128,
  credential: "unit-provider-secret-canary", policy: { gatewayTcb: "UpToDate", modelTcb: "UpToDate", gpuSignature: "required", composeRegistry: { rpc: "https://mainnet.base.org", chainId: 8453 } } });
const request = (body) => ({ method: "POST", headers: { authorization: "Bearer coupon-session" }, body: JSON.stringify(body) });
const body = () => ({ model: "selected/model", messages: [{ role: "user", content: "synthetic qualification content" }], stream: true, max_tokens: 128 });

test("selected NEAR profile is immutable and wrong model/auth/endpoint/pre-abort refuse before upstream", async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error("unexpected upstream"); };
  let adapter;
  try {
    const supplied = options(); adapter = openCouponNearAdapter(supplied);
    supplied.policy.gatewayTcb = "reported";
    assert.ok(Object.isFrozen(adapter.profile.policy)); assert.equal(adapter.profile.policy.gatewayTcb, "UpToDate");
    for (const change of [{ baseUrl: "https://example.invalid/v1" }, { credential: "synthetic-only-not-a-real-provider" }, { policy: { ...options().policy, gatewayTcb: "reported" } }, { policy: { ...options().policy, gpuSignature: "optional" } }]) assert.throws(() => openCouponNearAdapter({ ...options(), ...change }), /provider_admission_refused/);
    assert.throws(() => validateCouponNearProfile({ ...options(), maxTokens: 0 }));
    await assert.rejects(adapter.fetch("https://example.invalid/v1/chat/completions", request(body())), /request_refused/);
    await assert.rejects(adapter.fetch(`${options().baseUrl}/chat/completions`, { ...request(body()), headers: { authorization: "Bearer ambient-key-must-not-be-used" } }), /request_refused/);
    for (const changed of [{ ...body(), model: "other/model" }, { ...body(), api_key: "wire-key" }, { ...body(), messages: [{ role: "tool", content: "tool arguments" }] }, { ...body(), max_tokens: 129 }])
      await assert.rejects(adapter.fetch(`${options().baseUrl}/chat/completions`, request(changed)), /request_refused/);
    await assert.rejects(adapter.fetch(`${options().baseUrl}/chat/completions`, { ...request(body()), signal: AbortSignal.abort() }), /request_refused/);
    assert.equal(calls, 0);
    await adapter.close(); await assert.rejects(adapter.admit(), /provider_closed/); assert.equal(calls, 0);
    // An unopened adapter has no admission lease yet; its bounded verification has
    // its own timeout, independent of the window for issuing future requests.
    adapter = openCouponNearAdapter({ ...options(), sessionLifetimeMs: 5, timeoutMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    globalThis.fetch = (_url, init = {}) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("stalled")), { once: true });
    });
    const stalling = assert.rejects(adapter.admit(), { code: "provider_admission_refused" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await stalling;
  } finally { await adapter?.close(); globalThis.fetch = originalFetch; }
});

test("direct report auth never redirects, failures are sanitized, close aborts admission before inference", async () => {
  const originalFetch = globalThis.fetch; let mode = "redirect", calls = 0, inference = 0, aborted = false, seen;
  const entered = new Promise((resolve) => { seen = resolve; });
  globalThis.fetch = async (url, init) => {
    calls++;
    if (new URL(url).pathname === "/v1/chat/completions") inference++;
    assert.equal(new URL(url).origin, "https://cloud-api.near.ai");
    assert.equal(new URL(url).pathname, "/v1/attestation/report");
    assert.ok(new Headers(init.headers).get("authorization") === `Bearer ${options().credential}`);
    assert.equal(init.redirect, "manual");
    if (mode === "redirect") return new Response(null, { status: 302, headers: { location: "https://example.invalid/steal" } });
    if (mode === "error") return new Response(options().credential, { status: 403 });
    seen(); return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => { aborted = true; reject(new Error(options().credential)); }, { once: true }));
  };
  let adapter;
  try {
    adapter = openCouponNearAdapter(options());
    await assert.rejects(adapter.admit(), { code: "provider_admission_refused" }); assert.equal(calls, 1);
    mode = "error";
    await assert.rejects(adapter.admit(), { code: "provider_admission_refused" }); assert.equal(calls, 2);
    mode = "stall";
    const pending = assert.rejects(adapter.fetch(`${options().baseUrl}/chat/completions`, request(body())), { code: "provider_closed" });
    await entered; await adapter.close(); await pending;
    assert.ok(aborted); assert.equal(inference, 0); assert.equal(calls, 3);
  } finally { await adapter?.close(); globalThis.fetch = originalFetch; }
});

// A model key standing in for the attested signing key, and a pinned-transport stand-in that
// speaks the real wire protocol (decrypt prompts with the model key, answer encrypted to the
// client's key). Only the admission verdict is synthetic; the adapter runtime is the real one.
const modelKey = crypto.createECDH("secp256k1"); modelKey.generateKeys();
const verdict = (state) => ({
  signingPublicKey: modelKey.getPublicKey("hex"),
  profile: { gateway_tcb: "synthetic-only-not-hardware", model_tcb: ["synthetic-only-not-hardware"], gpu: "GPU: NVIDIA verdict (synthetic-only-not-hardware)" },
  transport: {
    close: async () => { state.closed = true; },
    fetch: async (input, init) => {
      state.chats++;
      const mode = state.mode ?? "ok";
      const url = new URL(String(input));
      assert.equal(url.origin, "https://cloud-api.near.ai"); assert.equal(url.pathname, "/v1/chat/completions");
      assert.equal(init.method, "POST"); assert.equal(init.redirect, "manual");
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${options().credential}`);
      const body = JSON.parse(init.body);
      assert.deepEqual(Object.keys(body).sort(), ["max_tokens", "messages", "model", "stream"]);
      assert.equal(body.model, "selected/model"); assert.equal(body.stream, true);
      assert.deepEqual(body.messages.map((m) => ({ role: m.role, content: decrypt(m.content, modelKey) })), [{ role: "user", content: "synthetic qualification content" }]);
      const clientPub = new Headers(init.headers).get("x-client-pub-key");
      assert.match(clientPub, /^[0-9a-f]{128}$/);
      assert.equal(new Headers(init.headers).get("x-model-pub-key"), modelKey.getPublicKey("hex"));
      if (mode === "stall") return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error(`upstream aborted ${options().credential}`)), { once: true }));
      if (mode === "revoked") return new Response(options().credential, { status: 401 });
      if (mode === "exhausted") return new Response("payment required", { status: 402 });
      if (mode === "pinmismatch") return new Response(JSON.stringify({ error: { message: "✗ refused: SPKI pin mismatch (observed …)" } }), { status: 403, headers: { "content-type": "application/json" } });
      if (mode === "unavailable") return new Response("retry later", { status: 503 });
      if (mode === "json") return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      if (mode === "tampered") return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "00".repeat(96) } }] })}\n\ndata: [DONE]\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
      if (mode === "cleartext") return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: `not ciphertext ${options().credential}` } }] })}\n\ndata: [DONE]\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: encrypt(`useful synthetic answer ${options().credential}`, clientPub) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  },
});

test("actual Pi OpenAI request grammar reaches the strict NEAR encrypted adapter", async () => {
  const { streamSimple } = await import("../pi/packages/ai/dist/api/openai-completions.js");
  const state = { chats: 0, closed: false, mode: "ok" };
  const adapter = openCouponNearAdapterForTesting({ ...options(), verifiedForTesting: verdict(state) });
  const model = { id: "selected/model", name: "SYNTHETIC near trial", provider: "nearai", api: "openai-completions", baseUrl: "http://127.0.0.1:0/v1",
    reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 128, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: NEAR_COUPON_PI_COMPAT };
  try {
    const response = await streamSimple(model, { messages: [{ role: "user", content: "synthetic qualification content", timestamp: Date.now() }] },
      { apiKey: "coupon-session", maxTokens: 128, fetch: (_url, init) => adapter.fetch(`${options().baseUrl}/chat/completions`, { ...init, body: typeof init.body === "string" ? init.body : String(init.body) }) }).result();
    assert.equal(state.chats, 1, "Pi's actual payload passed the strict parser and reached the encrypted synthetic transport");
    assert.notEqual(response.stopReason, "error", response.errorMessage);
    assert.ok(response.content.some((part) => part.type === "text" && part.text.includes("useful synthetic answer")));
  } finally { await adapter.close(); }
});

test("admitted runtime encrypts prompts to the attested model key, decrypts and sanitizes answers", { timeout: 10_000 }, async () => {
  const first = { chats: 0, closed: false, mode: "ok" };
  assert.throws(() => openCouponNearAdapterForTesting(), /provider_admission_refused/);
  // The testing factory accepts only explicitly synthetic verdicts; a genuine-shaped one is refused.
  assert.throws(() => openCouponNearAdapterForTesting({ ...options(), verifiedForTesting: { ...verdict(first), profile: { gateway_tcb: "UpToDate", model_tcb: ["UpToDate"], gpu: "GPU: NVIDIA verdict (signature checked)" } } }), /provider_admission_refused/);
  assert.throws(() => openCouponNearAdapterForTesting({ ...options(), credential: "synthetic-only-not-a-real-provider", verifiedForTesting: verdict(first) }), /provider_admission_refused/);
  const adapter = openCouponNearAdapterForTesting({ ...options(), verifiedForTesting: verdict(first) });
  try {
    const response = await adapter.fetch(`${options().baseUrl}/chat/completions`, request(body()));
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const text = await response.text();
    assert.ok(text.includes("useful synthetic answer") && text.endsWith("data: [DONE]\n"));
    assert.ok(!text.includes(options().credential));
    for (const [name, code] of [["revoked", "access_revoked_or_expired"], ["exhausted", "credit_exhausted"], ["unavailable", "provider_unavailable"],
      ["pinmismatch", "transport_refused"], ["json", "provider_response_refused"], ["tampered", "provider_response_refused"], ["cleartext", "provider_response_refused"]]) {
      first.mode = name;
      await assert.rejects(adapter.fetch(`${options().baseUrl}/chat/completions`, request(body())), (error) => error.code === code && !error.message.includes(options().credential));
    }
    first.mode = "stall";
    const controller = new AbortController();
    const pending = adapter.fetch(`${options().baseUrl}/chat/completions`, { ...request(body()), signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, (error) => error.code === "provider_unavailable" && !error.message.includes(options().credential));
    assert.equal(first.chats, 9);
  } finally { await adapter.close(); }
  assert.equal(first.closed, true, "close reaches the pinned transport");
});

test("expiry drops admission and the credential; the same delivered credential is reused only through fresh admission", async () => {
  const first = { chats: 0, closed: false };
  const adapter = openCouponNearAdapterForTesting({ ...options(), sessionLifetimeMs: 60, verifiedForTesting: verdict(first) });
  try {
    assert.ok((await (await adapter.fetch(`${options().baseUrl}/chat/completions`, request(body()))).text()).includes("useful synthetic answer"));
    await new Promise((resolve) => setTimeout(resolve, 90));
    await assert.rejects(adapter.admit(), { code: "provider_admission_expired" });
    await assert.rejects(adapter.fetch(`${options().baseUrl}/chat/completions`, request(body())), { code: "provider_admission_expired" });
    assert.equal(first.chats, 1, "an expired session never reuses its provider admission");
  } finally { await adapter.close(); }
  assert.equal(first.closed, true);
  const fresh = { chats: 0, closed: false };
  const readmitted = openCouponNearAdapterForTesting({ ...options(), verifiedForTesting: verdict(fresh) }); // same credential string
  try {
    assert.ok((await (await readmitted.fetch(`${options().baseUrl}/chat/completions`, request(body()))).text()).includes("useful synthetic answer"));
    assert.equal(fresh.chats, 1, "a fresh adapter admits the same delivered credential again without any new coupon or key");
  } finally { await readmitted.close(); }
});

const socketRequest = (socketPath, payload, { auth = "coupon-session", route = "/v1/chat/completions", method = "POST" } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ socketPath, path: route, method, agent: false, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" } }, (s) => {
    const chunks = []; s.on("data", (c) => chunks.push(c)); s.on("end", () => resolve({ status: s.statusCode, text: Buffer.concat(chunks).toString() })); s.on("error", reject);
  }); r.on("error", reject); r.end(typeof payload === "string" ? payload : JSON.stringify(payload));
});

test("credential broker hands the sandbox a placeholder-auth socket, explains admission expiry and cleans up", { timeout: 15_000 }, async () => {
  const states = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coupon-near-broker-")), busy = path.join(directory, "busy"), loose = path.join(directory, "loose");
  fs.mkdirSync(busy); fs.mkdirSync(loose); fs.chmodSync(loose, 0o755); fs.writeFileSync(path.join(busy, "occupied.sock"), "");
  const adapter = openCouponNearAdapterForTesting({ ...options(), sessionLifetimeMs: 900, verifiedForTesting: verdict({ chats: 0, closed: false }) });
  let broker;
  try {
    for (const bad of [{ socketPath: path.join(busy, "occupied.sock") }, { socketPath: path.join(loose, "b.sock") }, { socketPath: path.join(directory, "n.sock"), adapter: { fetch: adapter.fetch } }])
      await assert.rejects(couponNearCredentialBroker({ ...bad, adapter: bad.adapter ?? adapter }), { code: "broker_configuration" });
    broker = await couponNearCredentialBroker({ socketPath: path.join(directory, "broker.sock"), adapter, timeoutMs: 2000, maxBytes: 2048, onState: (s) => states.push(s) });
    const socketPath = broker.socketPath;
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
    for (const change of [{ auth: "ambient-key" }, { route: "/v1/models" }, { method: "GET" }]) assert.equal((await socketRequest(socketPath, body(), change)).status, 403);
    assert.equal((await socketRequest(socketPath, "x".repeat(3000))).status, 413, "a request beyond the broker bound is refused before the provider");
    assert.equal((await socketRequest(socketPath, "malformed json")).status, 403);
    assert.equal((await socketRequest(socketPath, { ...body(), model: "other/model" })).status, 403, "the adapter pins the model");
    const send = couponSocketFetch(socketPath);
    const response = await send("ignored", { body: JSON.stringify(body()) });
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "text/event-stream");
    const text = await response.text();
    assert.ok(text.includes("useful synthetic answer") && !text.includes(options().credential));
    assert.ok(states.includes("installed"));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const expired = await send("ignored", { body: JSON.stringify(body()) });
    assert.equal(expired.status, 503);
    const expiredText = await expired.text();
    assert.ok(expiredText.includes("fresh adapter admission") && expiredText.includes("do not create another coupon or recipient key"));
    assert.ok(!expiredText.includes(options().credential));
    assert.ok(states.includes("provider_admission_expired"));
    await broker.close();
    assert.equal(fs.existsSync(socketPath), false);
    await assert.rejects(send("ignored", { body: JSON.stringify(body()) }), /broker is unavailable/);
  } finally { await broker?.close(); await adapter.close(); fs.rmSync(directory, { recursive: true, force: true }); }

  // The same already-delivered credential serves again through a fresh adapter and a fresh broker.
  const fresh = { chats: 0, closed: false }, directory2 = fs.mkdtempSync(path.join(os.tmpdir(), "coupon-near-broker2-"));
  const readmitted = openCouponNearAdapterForTesting({ ...options(), verifiedForTesting: verdict(fresh) });
  let broker2;
  try {
    broker2 = await couponNearCredentialBroker({ socketPath: path.join(directory2, "broker.sock"), adapter: readmitted, timeoutMs: 2000 });
    const response = await couponSocketFetch(broker2.socketPath)("ignored", { body: JSON.stringify(body()) });
    assert.ok((await response.text()).includes("useful synthetic answer"));
    assert.equal(fresh.chats, 1);
  } finally { await broker2?.close(); await readmitted.close(); fs.rmSync(directory2, { recursive: true, force: true }); }
  assert.equal(fresh.closed, true, "broker close reaches the adapter and its pinned transport");
});

test("explicit paired OutOfDate trial adds only that verified status and warns each component without weakening signatures", async () => {
  const { OUT_OF_DATE_TRIAL_POLICY, couponNearAdmissionWarning } = await import("../lib/coupon-near.mjs");
  const trialPolicy = { ...options().policy, gatewayTcb: OUT_OF_DATE_TRIAL_POLICY, modelTcb: OUT_OF_DATE_TRIAL_POLICY };
  const verified = { gpu: "GPU: NVIDIA verdict (signature checked)", gateway_tcb_status: "OutOfDate", gateway_tcb_advisory_ids: ["INTEL-SA-01192"], model_tcb_statuses: ["OutOfDate", "UpToDate"], model_tcb_advisory_ids: [["INTEL-SA-01313"], []] };
  assert.equal(validateCouponNearProfile({ ...options(), policy: trialPolicy }).policy.modelTcb, OUT_OF_DATE_TRIAL_POLICY);
  const warning = couponNearAdmissionWarning(verified, trialPolicy);
  assert.match(warning, /gateway verified TCB OutOfDate; advisories: INTEL-SA-01192/);
  assert.match(warning, /model\[0\] verified TCB OutOfDate; advisories: INTEL-SA-01313/);
  assert.match(warning, /model\[1\] verified TCB UpToDate/);
  assert.match(warning, /private guarantees are not qualified/);
  assert.throws(() => couponNearAdmissionWarning(verified, options().policy), /provider_admission_refused/);
  for (const status of ["Revoked", "ConfigurationNeeded", "OutOfDateConfigurationNeeded", "SWHardeningNeeded", "ConfigurationAndSWHardeningNeeded", "Unknown", "OutOfDate extra", undefined]) {
    assert.throws(() => couponNearAdmissionWarning({ ...verified, gateway_tcb_status: status }, trialPolicy), /provider_admission_refused/);
    assert.throws(() => couponNearAdmissionWarning({ ...verified, model_tcb_statuses: [status], model_tcb_advisory_ids: [[]] }, trialPolicy), /provider_admission_refused/);
  }
  assert.throws(() => couponNearAdmissionWarning({ ...verified, model_tcb_statuses: [] }, trialPolicy));
  assert.throws(() => couponNearAdmissionWarning({ ...verified, gpu: "GPU: NVIDIA verdict (signature not checked)" }, trialPolicy));
  assert.throws(() => couponNearAdmissionWarning({ ...verified, gateway_tcb_advisory_ids: ["INTEL-SA-01192\nSECRET"] }, trialPolicy));
  for (const policy of [{ ...trialPolicy, modelTcb: "UpToDate" }, { ...trialPolicy, gatewayTcb: "reported" }, { ...trialPolicy, modelTcb: "reported" }]) assert.throws(() => validateCouponNearProfile({ ...options(), policy }));
  assert.throws(() => validateCouponNearProfile({ ...options(), maxTokens: 513, policy: trialPolicy }));
  const upToDate = { ...verified, gateway_tcb_status: "UpToDate", model_tcb_statuses: ["UpToDate"], model_tcb_advisory_ids: [[]] };
  assert.equal(couponNearAdmissionWarning(upToDate, options().policy), null);
});

// Synthetic verdict only; real transport/encryption/deadlines exercise the lifecycle.
test("lease starts on admission and an already sent response drains without paid replay", async () => {
  const state = { chats: 0, closed: false };
  const supplied = verdict(state), original = supplied.transport.fetch;
  supplied.transport.fetch = async (...args) => { await new Promise((r) => setTimeout(r, 35)); return original(...args); };
  const adapter = openCouponNearAdapterForTesting({ ...options(), sessionLifetimeMs: 10, timeoutMs: 100, verifiedForTesting: supplied });
  try {
    await new Promise((r) => setTimeout(r, 20)); // constructor time does not consume admission
    const response = await adapter.fetch(`${options().baseUrl}/chat/completions`, request(body()));
    assert.match(await response.text(), /useful synthetic answer/);
    assert.equal(state.chats, 1);
    await assert.rejects(adapter.fetch(`${options().baseUrl}/chat/completions`, request(body())), { code: "provider_admission_expired" });
    assert.equal(state.chats, 1, "expired admission cannot send another paid request");
  } finally { await adapter.close(); }
});
test("in-flight timeout never replays a request even when the admission lease expires", async () => {
  const state = { chats: 0, closed: false, mode: "stall" };
  const adapter = openCouponNearAdapterForTesting({ ...options(), sessionLifetimeMs: 5, timeoutMs: 30, verifiedForTesting: verdict(state) });
  try {
    const pending = assert.rejects(adapter.fetch(`${options().baseUrl}/chat/completions`, request(body())), { code: "provider_unavailable" });
    await new Promise((r) => setTimeout(r, 50)); await pending;
    assert.equal(state.chats, 1);
    assert.equal(state.closed, true);
  } finally { await adapter.close(); }
});

test("admission refusal retains only branded stage/code/status across broker response", async () => {
  const original = globalThis.fetch, credential = options().credential;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'near-diagnostic-')); fs.chmodSync(directory, 0o700);
  let adapter, broker, calls = 0;
  try {
    globalThis.fetch = async (url) => { calls++; assert.equal(new URL(url).pathname, '/v1/attestation/report'); return new Response('PRIVATE-BODY-CANARY ' + credential, { status: 403 }); };
    adapter = openCouponNearAdapter(options());
    let failure; try { await adapter.admit(); } catch (e) { failure = e; }
    assert.equal(failure.code, 'provider_admission_refused');
    assert.deepEqual(couponNearAdmissionDiagnostic(failure), { stage: 'attestation-report-response', errorCode: 'http_status', httpStatus: 403 });
    assert.ok(Object.isFrozen(failure.admissionDiagnostic));
    const serialized = JSON.stringify({ message: failure.message, diagnostic: failure.admissionDiagnostic });
    for (const secret of [credential, 'PRIVATE-BODY-CANARY', 'nonce=', '/v1/attestation/report']) assert.ok(!serialized.includes(secret));
    assert.equal(couponNearAdmissionDiagnostic({ admissionDiagnostic: { stage: 'SECRET', errorCode: credential, httpStatus: 403 } }), null);
    broker = await couponNearCredentialBroker({ socketPath: path.join(directory, 'broker.sock'), adapter });
    const send = couponSocketFetch(broker.socketPath);
    const response = await send('http://127.0.0.1:0/v1/chat/completions', request(body()));
    const error = (await response.json()).error;
    assert.equal(response.status, 502); assert.deepEqual(error.admissionDiagnostic, failure.admissionDiagnostic);
    assert.match(error.message, /attestation-report-response; http_status; HTTP 403/);
    assert.equal(calls, 2, 'one report GET per explicit admission attempt; zero inference POSTs');
    for (const secret of [credential, 'PRIVATE-BODY-CANARY', 'nonce=']) assert.ok(!JSON.stringify(error).includes(secret));
  } finally { await broker?.close(); await adapter?.close(); globalThis.fetch = original; fs.rmSync(directory, { recursive: true, force: true }); }
});

test("admission network/decode/verification refusals have static phase diagnostics without exception text", async () => {
  const original = globalThis.fetch;
  for (const [fetcher, expected] of [
    [async () => { throw Object.assign(new Error('PRIVATE-TRANSPORT-CANARY'), { cause: { code: 'ENOTFOUND', token: options().credential } }); }, { stage: 'attestation-report-request', errorCode: 'ENOTFOUND', httpStatus: null }],
    [async () => new Response('PRIVATE-JSON-CANARY', { status: 200 }), { stage: 'attestation-report-response', errorCode: 'response_decode', httpStatus: 200 }],
    [async () => Response.json({ private: 'PRIVATE-REPORT-CANARY' }), { stage: 'gateway-binding', errorCode: 'verification_refused', httpStatus: null }],
  ]) {
    const adapter = openCouponNearAdapter(options());
    try { globalThis.fetch = fetcher; await assert.rejects(adapter.admit(), e => { assert.deepEqual(couponNearAdmissionDiagnostic(e), expected); assert.ok(!JSON.stringify(e).includes('PRIVATE-')); assert.ok(!e.message.includes(options().credential)); return e.code === 'provider_admission_refused'; }); }
    finally { await adapter.close(); globalThis.fetch = original; }
  }
});

test("temporary DNS report GET retries once under the original admission deadline and preserves strict refusal", async () => {
  const original = globalThis.fetch;
  let adapter;
  try {
    let calls = 0, firstUrl;
    globalThis.fetch = async (url, init) => {
      assert.equal(init.method ?? 'GET', 'GET');
      assert.equal(new URL(url).pathname, '/v1/attestation/report');
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${options().credential}`);
      if (++calls === 1) { firstUrl = String(url); throw Object.assign(Error('PRIVATE-DNS'), { cause: { code: 'EAI_AGAIN' } }); }
      assert.equal(String(url), firstUrl, 'same nonce/report GET, no regenerated request');
      return Response.json({ private: 'PRIVATE-REPORT' });
    };
    adapter = openCouponNearAdapter(options());
    await assert.rejects(adapter.admit(), error => {
      assert.deepEqual(couponNearAdmissionDiagnostic(error), { stage: 'gateway-binding', errorCode: 'verification_refused', httpStatus: null });
      return true;
    });
    assert.equal(calls, 2, 'retry obtains report but never bypasses genuine verification');
    await adapter.close();

    calls = 0;
    globalThis.fetch = async () => { calls++; throw Object.assign(Error('PRIVATE-DNS'), { cause: { code: 'EAI_AGAIN' } }); };
    adapter = openCouponNearAdapter(options());
    await assert.rejects(adapter.fetch(`${options().baseUrl}/chat/completions`, request(body())), error => {
      assert.deepEqual(couponNearAdmissionDiagnostic(error), { stage: 'attestation-report-request', errorCode: 'EAI_AGAIN', httpStatus: null });
      assert.ok(!error.message.includes('PRIVATE-DNS')); return true;
    });
    assert.equal(calls, 2, 'one initial GET plus one retry; no inference POST');
  } finally { await adapter?.close(); globalThis.fetch = original; }
});

test("DNS retry wait respects admission abort and original timeout without another fetch", async () => {
  const original = globalThis.fetch;
  try {
    for (const cancel of ['abort', 'timeout']) {
      let calls = 0;
      const controller = new AbortController();
      globalThis.fetch = async () => { calls++; throw Object.assign(Error('PRIVATE-DNS'), { cause: { code: 'EAI_AGAIN' } }); };
      const adapter = openCouponNearAdapter({ ...options(), signal: controller.signal, timeoutMs: cancel === 'timeout' ? 20 : 60000 });
      const attempt = adapter.admit();
      const timer = cancel === 'abort' ? setTimeout(() => controller.abort(), 20) : null;
      try { await assert.rejects(attempt, error => error.code === (cancel === 'abort' ? 'provider_closed' : 'provider_admission_refused')); }
      finally { clearTimeout(timer); await adapter.close(); }
      assert.equal(calls, 1, 'retry delay shares original cancellation/deadline');
    }
  } finally { globalThis.fetch = original; }
});

test("temporary DNS during inference transport is terminal and never replays the POST", async () => {
  const state = { requests: 0 };
  const supplied = verdict(state);
  supplied.transport.fetch = async () => { state.requests++; throw Object.assign(Error('PRIVATE-POST'), { cause: { code: 'EAI_AGAIN' } }); };
  const adapter = openCouponNearAdapterForTesting({ ...options(), verifiedForTesting: supplied });
  try {
    await assert.rejects(adapter.fetch(`${options().baseUrl}/chat/completions`, request(body())), { code: 'provider_unavailable' });
    assert.equal(state.requests, 1);
  } finally { await adapter.close(); }
});

// This scoped module mock supplies only a synthetic verifier in this one unit
// instance. The ordinary factory/module and all genuine verification stay intact.
// It checks that activation returns its report to verification, never around it.
test("activation report 401 then 200 reaches verification; a substituted report still refuses", async () => {
  const { registerHooks } = await import('node:module');
  const realNear = new URL('../lib/near.mjs', import.meta.url).href;
  const source = `export {encrypt,decrypt,OUT_OF_DATE_TRIAL_POLICY} from ${JSON.stringify(realNear)};
    export async function verifyNearModel(base,model,getReport,policy,http,onStage) {
      const nonce='fixture-fresh-nonce';
      const response=await getReport('/v1/attestation/report?model='+encodeURIComponent(model)+'&nonce='+nonce);
      onStage('attestation-report-response',response.status);
      if(response.status!==200) throw Error('report refused');
      const report=await response.json(); onStage('gateway-binding');
      if(report.nonce!==nonce || report.model!==model) throw Error('binding refused');
      return {signingPublicKey:'test-only',profile:{gateway_tcb_status:'UpToDate',gateway_tcb_advisory_ids:[],model_tcb_statuses:['UpToDate'],model_tcb_advisory_ids:[[]],gpu:'GPU: NVIDIA verdict (signature checked)'},transport:{close:async()=>{}}};
    }`;
  const mockUrl='data:text/javascript,'+encodeURIComponent(source);
  const hook=registerHooks({resolve(specifier,context,next) {
    if(specifier==='./near.mjs' && context.parentURL?.endsWith('?activation-unit')) return {url:mockUrl,shortCircuit:true};
    return next(specifier,context);
  }});
  let isolated;
  try { isolated=await import(new URL('../lib/coupon-near.mjs' + '?activation-unit', import.meta.url).href); } finally { hook.deregister(); }
  const original=globalThis.fetch;
  try {
    for(const substituted of [false,true]) {
      let calls=0,reportUrl,auth;
      globalThis.fetch=async(url,init)=>{
        assert.equal(init.method??'GET','GET'); assert.equal(init.redirect,'manual');
        assert.equal(new URL(url).pathname,'/v1/attestation/report');
        if(++calls===1) { reportUrl=String(url);auth=new Headers(init.headers).get('authorization');return new Response('PRIVATE-BODY', {status:401}); }
        assert.equal(String(url),reportUrl);assert.equal(new Headers(init.headers).get('authorization'),auth);
        return Response.json({nonce:substituted?'other-nonce':'fixture-fresh-nonce',model:options().model});
      };
      const adapter=isolated.openCouponNearAdapter(options());
      try {
        if(substituted) await assert.rejects(adapter.admit(),e=>e.code==='provider_admission_refused' && isolated.couponNearAdmissionDiagnostic(e).stage==='gateway-binding');
        else assert.equal((await adapter.admit()).gateway_tcb_status,'UpToDate');
        assert.equal(calls,2,'same report and credential retried once; never inference');
      } finally { await adapter.close(); }
    }
  } finally { globalThis.fetch=original; }
});

test("permanent report 401 has one shared five-retry budget, including concurrent and later admits", async () => {
  const original=globalThis.fetch;let calls=0,adapter;
  globalThis.fetch=async(url,init)=>{
    calls++;assert.equal(new URL(url).pathname,'/v1/attestation/report');assert.equal(init.method??'GET','GET');
    return new Response('PRIVATE-ACTIVATION-BODY '+options().credential,{status:401});
  };
  try {
    adapter=openCouponNearAdapter(options());const began=performance.now();
    const results=await Promise.allSettled([adapter.admit(),adapter.admit()]);
    assert.equal(calls,6,'one original GET plus exactly five retries shared by both callers');
    assert.ok(performance.now()-began<30000,'absolute activation budget');
    for(const result of results) {
      assert.equal(result.status,'rejected');assert.deepEqual(couponNearAdmissionDiagnostic(result.reason),{stage:'attestation-report-response',errorCode:'http_status',httpStatus:401});
      assert.ok(!JSON.stringify(result.reason).includes('PRIVATE-ACTIVATION'));
    }
    await assert.rejects(adapter.admit(),{code:'provider_admission_refused'});
    assert.equal(calls,7,'later explicit admit makes one GET and cannot renew the retry budget');
  } finally { await adapter?.close();globalThis.fetch=original; }
});

test("activation wait respects close, abort and original shorter deadline without another report", async () => {
  const original=globalThis.fetch;
  try {
    for(const cancellation of ['close','abort','timeout']) {
      let calls=0;const controller=new AbortController();
      globalThis.fetch=async()=>{calls++;return new Response('PRIVATE',{status:401});};
      const adapter=openCouponNearAdapter({...options(),signal:controller.signal,timeoutMs:cancellation==='timeout'?20:60000});
      const pending=adapter.admit();
      const timer=cancellation==='timeout'?null:setTimeout(()=>cancellation==='close'?void adapter.close():controller.abort(),20);
      try { await assert.rejects(pending,e=>e.code===(cancellation==='timeout'?'provider_admission_refused':'provider_closed'));assert.equal(calls,1); }
      finally {clearTimeout(timer);await adapter.close();}
    }
  } finally {globalThis.fetch=original;}
});

test("a non401 report ends activation eligibility; inference 401 remains one terminal POST", async () => {
  const original=globalThis.fetch;let calls=0,adapter;
  try {
    globalThis.fetch=async()=>{calls++;return calls===1?Response.json({invalid:'report'}):new Response('PRIVATE',{status:401});};
    adapter=openCouponNearAdapter(options());
    await assert.rejects(adapter.admit(),e=>couponNearAdmissionDiagnostic(e).stage==='gateway-binding');
    await assert.rejects(adapter.admit(),e=>couponNearAdmissionDiagnostic(e).httpStatus===401);
    assert.equal(calls,2,'an earlier non401 response permanently ends activation retries');
  } finally {await adapter?.close();globalThis.fetch=original;}
  const state={chats:0,closed:false,mode:'revoked'};
  adapter=openCouponNearAdapterForTesting({...options(),verifiedForTesting:verdict(state)});
  try { await assert.rejects(adapter.fetch(`${options().baseUrl}/chat/completions`,request(body())),{code:'access_revoked_or_expired'});assert.equal(state.chats,1,'no inference POST replay'); }
  finally {await adapter.close();}
});


test("ordinary genuine factory still refuses an invalid 200 report after activation retry", async () => {
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>++calls===1?new Response('PRIVATE',{status:401}):Response.json({invalid:'NOT-HARDWARE-EVIDENCE'});
  const adapter=openCouponNearAdapter(options());
  try {await assert.rejects(adapter.admit(),e=>e.code==='provider_admission_refused' && couponNearAdmissionDiagnostic(e).stage==='gateway-binding');assert.equal(calls,2);}
  finally {await adapter.close();globalThis.fetch=original;}
});
