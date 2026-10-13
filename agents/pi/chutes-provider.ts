// Chutes TEE models, reached directly: lib/chutes.mjs verifies the instance a request goes to before its first byte, and
// the whole request (messages, tools, parameters) is sealed to that instance's attested ML-KEM key. Chutes' API relays the
// ciphertext and sees the account, model, instance, sizes and timing. Replies are requested unstreamed: Chutes' streamed
// frames carry no sequence numbers, so its API could drop or reorder them unnoticed; one sealed reply cannot be cut.
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { providers } from "../../lib/config.mjs";
import { API, open, pick, seal, strip, verifyInstance } from "../../lib/chutes.mjs";
import { untrusted } from "../../lib/near.mjs";

const refuse = (status: number, message: string) => new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });

// One sealed chat.completion as the stream pi reads: a single chunk carrying the whole message, then [DONE].
function asStream(c: any) {
  const ch = c.choices[0], m = ch.message;
  const delta = { role: "assistant", content: m.content, reasoning_content: m.reasoning_content ?? m.reasoning, tool_calls: m.tool_calls?.map((t: any, index: number) => ({ index, ...t })) };
  return `data: ${JSON.stringify({ id: c.id, object: "chat.completion.chunk", created: c.created, model: c.model, choices: [{ index: 0, delta, finish_reason: ch.finish_reason }], usage: c.usage })}\n\ndata: [DONE]\n\n`;
}

export default async function (pi: ExtensionAPI) {
  let ui: any = null;
  pi.on("session_start", async (_e: any, ctx: any) => { ui = ctx.ui; });
  const cfg = providers().admitted.find((a: any) => a.id === "chutes");
  const key = () => { const k = process.env[cfg.keyEnv]; if (!k) throw new Error(`no ${cfg.keyEnv}: add one with  abalone key add chutes`); return k; };
  const get = async (p: string) => {
    const r = await fetch(API + p, { headers: { authorization: `Bearer ${key()}` } });
    if (!r.ok) throw new Error(`✗ refused: Chutes ${p.split("?")[0]} answered HTTP ${r.status}: ${untrusted(await r.text())}; nothing was sent`);
    return r.json();
  };
  const verified = new Map<string, Promise<any>>(); // instance_id + e2e_pubkey → its verification (lib/chutes.mjs pick)

  const fetchE2ee: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init!.body)), m = models.find((x: any) => x.id === body.model)!;
    let inst: any, profile: any;
    try {
      const listed = (await get(`/e2e/instances/${m.chuteId}`)).instances.filter((i: any) => i.nonces?.length);
      if (!listed.length) throw new Error(`✗ refused: Chutes lists no instance of ${body.model} that takes encrypted requests; nothing was sent`);
      [inst, profile] = await pick(listed, verified, (i: any) => verifyInstance(i, get, cfg.policy).then((p: any) => {
        const prof = { ...p, model: body.model, chute_id: m.chuteId, place: "◈ attested", code: cfg.axes.code, observer: cfg.observer, custody: "unchecked" };
        pi.appendEntry("chutes-attestation", { ...prof, provider: "chutes" });
        return prof;
      }));
    } catch (e: any) { return refuse(403, e.message); } // the OpenAI client would report a thrown fetch only as "Connection error."
    ui?.setStatus("chutes", strip(profile));
    delete body.stream_options;
    const { blob, sk } = seal(inst.e2e_pubkey, { ...body, stream: false });
    const r = await fetch(`${API}/e2e/invoke`, { method: "POST", body: blob, signal: init!.signal, headers: {
      authorization: `Bearer ${key()}`, "content-type": "application/octet-stream", "X-Chute-Id": m.chuteId, "X-Instance-Id": inst.instance_id,
      "X-E2E-Nonce": inst.nonces[0], "X-E2E-Stream": "false", "X-E2E-Path": "/v1/chat/completions" } });
    if (!r.ok) return refuse(r.status, `Chutes says (HTTP ${r.status}): ${untrusted(await r.text())}`);
    const c = JSON.parse(open(Buffer.from(await r.arrayBuffer()), sk));
    if (!c.choices?.length) return refuse(502, `instance ${inst.instance_id} says: ${untrusted(JSON.stringify(c))}`);
    return new Response(asStream(c), { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const list = await (await fetch(cfg.modelsUrl)).json();
  const models = list.data.filter((m: any) => m.confidential_compute === true && m.supported_features?.includes("tools") && m.output_modalities?.includes("text")).map((m: any) => ({
    id: m.id, name: m.id, chuteId: m.chute_id, api: "openai-completions" as const, provider: "chutes", baseUrl: cfg.baseUrl, reasoning: false,
    input: ["text" as const], cost: { input: m.pricing.prompt, output: m.pricing.completion, cacheRead: m.pricing.input_cache_read ?? 0, cacheWrite: 0 },
    contextWindow: m.context_length, maxTokens: Math.min(m.max_output_length, 32768),
  }));
  const streams = openAICompletionsApi();
  pi.registerProvider(createProvider({
    id: "chutes", name: "Chutes (per-instance attestation, E2EE)", baseUrl: cfg.baseUrl,
    auth: { apiKey: { ...envApiKeyAuth("Chutes API key", [cfg.keyEnv]), login: undefined } } as any,
    models,
    api: {
      stream: (model: any, context: any, options: any) => streams.stream(model, context, { ...options, fetch: fetchE2ee }),
      streamSimple: (model: any, context: any, options: any) => streams.streamSimple(model, context, { ...options, fetch: fetchE2ee }),
    },
  } as any));
}
