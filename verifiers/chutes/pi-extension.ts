// Add protected private inference to ordinary Pi. No custom launcher or coupon
// state, tool replacement, system prompt replacement, or local sandbox.
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MODELS_URL, POLICY, privateModels, protectedFetch } from "./provider.mjs";

export async function registerChutes(pi: ExtensionAPI, options: any = {}) {
  const http = options.http ?? fetch;
  let ui: any;
  let selected = false;
  let status = "not checked yet";
  const display = () => ui?.setStatus("abalone-private-inference", selected ? `Chutes private inference · ${status}` : undefined);
  pi.on("session_start", (_event: any, ctx: any) => { ui = ctx.ui; selected = ctx.model?.provider === "chutes"; display(); });
  pi.on("model_select", (_event: any, ctx: any) => { ui = ctx.ui; selected = ctx.model?.provider === "chutes"; status = "not checked yet"; display(); });
  const response = await http(MODELS_URL);
  if (!response.ok) throw new Error(`Chutes private inference model list returned HTTP ${response.status}.`);
  const models = privateModels(await response.json());
  if (!models.length) throw new Error("Chutes currently lists no private inference models with tool support.");
  const send = protectedFetch({ models, policy: options.policy ?? POLICY, http, ...(options.verify ? { verify: options.verify } : {}),
    onState: (state: string) => { status = ({ checking: "checking instance", sending: "encrypted request", verified: "instance checked · request and tools encrypted", refused: "refused" } as any)[state]; display(); },
    onVerified: (profile: any) => {
      pi.appendEntry("chutes-attestation", { ...profile, code: options.code ?? "VM measurements pinned; serving code and model identity not measured" });
    },
  });
  const api = openAICompletionsApi();
  pi.registerProvider(createProvider({ id: "chutes", name: "Chutes private inference", baseUrl: "https://api.chutes.ai/v1",
    auth: { apiKey: { ...envApiKeyAuth("Chutes private inference key", ["CHUTES_API_KEY"]), login: undefined } } as any,
    models,
    // No automatic replay of a request that may already have been charged.
    api: {
      stream: (model: any, context: any, options: any) => api.stream(model, context, { ...options, fetch: send, maxRetries: 0 }),
      streamSimple: (model: any, context: any, options: any) => api.streamSimple(model, context, { ...options, fetch: send, maxRetries: 0 }),
    },
  } as any));
}

export default async function (pi: ExtensionAPI) { await registerChutes(pi); }
