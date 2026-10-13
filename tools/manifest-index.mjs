// agents/pi/admitted.json from the git index (the staged blobs), so every commit carries a manifest that matches it.
//   node tools/manifest-index.mjs --write   rehash and stage agents/pi/admitted.json (the pre-commit hook runs this)
//   node tools/manifest-index.mjs --check   exit 1 if the staged manifest does not match the staged entries
// Same hashing as lib/manifest.mjs: a file is the sha256 of its bytes; a directory is the sha256 of the sorted
// "<sha256>  <relative path>" lines of its files. Only staged files count: an untracked file under lib/ is not in a clone.
// Self-contained (no lib/ import), so another agent's unstaged lib/ cannot break the hook.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

const git = (args, input) => execFileSync("git", args, { input, maxBuffer: 1 << 30 });
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const staged = JSON.parse(git(["show", ":agents/pi/admitted.json"]).toString());
// Every staged blob under the entry paths, read in one cat-file --batch.
const files = git(["ls-files", "-s", "-z", "--", ...staged.entries.map((e) => e.path)]).toString().split("\0").filter(Boolean)
  .map((l) => { const [meta, p] = l.split("\t"); return { oid: meta.split(" ")[1], path: p }; });
const out = git(["cat-file", "--batch"], files.map((f) => f.oid).join("\n") + "\n");
let at = 0;
for (const f of files) {
  const nl = out.indexOf(10, at), size = Number(out.subarray(at, nl).toString().split(" ")[2]);
  f.hash = sha(out.subarray(nl + 1, nl + 1 + size));
  at = nl + 1 + size + 1;
}
const entries = staged.entries.map((e) => {
  const one = files.find((f) => f.path === e.path);
  if (one) return { ...e, sha256: one.hash };
  const under = files.filter((f) => f.path.startsWith(e.path + "/")).map((f) => ({ rel: f.path.slice(e.path.length + 1), hash: f.hash }));
  if (!under.length) throw new Error(`✗ manifest entry ${e.path} has no staged files`);
  return { ...e, sha256: sha(under.map((u) => u.rel).sort().map((r) => `${under.find((u) => u.rel === r).hash}  ${r}`).join("\n")) };
});
const text = JSON.stringify({ ...staged, entries }, null, 1) + "\n";
if (process.argv[2] === "--check") {
  const bad = entries.filter((e, i) => e.sha256 !== staged.entries[i].sha256).map((e) => e.path);
  if (bad.length) { console.error(`✗ agents/pi/admitted.json does not match the staged ${bad.join(", ")}: run node tools/manifest-index.mjs --write`); process.exit(1); }
} else if (process.argv[2] === "--write") {
  const oid = git(["hash-object", "-w", "--stdin"], text).toString().trim();
  git(["update-index", "--cacheinfo", `100644,${oid},agents/pi/admitted.json`]);
  fs.writeFileSync("agents/pi/admitted.json", text); // the working copy follows the index; nobody edits it by hand
} else throw new Error("usage: node tools/manifest-index.mjs --write|--check");
