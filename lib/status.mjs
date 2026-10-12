// What the session shows about its resources: the model picker's place labels, the one-line footer strip, and /evidence.
// Everything here is read from config, verifier entries in the session log and abalone's own logs, never from model text.
import fs from "node:fs";
import path from "node:path";
import { STATE, place, policy } from "./config.mjs";
import { DLOG } from "./disclose.mjs";
import { GIFT, giftLabel, left, placeLabel } from "./peer.mjs";
import { coupon as giftCoupon } from "./gift.mjs";

const EVIDENCE = () => path.join(STATE, "evidence.json");
const short = (id) => id.split("/").at(-1);
// NEAR TCB flags. The model TEE decrypts the prompt, so its TCB is the privacy flag (tcb:). The gateway sees only
// E2EE ciphertext plus account, model, timing, sizes and usage, so its flag (gw-tcb:) concerns that metadata alone.
// Chutes has no gateway TEE (gateway_tcb null): its tcb: is the instance that decrypts the prompt, and it has no gw-tcb:.
// The brief form (tcb:ok / tcb:ood, gw-tcb:ood) is the 80-column footer's, so sharing, balance and canary state still fit.
export function tcbFlag(p, brief = false) {
  const bad = p.model_tcb.filter((t) => !t.startsWith("UpToDate")), n = new Set(bad.flatMap((t) => t.split(" ")[1]?.split(",") ?? [])).size, gw = p.gateway_tcb != null && !p.gateway_tcb.startsWith("UpToDate");
  if (brief) return (bad.length ? "tcb:ood" : "tcb:ok") + (gw ? " gw-tcb:ood" : "");
  return (bad.length ? `tcb:out-of-date${n ? ` (${n} Intel advisor${n === 1 ? "y" : "ies"})` : ""}` : "tcb:up-to-date") + (gw ? ", gw-tcb:out-of-date" : "");
}

// Verifier output from the session log, keyed provider/model. NEAR verifies per model, Chutes per instance (the latest
// one shown), ACI per provider.
export function verifications(entries) {
  const v = {};
  for (const e of entries.filter((e) => e.type === "custom")) {
    if (e.customType === "near-attestation" || e.customType === "chutes-attestation") v[`${e.data.provider}/${e.data.model}`] = { ts: e.timestamp, flag: tcbFlag(e.data), brief: tcbFlag(e.data, true), data: e.data };
    if (e.customType === "aci-attestation") v[`${e.data.provider}/*`] = { ts: new Date(e.data.verifiedAt).toISOString(), flag: "verified", brief: "verified", data: e.data };
  }
  return v;
}

// The latest verifier result per model survives the session in <STATE>/evidence.json, so the picker can say when it was checked.
export function remember(entries) {
  const all = { ...(fs.existsSync(EVIDENCE()) ? JSON.parse(fs.readFileSync(EVIDENCE(), "utf8")) : {}), ...verifications(entries) };
  fs.writeFileSync(EVIDENCE(), JSON.stringify(all, null, 1), { mode: 0o600 });
  return all;
}

const verifiedFor = (ev, provider, id) => ev[`${provider}/${id}`] ?? ev[`${provider}/*`];
// "via RedPill → Phala TEE" for a model behind an ACI aggregator, as the launcher vetted it (lib/upstream.mjs).
const via = (m) => JSON.parse(process.env.ABALONE_VIA ?? "{}")[`${m.provider}/${m.id}`];

// "provider/id" → label for the model picker.
export function labels(models, ev) {
  return Object.fromEntries(models.map((m) => {
    const where = place(m.provider), v = verifiedFor(ev, m.provider, m.id);
    const label = m.provider === GIFT ? giftLabel(giftCoupon())
      : where === "⌂ local" ? "⌂ local: this computer"
      : where === "◈ attested" ? `◈ attested${via(m) ? ` ${via(m)}` : ""}: ${v ? `${v.flag}, checked ${v.ts.slice(0, 16).replace("T", " ")}` : "checked before the first byte"}`
      : m.provider === "runner" ? `○ outside: your ${m.id} login, sandboxed runner`
      : m.provider === "nearai-outside" ? "○ outside: NEAR proxy, no TEE"
      : "○ outside";
    return [`${m.provider}/${m.id}`, label];
  }));
}

