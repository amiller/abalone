// The private research notebook: records and a lexical index, on this machine only (<STATE>/notebook).
// No embeddings and no network: search is a local inverted index over records and source lines.
// Record kinds stay distinct: source (a file, by sha256), quote (a source line, verbatim),
// conclusion (model output), decision (the researcher's own text), open (an outside answer: untrusted).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STATE } from "./config.mjs";

export const DIR = path.join(STATE, "notebook");
const RECORDS = path.join(DIR, "records.jsonl");
const INDEX = path.join(DIR, "index.json");
export const LABEL = { source: "source", quote: "quote", conclusion: "model conclusion", decision: "your decision", line: "source line", open: "open answer (outside, untrusted)" };
export const RETENTION = `kept on this computer in ${DIR} until you delete it (abalone notebook rm <source-id>); ` +
  "rm also removes its quotes, conclusions, decisions, history and index entries";

export const records = () => fs.existsSync(RECORDS) ? fs.readFileSync(RECORDS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const write = (rs) => { fs.writeFileSync(RECORDS, rs.map((r) => JSON.stringify(r) + "\n").join("")); reindex(rs); };
export const sourceText = (src) => fs.readFileSync(path.join(DIR, "sources", `${src.sha256}.txt`), "utf8").split("\n");
const id = (p) => `${p}-${crypto.randomBytes(4).toString("hex")}`;
const tokens = (s) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 1);
const get = (rs, i) => { const r = rs.find((r) => r.id === i); if (!r) throw new Error(`no notebook record ${i}`); return r; };

function reindex(rs) {
  const terms = {};
  const add = (key, text) => { for (const t of new Set(tokens(text))) (terms[t] ??= []).push(key); };
  for (const r of rs) {
    add(r.id, [r.name, r.question, r.text].filter(Boolean).join(" "));
    if (r.kind === "source") sourceText(r).forEach((l, i) => add(`${r.id}:L${i + 1}`, l));
  }
  fs.writeFileSync(INDEX, JSON.stringify({ built: new Date().toISOString(), records: rs.length, terms }));
}

// One answered question: the source (deduplicated by sha256), the model's conclusion, and a quote record per cited line that exists.
export function save({ project, file, sha256, bytes, text, question, answer, refs, model, verification, history }) {
  fs.mkdirSync(path.join(DIR, "sources"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(DIR, "history"), { recursive: true });
  const rs = records(), ts = new Date().toISOString();
  let src = rs.find((r) => r.kind === "source" && r.sha256 === sha256);
  if (!src) {
    fs.writeFileSync(path.join(DIR, "sources", `${sha256}.txt`), text);
    src = { id: `src-${sha256.slice(0, 10)}`, kind: "source", project, ts, name: path.basename(file), path: file, sha256, bytes };
    rs.push(src);
  }
  const lines = text.split("\n");
  const c = { id: id("c"), kind: "conclusion", project, ts, source: src.id, question, text: answer, refs, model, verification, history };
  rs.push(c, ...refs.filter((n) => n <= lines.length).map((n) => ({ id: id("q"), kind: "quote", project, ts, source: src.id, from: c.id, line: n, text: lines[n - 1] })));
  write(rs);
  return { source: src, conclusion: c };
}

// A frontier answer to a pour (kind open) and the private agent's check of it against the source (a conclusion).
export function saveOpen({ from, disclosure, to, answer, check, refs, model, verification }) {
  const rs = records(), c0 = get(rs, from), ts = new Date().toISOString();
  const lines = sourceText(get(rs, c0.source));
  const o = { id: id("o"), kind: "open", project: c0.project, ts, source: c0.source, from, disclosure, to, text: answer };
  const c = { id: id("c"), kind: "conclusion", project: c0.project, ts, source: c0.source, from: o.id, question: `private check of the open answer ${o.id} against the source`, text: check, refs, model, verification };
  write([...rs, o, c, ...refs.filter((n) => n <= lines.length).map((n) => ({ id: id("q"), kind: "quote", project: c0.project, ts, source: c0.source, from: c.id, line: n, text: lines[n - 1] }))]);
  return { open: o, conclusion: c };
}

export function decide(about, text) {
  const rs = records();
  const r = get(rs, about);
  const d = { id: id("d"), kind: "decision", project: r.project, ts: new Date().toISOString(), about, source: r.source ?? r.id, text };
  write([...rs, d]);
  return d;
}

export function search(q) {
  const { terms } = JSON.parse(fs.readFileSync(INDEX, "utf8"));
  const score = {};
  for (const t of new Set(tokens(q))) for (const k of terms[t] ?? []) score[k] = (score[k] ?? 0) + 1;
  const rs = records();
  return Object.entries(score).sort((a, b) => b[1] - a[1]).map(([k, n]) => {
    const [rid, line] = k.split(":L");
    const r = get(rs, rid);
    return line ? { key: k, kind: "line", score: n, text: sourceText(r)[line - 1], name: r.name } : { key: k, kind: r.kind, score: n, text: r.text ?? r.name, name: r.name };
  });
}

// Removes a source and everything derived from it: quotes, conclusions, decisions, history files, index entries.
export function rm(srcId) {
  const rs = records();
  const src = get(rs, srcId);
  if (src.kind !== "source") throw new Error(`${srcId} is a ${src.kind}; rm takes a source id`);
  const gone = rs.filter((r) => r.id === srcId || r.source === srcId);
  for (const r of gone.filter((r) => r.history)) fs.rmSync(path.join(DIR, r.history));
  fs.rmSync(path.join(DIR, "sources", `${src.sha256}.txt`));
  write(rs.filter((r) => !gone.includes(r)));
  return gone.length;
}

export function exportTo(dest) {
  if (fs.existsSync(dest)) throw new Error(`${dest} exists; export writes a new directory`);
  fs.cpSync(DIR, dest, { recursive: true });
}
