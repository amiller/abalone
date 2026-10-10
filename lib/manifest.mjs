// curated/manifest.json: every extension, skill, preload and dependency tree that may load, with a sha256.
// A file hashes as its bytes; a directory hashes as the sorted list of "<sha256>  <relative path>" lines,
// so an added, removed or edited file anywhere in it changes the hash.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT, manifest } from "./config.mjs";

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
export function hash(p) {
  if (!fs.statSync(p).isDirectory()) return sha(fs.readFileSync(p));
  const lines = fs.readdirSync(p, { recursive: true }).map(String).sort()
    .filter((f) => !fs.statSync(path.join(p, f)).isDirectory()).map((f) => `${sha(fs.readFileSync(path.join(p, f)))}  ${f}`);
  return sha(lines.join("\n"));
}

// Verify every entry; return them with absolute paths. Any mismatch is an error.
export function verified() {
  return manifest().entries.map((e) => {
    const abs = path.join(ROOT, e.path);
    if (!fs.existsSync(abs)) throw new Error(`✗ refused: ${e.path} is listed in curated/manifest.json but missing`);
    const h = hash(abs);
    if (h !== e.sha256) throw new Error(`✗ refused: abalone's own code changed since it was verified (${e.path}), so it will not run it.
  In a development checkout: git status shows the change; once it is reviewed and committed, node tools/rehash-manifest.mjs records it.
  In a release: reinstall abalone.
  details: sha256 ${h}, curated/manifest.json has ${e.sha256}`);
    return { ...e, abs };
  });
}

// A path asked for at runtime (a -e/--skill flag, a provider extension) must be, or lie inside, a verified entry.
export function admit(entries, p, what) {
  const abs = path.resolve(p);
  if (!entries.some((e) => abs === e.abs || abs.startsWith(e.abs + path.sep))) throw new Error(`✗ refused: ${what} ${p} is not listed in curated/manifest.json`);
  return abs;
}