// Segments as [long, short]; the short forms are used when the long line does not fit.
export function segments({ model, entries, session, coupon, couponSession = false, incognito = false }) {
  if (couponSession) {
    const near = model.provider === "nearai";
    // This session holds a capped credential, not a locally measured credit purse.
    // Trust and retention details remain in /coupon and the launch consent.
    return [
      ...(incognito ? [["incognito", "incognito", 3]] : []),
      [`${near ? "NEAR" : "fixture"} ${short(model.id)}`, `${near ? "NEAR" : "fixture"} ${short(model.id)}`, 3],
      ["session", "session", 3],
      ["credit unknown", "credit ?", 3],
      [near ? "⚠ trial (/coupon)" : "⚠ fixture (/coupon)", near ? "⚠ trial" : "⚠ fixture", 4],
    ];
  }
  const ev = verifications(entries), where = place(model.provider);
  const v = verifiedFor(ev, model.provider, model.id), flag = v ? v.flag : "not yet checked", brief = v ? v.brief : flag;
  // "checked" names what abalone's verifier established; a part it did not check is said in words, never as "verified".
  const checked = v ? `checked, ${flag}${v.data.gpu ? ` · ${v.data.gpu}` : ""}` : flag;
  const [mp, ...mid] = policy().mediator.split("/"), reader = `${place(mp).slice(0, 1)} ${short(mid.join("/"))}`;
  const m = model.provider === GIFT ? [`${placeLabel()} gift/${model.id}, ${checked}`, `◈ ${short(model.id)} ${brief}`]
    : where === "⌂ local" ? [`⌂ local ${model.id}`, `⌂ local ${short(model.id)}`]
    : where === "◈ attested" ? [`◈ attested ${model.id}${via(model) ? ` ${via(model)}` : ""}, ${checked}`, `◈ attested ${short(model.id)} ${brief}`]
    : [`○ outside ${model.provider}/${model.id}, read first by ${reader}`, `○ ${short(model.id)}, read first by ${reader}`];
  const sent = fs.existsSync(DLOG()) ? fs.readFileSync(DLOG(), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.session === session && r.label === "released") : [];
  const bytes = sent.reduce((s, r) => s + r.bytes, 0);
  const shared = sent.length ? [`shared ${sent.length} pour(s), ${bytes} bytes`, `shared ${sent.length} (${bytes} B)`, 1] : ["nothing shared", "nothing shared", 1];
  const off = process.env.ABALONE_NO_CANARIES ? [["no canaries", "no canaries", 0]] : [];
  if (!coupon) return [[...m, 3], shared, ...off];
  const usd = (micro) => `$${(micro / 1e6).toFixed(2)}`;
  return [[...m, 3], shared, ...off, [`gift ${usd(left(coupon))} left`, `gift ${usd(left(coupon))}`, 2]];
}

// One line, at most `width` columns. Each segment is [long, short, priority]; when even the short forms do not fit,
// the lowest-priority segments go first (decoration before state), and only then is the line cut. The words carry
// every meaning; a theme only paints the model's tcb:out-of-date (tcb:ood in the brief form).
export function footerLine(segs, width, t) {
  const join = (ss, i) => ss.map((s) => s[i]).join(" · ");
  let kept = [...segs];
  while (join(kept, 1).length > width && kept.length > 1) {
    const low = Math.min(...kept.map((s) => s[2] ?? 1));
    kept.splice(kept.findLastIndex((s) => (s[2] ?? 1) === low), 1);
  }
  const long = join(segs, 0), brief = join(kept, 1);
  const line = long.length <= width ? long : join(segs, 1).length <= width ? join(segs, 1) : brief.length <= width ? brief : brief.slice(0, width - 1) + "…";
  return t.paint(null, line).replace(/(?<!gw-)tcb:(out-of-date|ood)/g, (s) => t.paint("failed", s));
}

// /evidence: where each resource runs, then the verifier output recorded in this session, verbatim.
export function evidence({ model, entries }) {
  const ev = verifications(entries);
  const lines = ["Evidence (from abalone's verifiers and config; model text cannot add to it)",
    "harness: ⌂ this computer (not attested)", process.env.ABALONE_OWNED_HOST === "1" ? "tools: trusted owned host, ordinary-account filesystem/network access; no OS isolation" : "tools: ⌂ this computer, bash sandbox without network",
    `selected model: ${place(model.provider)} ${model.provider}/${model.id}`, `private reader for outside models: ${place(policy().mediator.split("/")[0])} ${policy().mediator}`,
    `spent this session: $${entries.filter((e) => e.type === "message" && e.message.role === "assistant" && e.message.usage).reduce((s, e) => s + e.message.usage.cost.total, 0).toFixed(4)} at list price`];
  if (!Object.keys(ev).length) return [...lines, "", "No verifier output in this session yet: an attested model is checked before its first prompt byte."].join("\n");
  for (const [k, v] of Object.entries(ev)) lines.push("", `${k}: ${v.flag}, checked ${v.ts}`, JSON.stringify(v.data, null, 1));
  return lines.join("\n");
}

// The line after each answer: where the conversation went and what was read into it, from the run's measured state.
// `held` are files read in earlier turns: they are still in the conversation, so this turn sent them again.
export function sentTo({ provider, model, files, held = [], traces, pages, gift }) {
  const where = place(provider);
  const to = where === "⌂ local" ? `this computer (${model}, a local model)` : gift ? `${gift} (${model})`
    : where === "◈ attested" ? `${provider === "nearai" ? "NEAR" : provider} TEE (${model}), encrypted to the enclave abalone checked`
    : `${provider}/${model} outside: only the text you approved in the review prompt`;
  const dest = where === "⌂ local" ? "this computer" : gift ? "the gift's TEE" : `the ${provider === "nearai" ? "NEAR" : provider} TEE`;
  const earlier = `the conversation already holds ${held.join(", ")}`;
  return [`sent to: ${to}`, files.length ? `files read into it: ${files.join(", ")}${held.length ? `; ${earlier}` : ""}` : held.length ? `no new files; ${earlier}` : "files read into it: none beyond the folder's file names and sizes",
    ...traces.map((id) => `trace ${id} (decrypted on this computer, sent to ${dest})`),
    ...(pages.length ? [`browser pages read into it: ${pages.join(", ")}`] : [])].join(" · ");
}
