// NEAR AI Cloud as an admitted provider, admitted per model: lib/near.mjs verifies each model before its
// first prompt byte; models NEAR proxies to outside vendors are refused. Chat bodies are E2EE to the
// model's attested key and go only over the channel pinned to the attested gateway SPKI.
// nearProvider(pi, "gift", gift) is the same provider reached through a gift's peer (agents/pi/peer-provider.ts): no key
// here; the attestation report and the chat go through the peer, signed by this device. The report still carries our
// nonce and is verified here; prompt contents are still encrypted to the attested model key. The peer pins NEAR's SPKI.
import crypto from "node:crypto";
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { providers } from "../../lib/config.mjs";
import { ATTESTED_OWNERS, chatSignatureFails, untrusted, encrypt, verifyNearModel, withKey } from "../../lib/near.mjs";
import { deviceHeaders } from "../../lib/gift.mjs";
import { saveLeft } from "../../lib/peer.mjs";
import { prepareNearTextTools } from "../../lib/near-tool-boundary.mjs";
import { decryptSse } from "../../lib/near-sse.mjs";
import { tcbFlag } from "../../lib/status.mjs";

const FIELDS = ["content", "reasoning_content", "reasoning"];

// Shown in the status strip once a model is verified. Policy (providers.json): gateway and model TCB are reported, not
// gating. The model's out-of-date TCB is red; the gateway's (gw-tcb:) is not, since it sees only ciphertext and metadata.
const RED = (s: string) => `\x1b[31m${s}\x1b[39m`;
const strip = (p: any, gift: Gift | null) => `${gift ? `${gift.peer} → ` : ""}◈ nearai ${p.model} · ${tcbFlag(p).replace(/(?<!gw-)tcb:out-of-date/, RED)} · ${gift ? "the peer sees ciphertext, sizes and usage only" : "tools off (NEAR sees E2EE messages only)"}`;

// A gift: its coupon, the launcher's attested loopback endpoint to its peer, and how the peer is named.
export type Gift = { coupon: any; url: string; peer: string };

export default async function (pi: ExtensionAPI) { pi.registerProvider(createProvider(await nearProvider(pi, "nearai", null))); }

