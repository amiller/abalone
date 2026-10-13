import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { statePath, portableWorkspace } from "../lib/state-path.mjs";
const marker = { kind: "abalone-portable", version: 1, revision: "abcdef0", runtimeSha256: "a".repeat(64), profile: "linux-node24-owned-host" };
function fixture(t, marked = true) {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), "abalone-portable-"));
  t.after(() => fs.rmSync(container, { recursive: true, force: true }));
  const root = path.join(container, "abalone"); fs.mkdirSync(root);
  if (marked) fs.writeFileSync(path.join(container, "portable.json"), JSON.stringify(marker), { mode: 0o600 });
  return { container, root };
}
test("unmarked installs keep home state and an explicit override wins without opening portable state", (t) => {
  const { container, root } = fixture(t, false);
  assert.equal(statePath(root, {}, "/synthetic/home"), "/synthetic/home/.abalone");
  fs.writeFileSync(path.join(container, "portable.json"), "invalid");
  assert.equal(statePath(root, { ABALONE_DIR: "/explicit/state" }), "/explicit/state");
  assert.equal(fs.existsSync(path.join(container, "state")), false);
});
test("portable state is a private sibling; moving the whole container keeps saved access", (t) => {
  const { container, root } = fixture(t), state = statePath(root, {});
  assert.equal(state, path.join(container, "state"));
  assert.equal(fs.statSync(state).mode & 0o777, 0o700);
  fs.writeFileSync(path.join(state, "saved.json"), '{"synthetic":true}', { mode: 0o600 });
  const moved = container + "-moved";
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  fs.renameSync(container, moved);
  assert.equal(fs.readFileSync(path.join(statePath(path.join(moved, "abalone"), {}), "saved.json"), "utf8"), '{"synthetic":true}');
});
test("malformed and symlink markers refuse instead of opening home state", (t) => {
  const { container, root } = fixture(t);
  fs.writeFileSync(path.join(container, "portable.json"), "{}");
  assert.throws(() => statePath(root, {}), /marker is invalid/);
  fs.unlinkSync(path.join(container, "portable.json"));
  fs.writeFileSync(path.join(container, "other.json"), JSON.stringify(marker));
  fs.symlinkSync("other.json", path.join(container, "portable.json"));
  assert.throws(() => statePath(root, {}), /marker is invalid/);
  assert.equal(fs.existsSync(path.join(container, "state")), false);
});
test("symlinked or public portable state refuses without changing existing files", (t) => {
  const { container, root } = fixture(t), elsewhere = path.join(container, "elsewhere");
  fs.mkdirSync(elsewhere); fs.symlinkSync(elsewhere, path.join(container, "state"));
  assert.throws(() => statePath(root, {}), /unsafe/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  fs.unlinkSync(path.join(container, "state")); fs.mkdirSync(path.join(container, "state"), { mode: 0o755 });
  assert.throws(() => statePath(root, {}), /unsafe/);
  assert.equal(fs.statSync(path.join(container, "state")).mode & 0o777, 0o755);
});

test("launching from the container chooses a private work folder; a selected project stays selected", (t) => {
  const { container, root } = fixture(t), workspace = portableWorkspace(root, container);
  assert.equal(workspace, path.join(container, "work"));
  assert.equal(fs.statSync(workspace).mode & 0o777, 0o700);
  assert.notEqual(workspace, statePath(root, {}));
  assert.equal(portableWorkspace(root, workspace), workspace);
  assert.equal(portableWorkspace(root, os.tmpdir()), os.tmpdir());
});
