// ⌂ local inference: OpenAI-compatible servers on loopback (ollama, llama-server) from providers.json "local".
// The launcher refuses a non-loopback baseUrl, and the sandbox can only reach loopback ports it forwards.
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { providers } from "../lib/config.mjs";

export default async function (pi: ExtensionAPI) {
  if (process.env.ABALONE_COUPON_SOCKET) return; // the coupon's exact admitted model uses its scoped socket adapter
  for (const l of providers().local.filter((l: any) => !l.builtin)) {
    let ids: string[];
    try {
      const r = await fetch(`${l.baseUrl}/models`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      ids = (await r.json()).data.map((m: any) => m.id);
    } catch (e: any) {
      console.error(`⌂ local provider ${l.id}: ${l.baseUrl} not reachable (${e.cause?.code ?? e.message}); no models`);
      continue;
    }
    const models = ids.map((id) => ({ id, name: id, api: "openai-completions" as const, provider: l.id, baseUrl: l.baseUrl, reasoning: false,
      input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: l.contextWindow ?? 32768, maxTokens: l.maxTokens ?? 4096 }));
    const streams = openAICompletionsApi();
    pi.registerProvider(createProvider({ id: l.id, name: `${l.id} ⌂ local`, baseUrl: l.baseUrl,
      auth: { apiKey: { name: l.id, resolve: async () => ({ auth: { apiKey: "local" } }) } } as any, models, api: streams }));
  }
}
