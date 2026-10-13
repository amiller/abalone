// Private inference in ordinary Pi. Local tools and retention remain Pi's choices.
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MODELS_URL, POLICY, privateModels, protectedFetch } from "./provider.mjs";

export async function registerChutes(pi: ExtensionAPI, options: any = {}) {
  const http = options.http ?? fetch;
  // A separate ID keeps this integration distinct from Pi's ordinary endpoint.
  const providerId = options.providerId ?? "abalone-chutes";
  const modelPath = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "models.json");
  const models: any[] = [];
  let catalogueReady = false;
  let registry: any, ui: any, selected = false;
  let status = "not checked yet";
  const display = () => ui?.setStatus("abalone-private-inference", selected ? `Chutes private inference · ${status}` : undefined);
  const eligible = (m: any) => m?.api === "openai-completions" && models.some((known) => known.id === m.id);
  const assertEligible = () => {
    const reject = () => { throw new Error("Private inference refused: repair model configuration or refresh the private model catalogue. Automatic billing retry is disabled."); };
    if (!catalogueReady) reject();
    try {
      if (fs.existsSync(modelPath)) {
        const config = JSON.parse(fs.readFileSync(modelPath, "utf8"))?.providers?.[providerId];
        if (config?.api && config.api !== "openai-completions") reject();
        if (config?.models?.some((m: any) => !eligible({ ...m, api: m.api ?? config.api ?? "openai-completions" }))) reject();
      }
      if (registry?.getAll().some((m: any) => m.provider === providerId && !eligible(m))) reject();
    } catch { reject(); }
  };
  const select = (ctx: any) => { ui = ctx.ui; registry = ctx.modelRegistry; selected = ctx.model?.provider === providerId; display(); };
  pi.on("session_start", (_event: any, ctx: any) => select(ctx));
  pi.on("model_select", (_event: any, ctx: any) => { status = catalogueReady ? "not checked yet" : "model catalogue unavailable"; select(ctx); });
  pi.on("input", (_event: any, ctx: any) => {
    if (ctx.model?.provider !== providerId) return { action: "continue" };
    try { assertEligible(); if (eligible(ctx.model)) return { action: "continue" }; } catch {}
    status = "refused: incompatible model configuration"; display();
    ctx.ui.notify("Choose a Chutes private-inference model from this integration. A custom API override cannot use its protected transport.", "error");
    return { action: "handled" };
  });
  for (const event of ["session_before_compact", "session_before_tree"] as const) pi.on(event, (_event: any, ctx: any) => {
    if (ctx.model?.provider !== providerId) return;
    try { assertEligible(); } catch { ctx.ui.notify("Private inference configuration must be repaired before summarizing history.", "error"); return { cancel: true }; }
  });

  // Stock Pi resolves this auth for prompts AND summaries, including explicit
  // and configured keys. Check the live registry and config on every resolution.
  const auth = envApiKeyAuth("Chutes private inference key", ["CHUTES_API_KEY"]);
  const guardedAuth = { ...auth, login: undefined, resolve: async (input: any) => { assertEligible(); return auth.resolve(input); } };
  const send = protectedFetch({ models, policy: options.policy ?? POLICY, http, ...(options.verify ? { verify: options.verify } : {}),
    onState: (state: string) => { status = ({ checking: "checking instance", sending: "encrypted request", verified: "instance checked · request and tools encrypted", refused: "refused" } as any)[state]; display(); },
    onVerified: (profile: any) => pi.appendEntry("chutes-attestation", { ...profile, provider: providerId,
      code: options.code ?? "VM measurements pinned; serving code and model identity not measured" }),
  });
  const api = openAICompletionsApi();
  const register = () => pi.registerProvider(createProvider({ id: providerId, name: "Chutes private inference (Dsmack)", baseUrl: "https://api.chutes.ai/v1",
    auth: { apiKey: guardedAuth } as any, models,
    api: {
      stream: (m: any, c: any, o: any) => api.stream(m, c, { ...o, fetch: send, maxRetries: 0 }),
      streamSimple: (m: any, c: any, o: any) => api.streamSimple(m, c, { ...o, fetch: send, maxRetries: 0 }),
    },
  } as any));
  // Install the refusal boundary BEFORE fallible discovery. A configured model
  // must not become a standard API fallback if the catalogue is unavailable.
  register();
  try {
    const response = await http(MODELS_URL);
    if (!response.ok) throw new Error();
    models.push(...privateModels(await response.json()).map((m: any) => ({ ...m, provider: providerId })));
    if (!models.length) throw new Error();
    register();
    catalogueReady = true;
  } catch { catalogueReady = false; status = "model catalogue unavailable; requests refused"; display(); }
}

export default async function (pi: ExtensionAPI) { await registerChutes(pi); }
