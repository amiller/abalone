// Synthetic socket responses; real coupon provider SDK and Pi session callers, no provider/key/spend.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const { createJiti } = createRequire(new URL("../vendor/pi/package.json", import.meta.url))("jiti");
import { createAgentSession, SessionManager, DefaultResourceLoader } from "../vendor/pi/packages/coding-agent/dist/index.js";
import { ModelRuntime } from "../vendor/pi/packages/coding-agent/dist/core/model-runtime.js";
import { AuthStorage } from "../vendor/pi/packages/coding-agent/dist/core/auth-storage.js";
const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: { "@earendil-works/pi-ai/utils/retry": fileURLToPath(new URL("../vendor/pi/packages/ai/dist/utils/retry.js", import.meta.url)), "@earendil-works/pi-ai/compat": fileURLToPath(new URL("../vendor/pi/packages/ai/dist/compat.js", import.meta.url)), "@earendil-works/pi-ai": fileURLToPath(new URL("../vendor/pi/packages/ai/dist/index.js", import.meta.url)) } });
import { SettingsManager } from "../vendor/pi/packages/coding-agent/dist/core/settings-manager.js";
const { default: couponProvider } = await jiti.import("../agents/pi/coupon-provider.ts");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coupon-no-replay-"));
const socket = path.join(directory, "broker.sock");
const previous = { socket: process.env.ABALONE_COUPON_SOCKET, model: process.env.ABALONE_COUPON_MODEL, provider: process.env.ABALONE_COUPON_PROVIDER, maxTokens: process.env.ABALONE_COUPON_MAX_TOKENS };
process.env.ABALONE_COUPON_SOCKET = socket; process.env.ABALONE_COUPON_MODEL = "Qwen/Qwen3.8-27B"; process.env.ABALONE_COUPON_PROVIDER = "nearai"; process.env.ABALONE_COUPON_MAX_TOKENS = "4096";
let provider, requests = 0, mode = "503", bodies = [];
await couponProvider({ registerProvider: (p) => { provider = p; } });
const model = provider.getModels()[0];
const server = http.createServer((req, res) => {
  assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/chat/completions");
  requests++; const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => bodies.push(JSON.parse(Buffer.concat(chunks))));
  if (mode === "503" || mode === "overflow") {
    res.writeHead(mode === "503" ? 503 : 400, { "content-type": "application/json", "retry-after-ms": "1" });
    res.end(JSON.stringify({ error: { message: mode === "503" ? "synthetic ambiguous upstream failure" : "maximum context length exceeded", type: "synthetic_error" } }));
  } else {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "synthetic-reply", object: "chat.completion.chunk", created: 0, model: model.id,
      choices: [{ index: 0, delta: { content: "synthetic response" }, finish_reason: mode === "length" ? "length" : "stop" }],
      usage: { prompt_tokens: mode === "threshold" ? 32000 : 1, completion_tokens: 1, total_tokens: mode === "threshold" ? 32001 : 2 } })}\n\ndata: [DONE]\n\n`);
  }
});
await new Promise((resolve) => server.listen(socket, resolve));
test.after(async () => {
  await new Promise((resolve) => server.close(resolve)); fs.rmSync(directory, { recursive: true, force: true });
  for (const [key, env] of [["socket", "ABALONE_COUPON_SOCKET"], ["model", "ABALONE_COUPON_MODEL"], ["provider", "ABALONE_COUPON_PROVIDER"], ["maxTokens", "ABALONE_COUPON_MAX_TOKENS"]]) {
    if (previous[key] === undefined) delete process.env[env]; else process.env[env] = previous[key];
  }
});

test("Pi's thinking level sets enable_thinking on coupon requests; the trial's cap is the model's max_tokens", async () => {
  mode = "stop"; bodies = [];
  assert.equal(model.reasoning, true); assert.equal(model.maxTokens, 4096);
  for (const reasoning of [undefined, "medium"]) await provider.streamSimple(model, { messages: [{ role: "user", content: "synthetic request", timestamp: 0 }] }, { apiKey: "coupon-session", reasoning }).result();
  assert.deepEqual(bodies.map((b) => b.chat_template_kwargs), [{ enable_thinking: false }, { enable_thinking: true }]);
  assert.deepEqual(bodies.map((b) => b.max_tokens), [4096, 4096]);
  assert.deepEqual(bodies.map((b) => b.stream_options), [{ include_usage: true }, { include_usage: true }]);
});

test("the coupon model's cap is the trial's; a missing or out-of-range cap refuses", async () => {
  assert.equal(model.maxTokens, 4096);
  for (const value of [undefined, "0", "4097", "512.5"]) {
    if (value === undefined) delete process.env.ABALONE_COUPON_MAX_TOKENS; else process.env.ABALONE_COUPON_MAX_TOKENS = value;
    await assert.rejects(couponProvider({ registerProvider: () => assert.fail("registered") }), { code: "model_not_admitted" });
  }
  process.env.ABALONE_COUPON_MAX_TOKENS = "4096";
});

for (const api of ["stream", "streamSimple"]) test(`coupon ${api} sends once despite caller SDK retry override`, async () => {
  requests = 0; mode = "503";
  const stream = provider[api](model, { messages: [{ role: "user", content: "synthetic request", timestamp: 0 }] }, { apiKey: "coupon-session", maxRetries: 3 });
  const result = await stream.result();
  assert.equal(result.stopReason, "error"); assert.equal(requests, 1);
});

for (const response of ["503", "overflow", "length", "threshold"]) test(`Pi coupon ${response} has no automatic retry, summary or continuation after project/runtime overrides`, async () => {
  requests = 0; mode = response;
  const cwd = path.join(directory, response), agentDir = path.join(cwd, "agent"); fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true }); fs.mkdirSync(agentDir);
  const enable = { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, provider: { maxRetries: 3 } }, compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 1024 } };
  fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify(enable));
  const settings = SettingsManager.create(cwd, agentDir);
  settings.applyOverrides(enable); settings.setRetryEnabled(true); settings.setCompactionEnabled(true); settings.setCacheWarmingMode("idle");
  assert.equal(settings.getCacheWarmingMode(), "off");
  const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, allowModelNetwork: false });
  runtime.registerNativeProvider(provider); await runtime.refresh({ allowNetwork: false });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), tools: [] });
  const events = []; session.subscribe((e) => events.push(e.type));
  try {
    await session.prompt("synthetic request"); await session.agent.waitForIdle();
    assert.equal(requests, 1, "No SDK/agent retry, summary request or automatic continuation is allowed");
    assert.ok(!events.includes("auto_retry_start")); assert.ok(!events.includes("auto_compaction_start"));
    assert.equal(session.state.messages.filter((m) => m.role === "assistant").length, 1);
    const final = session.state.messages.at(-1); assert.equal(final.stopReason, response === "503" || response === "overflow" ? "error" : response === "length" ? "length" : "stop");
  } finally { session.dispose(); }
});

test("non-coupon retry and compaction preferences stay unchanged", () => {
  delete process.env.ABALONE_COUPON_SOCKET;
  try {
    const manager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 3, provider: { maxRetries: 2 } }, compaction: { enabled: true }, cacheWarming: "streaming" });
    assert.equal(manager.getRetryEnabled(), true); assert.equal(manager.getRetrySettings().maxRetries, 3);
    assert.equal(manager.getProviderRetrySettings().maxRetries, 2); assert.equal(manager.getCompactionEnabled(), true); assert.equal(manager.getCacheWarmingMode(), "streaming");
  } finally { process.env.ABALONE_COUPON_SOCKET = socket; }
});
