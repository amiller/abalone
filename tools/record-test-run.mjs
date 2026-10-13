// Attribute explicitly invoked checks; never read credentials or dump the environment.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
const [action, directory, mode, ...selection] = process.argv.slice(2);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
if (action === "start") {
  const locks = ["package-lock.json", "vendor/pi/package-lock.json", "vendor/phala-aci/package-lock.json", "verifiers/chutes/package-lock.json"];
  fs.writeFileSync(path.join(directory, "run.json"), JSON.stringify({
    requested: { mode, selection },
    untrackedSourcePresent: Boolean(git("ls-files", "--others", "--exclude-standard")),
    startedAt: new Date().toISOString(), revision: git("rev-parse", "HEAD"),
    trackedChanges: git("diff", "--name-only", "HEAD").split("\n").filter(Boolean),
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    buildIdentity: process.env.ABALONE_TEST_BUILD_ID ?? "not recorded",
    lockfiles: locks.filter((f) => fs.existsSync(f)).map((f) => ({ path: f,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") })),
    scope: "Source and lockfile attribution only; does not attest installed dependencies or build output.",
  }, null, 2) + "\n");
} else if (action === "finish") {
  const file = path.join(directory, "run.json"), record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.finishedAt = new Date().toISOString();
  record.results = fs.readFileSync(path.join(directory, "results.tsv"), "utf8").trim().split("\n").filter(Boolean)
    .map((line) => { const [id, label, name, code, seconds, log] = line.split("\t");
      return { id, label, name, exitCode: Number(code), seconds: Number(seconds), log }; });
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
} else throw new Error("usage: node tools/record-test-run.mjs start|finish LOG_DIRECTORY");