export async function nearProvider(pi: ExtensionAPI, id: string, gift: Gift | null) {
  let ui: any = null;
  pi.on("session_start", async (_e: any, ctx: any) => { ui = ctx.ui; });
  const cfg = providers().admitted.find((a: any) => a.id === "nearai");
  const key = () => { const k = process.env[cfg.keyEnv]; if (!k) throw new Error(`no ${cfg.keyEnv}: add one with  abalone key add nearai`); return k; };
  const getReport = (p: string) => gift ? fetch(gift.url + p, { headers: deviceHeaders(gift.coupon, "GET", p, "", "") }) : withKey(cfg.baseUrl, key())(p);
  // A retried request (same plaintext body in this process) reuses its idempotency key and response key,
  // so the node answers it from its stored copy and never debits twice.
  const retries = new Map<string, { idem: string; ecdh: crypto.ECDH }>();
  const verified = new Map<string, ReturnType<typeof verifyNearModel>>();

  const fetchE2ee: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init!.body));
    prepareNearTextTools(body);
    if (!verified.has(body.model)) verified.set(body.model, verifyNearModel(cfg.baseUrl, body.model, getReport, cfg.policy).then((v) => (pi.appendEntry("near-attestation", { ...v.profile, provider: id }), ui?.setStatus(id, strip(v.profile, gift)), v)));
    // A refusal must reach the user verbatim; the OpenAI client reports a thrown fetch only as "Connection error."
    const v = await verified.get(body.model)!.catch((e) => e as Error);
    const plain = crypto.createHash("sha256").update(String(init!.body)).digest("hex");
    if (v instanceof Error) return new Response(JSON.stringify({ error: { message: v.message } }), { status: 403, headers: { "content-type": "application/json" } });
    for (const m of body.messages) {
      if (Array.isArray(m.content)) {
        if (m.content.some((p: any) => p.type !== "text")) throw new Error("✗ refused: NEAR E2EE carries text only");
        m.content = m.content.map((p: any) => p.text).join("");
      }
      for (const f of FIELDS) if (typeof m[f] === "string" && m[f]) m[f] = encrypt(m[f], v.signingPublicKey);
    }
    const st = retries.get(plain) ?? { idem: crypto.randomBytes(16).toString("hex"), ecdh: crypto.createECDH("secp256k1") };
    if (!retries.has(plain)) { st.ecdh.generateKeys(); if (gift) retries.set(plain, st); }
    const ecdh = st.ecdh;
    const headers = new Headers(init!.headers);
    headers.set("X-Signing-Algo", "ecdsa");
    headers.set("X-Client-Pub-Key", ecdh.getPublicKey("hex").slice(2));
    headers.set("X-Model-Pub-Key", v.signingPublicKey);
    headers.delete("content-length");
    const out = JSON.stringify(body);
    if (gift) headers.delete("authorization");
    if (gift) for (const [k, val] of Object.entries(deviceHeaders(gift.coupon, "POST", "/v1/chat/completions", st.idem, out))) headers.set(k, val);
    const r = gift ? await fetch(`${gift.url}/v1/chat/completions`, { method: "POST", headers, body: out }) : await v.transport.fetch(input, { ...init, headers, body: out });
    if (!r.ok) retries.delete(plain); // nothing to replay: a later send of the same message is a new request
    if (!r.ok || !body.stream) {
      if (r.ok) throw new Error("NEAR E2EE path expects a streamed response");
      // The error body comes from NEAR or the gift peer: shown as theirs, without escapes, controls or bidi characters.
      const t = await r.text();
      let said: string;
      try { said = JSON.parse(t).error.message; } catch { said = t; }
      return new Response(JSON.stringify({ error: { message: `${gift ? "peer" : "NEAR"} says (HTTP ${r.status}): ${untrusted(String(said))}` } }), { status: r.status, headers: { "content-type": "application/json" } });
    }
    const h = new Headers(r.headers);
    h.delete("content-length");
    h.delete("content-encoding");
    const m = models.find((x: any) => x.id === body.model);
    return new Response(decryptSse(r.body!, ecdh, gift && m.cost, gift && ((c: any) => { retries.delete(plain); saveLeft(gift.coupon.account, c.remaining); pi.appendEntry("gift-charge", { model: body.model, idem: st.idem, ...c }); }), gift && ((s: string | null) => ui?.setStatus("gift-credit", s ? `◌ ${s}` : undefined)), gift && (async (raw: Buffer) => {
      // The reply came through the peer, past the TLS pin: it counts as NEAR's only if NEAR signed exactly this request
      // and these bytes with a key this client attested. Until then its tool lines never run.
      const id = /"id":"([^"]+)"/.exec(raw.toString())?.[1] ?? "", p = `/v1/signature?chat_id=${encodeURIComponent(id)}&model=${encodeURIComponent(body.model)}`;
      const s = await fetch(gift.url + p, { headers: deviceHeaders(gift.coupon, "GET", p, "", "") });
      const t = await s.text();
      const why = s.ok ? chatSignatureFails(JSON.parse(t), out, raw, v.profile) : `peer says (HTTP ${s.status}): ${untrusted(t)}`;
      pi.appendEntry("near-signature", { chat_id: id, model: body.model, verified: !why, reason: why, kind: s.ok ? JSON.parse(t).signature_kind : null });
      if (why) ui?.notify(`This reply is unverified: NEAR's signature over it did not check (${why}). Its tool requests will not run.`, "warning");
    }), body.chat_template_kwargs?.enable_thinking === false), { status: r.status, headers: h });
  };

  const list = await (await fetch(`${cfg.baseUrl}/models`)).json();
  const models = list.data.filter((m: any) => ATTESTED_OWNERS.includes(m.owned_by) && m.supported_features?.includes("tools") && m.output_modalities?.includes("text")).map((m: any) => ({
    id: m.id, name: m.name ?? m.id, api: "openai-completions" as const, provider: id, baseUrl: cfg.baseUrl, reasoning: !!m.supported_features?.includes("reasoning"),
    // NEAR's GLM and Qwen honour chat_template_kwargs.enable_thinking (measured: off gives 0 reasoning tokens);
    // without it --thinking off sent nothing and GLM thought anyway.
    compat: { thinkingFormat: "qwen-chat-template" as const },
    input: ["text" as const], cost: { input: m.pricing?.input ?? 0, output: m.pricing?.output ?? 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.context_length ?? 131072, maxTokens: Math.min(m.max_output_length ?? 16384, 32768),
  }));
  const streams = openAICompletionsApi();
  return {
    id, name: gift ? `NEAR AI through the gift peer ${gift.peer}` : "NEAR AI (per-model attestation)", baseUrl: cfg.baseUrl,
    // The key comes only from the launcher (a configured key, abalone key add), never from an agent-side /login.
    // With a gift there is no key on this machine; the device signature authenticates each request.
    auth: { apiKey: gift ? { name: "abalone gift", resolve: async () => ({ auth: { apiKey: "gift" }, source: `gift peer ${gift.peer}` }) }
      : { ...envApiKeyAuth("NEAR AI API key", [cfg.keyEnv]), login: undefined } } as any,
    models,
    api: {
      stream: (model: any, context: any, options: any) => streams.stream(model, context, { ...options, fetch: fetchE2ee }),
      streamSimple: (model: any, context: any, options: any) => streams.streamSimple(model, context, { ...options, fetch: fetchE2ee }),
    },
  };
}
