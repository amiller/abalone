// Per-model admission behind an ACI aggregator (RedPill, Phala: providers.json entries with `upstreams`). The gateway
// is attested once, but it forwards the prompt in plaintext to whichever upstream serves the model. A model is admitted
// only if every session the gateway lists for it comes from an upstream in `upstreams.admit`, with its TEE, TCB and GPU
// claims asserted. A NEAR upstream thus follows NEAR's own rule (model TCB UpToDate). Issue 0007, docs/security.md.
const CLAIMS = ["tee_attested", "tcb_up_to_date", "gpu_attested"];

// The admitted upstream a session belongs to (`phala-211` is phala), or undefined.
const upstreamOf = (admit, s) => Object.keys(admit).find((u) => s.upstream_name === u || s.upstream_name?.startsWith(`${u}-`));

// null if the session is admitted, otherwise the reason.
export function sessionVerdict(admit, s) {
  const u = upstreamOf(admit, s);
  if (!u) return `upstream ${s.upstream_name} is not admitted`;
  const bad = CLAIMS.find((c) => s.claims?.[c]?.status !== "asserted");
  return bad ? `upstream ${s.upstream_name}: ${bad} is ${s.claims?.[bad]?.status ?? "missing"}` : null;
}

// { label } if every listed session is admitted, otherwise { reason }.
export function modelVerdict(cfg, sessions) {
  if (!sessions.length) return { reason: "no upstream session listed" };
  for (const s of sessions) { const r = sessionVerdict(cfg.admit, s); if (r) return { reason: r }; }
  return { label: `via ${cfg.via} → ${[...new Set(sessions.map((s) => cfg.admit[upstreamOf(cfg.admit, s)]))].join(", ")}` };
}

// A receipt judged by the session it cites (its upstream.verified event).
export function receiptVerdict(admit, receipt, sessions) {
  const id = receipt.event_log.find((e) => e.type === "upstream.verified")?.session_id;
  const s = sessions.find((x) => x.session_id === id);
  return !id ? "receipt cites no upstream session" : !s ? `cited session ${id.slice(0, 12)}… is not listed` : sessionVerdict(admit, s);
}

// Every TEE model of an ACI provider, vetted: { admitted: { id: label }, refused: { id: reason } }. Uses the gateway's
// public listings (GET /models, GET /aci/sessions?model=); a failed fetch throws, so the caller loads nothing.
export async function vet(a, http = fetch) {
  const get = async (p) => { const r = await http(a.baseUrl + p); if (!r.ok) throw new Error(`${a.id} ${p}: HTTP ${r.status}`); return r.json(); };
  const ids = (await get("/models")).data.filter((m) => m.is_tee).map((m) => m.id);
  const out = { admitted: {}, refused: {} };
  await Promise.all(ids.map(async (id) => {
    const v = modelVerdict(a.upstreams, (await get(`/aci/sessions?model=${encodeURIComponent(id)}`)).sessions);
    if (v.label) out.admitted[id] = v.label; else out.refused[id] = v.reason;
  }));
  return out;
}
