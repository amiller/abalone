// The disclosure gate: one check for every release of private data (ask_frontier pours, ask_abalone answers).
import path from "node:path";
import { ROOT, catalog, policy, readJson, standing as standingPolicies } from "./config.mjs";

// Each canary with the rule that names it; a refusal names the rule, never the matched text.
export function canaries() {
  const p = policy();
  return [...p.canaries.map((v, i) => ({ rule: `policy.json canaries[${i}]`, value: String(v) })),
    ...p.canary_files.flatMap((f) => readJson(path.join(ROOT, f)).map((c) => ({ rule: `${f} ${c.id}`, value: String(c.value) }))),
    ...(process.env.ABALONE_CANARIES ? readJson(process.env.ABALONE_CANARIES).canaries.map((c) => ({ rule: `folder canary ${c.id}`, value: c.value })) : [])];
}

// Deterministic shapes. The gate cannot check a policy's wording ("forbids names, IDs, amounts"): that is an
// instruction to the private model. It can check that a metadata_only payload carries no free string: names are short
// identifiers with no digits, everything else is a number from a bounded range or a word from a fixed vocabulary.
// {"files":[{"path","rows_about","columns":[{"name","type","unit"?,"levels"?,"years"?:[from,to]}]}]}
const TYPES = ["string", "integer", "number", "boolean", "date", "categorical"];
const UNITS = ["count", "currency", "percent", "ratio", "years", "months", "days", "hours", "minutes", "seconds", "kg", "g", "m", "cm", "celsius"];
const PATH = /^[A-Za-z_][A-Za-z_./-]{0,47}$/, NAME = /^[A-Za-z_][A-Za-z_]{0,31}$/;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const only = (o, keys) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).every((k) => keys.includes(k));
const metadataOnly = (payload) => {
  let d;
  try { d = JSON.parse(payload); } catch { return "metadata_only must be JSON (no prose)"; }
  const col = (c) => only(c, ["name", "type", "unit", "levels", "years"]) && NAME.test(c.name ?? "") && TYPES.includes(c.type) && (c.unit === undefined || UNITS.includes(c.unit))
    && (c.levels === undefined || int(c.levels, 0, 1000)) && (c.years === undefined || (Array.isArray(c.years) && c.years.length === 2 && c.years.every((y) => int(y, 1900, 2100))));
  const file = (f) => only(f, ["path", "rows_about", "columns"]) && PATH.test(f.path ?? "") && !f.path.includes("..")
    && (f.rows_about === undefined || (int(f.rows_about, 0, 1e9) && f.rows_about % 10 === 0)) && (f.columns === undefined || (Array.isArray(f.columns) && f.columns.length <= 200 && f.columns.every(col)));
  return only(d, ["files"]) && Array.isArray(d.files) && d.files.length <= 50 && d.files.every(file) ? null
    : "metadata_only payload does not match its schema (see the catalog's format: no digits in names, units and types from a fixed list, no free strings)";
};
export const SHAPES = { metadata_only: metadataOnly };

// C0 (except newline), DEL, C1 and bidi overrides: a payload holding one cannot be shown exactly, so it is not sent.
export const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const norm = (s) => s.toLowerCase().replace(/(\d),(?=\d)/g, "$1");
// Runs that may be base64, base64url or hex, decoded, so an encoded canary is caught too.
// A run glued to other letters is tried at each of the 4 base64 alignments, a hex run at both.
const decoded = (s) => [...(s.match(/[A-Za-z0-9+/_=-]{12,}/g) ?? []).flatMap((r) => [0, 1, 2, 3].flatMap((i) => [Buffer.from(r.slice(i), "base64"), Buffer.from(r.slice(i), "base64url")])),
  ...(s.match(/[0-9a-fA-F]{12,}/g) ?? []).flatMap((r) => [Buffer.from(r, "hex"), Buffer.from(r.slice(1), "hex")])].map((b) => b.toString("latin1"));

// state: { spent, lastWidth, seenOpen } for this session. Returns { verdict: "go"|"ask"|"block", reason, bytes, width }.
export function checkPour({ policyId, payload, answerer }, state) {
  const bytes = Buffer.byteLength(payload ?? "");
  if (!policyId || !payload) return { verdict: "block", reason: "private→outside without pour: a release needs a catalog policy and a payload", bytes };
  if (payload.search(CONTROL) >= 0) return { verdict: "block", reason: "payload holds control or bidi characters (shown escaped); abalone sends only text it can show exactly", bytes };
  const text = [payload, ...decoded(payload)].map(norm);
  const hit = canaries().find((c) => text.some((t) => t.includes(norm(c.value))));
  if (hit) return { verdict: "block", reason: `canary in payload (rule ${hit.rule})`, bytes };
  const shape = SHAPES[policyId]?.(payload);
  if (shape) return { verdict: "block", reason: shape, bytes };
  const p = policy();
  const standing = standingPolicies()[answerer];
  if (!standing) return { verdict: "block", reason: `missing capability pour(*, ${answerer})`, bytes };
  const pol = catalog()[policyId];
  const outside = !pol ? `policy ${policyId} is not in the catalog`
    : !standing.includes(policyId) ? `policy ${policyId} has no standing approval`
    : bytes > pol.max_bytes ? `over max_bytes: ${bytes} > ${pol.max_bytes}`
    : state.spent + bytes > p.session_budget_bytes ? `over session budget: ${state.spent} + ${bytes} > ${p.session_budget_bytes}`
    : null;
  // After open content in the session, pours are checked strictly: no widening, no ad-hoc approval.
  if (state.seenOpen && outside) return { verdict: "block", reason: `after open content, no ad-hoc approval: ${outside}`, bytes };
  if (state.seenOpen && pol.width > state.lastWidth) return { verdict: "block", reason: `widened after open content: ${policyId} (width ${pol.width}) > previous width ${state.lastWidth}`, bytes };
  if (outside) return { verdict: "ask", reason: outside, bytes, width: pol?.width ?? Infinity };
  return { verdict: "go", reason: "standing policy", bytes, width: pol.width };
}
