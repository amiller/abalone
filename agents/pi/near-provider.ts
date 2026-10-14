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
import { ATTESTED_OWNERS, chatSignatureFails, peerStatus, untrusted, decrypt, encrypt, verifyNearModel, withKey } from "../../lib/near.mjs";
import { deviceHeaders } from "../../lib/gift.mjs";
import { saveLeft } from "../../lib/peer.mjs";
import { tcbFlag } from "../../lib/status.mjs";

const FIELDS = ["content", "reasoning_content", "reasoning"];

// The node appends ": abalone-charge {charge, remaining}" after NEAR's stream. We recompute the charge from
// NEAR's usage and our own price list, and stop the turn if they differ.
// ": abalone-status <text>" from the peer (e.g. "confirming credit" while its next spending window reaches the chain's
// safe head) is shown until the answer starts.
// onNear gets NEAR's own bytes (without the peer's status and charge lines) before [DONE] is released.
// thinkOff: with enable_thinking=false GLM still writes a short thought, then "</think>", into the content (measured on
// NEAR). That prefix is passed on as reasoning, so the answer starts after the marker; with no marker, the buffered
// text is the answer and is sent as content at the end.
function decryptSse(body: ReadableStream<Uint8Array>, ecdh: crypto.ECDH, price?: { input: number; output: number }, onCharge?: (c: any) => void, onStatus?: (s: string | null) => void, onNear?: (raw: Buffer) => Promise<void>, thinkOff = false): ReadableStream<Uint8Array> {
  const raw: Buffer[] = [];
  let pending = "", usage: any = null, pre = "", split = !thinkOff;
  const dec = new TextDecoder(), enc = new TextEncoder();
  let held = false, charged = false;
  const line = (l: string) => {
    // The node's charge line follows NEAR's [DONE]; hold [DONE] back so the client reads (and checks) the charge first.
    if ((price || !split) && l === "data: [DONE]") { held = true; return ""; }
    if (price && l.startsWith(": abalone-charge ")) {
      const c = JSON.parse(l.slice(17));
      if (!usage) throw new Error(`Stopped. NEAR reported no usage for that answer, so its charge (${c.charge} µ$, the most it could have cost) cannot be checked here and nothing more will be sent.`);
      const expect = Math.ceil(usage.prompt_tokens * price.input + usage.completion_tokens * price.output);
      if (c.charge !== expect) throw new Error(`Stopped. The charge for that answer didn't match what was used, so nothing more will be sent.\ndetails: node charged ${c.charge} µ$, usage ${JSON.stringify(usage)} prices to ${expect} µ$`);
      onCharge!(c);
      charged = true;
      return l;
    }
    if (l.startsWith(": abalone-status ")) { onStatus?.(peerStatus(l)); return ""; }
    if (!l.startsWith("data: {")) return l;
    onStatus?.(null);
    const d = JSON.parse(l.slice(6));
    usage = d.usage ?? usage;
    for (const c of d.choices ?? []) for (const f of FIELDS) if (typeof c.delta?.[f] === "string" && c.delta[f]) c.delta[f] = decrypt(c.delta[f], ecdh);
    for (const c of d.choices ?? []) {
      if (split || typeof c.delta?.content !== "string" || !c.delta.content) continue;
      const start = pre.length; pre += c.delta.content;
      const i = pre.indexOf("</think>");
      if (i < 0) { c.delta.reasoning_content = c.delta.content; delete c.delta.content; continue; }
      c.delta.reasoning_content = pre.slice(start, Math.max(start, i));
      c.delta.content = pre.slice(i + "</think>".length);
      split = true;
    }
    return "data: " + JSON.stringify(d);
  };
  return body.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      if (onNear) raw.push(Buffer.from(chunk));
      pending += dec.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const l of lines) ctl.enqueue(enc.encode(line(l) + "\n"));
    },
    async flush(ctl) {
      if (pending) ctl.enqueue(enc.encode(line(pending)));
      if (!split && pre) ctl.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: pre } }] })}\n\n`));
      if (price && !charged) throw new Error("Stopped. The gift node sent no charge for that answer, so nothing more will be sent.");
      if (onNear) {
        let b = Buffer.concat(raw);
        while (b.subarray(0, 17).toString() === ": abalone-status ") b = b.subarray(b.indexOf("\n\n") + 2);
        await onNear(b.subarray(0, b.lastIndexOf(": abalone-charge ")));
      }
      if (held) ctl.enqueue(enc.encode("data: [DONE]\n\n"));
    },
  }));
}

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
    if (!verified.has(body.model)) verified.set(body.model, verifyNearModel(cfg.baseUrl, body.model, getReport, cfg.policy).then((v) => (pi.appendEntry("near-attestation", { ...v.profile, provider: id }), ui?.setStatus(id, strip(v.profile, gift)), v)));
    // A refusal must reach the user verbatim; the OpenAI client reports a thrown fetch only as "Connection error."
    const v = await verified.get(body.model)!.catch((e) => e as Error);
    const plain = crypto.createHash("sha256").update(String(init!.body)).digest("hex");
    if (v instanceof Error) return new Response(JSON.stringify({ error: { message: v.message } }), { status: 403, headers: { "content-type": "application/json" } });
    // This integration does not use NEAR's opt-in all-fields tool encryption; native tool fields never go to NEAR.
    delete body.tools; delete body.tool_choice; delete body.parallel_tool_calls;
    if (body.messages.some((m: any) => m.tool_calls || m.role === "tool")) throw new Error("✗ refused: tool calls are not sent to NEAR (their arguments are not end-to-end encrypted)");
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
