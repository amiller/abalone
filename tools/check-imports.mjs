// Pre-commit: every relative import in a staged .mjs/.ts must resolve to a tracked or staged file (build output under dist/ excepted).
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const git = (a) => execSync(`git ${a}`, { encoding: "utf8" }).split("\n").filter(Boolean);
const known = new Set([...git("ls-files"), ...git("diff --cached --name-only --diff-filter=AM")]);
for (const g of git("diff --cached --name-only --diff-filter=D")) known.delete(g);
const bad = [];
for (const f of git("diff --cached --name-only --diff-filter=AM")) {
  if (!/^(lib|bin|agents|verifiers|plugins|tools|tests)\/.*\.(mjs|ts)$/.test(f) || !fs.existsSync(f)) continue;
  const src = execSync(`git show :${f}`, { encoding: "utf8" });
  for (const m of src.matchAll(/(?:import|from)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const t = path.normalize(path.join(path.dirname(f), m[1]));
    if (!known.has(t) && !/\/dist(-test)?\//.test(t)) bad.push(`${f} imports ${m[1]} (${t} is not tracked or staged)`);
  }
}
if (bad.length) { console.error("✗ commit refused: imports of uncommitted files\n  " + bad.join("\n  ")); process.exit(1); }
