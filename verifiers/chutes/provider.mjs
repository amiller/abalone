// Provider-independent Pi glue lives in pi-extension.ts. This module owns only
// the Chutes protected request path and can be used by other clients.
import { API, open, pick, seal, verifyInstance } from "./transport.mjs";

export const MODELS_URL = "https://llm.chutes.ai/v1/models";
export const POLICY = Object.freeze({ tcb: "UpToDate", gpuSignature: "required" });
// Stock Pi recognises billing errors as final even when automatic retry is on.
// Never expose a raw fetch exception after a potentially charged invocation.
const refusal = (_status, message) => new Response(JSON.stringify({ error: { message: message + " Automatic billing retry is disabled." } }),
  { status: 400, headers: { "content-type": "application/json" } });

export function privateModels(list) {
  if (!Array.isArray(list?.data)) throw new Error("Chutes did not return a model list.");
  return list.data.filter((m) => m.confidential_compute === true && m.supported_features?.includes("tools") &&
    m.output_modalities?.includes("text") && typeof m.id === "string" && typeof m.chute_id === "string").map((m) => ({
    id: m.id, name: m.id, chuteId: m.chute_id, api: "openai-completions", provider: "chutes", baseUrl: API + "/v1",
    reasoning: false, input: ["text"], cost: { input: m.pricing?.prompt ?? 0, output: m.pricing?.completion ?? 0,
      cacheRead: m.pricing?.input_cache_read ?? 0, cacheWrite: 0 },
    contextWindow: m.context_length, maxTokens: Math.min(m.max_output_length, 32768),
  }));
}

function asStream(c) {
  const ch = c.choices[0], m = ch.message;
  if (!m || typeof m !== "object") throw new Error("Chutes returned no assistant message.");
  const delta = { role: "assistant", content: m.content, reasoning_content: m.reasoning_content ?? m.reasoning,
    tool_calls: m.tool_calls?.map((t, index) => ({ index, ...t })) };
  return `data: ${JSON.stringify({ id: c.id, object: "chat.completion.chunk", created: c.created, model: c.model,
    choices: [{ index: 0, delta, finish_reason: ch.finish_reason }], usage: c.usage })}\n\ndata: [DONE]\n\n`;
}

// Dependencies are injectable for offline checks; the shipped extension always
// uses the fixed API and verifier. There is no environment switch to skip checks.
export function protectedFetch({ models, policy = POLICY, http = fetch, verify = verifyInstance, onVerified = () => {}, onState = () => {} }) {
  const verified = new Map();
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const model = models.find((m) => m.id === body.model);
    if (!model) return refusal(403, "Private inference refused: model is not in this integration's Chutes TEE list.");
    const authorization = new Headers(init.headers).get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length <= 7)
      return refusal(401, "Private inference needs a Chutes credential. Set CHUTES_API_KEY before starting Pi.");
    const get = async (p) => {
      const r = await http(API + p, { headers: { authorization }, signal: init.signal });
      if (!r.ok) throw new Error(`Chutes verification request returned HTTP ${r.status}.`);
      return r.json();
    };
    let inst, profile;
    onState("checking");
    try {
      if (init.signal?.aborted) throw new Error("Request cancelled.");
      const result = await get(`/e2e/instances/${encodeURIComponent(model.chuteId)}`);
      const listed = result.instances?.filter((i) => typeof i.instance_id === "string" && typeof i.e2e_pubkey === "string" &&
        Array.isArray(i.nonces) && i.nonces.some((n) => typeof n === "string" && n));
      if (!listed?.length) throw new Error("Chutes lists no instance accepting encrypted requests.");
      [inst, profile] = await pick(listed, verified, (i) => verify(i, get, policy, http));
      onVerified({ ...profile, model: body.model, provider: "chutes" });
    } catch (e) {
      onState("refused");
      // Verification failures are not OpenAI transport exceptions: Pi must not
      // turn a failed check into an automatic request with another transport.
      const reason = String(e.message).replaceAll(authorization.slice(7), "[credential withheld]")
        .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 240);
      return refusal(403, "Private inference refused: " + reason);
    }
    if (init.signal?.aborted) throw new Error("Request cancelled.");
    delete body.stream_options;
    const { blob, sk } = seal(inst.e2e_pubkey, { ...body, stream: false });
    onState("sending");
    let r;
    try { r = await http(`${API}/e2e/invoke`, { method: "POST", body: blob, signal: init.signal, headers: {
      authorization, "content-type": "application/octet-stream", "X-Chute-Id": model.chuteId,
      "X-Instance-Id": inst.instance_id, "X-E2E-Nonce": inst.nonces.find((n) => typeof n === "string" && n),
      "X-E2E-Stream": "false", "X-E2E-Path": "/v1/chat/completions" } }); }
    catch { onState("refused"); return refusal(400, "The encrypted request did not complete. It may have been charged; check provider usage before sending again."); }
    if (!r.ok) { onState("refused"); return refusal(r.status, `Chutes encrypted request returned HTTP ${r.status}.`); }
    try {
      const c = JSON.parse(open(Buffer.from(await r.arrayBuffer()), sk));
      if (!c.choices?.length) throw new Error("No answer in authenticated response.");
      const stream = asStream(c);
      onState("verified");
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    } catch {
      onState("refused");
      return refusal(502, "Private inference refused: the complete encrypted response could not be authenticated or decoded.");
    }
  };
}
