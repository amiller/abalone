// Configured provider keys as credit-store records: kind "key", 0600 files, lock discipline, newest key active,
// no local cap, invisible to coupon credit status; and the CLI never prints a key.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const state = fs.mkdtempSync(path.join(os.tmpdir(), "abalone-keys-"));
process.env.ABALONE_DIR = state;
const keys = await import("../lib/keys.mjs");
const { creditStore } = await import("../lib/credit-store.mjs");
const { createCreditManager } = await import("../lib/credit.mjs");
const dir = path.join(state, "credit");
const cli = (...a) => spawnSync(process.execPath, [path.join(root, "bin/abalone.mjs"), ...a], { env: { ...process.env, ABALONE_DIR: state }, encoding: "utf8", input: "" });
test.after(() => fs.rmSync(state, { recursive: true, force: true }));

test("a saved key is a 0600 kind:key record with no local cap, readable through the credit store", () => {
  keys.save("chutes", "one", "secret-one");
  const [k] = keys.list(), file = path.join(dir, `${k.id}.json`);
  assert.deepEqual(Object.keys(k).sort(), ["added", "id", "key", "kind", "label", "provider", "version"]);
  assert.equal(k.version, 1); assert.equal(k.kind, "key"); assert.equal(k.key, "secret-one");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${file}.lock`).mode & 0o777, 0o600);
  assert.deepEqual(creditStore(dir).read(k.id), k);
  assert.equal(keys.TERMS, "no local cap; the provider's limit applies");
});

test("a second key under one provider and label and an empty key are refused; the same key for another provider is a separate record", () => {
  assert.throws(() => keys.save("chutes", "one", "secret-other"), /already configured/);
  assert.throws(() => keys.save("chutes", "empty", ""), /empty key/);
  keys.save("nearai", "one", "secret-one");
  assert.equal(keys.list().filter((k) => k.key === "secret-one").length, 2);
  keys.forget("nearai");
});

test("the newest key for a provider is active; used() records last use under the lock", async () => {
  await new Promise((r) => setTimeout(r, 5));
  keys.save("chutes", "two", "secret-two");
  assert.equal(keys.active("chutes").label, "two");
  assert.equal(keys.active("nearai"), undefined);
  keys.used(keys.active("chutes").id);
  assert.match(keys.active("chutes").lastUsed, /^\d{4}-\d\d-\d\dT/);
  const unlock = creditStore(dir).lock(keys.active("chutes").id);
  try { assert.throws(() => keys.used(keys.active("chutes").id), { code: "credit_locked" }); } finally { unlock(); }
});

test("coupon credit status ignores key records", async () => {
  assert.deepEqual(await createCreditManager({ directory: dir }).status(), []);
});

test("a key record without its key or provider is refused by the store", () => {
  const s = creditStore(dir), id = "a".repeat(64), unlock = s.lock(id);
  try { s.write({ version: 1, kind: "key", id, label: "x", added: new Date().toISOString() }, { create: true }); } finally { unlock(); }
  assert.throws(() => s.read(id), { code: "credit_store_refused" });
  fs.unlinkSync(path.join(dir, `${id}.json`)); fs.unlinkSync(path.join(dir, `${id}.json.lock`));
});

test("forget needs --label when several keys exist, then removes the record and its lock", () => {
  assert.throws(() => keys.forget("chutes"), /name one with --label/);
  assert.throws(() => keys.forget("chutes", "nope"), /^Error: no such key is configured/);
  const gone = keys.forget("chutes", "one");
  assert.equal(gone.label, "one");
  assert.ok(!fs.existsSync(path.join(dir, `${gone.id}.json`)) && !fs.existsSync(path.join(dir, `${gone.id}.json.lock`)));
  assert.deepEqual(keys.list().map((k) => k.label), ["two"]);
});

test("CLI: list never prints a key; a key in arguments is refused without echo; usage names stdin", () => {
  const list = cli("key", "list");
  assert.equal(list.status, 0);
  assert.match(list.stdout, /^chutes {2}two {2}added \d{4}-\d\d-\d\d {2}last used \d{4}-\d\d-\d\d {2}no local cap; the provider's limit applies\n$/);
  assert.ok(!list.stdout.includes("secret"));
  const argv = cli("key", "add", "chutes", "secret-in-argv");
  assert.notEqual(argv.status, 0);
  assert.match(argv.stderr, /never from arguments/);
  assert.ok(!argv.stderr.includes("secret-in-argv"));
  assert.match(cli("help").stdout, /abalone key add\|list\|forget <provider>/);
  assert.ok(!/\bnode (keys|serve|relay)\b/.test(cli("help").stdout));
});

test("two concurrent adds under one label: exactly one is saved", async () => {
  const run = (key) => new Promise((ok) => {
    const c = spawn(process.execPath, ["-e", `import(${JSON.stringify(path.join(root, "lib/keys.mjs"))}).then((k) => k.save("chutes", "race", require("fs").readFileSync(0, "utf8")))`], { env: { ...process.env, ABALONE_DIR: state }, stdio: ["pipe", "ignore", "ignore"] });
    c.stdin.end(key); c.on("exit", ok);
  });
  const codes = await Promise.all([run("race-a"), run("race-b")]);
  assert.deepEqual(codes.sort(), [0, 1]);
  assert.equal(keys.list().filter((k) => k.label === "race").length, 1);
  keys.forget("chutes", "race");
});

test("lock(): a lock taken on an unlinked lock file is retried on the current file", async () => {
  const s = creditStore(dir), id = "b".repeat(64), lockFile = path.join(dir, `${id}.json.lock`), open = fs.openSync;
  const raceOnce = (then) => { let done = false; fs.openSync = (p, ...a) => { const fd = open(p, ...a); if (p === lockFile && !done) { done = true; fs.unlinkSync(lockFile); then(); } return fd; }; };
  try {
    raceOnce(() => {});
    const unlock = s.lock(id);
    const other = spawnSync("flock", ["-n", "-x", lockFile, "true"]);
    assert.equal(other.status, 1, "the returned lock is on the file at the path, so another process cannot take it");
    unlock();
    let holder;
    raceOnce(() => { fs.writeFileSync(lockFile, "", { mode: 0o600 }); holder = spawn("flock", ["-x", lockFile, "sleep", "30"]); spawnSync("sleep", ["0.3"]); });
    assert.throws(() => s.lock(id), { code: "credit_locked" }, "the current file's holder excludes us; the orphaned inode does not count");
    holder.kill();
    await new Promise((r) => holder.on("exit", r));
  } finally { fs.openSync = open; }
  fs.unlinkSync(lockFile);
});

test("unknown providers and unknown keys are reported without echoing the argument", () => {
  const add = cli("key", "add", "sk-PASTED-123");
  assert.notEqual(add.status, 0);
  assert.match(add.stderr, /unknown provider; expected one of .*nearai/);
  const forget = cli("key", "forget", "sk-PASTED-123");
  assert.match(forget.stderr, /no such key is configured/);
  assert.ok(!(add.stderr + forget.stderr).includes("sk-PASTED"));
});

test("an unreadable credit record is named and listing keeps failing", () => {
  const bad = path.join(dir, `${"c".repeat(64)}.json`);
  fs.writeFileSync(bad, "{}", { mode: 0o644 });
  assert.throws(() => keys.list(), (e) => e.message.startsWith(`credit record ${bad} is unreadable or unsafe`));
  fs.unlinkSync(bad);
});

test("plain abalone with only a configured key points to abalone sandbox", () => {
  const r = spawnSync(process.execPath, [path.join(root, "bin/abalone.mjs")], { env: { ...process.env, ABALONE_DIR: state }, encoding: "utf8", input: "" });
  assert.match(r.stderr, /A configured key exists; use abalone sandbox \(plain abalone opens coupon credit only, #21\)\./);
});
