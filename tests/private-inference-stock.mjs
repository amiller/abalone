// Run from a fresh published Pi install, with a packed provider package installed
// as an ordinary npm dependency. No vendored Pi or patched module aliases.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const stock = process.env.STOCK_PI_ROOT;
if (!stock) throw new Error("Set STOCK_PI_ROOT to the isolated published-Pi installation.");
const req = createRequire(path.join(stock, "package.json"));
const { createJiti } = req("jiti");
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
const pkg = path.join(stock, "node_modules/@abalone/pi-private-inference-chutes");
const { registerChutes } = await jiti.import(path.join(pkg, "pi-extension.ts"));
const { ml_kem768 } = await import(pathToFileURL(req.resolve("@noble/post-quantum/ml-kem.js", { paths: [pkg] })));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "abalone-stock-pi-"));
const instance = ml_kem768.keygen();
const listed = { instance_id: "synthetic-instance", e2e_pubkey: Buffer.from(instance.publicKey).toString("base64"), nonces: ["synthetic-once"] };
const modelId = "synthetic/private-TEE";
const key = "synthetic-private-key-never-print";
process.env.CHUTES_API_KEY = key;
let calls = [], bodies = [], behavior = "answer", checkFails = false;
const kdf = (ss, ct, info) => Buffer.from(crypto.hkdfSync("sha256", ss, ct.subarray(0, 16), info, 32));
function unseal(blob) {
  const ct = blob.subarray(0, 1088), key = kdf(ml_kem768.decapsulate(ct, instance.secretKey), ct, "e2e-req-v1");
  const cipher = crypto.createDecipheriv("chacha20-poly1305", key, blob.subarray(1088, 1100), { authTagLength: 16 });
  cipher.setAuthTag(blob.subarray(-16));
  return JSON.parse(zlib.gunzipSync(Buffer.concat([cipher.update(blob.subarray(1100, -16)), cipher.final()])));
}
function reply(body, message, finish = "stop") {
  const c = { id: "synthetic-response", model: modelId, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  const enc = ml_kem768.encapsulate(Buffer.from(body.e2e_response_pk, "base64")), ct = Buffer.from(enc.cipherText), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("chacha20-poly1305", kdf(enc.sharedSecret, ct, "e2e-resp-v1"), iv, { authTagLength: 16 });
  const out = Buffer.concat([ct, iv, cipher.update(zlib.gzipSync(JSON.stringify(c))), cipher.final(), cipher.getAuthTag()]);
  if (behavior === "corrupt") out[out.length - 1] ^= 1;
  return new Response(out);
}
const http = async (url, init = {}) => {
  const u = String(url); calls.push(u);
  if (u.endsWith("/v1/models")) return Response.json({ data: [{ id: modelId, chute_id: "synthetic-chute", confidential_compute: true,
    supported_features: ["tools"], output_modalities: ["text"], pricing: { prompt: 0, completion: 0 }, context_length: 65536, max_output_length: 4096 }] });
  assert.equal(init.headers.authorization, `Bearer ${key}`);
  if (u.includes("/e2e/instances/")) return Response.json({ instances: [listed] });
  assert.equal(u, "https://api.chutes.ai/e2e/invoke");
  assert.equal(init.headers["X-E2E-Stream"], "false");
  assert.ok(!init.body.includes("private specimen"), "prompt must not occur on the wire");
  const body = unseal(init.body); bodies.push(body);
  if (behavior === "lost") throw new Error("synthetic lost connection " + key);
  if (behavior === "503") return new Response("secret response " + key, { status: 503 });
  const wanted = behavior === "read" ? "read" : behavior === "edit" ? "edit" : undefined;
  if (wanted && !body.messages.some((m) => m.role === "tool")) {
    const args = wanted === "read" ? { path: "sample.md" } : { path: "sample.md", oldText: "draft", newText: "ready" };
    return reply(body, { role: "assistant", content: null, tool_calls: [{ id: "native-tool", type: "function", function: { name: wanted, arguments: JSON.stringify(args) } }] }, "tool_calls");
  }
  return reply(body, { role: "assistant", content: "Private inference task complete." });
};
let provider;
await registerChutes({ on() {}, appendEntry() {}, registerProvider: (p) => { provider = p; } },
  { http, verify: async () => { if (checkFails) throw new Error("wrong quote/key " + key); return { model_tcb: ["UpToDate"] }; } });
const model = provider.getModels()[0];
let retryCalls = 0;
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/retry-control") {
      for await (const _ of request) {}
      retryCalls++;
      if (retryCalls === 1) { response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "temporarily overloaded" } })); }
      else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ id: "retry-control", model: modelId, choices: [{ index: 0, delta: { content: "Retry control complete." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`);
      }
      return;
    }
    const chunks = []; for await (const c of request) chunks.push(c);
    const replay = JSON.parse(Buffer.concat(chunks));
    const init = { ...replay.init, ...(replay.init.body ? { body: Buffer.from(replay.init.body, "base64") } : {}) };
    const result = await http(replay.url, init);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch { response.destroy(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const replayUrl = `http://127.0.0.1:${server.address().port}`;
test.after(async () => { delete process.env.CHUTES_API_KEY; await new Promise((resolve) => server.close(resolve)); fs.rmSync(scratch, { recursive: true, force: true }); });

for (const method of ["stream", "streamSimple"]) test(`stock SDK ${method}: encrypted requests, authenticated responses, no retry override`, async () => {
  calls = []; bodies = []; behavior = "answer";
  const result = await provider[method](model, { messages: [{ role: "user", content: "private specimen", timestamp: 0 }],
    tools: [{ name: "read", description: "read private files", parameters: { type: "object", properties: {} } }] }, { apiKey: key, maxRetries: 5 }).result();
  assert.equal(result.stopReason, "stop");
  assert.equal(bodies.length, 1);
  assert.ok(bodies[0].messages.some((m) => String(m.content).includes("private specimen")));
});

async function piSession(name) {
  const cwd = path.join(scratch, name), agentDir = path.join(cwd, "agent"); fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(cwd, "sample.md"), "private specimen draft\n");
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, provider: { maxRetries: 3 } }, compaction: { enabled: false }, cacheWarming: "off" }));
  if (["endpoint-override", "api-override"].includes(name)) fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
    chutes: { baseUrl: replayUrl + "/plaintext-trap", ...(name === "api-override" ? { models: [{ id: modelId, api: "anthropic-messages", contextWindow: 65536, maxTokens: 4096 }] } : {}) },
  } }));
  const driver = path.join(cwd, "synthetic-extension.ts");
  fs.writeFileSync(driver, behavior === "retry-control" ? `import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
export default function(pi) {
  const api = openAICompletionsApi();
  pi.registerProvider(createProvider({ id: "chutes", baseUrl: ${JSON.stringify(replayUrl)},
    auth: { apiKey: envApiKeyAuth("synthetic", ["CHUTES_API_KEY"]) }, models: [${JSON.stringify({ ...model, baseUrl: replayUrl })}],
    api: { stream: (m,c,o) => api.stream(m,c,{...o,maxRetries:0,fetch:(_u,i)=>fetch(${JSON.stringify(replayUrl + "/retry-control")},i)}),
      streamSimple: (m,c,o) => api.streamSimple(m,c,{...o,maxRetries:0,fetch:(_u,i)=>fetch(${JSON.stringify(replayUrl + "/retry-control")},i)}) }
  }));
}` : `import { registerChutes } from ${JSON.stringify(path.join(pkg, "pi-extension.ts"))};
export default async function(pi) {
  await registerChutes(pi, {
    http: async (url, init = {}) => fetch(${JSON.stringify(replayUrl)}, { method: "POST", body: JSON.stringify({url: String(url), init: {...init, signal: undefined, body: init.body ? Buffer.from(init.body).toString("base64") : undefined}}) }),
    verify: async () => { if (${checkFails}) throw new Error("wrong quote/key ${key}"); return { model_tcb: ["UpToDate"] }; }
  });
}`);
  const child = spawn(process.execPath, [path.join(stock, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    "-e", driver, "--mode", "rpc", "--no-session", "--provider", "chutes", "--model", modelId, "--tools", "read,edit"],
    { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
  let errors = "", buffer = "";
  child.stderr.on("data", (b) => { errors += b; });
  const events = [];
  let completed;
  const done = new Promise((resolve, reject) => {
    completed = resolve;
    child.on("error", reject);
    child.on("exit", (code) => { if (code) reject(new Error(errors || `Pi exited ${code}`)); });
  });
  child.stdout.on("data", (b) => {
    buffer += b;
    let nl; while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      try { const event = JSON.parse(line); events.push(event); if (event.type === "agent_end" && event.willRetry === false || name === "api-override" && event.type === "response" && event.command === "prompt" && event.success) completed(); } catch {}
    }
  });
  return { cwd, events, prompt: async (message) => {
    child.stdin.write(JSON.stringify({ id: "task", type: "prompt", message }) + "\n");
    await Promise.race([done, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Pi test deadline: " + errors)), 20000); timer.unref(); })]);
  }, close: () => child.kill() };
}
for (const operation of ["read", "edit", "endpoint-override"]) test(`unmodified Pi ${operation} stays on the sealed request path`, async () => {
  calls = []; bodies = []; behavior = operation;
  const session = await piSession(operation);
  const { cwd } = session;
  try {
    await session.prompt(`Use ${operation} on sample.md, a private specimen, then report completion.`);

    assert.equal(bodies.length, operation === "endpoint-override" ? 1 : 2);
    if (operation !== "endpoint-override") {
      assert.ok(bodies[0].tools.some((t) => t.function.name === operation));
      assert.ok(bodies[1].messages.some((m) => m.role === "tool"));
    }
    assert.equal(session.events.findLast((e) => e.type === "message_end" && e.message?.role === "assistant").message.stopReason, "stop");
    if (operation === "edit") assert.equal(fs.readFileSync(path.join(cwd, "sample.md"), "utf8"), "private specimen ready\n");
  } finally { session.close(); }
});

test("custom API override cannot silently replace Chutes private inference with another transport", async () => {
  calls = []; bodies = []; behavior = "answer";
  const session = await piSession("api-override");
  try {
    await session.prompt("private specimen");
    assert.equal(bodies.length, 0);
    assert.ok(!session.events.some((e) => e.type === "agent_start"));
    assert.ok(session.events.some((e) => e.type === "extension_ui_request" && /custom API override/.test(e.message ?? "")));
  } finally { session.close(); }
});

test("retry control: harness waits through agent_end.willRetry and observes the second invocation", async () => {
  behavior = "retry-control"; retryCalls = 0;
  const session = await piSession("retry-control");
  try {
    await session.prompt("private specimen");
    assert.equal(retryCalls, 2);
    assert.ok(session.events.some((e) => e.type === "agent_end" && e.willRetry === true));
    assert.ok(session.events.some((e) => e.type === "auto_retry_start"));
    assert.equal(session.events.findLast((e) => e.type === "agent_end").willRetry, false);
  } finally { session.close(); }
});

for (const mode of ["503", "lost", "corrupt", "bad-evidence"]) test(`stock Pi ${mode}: no automatic charged replay and no secret in errors`, async () => {
  calls = []; bodies = []; behavior = mode; checkFails = mode === "bad-evidence";
  // Fresh provider/cache for the verification refusal.
  await registerChutes({ on() {}, appendEntry() {}, registerProvider: (p) => { provider = p; } },
    { http, verify: async () => { if (checkFails) throw new Error("wrong quote/key " + key); return { model_tcb: ["UpToDate"] }; } });
  const session = await piSession(mode);
  const events = session.events;
  try {
    await session.prompt("private specimen");
    assert.equal(bodies.length, mode === "bad-evidence" ? 0 : 1);
    assert.ok(!events.some((e) => e.type === "auto_retry_start"));
    assert.ok(events.filter((e) => e.type === "agent_end").every((e) => e.willRetry === false));
    const final = events.findLast((e) => e.type === "message_end" && e.message?.role === "assistant").message;
    assert.equal(final.stopReason, "error"); assert.ok(!final.errorMessage.includes(key));
  } finally { session.close(); checkFails = false; }
});
