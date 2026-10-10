// Synthetic recipient-session adapter. No current issuer policy qualifies production.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { multiaddr } from "@multiformats/multiaddr";
import { couponAccountlessClient, couponAccountlessRecipient } from "./coupon-accountless.mjs";

const failure = (code, message) => Object.assign(new Error(message), { code });
export function admitCouponSessionIssuer({ experimental = false, peerAddr, admit }) {
  if (!experimental) throw failure("issuer_unverified", "Coupon issuance is not verified for production. No coupon was read or sent. Only the explicit synthetic local experiment is available.");
  const parts = multiaddr(peerAddr).getComponents();
  if (parts.length !== 3 || parts[0].name !== "ip4" || parts[0].value !== "127.0.0.1" || parts[1].name !== "tcp" || !Number(parts[1].value) || parts[2].name !== "p2p" || admit?.dev !== true)
    throw failure("experimental_profile_refused", "The synthetic experiment requires a loopback development issuer and explicit development-peer admission. Nothing was claimed.");
  return Object.freeze({ profile: "synthetic-local-unattested", productionVerified: false });
}

export function admitCouponSessionProvider(config, model, { occupied = false, ambient = false } = {}) {
  const p = config?.couponSession;
  if (!p || Object.keys(p).sort().join(",") !== "baseUrl,mode,models,provider" || p.mode !== "synthetic-loopback" || p.provider !== "synthetic-near"
      || !Array.isArray(p.models) || !p.models.length || p.models.length > 32 || !p.models.every((id) => typeof id === "string" && /^[A-Za-z0-9_./-]{1,120}$/.test(id))
      || !p.models.includes(model)) throw failure("model_not_admitted", "Choose a model explicitly admitted by the synthetic coupon-session profile. Nothing was claimed.");
  let url;
  try { url = new URL(p.baseUrl); } catch { throw failure("provider_not_admitted", "The synthetic provider configuration is invalid. Nothing was claimed."); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/v1")
    throw failure("provider_not_admitted", "The experiment only admits a configured loopback synthetic provider. Nothing was claimed.");
  if (occupied || ambient) throw failure("credential_slot_occupied", "A credential already exists for this provider. Nothing was replaced or claimed. Use a fresh synthetic profile; replacement is not supported.");
  return Object.freeze({ provider: p.provider, baseUrl: url.href, model });
}

export function couponSessionOfferText(accepted, provider) {
  const o = accepted.offer;
  return `SYNTHETIC EXPERIMENT: issuance code is unverified; this is not a private-issuance guarantee.
Provider: ${o.provider.id}; direct synthetic inference at ${provider.baseUrl}; model: ${provider.model}.
Nominal limit: ${o.budget_nano_usd} nanoUSD (a provider cap can overshoot).
Claim expires: ${o.claim_expires_at}; provider expiry: unknown; balance: unknown.
Sponsor may revoke the credential or change its limits. Copied codes can be stolen before first claim.
Offer hash: ${accepted.offer_hash}.
Retention: coupon, Noise identity, delivery key and provider credential stay in this process's memory.
EXIT OR CRASH LOSES RECOVERY: this profile cannot recover the credential on restart or claim a replacement.
Ordinary conversation history, notebook records, workspace files and host egress names may persist.
Forgetting locally is not upstream revocation or secure erasure. No private summary is sent to a setup agent.`;
}

export async function openCouponSession({ peerAddr, admit, config, model, experimental, occupied, ambient, connect = couponAccountlessClient }) {
  const issuer = admitCouponSessionIssuer({ experimental, peerAddr, admit });
  const provider = admitCouponSessionProvider(config, model, { occupied, ambient });
  let client;
  try { client = await connect(peerAddr, admit); } catch { throw failure("service_unavailable", "The coupon service is unavailable or its identity was refused. No coupon was sent. Check the local fixture, then retry."); }
  let recipient = couponAccountlessRecipient();
  let coupon, accepted, credential, state = "unclaimed", usageState, busy = false, broker, brokerOpening, closing;
  const requireOpen = () => { if (state === "closed") throw failure("session_closed", "This coupon session is closed. Its keys cannot be recovered by starting another process."); };
  const claim = async () => {
    requireOpen();
    if (busy) throw failure("claim_in_progress", "A claim is already in progress. Wait for its result; do not create new keys.");
    busy = true; state = "claiming";
    try {
      const result = await client.claim(coupon, recipient, accepted);
      requireOpen();
      const key = recipient.decryptDelivery(coupon, result, accepted);
      if (!/^synthetic-only-coupon-[0-9a-f]{64}$/.test(key)) throw failure("synthetic_credential_refused", "The delivery is not a synthetic fixture credential. It was not installed.");
      credential = key; state = "installed";
      return Object.freeze({ state, provider: provider.provider, model: provider.model, balance: "unknown", providerExpiry: "unknown", retention: "session-only" });
    } catch (error) {
      if (state !== "closed") state = "claim_uncertain";
      if (error.code === "synthetic_credential_refused") throw error;
      throw failure("claim_uncertain", "The claim response was interrupted, denied or invalid. Keep this process open and use same-session recovery. Do not try another identity or delivery key.");
    } finally { busy = false; }
  };
  return Object.freeze({
    issuer, provider,
    get state() { return state === "installed" ? (usageState ?? state) : state; },
    // The /coupon state the child sees; session-only facts only, never the credential.
    info() {
      requireOpen();
      return Object.freeze({ state: state === "installed" ? (usageState ?? state) : state, provider: provider.provider, model: provider.model,
        balance: "unknown", providerExpiry: "unknown", retention: "session-only", issuer: "synthetic-local-unattested",
        sponsorPowers: ["revoke", "change_limits"], restartRecovery: false });
    },
    async inspect(value) {
      requireOpen();
      if (coupon !== undefined) throw failure("coupon_already_selected", "This process already holds a coupon. Recover or close this session; do not replace its keys.");
      coupon = value;
      try {
        accepted = await client.offer(coupon);
        requireOpen();
        if (accepted.offer.provider.id !== provider.provider || accepted.offer.issuer.policy !== "experimental-local-unattested") throw new Error();
        state = "offer_received";
        return Object.freeze({ text: couponSessionOfferText(accepted, provider), offerHash: accepted.offer_hash });
      } catch {
        if (state === "closed") { accepted = undefined; throw failure("session_closed", "This coupon session closed while inspecting its offer. Nothing was claimed."); }
        state = "offer_refused"; throw failure("offer_refused", "The coupon offer was denied, unavailable or did not match this synthetic profile. Nothing was claimed. Check the gift and issuer with its operator.");
      }
    },
    async claim({ offerHash, consent } = {}) {
      requireOpen();
      if (state !== "offer_received" || offerHash !== accepted?.offer_hash || consent !== "CLAIM SESSION ONLY") throw failure("consent_required", "Review the exact offer and explicitly accept session-only retention before claiming.");
      return claim();
    },
    async recover({ consent } = {}) {
      requireOpen();
      if (state !== "claim_uncertain" || busy || consent !== "RETRY SAME KEYS") throw failure("recovery_refused", "Recovery requires this original process and explicit same-key retry. Nothing was claimed.");
      let s;
      try { s = await client.status(coupon); } catch { throw failure("status_unavailable", "Status is unavailable or access is denied. Keep this process open; ask the issuer to reconcile the original claim. No new issuance was requested."); }
      requireOpen();
      if (s.state === "reconciliation_required" || s.accounting_blocked) throw failure("reconciliation_required", "Issuance requires operator reconciliation. Automatic retry is disabled. Preserve this process's original keys; do not claim a replacement.");
      if (s.state === "ready" && s.claim_expired) throw failure("claim_expired", "The unclaimed gift expired. Nothing was installed; ask its sponsor for a new gift.");
      return claim(); // ready or delivered: original accepted hash, Noise identity and delivery key only
    },
    async broker(socketPath, options = {}) {
      requireOpen();
      if (state !== "installed" || broker || brokerOpening) throw failure("slot_unavailable", "The session credential is unavailable or already installed. No slot was replaced.");
      brokerOpening = couponCredentialBroker({ socketPath, provider, credential, coupon, ...options, onState: (value) => { if (state !== "closed") usageState = value; options.onState?.(value); } });
      let opened;
      try { opened = await brokerOpening; }
      finally { brokerOpening = undefined; }
      if (state === "closed") { await opened.close(); throw failure("session_closed", "This coupon session closed before its broker was installed."); }
      broker = opened; return broker;
    },
    async close() {
      if (closing) return closing;
      state = "closed"; usageState = undefined; credential = undefined; coupon = undefined; accepted = undefined; recipient = undefined;
      const opening = brokerOpening;
      closing = (async () => {
        await broker?.close();
        if (opening) await (await opening.catch(() => undefined))?.close();
        await client.close(); client = undefined;
      })();
      return closing;
    },
  });
}

// A socket is a scoped provider-use capability, not secret sealing from the host.
export async function couponCredentialBroker({ socketPath, provider, credential, coupon, timeoutMs = 30_000, maxBytes = 2 * 1024 * 1024, onState = () => {} }) {
  admitCouponSessionProvider({ couponSession: { mode: "synthetic-loopback", provider: provider?.provider, baseUrl: provider?.baseUrl, models: [provider?.model] } }, provider?.model);
  if (!/^synthetic-only-coupon-[0-9a-f]{64}$/.test(credential ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(coupon ?? "")) throw failure("broker_configuration", "Only a synthetic session credential is allowed.");
  const dir = fs.lstatSync(path.dirname(socketPath));
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o077) || fs.existsSync(socketPath)) throw failure("broker_configuration", "The coupon broker requires an unused socket in a private directory owned by this user.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw failure("broker_configuration", "Invalid coupon broker bounds.");
  const pending = new Set(), sockets = new Set(); let closed = false, closing;
  const answer = (res, status, code) => { if (!res.destroyed && !res.headersSent && !res.writableEnded) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: `coupon session: ${code}`, type: code } })); } };
  const server = http.createServer(async (req, res) => {
    if (pending.size >= 16) return answer(res, 503, "broker_busy");
    const controller = new AbortController(); pending.add(controller);
    const timer = setTimeout(() => { controller.abort(); req.destroy(); res.destroy(); }, timeoutMs); timer.unref();
    res.once("close", () => controller.abort());
    try {
      if (closed || req.method !== "POST" || req.url !== "/v1/chat/completions" || req.headers.authorization !== "Bearer coupon-session") return answer(res, 403, "request_refused");
      const chunks = []; let count = 0;
      for await (const chunk of req) { count += chunk.length; if (count > maxBytes) { answer(res, 413, "request_too_large"); req.destroy(); return; } chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return answer(res, 400, "request_refused"); }
      if (body?.model !== provider.model || !Array.isArray(body.messages) || ["baseUrl", "endpoint", "url", "api_key", "authorization"].some((key) => Object.hasOwn(body, key))) return answer(res, 403, "model_not_admitted");
      const upstream = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual", signal: controller.signal });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        const code = upstream.status === 402 || upstream.status === 429 ? "credit_exhausted" : upstream.status === 401 || upstream.status === 403 ? "access_revoked_or_expired" : "provider_unavailable";
        onState(code); return answer(res, 502, code);
      }
      const contentType = upstream.headers.get("content-type") ?? "";
      if (!/^(application\/json|text\/event-stream)(?:;|$)/i.test(contentType)) { await upstream.body?.cancel(); return answer(res, 502, "provider_response_refused"); }
      const response = []; count = 0;
      for await (const chunk of upstream.body) { count += chunk.length; if (count > maxBytes) { controller.abort(); return answer(res, 502, "provider_response_too_large"); } response.push(chunk); }
      let text = Buffer.concat(response).toString("utf8");
      for (const secret of [credential, coupon]) if (secret) text = text.split(secret).join("[private credential removed]");
      onState("installed");
      res.writeHead(200, { "content-type": contentType }); res.end(text);
    } catch { onState("provider_unavailable"); answer(res, 502, "provider_unavailable"); }
    finally { clearTimeout(timer); pending.delete(controller); }
  });
  server.maxConnections = 32;
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600);
  return Object.freeze({ socketPath, async close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => { for (const c of pending) c.abort(); for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)); fs.rmSync(socketPath, { force: true }); credential = undefined; coupon = undefined; })();
    return closing;
  } });
}
