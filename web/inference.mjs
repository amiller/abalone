import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { prepareE2eeChatRequest } from "@nearai/inference-sdk";
import { checkEvidence } from "./evidence.mjs";
import { replyFailure } from "./reply-recovery.mjs";
const require = (ok, message) => { if (!ok) throw new Error(message); };
export async function* sse(body) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      pending = pending.replace(/\r\n/g, "\n");
      let at;
      while ((at = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, at);
        pending = pending.slice(at + 2);
        let event = "message", data = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
      if (done) {
        require(
          !pending.trim(),
          "Inference stream ended in a partial event. Reconcile usage before retrying.",
        );
        break;
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
export const NEAR_CLOUD = "https://cloud-api.near.ai";
// NEAR AI's attestation report for a fresh nonce, fetched by the browser itself: the gateway with its TLS key binding,
// then the model's TEE and GPU evidence. Same two reads as relay-broker near.mjs attest().
export async function nearAttestation(model, nonce, fetcher = fetch) {
  const read = async (query) => {
    const r = await fetcher(`${NEAR_CLOUD}/v1/attestation/report?${new URLSearchParams(query)}`);
    if (!r.ok) throw new Error(`NEAR attestation: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    return r.json();
  };
  const gateway = await read({ nonce, signing_algo: "ecdsa", include_tls_fingerprint: "true" });
  const models = await read({ model, provider: "near", nonce, signing_algo: "ecdsa", include_tls_fingerprint: "false" });
  return { provider: "near", model, mode: "near-direct",
    report: { gateway_attestation: gateway.gateway_attestation, model_attestations: models.model_attestations } };
}
// Model calls straight to NEAR AI Cloud with the page's own key: the browser verifies the attestation, encrypts every
// message field to the attested model key and decrypts the reply. NEAR bills the key; no broker is involved.
export function nearDirectStream({ apiKey, evidence, error, status, preflight, systemPrompt, startedAt }) {
  return (model, context, options = {}) => {
    const stream = new AssistantMessageEventStream();
    const answer = { role: "assistant", content: [{ type: "text", text: "" }], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now() };
    (async () => {
      await preflight?.(context, options.signal);
      const { messages, tools } = modelTranscript(context);
      status?.("Verifying the model…", "", "verify");
      const started = Date.now(), nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
      const e = await nearAttestation(model.id, nonce);
      const modelPublicKey = e.report.model_attestations?.[0]?.signing_public_key;
      const checked = await checkEvidence(e, model.id, started, nonce, modelPublicKey);
      await evidence(checked);
      const runtime = `Model: ${checked.model}\nProvider: NEAR AI Cloud (TEE), your own account\nConversation started: ${startedAt}`;
      messages.unshift({ role: "system", content: systemPrompt({ checked, runtime }) });
      const prepared = await prepareE2eeChatRequest({
        request: new Request(NEAR_CLOUD + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: model.id, messages, ...(tools.length ? { tools, tool_choice: "auto" } : {}),
            max_tokens: options.maxTokens ?? model.maxTokens, stream: true, stream_options: { include_usage: true } }) }),
        modelKey: { signingAlgo: "ecdsa", publicKey: modelPublicKey },
      });
      status?.("Waiting for reply…", "", "reply");
      const response = await fetch(prepared.request.url, { method: "POST", signal: options.signal,
        headers: { ...Object.fromEntries(prepared.request.headers), authorization: "Bearer " + await apiKey() },
        body: await prepared.request.text() });
      if (!response.ok) throw new Error(`NEAR AI: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
      await readCompletion(await prepared.decryptResponse(response), answer, stream, model);
    })().catch((e) => {
      answer.stopReason = options.signal?.aborted ? "aborted" : "error";
      answer.failure = replyFailure(options.signal?.aborted ? new DOMException("Request aborted", "AbortError") : e,
        { partial: answer.content.some((part) => part.type === "text" && part.text) });
      answer.errorMessage = answer.failure.message;
      if (!options.signal?.aborted) error?.(Object.assign(new Error(answer.failure.message), { replyFailure: answer.failure }));
    }).finally(() => {
      stream.push(["error", "aborted"].includes(answer.stopReason) ? { type: "error", reason: answer.stopReason, error: answer }
        : { type: "done", reason: answer.stopReason, message: answer });
      stream.end(answer);
    });
    return stream;
  };
}

// Decrypted OpenAI-style SSE into Pi stream events; sets the answer's text, tool calls, usage and stop reason.
async function readCompletion(decrypted, answer, stream, model) {
  let done = false, finishReason;
  const toolCalls = new Map();
  stream.push({ type: "start", partial: answer });
  for await (const item of sse(decrypted.body)) {
    if (item.event === "error") {
      const e = JSON.parse(item.data).error;
      throw Object.assign(new Error(
        (e?.code || "INFERENCE_ERROR") + ": " +
          (e?.message || "Stream failed. Reconcile usage."),
      ), { code: e?.code || "INFERENCE_ERROR" });
    }
    if (item.data === "[DONE]") {
      done = true;
      continue;
    }
    const chunk = JSON.parse(item.data);
    require(
      !chunk.model || chunk.model === model.id,
      "Provider completion model differs from its attestation.",
    );
    if (chunk.usage) {
      answer.usage.input = chunk.usage.prompt_tokens;
      answer.usage.output = chunk.usage.completion_tokens;
      answer.usage.totalTokens = chunk.usage.total_tokens;
    }
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta?.content;
    if (typeof delta === "string" && delta) {
      if (!answer.content[0].text) stream.push({ type: "text_start", contentIndex: 0, partial: answer });
      answer.content[0].text += delta;
      stream.push({ type: "text_delta", contentIndex: 0, delta, partial: answer });
    }
    for (const call of choice?.delta?.tool_calls || []) {
      let current = toolCalls.get(call.index);
      if (!current) {
        current = { index: answer.content.length, json: "", block: { type: "toolCall", id: call.id || "", name: call.function?.name || "", arguments: {} } };
        toolCalls.set(call.index, current);
        answer.content.push(current.block);
        stream.push({ type: "toolcall_start", contentIndex: current.index, partial: answer });
      } else {
        if (call.id) current.block.id += call.id;
        if (call.function?.name) current.block.name += call.function.name;
      }
      const fragment = call.function?.arguments || "";
      current.json += fragment;
      stream.push({ type: "toolcall_delta", contentIndex: current.index, delta: fragment, partial: answer });
    }
  }
  require(
    done,
    "Inference transport ended before completion. Reconcile provider usage.",
  );
  if (answer.content[0].text) stream.push({ type: "text_end", contentIndex: 0, content: answer.content[0].text, partial: answer });
  for (const current of toolCalls.values()) {
    try {
      current.block.arguments = JSON.parse(current.json || "{}");
      require(current.block.arguments && !Array.isArray(current.block.arguments) && typeof current.block.arguments === "object", "Tool arguments must be a JSON object.");
    } catch (e) {
      current.block.arguments = {};
      current.block.argumentsError = "Model returned invalid tool arguments: " + current.json;
    }
    require(current.block.id && current.block.name, "Incomplete tool call from model.");
    stream.push({ type: "toolcall_end", contentIndex: current.index, toolCall: current.block, partial: answer });
  }
  answer.stopReason = toolCalls.size ? "toolUse" : finishReason === "length" ? "length" : "stop";
}

// Preserve tool requests and results in the encrypted provider transcript. Pi 1.4
// carries declarations in system messages, including changes during a session.
export function modelTranscript(context) {
  const declarations = new Map(), messages = [];
  for (const message of context.messages) {
    if (message.role === "system") {
      for (const tool of message.toolsAdded || []) declarations.set(tool.name, tool);
      for (const tool of message.toolsRemoved || []) declarations.delete(tool.name);
    } else if (message.role === "toolResult") {
      messages.push({ role: "tool", tool_call_id: message.toolCallId,
        content: contentText(message.content) });
    } else if (message.role === "assistant") {
      // Keep failed attempts in the page, but never replay a partial answer as
      // completed model output when the user retries or sends another turn.
      const failed = message.stopReason === "error" || message.stopReason === "aborted";
      const calls = message.content.filter(c => c.type === "toolCall");
      if (failed && !calls.length) continue;
      messages.push({ role: "assistant", content: failed ? null : contentText(message.content) || null,
        ...(calls.length ? { tool_calls: calls.map(c => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}) });
    } else if (message.role === "user") messages.push({ role: "user", content: contentText(message.content) });
  }
  return { messages, tools: [...declarations.values()].map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) };
}
function contentText(content) {
  return typeof content === "string" ? content : content.filter(c => c.type === "text").map(c => c.text).join("\n");
}
