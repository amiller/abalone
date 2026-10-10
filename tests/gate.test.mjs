// The gate's deterministic checks, offline: the metadata_only schema refuses the second first-contact audit's
// smuggling (SSNs and names in path, name and value fields), and an encoded canary (base64, base64url, hex) is caught.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abalone-gate-"));
process.env.ABALONE_DIR = dir;
delete process.env.ABALONE_CONFIG;
fs.writeFileSync(path.join(dir, "canaries.json"), JSON.stringify({ canaries: [{ id: "codename", value: "PRJ-7F3A9C01D2" }] }));
process.env.ABALONE_CANARIES = path.join(dir, "canaries.json");
const { checkPour } = await import("../lib/gate.mjs");
const pour = (policyId, payload) => checkPour({ policyId, payload, answerer: "mcp-caller" }, { spent: 0, lastWidth: 0, seenOpen: false });
const meta = (files) => pour("metadata_only", JSON.stringify({ files }));

test("a structural description passes the schema (it still needs the human: no standing)", () => {
  const v = meta([{ path: "data/visits.csv", rows_about: 60, columns: [{ name: "arm", type: "categorical", levels: 3 }, { name: "visit_date", type: "date", years: [2019, 2023] }, { name: "cost", type: "number", unit: "currency" }] }]);
  assert.equal(v.verdict, "ask", v.reason);
});
for (const [name, files] of [
  ["SSN in path", [{ path: "123-45-6789", rows_about: 10 }]],
  ["SSNs in a path list", [{ path: "a.csv" }, { path: "ssn_123456789" }]],
  ["a row in a column name", [{ path: "a.csv", columns: [{ name: "Smith_John_123456789", type: "string" }] }]],
  ["free values", [{ path: "a.csv", columns: [{ name: "name", type: "string", values: ["Marisol Vantongeren-Pike"] }] }]],
  ["a free unit", [{ path: "a.csv", columns: [{ name: "salary", type: "number", unit: "183000 usd" }] }]],
  ["an exact row count", [{ path: "a.csv", rows_about: 57 }]],
  ["an extra field", [{ path: "a.csv", note: "anything" }]],
  ["a path with spaces (prose)", [{ path: "Marisol earns a lot" }]],
]) test(`schema refuses: ${name}`, () => assert.match(meta(files).reason, /metadata_only payload does not match its schema/));
for (const [name, enc] of [["plain", (s) => s], ["base64", (s) => Buffer.from(s).toString("base64")], ["base64url", (s) => Buffer.from(s).toString("base64url")], ["hex", (s) => Buffer.from(s).toString("hex")], ["base64 glued to a word", (s) => "x" + Buffer.from(s).toString("base64")], ["hex glued to a hex digit", (s) => "a" + Buffer.from(s).toString("hex")]])
  test(`canary blocked: ${name}`, () => assert.equal(pour("free_text", `ref ${enc("the codename is PRJ-7F3A9C01D2, ok")} end`).reason, "canary in payload (rule folder canary codename)"));
