// Search a transcript (any text file) for corpus canaries. A canary may appear only if a released
// payload in disclosures.jsonl carried it (it never should: the gate blocks canaries).
import fs from "node:fs";
import path from "node:path";
import { STATE } from "../lib/config.mjs";
import { canaries } from "../lib/gate.mjs";
const norm = (s) => s.toLowerCase().replace(/(\d),(?=\d)/g, "$1");
const t = norm(fs.readFileSync(process.argv[2], "utf8"));
const d = path.join(STATE, "disclosures.jsonl");
const released = norm(fs.existsSync(d) ? fs.readFileSync(d, "utf8").split("\n").filter((l) => l.includes('"label":"released"')).join("\n") : "");
const hits = canaries().map((c) => c.value).filter((c) => t.includes(norm(c)));
const unexplained = hits.filter((c) => !released.includes(norm(c)));
console.log(`${unexplained.length ? "FAIL" : "PASS"} canary transcript check: ${canaries().length} canaries, ${hits.length} in transcript, ${unexplained.length} not in released payloads ${unexplained.join(", ")}`);
process.exit(unexplained.length ? 1 : 0);
