// Folder canaries: `abalone canary init <folder>` plants a file of random values in the folder and records them
// outside it, in <ABALONE_DIR>/canaries/<sha256 of the folder's real path>.json. The gate blocks any release
// holding one. A folder session refuses to start without its record, unless started with --no-canaries.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STATE, readJson } from "./config.mjs";

export const record = (folder) => path.join(STATE, "canaries", crypto.createHash("sha256").update(fs.realpathSync(folder)).digest("hex") + ".json");

export function init(folder) {
  const f = record(folder);
  if (fs.existsSync(f)) throw new Error(`✗ refused: ${folder} already has canaries (${f})`);
  const tag = crypto.randomBytes(3).toString("hex"), file = `ref-${tag}.txt`;
  const canaries = [{ id: "codename", value: `PRJ-${crypto.randomBytes(5).toString("hex").toUpperCase()}` },
    { id: "account", value: String(crypto.randomInt(1e8, 1e9)) }].map((c) => ({ ...c, file }));
  // Nothing in the file says it is a canary, so a private model told to skip canaries cannot tell it apart.
  fs.writeFileSync(path.join(folder, file), `Project codename: ${canaries[0].value}\nSettlement account: ${canaries[1].value}\n`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ folder: fs.realpathSync(folder), created: new Date().toISOString(), canaries }, null, 1));
  return { file: path.join(folder, file), record: f, canaries };
}

// The record for a folder session, checked against the planted file. null only with --no-canaries.
export function forSession(folder, off) {
  if (off) return null;
  const f = record(folder);
  if (!fs.existsSync(f)) throw new Error(`✗ refused: no canaries for ${fs.realpathSync(folder)}. Plant them with  abalone canary init ${folder}  or start with --no-canaries (shown in the strip)`);
  for (const c of readJson(f).canaries) {
    const p = path.join(folder, c.file);
    if (!fs.existsSync(p) || !fs.readFileSync(p, "utf8").includes(c.value)) throw new Error(`✗ refused: canary file ${p} is missing or changed; remove ${f} and run  abalone canary init ${folder}  again`);
  }
  return f;
}

// The planted files of a folder, kept out of the private model's view (abalone's listing, list, read and grep): they are
// outbound tripwires, and a model that reads them only remarks on them. A file the user mentions with @ is still read.
export const hidden = (folder) => { const f = record(folder); return fs.existsSync(f) ? [...new Set(readJson(f).canaries.map((c) => c.file))] : []; };
