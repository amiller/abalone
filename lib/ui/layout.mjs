// The common terminal layout and semantic states. Conversation first, task status second, optional details third.
// Words carry every meaning; a theme only adds emphasis, so no-color output loses nothing. Nothing animates.
import { CONTROL } from "../gate.mjs";

export const STATES = ["working", "waiting", "blocked", "canceled", "failed", "completed"];
const SGR = { boundary: "33", failed: "31", dim: "2", strong: "1" }; // amber only for a proposed boundary change

export const themes = {
  plain: { name: "plain", paint: (_role, s) => s },
  ansi: { name: "ansi", paint: (role, s) => (SGR[role] ? `\x1b[${SGR[role]}m${s}\x1b[0m` : s) },
};

export function theme() {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return themes.plain;
  const t = themes[process.env.ABALONE_THEME ?? "ansi"];
  if (!t) throw new Error(`ABALONE_THEME=${process.env.ABALONE_THEME} is not one of: ${Object.keys(themes).join(", ")}`);
  return t;
}

export const columns = () => process.stdout.columns ?? Number(process.env.COLUMNS ?? 80);

// Text that will be shown and also sent: every control or bidi character is spelled out, never stripped,
// so what the screen shows is exactly what leaves.
export const visible = (s) => s.replace(CONTROL, (c) => c.codePointAt(0) > 0xff ? `\\u${c.codePointAt(0).toString(16)}` : `\\x${c.codePointAt(0).toString(16).padStart(2, "0")}`);

// Word wrap for prose, first/rest prefixes. A long path breaks after a "/", never inside a name; only a single
// name longer than the line is cut.
export function wrap(text, width, first = "", rest = " ".repeat(first.length)) {
  const out = [], max = width - Math.max(first.length, rest.length);
  for (const para of text.split("\n")) {
    let line = null;
    const put = (w, glue) => {
      if (line !== null && line.length + glue.length + w.length <= width) line += glue + w;
      else { if (line !== null) out.push(line); line = (out.length ? rest : first) + w; }
    };
    for (const w of para.split(/\s+/).filter(Boolean)) w.split(/(?<=\/)/).flatMap((s) => s.match(new RegExp(`.{1,${max}}`, "gu"))).forEach((s, i) => put(s, i ? "" : " "));
    out.push(line ?? (out.length ? rest : first).trimEnd());
  }
  return out;
}

// Exact text: hard-wrapped by character so every byte stays where it was. "| " starts a line of the text,
// "+ " continues one that was too wide (not a newline in the text).
export function exact(text, width) {
  const max = width - 2;
  return visible(text).split("\n").flatMap((l) => (l.match(new RegExp(`.{1,${max}}`, "gu")) ?? [""]).map((seg, i) => (i ? "+ " : "| ") + seg));
}

// A task status line: the state is a word, never only a color or a glyph.
export function status(state, text, width) {
  if (!STATES.includes(state)) throw new Error(`unknown task state ${state}`);
  return wrap(text, width, `[${state}] `, "  ");
}
export const stateRole = (state) => (state === "failed" || state === "blocked" ? "failed" : null);

// The resource strip: segments come only from measured runtime state, packed with " · ".
export const strip = (segments, width) => segments.reduce((ls, seg) => (ls.length && ls.at(-1).length + 3 + seg.length <= width - 2 ? (ls[ls.length - 1] += ` · ${seg}`) : ls.push(seg), ls), []).flatMap((l) => wrap(l, width, "  "));

// main: [{text, role}] for the conversation; details: [{text, role}] for the details pane. At 120 columns
// or more the details sit in a pane on the right; narrower, they collapse into one line naming the drawer key.
export const PANE = 38;
export function frame(main, details, width, drawer) {
  const wide = width >= 120, left = wide ? width - PANE - 3 : width;
  const rows = main(left);
  if (!wide) return details.length ? [...rows, { text: `Details: ${drawer}`, role: "dim" }] : rows;
  const right = details.flatMap((d) => wrap(d.text, PANE, "", "  ").map((text) => ({ text, role: d.role ?? "dim" })));
  return Array.from({ length: Math.max(rows.length, right.length) }, (_, i) => ({ text: (rows[i]?.text ?? "").padEnd(left), role: rows[i]?.role, side: right[i] }));
}

// Paint rows: the role colors a whole row; a pane cell keeps its own role after a plain " | " separator.
export const paint = (rows, t) => rows.map((r) => (r.side ? `${t.paint(r.role, r.text)} | ${t.paint(r.side.role, r.side.text)}` : t.paint(r.role, r.text.trimEnd()))).join("\n");
