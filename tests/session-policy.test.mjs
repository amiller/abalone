import assert from "node:assert/strict";
import test from "node:test";
import { sessionPolicy } from "../lib/ui/session-policy.mjs";
const text = (options) => sessionPolicy(options).map((row) => typeof row === "string" ? row : `${row.label}: ${row.text}`).join("\n");
test("owned-host display says tools retain network access and separates credential use from conversation retention", () => {
  const s = text({ model: "nearai/private-model", incognito: true, descriptor: { local_boundary: "trusted-owned-host", retention: { kind: "session-only" } } });
  assert.match(s, /not checked yet/); assert.match(s, /no tool sandbox/); assert.match(s, /conversation not saved/);
  assert.match(s, /workspace edits and terminal output can remain/); assert.doesNotMatch(s, /checked for this model/);
});
test("sandbox display shows the shell boundary and explicit encrypted trace choice", () => {
  const s = text({ model: "chutes/private-model", checked: true, incognito: true,
    descriptor: { local_boundary: "bubblewrap", retention: { kind: "encrypted-trace" } } });
  assert.match(s, /checked for this model/); assert.match(s, /shell network blocked/); assert.match(s, /encrypted trace saved by choice/);
});
test("unknown state never becomes a protection claim, and art is an explicit local choice", () => {
  assert.match(text({ model: "other/model" }), /local boundary unknown/);
  assert.match(text({ model: "other/model" }), /protected request path unknown/);
  assert.equal(sessionPolicy({ model: "other/model" }).length, 5);
  assert.equal(sessionPolicy({ model: "other/model", art: true }).length, 9);
});
