// Maintainer step after reviewing and committing a change to a curated file: rewrite the sha256 of every entry
// in <ABALONE_CONFIG or repo>/curated/manifest.json. abalone itself never rehashes.
// The repo manifest is rehashed only over committed paths, so it matches what a clone verifies.
// Tests rehash a copy in a temporary ABALONE_CONFIG over the working tree they test.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CFG, ROOT, manifest } from "../lib/config.mjs";
import { hash } from "../lib/manifest.mjs";
const m = manifest();
if (path.resolve(CFG) === ROOT) {
  const dirty = execFileSync("git", ["-C", ROOT, "status", "--porcelain", "--", ...m.entries.map((e) => e.path)], { encoding: "utf8" });
  if (dirty) throw new Error(`✗ refused: uncommitted changes under manifest entries; commit them first:\n${dirty}`);
}
m.entries = m.entries.map((e) => ({ ...e, sha256: hash(path.join(ROOT, e.path)) }));
fs.writeFileSync(path.join(CFG, "curated", "manifest.json"), JSON.stringify(m, null, 1) + "\n");
for (const e of m.entries) console.log(e.sha256.slice(0, 12), e.kind.padEnd(9), e.path);
