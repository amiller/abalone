// The worker side of abalone-task/1 (docs/protocols/task-v1.md), inside the gift peer: one Offer, commissioned tasks
// that each run in a fresh guest (bin/task-guest.mjs), metered against the redeemed gift's balance in the peer's own
// ledger, and a bundle written once at terminal. Executors: "runner" (a task VM through runner.local, the Mac runner's
// task API in docs/protocols/runner-task.md) and "local" (a sandboxed process on this host, for development).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { V, h, requestMsg, offerId, completionData, check, TERMINAL } from "./contracts/task-v1.mjs";
import { verify } from "./gift.mjs";
import { runnerFetch, runnerJson, tunnel } from "./macrunner.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const MAX_OUT = 4096; // output tokens per model call, so a call's hold stays small against a task's cap
export const RESOURCES = [{ id: "small", cpus: 2, mem_mb: 2048, max_seconds: 1800, max_input_bytes: 20 << 20 }];

// ustar, enough for the runner's inputs and collect tars (regular files only).
export const tarPack = (files) => Buffer.concat([...files.flatMap(({ path: p, data }) => {
  const hd = Buffer.alloc(512), cut = p.length > 100 ? p.lastIndexOf("/", 155) : -1;
  hd.write(cut > 0 ? p.slice(cut + 1) : p, 0); if (cut > 0) hd.write(p.slice(0, cut), 345);
  for (const [o, v] of [[100, "0000644\0"], [108, "0000000\0"], [116, "0000000\0"], [124, data.length.toString(8).padStart(11, "0") + "\0"], [136, "00000000000\0"], [148, "        "], [156, "0"], [257, "ustar\0"], [263, "00"]]) hd.write(v, o);
  hd.write(hd.reduce((s, b) => s + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
  return [hd, data, Buffer.alloc((512 - data.length % 512) % 512)];
}), Buffer.alloc(1024)]);
// The byte offset of the first header whose name passes test, or -1.
export function tarOffset(b, test) {
  for (let o = 0; o + 512 <= b.length;) {
    const hd = b.subarray(o, o + 512);
    if (hd.every((x) => !x)) return -1;
    if (test(hd.toString("utf8", 0, 100).replace(/\0.*$/s, ""))) return o;
    o += 512 + Math.ceil(parseInt(hd.toString("utf8", 124, 136).replace(/\0.*$/s, "").trim() || "0", 8) / 512) * 512;
  }
  return -1;
}
export function tarUnpack(b) {
  const out = [], str = (o, n, at) => at.toString("utf8", o, o + n).replace(/\0.*$/s, "");
  for (let o = 0; o + 512 <= b.length;) {
    const hd = b.subarray(o, o + 512);
    if (hd.every((x) => !x)) break;
    const size = parseInt(str(124, 12, hd).trim() || "0", 8), pre = str(345, 155, hd), name = (pre ? pre + "/" : "") + str(0, 100, hd);
    if ([0, 48].includes(hd[156])) out.push({ path: name.replace(/^\.\//, ""), data: b.subarray(o + 512, o + 512 + size) });
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

// An executor runs one guest: write(frame), onFrame(cb), onExit(cb), seconds(), kill(), collect() → [{path, data}] of /out.
function localExecutor(t, base) {
  const d = (n) => path.join(base, n);
  for (const n of ["work", "out", "state"]) fs.mkdirSync(d(n), { recursive: true });
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, TASK_IN: d("in"), TASK_OUT: d("out"), TASK_WORK: d("work"), TASK_STATE: d("state") };
  const node = process.execPath, guest = path.join(ROOT, "bin/task-guest.mjs");
  // Linux: bwrap with no network, only system dirs, node, the abalone tree read-only and the task's own dirs.
  // macOS: sandbox-exec with no network except loopback, and no reads of the owner's home outside the task and abalone.
  const argv = process.platform === "linux"
    ? ["bwrap", "--die-with-parent", "--unshare-all", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
      "--ro-bind", "/etc/passwd", "/etc/passwd", "--ro-bind", path.resolve(node, "../.."), path.resolve(node, "../.."), "--ro-bind", path.join(ROOT, "bin"), path.join(ROOT, "bin"), "--ro-bind", path.join(ROOT, "pi"), path.join(ROOT, "pi"),
      "--ro-bind", d("in"), d("in"), ...["work", "out", "state"].flatMap((n) => ["--bind", d(n), d(n)]), "--chdir", d("work"), "--", node, guest]
    : ["sandbox-exec", "-p", `(version 1)(allow default)(deny network*)(allow network* (local ip "localhost:*") (remote ip "localhost:*"))(deny file-read* file-write* (subpath "${os.homedir()}"))(allow file-read-metadata)(allow file-read* (subpath "${base}") (subpath "${path.join(ROOT, "bin")}") (subpath "${path.join(ROOT, "pi")}") (subpath "${path.resolve(node, "../..")}"))(allow file-write* (subpath "${base}"))`, node, guest];
  const p = spawn(argv[0], argv.slice(1), { env, stdio: ["pipe", "pipe", "pipe"] });
  const t0 = Date.now();
  p.stderr.on("data", (x) => console.error(`task ${t.id.slice(0, 8)}: ${String(x).trimEnd()}`));
  return {
    write: (o) => p.stdin.writable && p.stdin.write(JSON.stringify(o) + "\n"),
    onFrame: (cb) => readline.createInterface({ input: p.stdout }).on("line", (l) => cb(JSON.parse(l))),
    onExit: (cb) => p.on("exit", (code, signal) => cb(code ?? signal)),
    seconds: () => (Date.now() - t0) / 1000,
    kill: () => p.kill("SIGKILL"),
    collect: async () => walk(d("out")).map((f) => ({ path: path.relative(d("out"), f), data: fs.readFileSync(f) })),
    guest: async () => [],
  };
}
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

async function runnerExecutor(t, base, image) {
  const files = walk(path.join(base, "in")).sort().map((f) => ({ path: path.relative(path.join(base, "in"), f), data: fs.readFileSync(f) }));
  const compose = { manifest_version: 2, name: `abalone-task-${t.id}`, runner: "docker-compose", kms_enabled: false,
    docker_compose_file: JSON.stringify({ services: { task: { image, command: ["node", "/abalone/bin/task-guest.mjs"], labels: { "abalone.task_id": t.id, "abalone.auth_hash": t.auth_hash, "abalone.inputs_root": t.auth.inputs_root } } } }),
    egress: { max_requests: 0, max_tokens: 0, allow: [], tcp: [] }, task: { resource: t.auth.task.resource } };
  const started = await runnerJson("/task/start", { task_id: t.id, compose, inputs_tar_b64: tarPack(files).toString("base64") });
  t.guestCompose = started.compose_hash;
  const s = await tunnel(`task-${t.id}.runner.local`, 1);
  const status = async () => { const r = await runnerFetch(`http://runner.local/task/status?id=${t.id}`); if (!r.ok) throw new Error(`runner task status: HTTP ${r.status} ${await r.text()}`); return r.json(); };
  let wall = 0, exitCb;
  const poll = setInterval(async () => { const st = await status(); wall = st.wall_seconds; if (["exited", "stopped", "failed"].includes(st.state)) { clearInterval(poll); exitCb?.(`${st.state} ${st.exit_code ?? ""} ${st.reason ?? ""}`.trim()); } }, 5000);
  // The runner's collect tar: guest/ entries (app-compose.json, clientData.bin, attest.json, receipts.jsonl), then the
  // /out entries under out/. The runner's exit receipt hashes the /out tar alone, which is exactly this tar's suffix from
  // the first out/ header; that suffix is kept verbatim as guest/out.tar.
  let tar;
  const collected = async () => {
    if (tar) return tar;
    const r = await runnerFetch(`http://runner.local/task/collect?id=${t.id}`);
    if (!r.ok) throw new Error(`runner task collect: HTTP ${r.status} ${await r.text()}`);
    const b = Buffer.from(await r.arrayBuffer()), files = tarUnpack(b), at = tarOffset(b, (n) => n.startsWith("out/"));
    if (at < 0) throw new Error("runner task collect: no out/ entries in the collect tar");
    return (tar = { out: files.filter((f) => f.path.startsWith("out/")).map((f) => ({ path: f.path.slice(4), data: f.data })), guest: [...files.filter((f) => f.path.startsWith("guest/")), { path: "guest/out.tar", data: b.subarray(at) }] });
  };
  return {
    write: (o) => s.write(JSON.stringify(o) + "\n"),
    onFrame: (cb) => readline.createInterface({ input: s }).on("line", (l) => cb(JSON.parse(l))),
    onExit: (cb) => (exitCb = cb),
    seconds: () => wall,
    kill: () => runnerJson("/task/stop", { task_id: t.id, grace_seconds: 0 }),
    collect: async () => (await collected()).out,
    guest: async () => (await collected()).guest,
  };
}

// ctx from lib/node.mjs serve(): the ledger, per-account serialisation, model forwarding and pricing, and how this peer signs.
export function taskService({ L, slice, dir, serial, infer, hold, cost, models, peerId, evidence, sign, cfg }) {
  const TASKS = path.resolve(dir, "tasks"); // absolute: the local executor's sandbox profiles name it
  fs.mkdirSync(TASKS, { recursive: true, mode: 0o700 });
  const runtime = cfg.executor === "runner" ? cfg.image : `local:abalone@sha256:${sha(fs.readFileSync(path.join(ROOT, "curated/manifest.json")))}`;
  const enforced = cfg.executor === "runner" ? "Mac runner (task VM)" : `none: a development process on this host (${process.platform === "linux" ? "bwrap" : "sandbox-exec"}, no network)`;
  const body = { v: V, type: "offer", worker: { peer: peerId, operator: cfg.operator, label: cfg.label }, evidence,
    runtime: { image: runtime, agent: "pi", tools: ["read", "bash", "edit", "write"] },
    resources: RESOURCES.map((r) => ({ ...r, enforced_by: enforced })), network: { egress: [], enforced_by: enforced },
    inference: { route: cfg.executor === "runner" ? "task VM → peer → runner proxy → NEAR" : "task process → peer → NEAR (TLS pinned by the peer)", models, max_output_tokens: MAX_OUT, sees_plaintext: ["task guest", "peer", ...(cfg.executor === "runner" ? ["runner proxy"] : [])] },
    accepts: ["released", "open"],
    persistence: { continuation: "runs to terminal while the client is away", retention_ms: 864e5, after: "outputs and events deleted" },
    tariff: { version: "t1", execution_per_second: cfg.perSecond, interval_seconds: 15, inference: "NEAR list price × usage", storage: 0, sponsored: cfg.perSecond === 0 },
    expiry: Date.now() + 864e5 };
  const offer = { ...body, offer_id: offerId(body) };
  check("offer", offer);
  const tasks = new Map();

  const record = (t, f, x) => fs.writeFileSync(path.join(t.dir, f), typeof x === "string" || Buffer.isBuffer(x) ? x : JSON.stringify(x, null, 1), { mode: 0o600 });
  const handle = (t) => ({ task_id: t.id, worker: peerId, auth_hash: t.auth_hash, state: t.state, control: t.control, seq: t.events.length, created: t.created, updated: t.events.at(-1)?.ts ?? t.created });
  const usage = (t) => ({ tariff_version: "t1", cap: t.auth.cap, reserved: t.auth.cap, sponsored: offer.tariff.sponsored,
    execution: { seconds: Math.ceil(t.seconds), per_second: cfg.perSecond, charge: t.execCharge }, inference: { ...t.inf },
    storage: { charge: 0 }, charged: t.charged, released: t.done ? t.auth.cap - t.charged : 0, settled: !!t.done, ledger: t.ledger });
  function emit(t, kind, data) {
    const e = { seq: t.events.length + 1, ts: Date.now(), kind, data, prev: t.events.at(-1)?.hash ?? "0".repeat(64) };
    e.hash = h({ seq: e.seq, ts: e.ts, kind, data, prev: e.prev });
    t.events.push(e);
    fs.appendFileSync(path.join(t.dir, "events.jsonl"), JSON.stringify(e) + "\n");
    for (const w of t.watchers) w(e);
  }
  // A debit in the gift ledger. The idem makes a repeat a no-op; the task's reservation shrinks by what was charged.
  function charge(t, kind, idem, amount, extra = {}) {
    if (L.done.has(`${t.account}:${idem}`) || amount <= 0) return;
    L.append({ type: "debit", account: t.account, slice, idem, model: extra.model ?? null, usage: extra.usage ?? null, charge: amount, hold: amount, task: t.id, kind });
    L.accounts.get(t.account).held -= amount;
    t.charged += amount; t.ledger.push(idem);
    if (kind === "execution") t.execCharge += amount; else t.inf.charge += amount;
    emit(t, "charge", { kind, idem, amount, charged: t.charged, cap: t.auth.cap });
  }

  function verifyRequest(q) {
    const a = L.accounts.get(q.account);
    if (!a?.device) throw Object.assign(new Error("This gift isn't set up on this worker. Redeem it here first."), { code: "no_account" });
    if (!(Math.abs(Date.now() - Number(q.ts)) < 300e3)) throw Object.assign(new Error("This computer's clock is more than 5 minutes off."), { code: "clock" });
    if (!verify(a.device, requestMsg(q.op, q.task_id, q.ts, q.idem, q.body), q.sig ?? "")) throw Object.assign(new Error("The request is not signed by the device that redeemed this gift."), { code: "bad_signature" });
    return a;
  }
  const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const mine = (q) => { const t = tasks.get(q.task_id); if (!t || t.account !== q.account) refuse("unknown_task", `No task ${q.task_id} for this gift on this worker.`); return t; };

  async function commission(q, a) {
    const { authorization: au, inputs } = q.body;
    check("authorization", au);
    if (au.task_id !== q.task_id || au.account !== q.account || au.device !== a.device) refuse("scope", "The authorization names a different task, gift or device than the request.");
    const existing = tasks.get(au.task_id);
    if (existing) { if (existing.auth_hash !== h(au)) refuse("task_id_reused", "This task ID was already used for a different authorization."); return handle(existing); }
    if (au.worker !== peerId) refuse("scope", `The authorization is for worker ${au.worker}, not this one.`);
    if (au.offer_id !== offer.offer_id || au.tariff_version !== offer.tariff.version) refuse("scope", "The authorization is for an offer this worker no longer makes. Fetch the offer again.");
    if (au.expires < Date.now()) refuse("scope", "The authorization has expired.");
    const res = RESOURCES.find((r) => r.id === au.task?.resource) ?? refuse("scope", `Unknown resource ${au.task?.resource}.`);
    if (typeof au.task.prompt !== "string" || !au.task.prompt) refuse("scope", "The task has no prompt.");
    if (!models.includes(au.model)) refuse("scope", `Model ${au.model} is not offered here.`);
    for (const tl of au.capabilities.tools ?? []) if (!offer.runtime.tools.includes(tl)) refuse("scope", `Tool ${tl} is not offered here.`);
    if ((au.capabilities.egress ?? []).length) refuse("scope", "This worker offers no network access to tasks.");
    for (const i of au.inputs) if (!offer.accepts.includes(i.label)) refuse("scope", `Input ${i.path} is labelled ${i.label}; this worker takes only ${offer.accepts.join(" and ")} data.`);
    const bytes = au.inputs.reduce((s, i) => s + i.bytes, 0);
    if (bytes > res.max_input_bytes) refuse("scope", `Inputs total ${bytes} bytes; the limit is ${res.max_input_bytes}.`);
    const got = new Map(inputs.map((f) => [f.path, Buffer.from(f.b64, "base64")]));
    if (got.size !== au.inputs.length) refuse("scope", "The uploaded files are not exactly the authorized inputs.");
    for (const i of au.inputs) { const b = got.get(i.path); if (!b || sha(b) !== i.sha256 || b.length !== i.bytes || path.isAbsolute(i.path) || i.path.split("/").includes("..")) refuse("scope", `Input ${i.path} does not match its authorized hash or size, or its path leaves the input folder.`); }
    if (au.cap > L.remaining(a)) refuse("budget", `The cap ${au.cap} µ$ is more than this gift has left (${L.remaining(a)} µ$).`);
    // Accepted: reserve the cap, write the record, start a fresh guest.
    const t = { id: au.task_id, account: a.account, auth: au, auth_hash: h(au), dir: path.join(TASKS, au.task_id), state: "booting", control: "agent", created: Date.now(),
      events: [], watchers: new Set(), charged: 0, execCharge: 0, pending: 0, inf: { calls: 0, prompt_tokens: 0, completion_tokens: 0, charge: 0 }, ledger: [], seconds: 0, busy: false, msgs: new Map() };
    a.held += au.cap;
    fs.mkdirSync(path.join(t.dir, "in"), { recursive: true, mode: 0o700 });
    for (const [p, b] of got) { fs.mkdirSync(path.dirname(path.join(t.dir, "in", p)), { recursive: true }); fs.writeFileSync(path.join(t.dir, "in", p), b); }
    record(t, "offer.json", offer); record(t, "authorization.json", { authorization: au, request: { ts: q.ts, idem: q.idem, sig: q.sig, body_hash: h(q.body) } });
    tasks.set(t.id, t);
    emit(t, "state", { state: "booting", worker: offer.worker, runtime: offer.runtime.image, cap: au.cap, reserved: au.cap });
    run(t, res).catch((e) => { emit(t, "error", { message: e.message }); finish(t, "failed", e.message); });
    return handle(t);
  }

  async function run(t, res) {
    const x = t.exe = cfg.executor === "runner" ? await runnerExecutor(t, t.dir, cfg.image) : localExecutor(t, t.dir);
    x.onFrame((m) => frame(t, m));
    x.onExit((code) => finish(t, t.stopping ?? (t.outputs ? "completed" : "failed"), t.stopReason ?? `guest exited (${code})${t.outputs ? "" : " without outputs"}`));
    x.write({ t: "init", prompt: t.auth.task.prompt, model: t.auth.model, tools: t.auth.capabilities.tools, check: t.auth.task.check });
    const rate = cfg.perSecond, interval = offer.tariff.interval_seconds;
    t.tick = setInterval(() => {
      t.seconds = x.seconds();
      for (let k = 1; k <= Math.floor(t.seconds / interval) && !t.stopping; k++) {
        if (t.charged + t.pending + rate * interval > t.auth.cap) return stop(t, "budget_exhausted", "The next execution interval would pass the cap.");
        charge(t, "execution", `task:${t.id}:exec:${k}`, rate * interval);
      }
    }, 1000);
    t.timer = setTimeout(() => stop(t, "timed_out", `The ${res.max_seconds} s limit was reached.`), res.max_seconds * 1000);
  }

  function frame(t, m) {
    if (m.t === "ev") {
      if (m.kind === "agent_start") t.busy = true;
      // Running means the agent has started on the prompt; until then the guest is booting and takes no control.
      if (m.kind === "agent_start" && t.state === "booting") { t.state = "running"; t.ready = true; emit(t, "state", { state: "running" }); }
      emit(t, "agent", { kind: m.kind, ...m.data });
      if (m.kind === "agent_settled") { t.busy = false; if (t.control === "agent" && !t.stopping) { t.stopping = "completed"; t.stopReason = "the agent finished"; t.exe.write({ t: "finish", reason: "the agent finished" }); } }
    }
    if (m.t === "infer") inferCall(t, m).catch((e) => { emit(t, "error", { message: `model call: ${e.message}` }); t.exe.write({ t: "infer-head", id: m.id, status: 502 }); t.exe.write({ t: "infer-data", id: m.id, b64: Buffer.from(JSON.stringify({ error: { message: e.message } })).toString("base64") }); t.exe.write({ t: "infer-end", id: m.id }); });
    if (m.t === "outputs") t.outputs = m.files;
  }

  async function inferCall(t, m) {
    const b = JSON.parse(m.body), reply = (status, obj) => { t.exe.write({ t: "infer-head", id: m.id, status }); t.exe.write({ t: "infer-data", id: m.id, b64: Buffer.from(JSON.stringify(obj)).toString("base64") }); t.exe.write({ t: "infer-end", id: m.id }); };
    if (b.model !== t.auth.model) return reply(400, { error: { message: `model ${b.model} is not the authorized ${t.auth.model}` } });
    if (t.stopping) return reply(409, { error: { message: "the task is stopping" } });
    delete b.max_completion_tokens;
    Object.assign(b, { stream: true, stream_options: { include_usage: true }, max_tokens: Math.min(b.max_tokens ?? MAX_OUT, MAX_OUT) });
    const body = JSON.stringify(b), held = hold(b.model, body), k = ++t.inf.calls;
    if (t.charged + t.pending + held > t.auth.cap) { reply(402, { error: { message: "budget exhausted: this call could pass the task's cap" } }); return stop(t, "budget_exhausted", "The next model call could pass the cap."); }
    t.pending += held;
    try {
      const res = { headersSent: false, writeHead(status) { this.headersSent = true; t.exe.write({ t: "infer-head", id: m.id, status }); }, write(c) { t.exe.write({ t: "infer-data", id: m.id, b64: Buffer.from(c).toString("base64") }); return true; }, end(c) { if (c) this.write(c); t.exe.write({ t: "infer-end", id: m.id }); }, destroy() { t.exe.write({ t: "infer-end", id: m.id }); }, on() {} };
      const f = await infer(body, res);
      if (!f) return;
      res.end();
      t.inf.prompt_tokens += f.usage?.prompt_tokens ?? 0; t.inf.completion_tokens += f.usage?.completion_tokens ?? 0;
      charge(t, "inference", `task:${t.id}:infer:${k}`, f.usage ? cost(b.model, f.usage) : held, { model: b.model, usage: f.usage });
    } finally { t.pending -= held; }
  }

  function stop(t, status, reason) {
    if (t.stopping) return;
    t.stopping = status; t.stopReason = reason;
    emit(t, "state", { state: "stopping", status, reason });
    t.exe?.write({ t: "pi", cmd: { type: "abort" } });
    t.exe?.write({ t: "finish", reason });
    t.kill = setTimeout(() => t.exe?.kill(), 20e3);
  }

  // Terminal, once: the last execution charge (never past the cap), the settle entry releasing the rest, the
  // terminal event, then the completion and bundle.
  async function finish(t, status, reason) {
    if (t.finishing) return;
    t.finishing = true;
    clearInterval(t.tick); clearTimeout(t.timer); clearTimeout(t.kill);
    const a = L.accounts.get(t.account);
    if (t.exe) {
      t.seconds = t.exe.seconds();
      const done = Math.floor(t.seconds / offer.tariff.interval_seconds);
      for (let k = 1; k <= done && t.charged + cfg.perSecond * offer.tariff.interval_seconds <= t.auth.cap; k++) charge(t, "execution", `task:${t.id}:exec:${k}`, cfg.perSecond * offer.tariff.interval_seconds);
      charge(t, "execution", `task:${t.id}:exec:final`, Math.min(t.auth.cap - t.charged, Math.round(cfg.perSecond * (t.seconds - done * offer.tariff.interval_seconds))));
    }
    const files = t.exe ? await t.exe.collect() : [];
    const guest = t.exe ? await t.exe.guest() : [];
    t.done = true;
    if (status !== "worker_lost") a.held -= t.auth.cap - t.charged;
    // The settle entry is the settlement: its exact ledger line's hash goes into the completion (and so the receipt).
    const settle = { ts: new Date().toISOString(), type: "task-settle", account: t.account, slice, idem: `task:${t.id}:settle`, task: t.id, reserved: t.auth.cap, charged: t.charged, released: t.auth.cap - t.charged, debits: [...t.ledger] };
    L.append(settle);
    t.settlement = { ledger: `peer ${peerId} slice ${slice}`, entry: settle.idem, entry_sha256: sha(JSON.stringify(settle)), reserved: settle.reserved, charged: settle.charged, released: settle.released, debits: settle.debits };
    t.ledger.push(`task:${t.id}:settle`);
    t.state = status;
    emit(t, "state", { state: status, reason, charged: t.charged, released: t.auth.cap - t.charged });
    const B = path.join(t.dir, "bundle");
    fs.mkdirSync(B, { recursive: true });
    for (const f of [...files.map((f) => ({ ...f, path: `outputs/${f.path}` })), ...guest]) { fs.mkdirSync(path.dirname(path.join(B, f.path)), { recursive: true }); fs.writeFileSync(path.join(B, f.path), f.data); }
    const receipts = guest.find((f) => f.path === "guest/receipts.jsonl")?.data.toString().split("\n").filter(Boolean) ?? [];
    const completion = { v: V, type: "completion", task_id: t.id, auth_hash: t.auth_hash, offer_id: offer.offer_id, inputs_root: t.auth.inputs_root,
      worker: { peer: peerId, operator: cfg.operator }, peer_evidence: evidence,
      guest: { image: offer.runtime.image, compose_hash: t.guestCompose ?? null, receipts: { count: receipts.length, head: receipts.length ? sha(receipts.at(-1)) : null } },
      status, reason, events: { count: t.events.length, head: t.events.at(-1).hash },
      outputs: files.map((f) => ({ path: f.path, sha256: sha(f.data), bytes: f.data.length })).sort((x, y) => x.path.localeCompare(y.path)),
      usage: usage(t), settlement: t.settlement, retention: { until: Date.now() + offer.persistence.retention_ms, delete: "automatic at until" } };
    check("completion", completion);
    const put = (p, x) => fs.writeFileSync(path.join(B, p), typeof x === "string" ? x : JSON.stringify(x, null, 1));
    put("offer.json", offer);
    fs.copyFileSync(path.join(t.dir, "authorization.json"), path.join(B, "authorization.json"));
    put("completion.json", completion);
    put("completion.sig", await sign(completionData(completion)));
    fs.copyFileSync(path.join(t.dir, "events.jsonl"), path.join(B, "events.jsonl"));
    const all = walk(B).map((f) => path.relative(B, f)).sort();
    put("bundle.json", { v: "abalone-task-bundle/1", task_id: t.id, files: Object.fromEntries(all.map((p) => [p, sha(fs.readFileSync(path.join(B, p)))])) });
    t.completion = completion;
    for (const w of t.watchers) w(null);
  }

  // A peer restart leaves no guest behind: a task without a completion becomes worker_lost, charged what the ledger holds.
  for (const id of fs.readdirSync(TASKS)) {
    const d = path.join(TASKS, id), au = JSON.parse(fs.readFileSync(path.join(d, "authorization.json"), "utf8")).authorization;
    const events = fs.existsSync(path.join(d, "events.jsonl")) ? fs.readFileSync(path.join(d, "events.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
    const debits = L.entries.filter((e) => e.type === "debit" && e.task === id);
    const t = { id, account: au.account, auth: au, auth_hash: h(au), dir: d, events, watchers: new Set(), created: events[0]?.ts ?? 0, control: "agent", charged: debits.reduce((s, e) => s + e.charge, 0),
      execCharge: debits.filter((e) => e.kind === "execution").reduce((s, e) => s + e.charge, 0), inf: { calls: 0, prompt_tokens: 0, completion_tokens: 0, charge: debits.filter((e) => e.kind === "inference").reduce((s, e) => s + e.charge, 0) }, ledger: debits.map((e) => e.idem), seconds: 0, pending: 0 };
    tasks.set(id, t);
    if (fs.existsSync(path.join(d, "bundle/completion.json"))) { t.completion = JSON.parse(fs.readFileSync(path.join(d, "bundle/completion.json"), "utf8")); t.state = t.completion.status; t.done = true; }
    else { t.state = "running"; finish(t, "worker_lost", "the worker restarted while the task ran").catch((e) => console.error(`task ${id}: ${e.message}`)); }
  }

  // /abalone/task/1: one signed request per stream.
  async function serveTask(lp, raw, recv) {
    const q = await recv();
    let a;
    // Every reply but an event carries the gift's balance left after reservations, so the client's display stays current.
    const send = (o) => raw(o.event || o.error ? o : { ...o, remaining: L.remaining(a) });
    try {
      a = verifyRequest(q);
      if (q.op === "commission") return send({ ok: true, ...(await serial(a.account, () => commission(q, a))) });
      if (q.op === "list") return send({ ok: true, tasks: [...tasks.values()].filter((t) => t.account === a.account).map(handle) });
      const t = mine(q);
      if (q.op === "status") return send({ ok: true, ...handle(t), usage: usage(t), completion: t.completion });
      if (q.op === "watch") {
        let open = true, chain = Promise.resolve();
        const out = (e) => (chain = chain.then(() => open && send(e ? { event: e } : { end: true, completion: t.completion })).catch(() => (open = false, t.watchers.delete(out))));
        for (const e of t.events.slice(Math.max(0, (q.body.from_seq ?? 1) - 1))) out(e);
        if (t.completion) return out(null), chain;
        t.watchers.add(out);
        await new Promise((r) => { const w = (e) => { if (!e) { t.watchers.delete(w); r(); } }; t.watchers.add(w); });
        t.watchers.delete(out);
        return chain;
      }
      if (q.op === "stop") { if (!t.done) stop(t, "cancelled", q.body.reason || "stopped by the client"); return send({ ok: true, ...handle(t) }); }
      if (q.op === "collect") {
        if (!t.completion) refuse("not_terminal", `The task is ${t.state}; results are collected after it ends.`);
        const B = path.join(t.dir, "bundle");
        return send({ ok: true, files: walk(B).sort().map((f) => ({ path: path.relative(B, f), b64: fs.readFileSync(f).toString("base64") })) });
      }
      if (t.done || t.stopping) refuse("terminal", `The task is ${t.stopping && !t.done ? "stopping" : t.state}.`);
      if (!t.ready) refuse("booting", "The task's guest is still starting. Send this again once it shows running.");
      if (q.op === "take") { if (t.control !== "human") { t.control = "human"; t.exe.write({ t: "pi", cmd: { type: "clear_queue" } }); t.exe.write({ t: "pi", cmd: { type: "abort" } }); emit(t, "control", { control: "human" }); } return send({ ok: true, control: t.control }); }
      if (q.op === "release") {
        if (t.control !== "agent") { t.control = "agent"; emit(t, "control", { control: "agent" }); if (!t.busy) { t.stopping = "completed"; t.stopReason = "control returned with the agent idle"; t.exe.write({ t: "finish", reason: t.stopReason }); } }
        return send({ ok: true, control: t.control });
      }
      if (q.op === "instruct" || q.op === "bash") {
        if (t.msgs.has(q.body.msg_id)) return send({ ok: true, accepted: true, seq: t.msgs.get(q.body.msg_id), repeated: true });
        if (q.op === "bash" && t.control !== "human") refuse("control", "Take control first (/take); the agent is in control.");
        const cmd = q.op === "bash" ? { type: "bash", command: q.body.command } : t.busy ? { type: q.body.mode === "follow_up" ? "follow_up" : "steer", message: q.body.text } : { type: "prompt", message: q.body.text };
        emit(t, q.op, q.op === "bash" ? { command: q.body.command } : { text: q.body.text, as: cmd.type });
        t.msgs.set(q.body.msg_id, t.events.length);
        t.exe.write({ t: "pi", cmd });
        return send({ ok: true, accepted: true, seq: t.events.length });
      }
      refuse("bad_op", `unknown op ${q.op}`);
    } catch (e) { await send({ error: { code: e.code ?? "internal", message: e.code ? e.message : `internal error (${e.name})` } }); if (!e.code) console.error(`task ${q?.op}: ${e.stack}`); }
  }
  return { offer, serveOffer: async (lp, send, recv) => { await recv(); await send({ offers: [offer] }); }, serveTask };
}
