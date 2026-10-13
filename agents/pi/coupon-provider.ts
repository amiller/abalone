// Coupon session provider: the raw credential stays in the launcher's socket broker.
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { providers } from "../../lib/config.mjs";
import { admitAttestedCouponNearProvider, admitCouponSessionProvider, NEAR_COUPON_PI_COMPAT } from "../../lib/coupon-attested-session.mjs";
import { couponSocketFetch } from "../../lib/coupon-socket.mjs";

export default async function (pi: ExtensionAPI) {
  const socketPath = process.env.ABALONE_COUPON_SOCKET, selected = process.env.ABALONE_COUPON_MODEL;
  const providerId = process.env.ABALONE_COUPON_PROVIDER ?? "synthetic-near";
  if (!socketPath || !selected) return;
  // "synthetic-near": the configured loopback fixture provider (v4 fixture profile).
  // "nearai": the strict pinned NEAR profile of the attested v4 debug-staging session — no
  // providers.json inheritance, no ambient key; the launcher's adapter holds the credential.
  const p = providerId === "nearai" ? admitAttestedCouponNearProvider(selected, false, Number(process.env.ABALONE_COUPON_MAX_TOKENS)) : admitCouponSessionProvider(providers(), selected);
  const socketFetch = couponSocketFetch(socketPath);
  const send: typeof fetch = async (input, init) => {
    try {
      const response = await socketFetch(input, init);
      if (providerId === "nearai") pi.appendEntry?.("coupon-provider-result", { provider: providerId, model: selected, accepted: response.ok });
      return response;
    } catch (error) {
      if (providerId === "nearai") pi.appendEntry?.("coupon-provider-result", { provider: providerId, model: selected, accepted: false });
      throw error;
    }
  };
  const api = openAICompletionsApi();
  const near = providerId === "nearai";
  pi.registerProvider(createProvider({ id: p.provider, baseUrl: "http://127.0.0.1:0/v1",
    name: near ? "NEAR coupon · trial" : "Synthetic coupon fixture",
    auth: { apiKey: { name: "session coupon socket", resolve: async () => ({ auth: { apiKey: "coupon-session" } }) } } as any,
    models: [{ id: p.model, name: near ? p.model : `${p.model} (fixture)`,
      api: "openai-completions", provider: p.provider, baseUrl: "http://127.0.0.1:0/v1", reasoning: near, input: ["text"],
      ...(near ? { compat: NEAR_COUPON_PI_COMPAT } : {}),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: near ? p.maxTokens : 4096 }],
    api: { stream: (model: any, context: any, options: any) => api.stream(model, context, { ...options, fetch: send, maxRetries: 0 }),
      streamSimple: (model: any, context: any, options: any) => api.streamSimple(model, context, { ...options, fetch: send, maxRetries: 0 }) },
  }));
}
