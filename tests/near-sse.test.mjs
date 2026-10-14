import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { decryptSse } from "../lib/near-sse.mjs";
import { prepareNearTextTools } from "../lib/near-tool-boundary.mjs";
import { encrypt } from "../lib/near.mjs";

const key = crypto.createECDH("secp256k1"); key.generateKeys();
const seal = (text) => encrypt(text, key.getPublicKey("hex"));
const wire = (text, width = 7) => new ReadableStream({ start(controller) {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += width) controller.enqueue(bytes.slice(i, i + width));
  controller.close();
} });
const decode = (text, width) => new Response(decryptSse(wire(text, width), key)).text();

for (const prefix of ["data: ", "data:", "data:  "]) {
  test(`ordinary NEAR decoder refuses native tool arguments (${JSON.stringify(prefix)})`, async () => {
    const secret = "synthetic-native-tool-canary";
    for (const delta of [
      { tool_calls: [{ index: 0, function: { arguments: secret } }] },
      { function_call: { name: "read", arguments: secret } },
      { nearai_tool_result: { output: secret } },
    ]) await assert.rejects(decode(`${prefix}${JSON.stringify({ choices: [{ delta }] })}\r\n\r\ndata: [DONE]\r\n`), /unsupported native tool/);
  });
}

test("ordinary NEAR decoder keeps encrypted text tools and reasoning", async () => {
  const text = '<tool_call>read<arg_key>path</arg_key><arg_value>synthetic.txt</arg_value></tool_call>';
  const delta = { content: seal(text), reasoning_content: seal("synthetic reasoning"), tool_calls: null };
  const result = await decode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, 1);
  const parsed = JSON.parse(result.split("\n").find((line) => line.startsWith("data: {" )).slice(6));
  assert.equal(parsed.choices[0].delta.content, text);
  assert.equal(parsed.choices[0].delta.reasoning_content, "synthetic reasoning");
  assert.ok(result.includes("data: [DONE]"));
});

test("ordinary request preparation removes schemas and refuses both history formats", () => {
  const secret = "synthetic-schema-canary";
  const body = { messages: [{ role: "user", content: secret }], tools: [{ description: secret }],
    tool_choice: "auto", parallel_tool_calls: true, functions: [{ name: secret }], function_call: { name: secret } };
  prepareNearTextTools(body);
  assert.deepEqual(body, { messages: [{ role: "user", content: secret }] });
  for (const message of [
    { role: "assistant", content: "", tool_calls: [{ function: { arguments: secret } }] },
    { role: "assistant", content: "", function_call: { arguments: secret } },
    { role: "tool", content: secret }, { role: "function", content: secret },
    { role: "assistant", content: "", tool_call_id: secret },
    { role: "assistant", content: "", name: secret },
  ]) assert.throws(() => prepareNearTextTools({ messages: [message] }), (error) =>
    error.message.includes("unsupported") && !error.message.includes(secret));
});

test("native finish reasons and non-stream message envelopes cannot bypass refusal", async () => {
  for (const choice of [
    { delta: {}, finish_reason: "tool_calls" }, { delta: {}, finish_reason: "function_call" },
    { message: { function_call: { arguments: "synthetic-secret" } } },
  ]) await assert.rejects(decode(`data:${JSON.stringify({ choices: [choice] })}\n\n`), /unsupported native tool/);
});

test("gift accounting and raw response verification finish before DONE", async () => {
  const raw = `data: ${JSON.stringify({ choices: [{ delta: { content: seal("synthetic answer") } }], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\ndata: [DONE]\n\n`;
  const charge = { charge: 8, remaining: 92 };
  const bytes = raw + `: abalone-charge ${JSON.stringify(charge)}\n\n`;
  const steps = [];
  const result = await new Response(decryptSse(wire(bytes), key, { input: 1, output: 2 },
    (value) => { assert.deepEqual(value, charge); steps.push("charge"); }, undefined,
    async (observed) => { assert.equal(observed.toString(), raw); steps.push("verified"); })).text();
  assert.deepEqual(steps, ["charge", "verified"]);
  assert.ok(result.includes("synthetic answer"));
  assert.ok(result.endsWith("data: [DONE]\n\n"));
  await assert.rejects(new Response(decryptSse(wire(bytes.replace('"charge":8', '"charge":9')), key,
    { input: 1, output: 2 }, () => assert.fail("wrong charge accepted"))).text(), /charge.*didn't match/);
});

test("encrypted thinking marker split across chunks preserves tools after the marker", async () => {
  const data = ["thinking </thi", "nk><tool_call>read</tool_call>"].map((content) =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: seal(content) } }] })}\n\n`).join("") + "data: [DONE]\n\n";
  const decoded = await new Response(decryptSse(wire(data, 1), key, undefined, undefined, undefined, undefined, true)).text();
  const chunks = decoded.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  assert.equal(chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join(""), "<tool_call>read</tool_call>");
});

test("Pi receives an error rather than an executable native tool request", async () => {
  const { streamSimple } = await import("../vendor/pi/packages/ai/dist/api/openai-completions.js");
  const model = { id: "synthetic/model", name: "Synthetic", provider: "nearai", api: "openai-completions", baseUrl: "http://synthetic.invalid/v1",
    reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 128,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const bad = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "synthetic-call", type: "function", function: { name: "read", arguments: '{"path":"synthetic.txt"}' } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
  const response = await streamSimple(model, { messages: [{ role: "user", content: "synthetic", timestamp: Date.now() }] },
    { apiKey: "synthetic", fetch: async () => new Response(decryptSse(wire(bad), key), { headers: { "content-type": "text/event-stream" } }) }).result();
  assert.equal(response.stopReason, "error");
  assert.ok(!response.content.some((part) => part.type === "toolCall"));
});
