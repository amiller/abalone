// The client side of abalone-task/1: read a worker's offer, commission a task paid from this computer's redeemed gift,
// watch and steer it, stop it, and collect its bundle. Records live in <STATE>/tasks/<task_id>/ (0700): the signed
// request (so a retry resends the same authorization), the last event seen, and the collected bundle.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { STATE, providers } from "./config.mjs";
import { coupon, fmt, sign } from "./gift.mjs";
import { V, h, requestMsg, check } from "./contracts/task-v1.mjs";
import { saveLeft } from "./peer.mjs";

const TASKS = path.join(STATE, "tasks");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const rec = (id) => path.join(TASKS, id, "record.json");
export const record = (id) => { if (!fs.existsSync(rec(id))) throw new Error(`No task ${id} on this computer (${TASKS}).`); return JSON.parse(fs.readFileSync(rec(id), "utf8")); };
const save = (r) => { fs.mkdirSync(path.dirname(rec(r.task_id)), { recursive: true, mode: 0o700 }); fs.writeFileSync(rec(r.task_id), JSON.stringify(r, null, 1), { mode: 0o600 }); };
export const records = () => fs.existsSync(TASKS) ? fs.readdirSync(TASKS).filter((d) => fs.existsSync(rec(d))).map(record) : [];
const gift = () => coupon() ?? (() => { throw new Error("No gift on this computer. Redeem one first: abalone redeem --peer <multiaddr> <code>"); })();

// One signed request on /abalone/task/1. Replies with {error} become errors naming the worker's reason.
export async function call(g, op, task_id, body = {}, idem = crypto.randomBytes(16).toString("hex"), onFrame) {
  const c = gift(), ts = String(Date.now());
  const q = { op, task_id, account: c.account, idem, ts, body, sig: sign(crypto.createPrivateKey(c.device_key), requestMsg(op, task_id, ts, idem, body)) };
  const f = await g.request("/abalone/task/1", q, (f) => {
    if (f.error) throw Object.assign(new Error(`${f.error.message} (${f.error.code})`), { code: f.error.code });
    if (f.remaining !== undefined) saveLeft(c.account, f.remaining);
    return onFrame ? onFrame(f) : true;
  });
  return f;
}

// The worker's offer, accepted only if it describes the peer this connection verified.
export async function offer(g) {
  const { offers } = await g.request("/abalone/offer/1", {});
  const o = check("offer", offers[0]);
  const ev = o.evidence, v = g.verdict;
  if (o.worker.peer !== g.peerId) throw new Error(`✗ refused: the offer names worker ${o.worker.peer}, but this connection verified ${g.peerId}`);
  const same = ev.type === "dev" ? v.tier === "dev" : ev.type === "macrunner" ? v.compose_hash === ev.compose_hash : ev.type === "appattest" && v.place.includes("App Attest probe");
  if (!same) throw new Error(`✗ refused: the offer claims ${JSON.stringify(ev)} evidence, but the handshake verified ${v.place}${v.compose_hash ? ` (compose ${v.compose_hash})` : ""}`);
  if (o.expiry < Date.now()) throw new Error("✗ refused: the worker's offer has expired");
  // A runner worker must name an admitted task image; a local: image is a development process, labelled as one.
  if (!o.runtime.image.startsWith("local:") && !providers().peers.admit.task.images.includes(/@(sha256:[0-9a-f]{64})$/.exec(o.runtime.image)?.[1])) throw new Error(`✗ refused: the worker's task image ${o.runtime.image} is not an admitted digest (providers.json peers.admit.task.images)`);
  if (o.runtime.image.startsWith("local:") && ev.type === "macrunner") throw new Error("✗ refused: a runner worker offers a development (local:) task image");
  return o;
}

// What the user is agreeing to, in the offer's own facts: who runs the worker, what a task can read, change, run and
// send, where inference happens, the price and what happens at the cap.
export function describe(o, v) {
  const t = o.tariff, r = o.resources[0], dev = o.runtime.image.startsWith("local:");
  return [`Worker   ${o.worker.label}; ${o.worker.operator === "owner-operated" ? "owner-operated (the person commissioning runs it)" : "independent (someone else runs it)"}; peer ${o.worker.peer.slice(0, 16)}…`,
    `         ${dev ? "Development worker: each task is a sandboxed process on the host, not a measured VM." : "Mac runner: each task gets a fresh VM from the measured runner."} Checked: ${v.place}${v.cdhash ? `, CDHash ${v.cdhash.slice(0, 12)}…` : ""}${v.compose_hash ? `, compose ${v.compose_hash.slice(0, 12)}…` : ""}.`,
    `Reads    only the files you send; it works on its own copy. Nothing else on your computer, and not this conversation.`,
    `Changes  only that copy. You get back a patch, the changed files and the check's output.`,
    `Runs     ${o.runtime.agent} with ${o.runtime.tools.join(", ")} (shell commands included) in ${o.runtime.image}; ${r.cpus} CPUs, ${r.mem_mb} MB, at most ${r.max_seconds / 60} min, enforced by ${r.enforced_by}.`,
    `Sends    nothing to the network (${o.network.egress.length ? o.network.egress.join(", ") : "no egress"}). Model calls: ${o.inference.models.join(", ")} via ${o.inference.route}.`,
    `Sees     ${o.inference.sees_plaintext.join(", ")} see the task's text in plaintext; the worker's owner can see its files, commands and model traffic. It takes ${o.accepts.join(" and ")} files only.`,
    `Price    execution ${fmt(t.execution_per_second * 3600)}/h (${t.execution_per_second} µ$/s, charged every ${t.interval_seconds} s), model calls at ${t.inference}, storage free${t.sponsored ? ". SPONSORED development offer: not paid execution" : ""}.`,
    `At cap   the worker stops the task before any charge would pass your cap. You pay what was used; the rest of the reservation returns to your gift.`,
    `Keeps    events and results ${Math.round(o.persistence.retention_ms / 3600e3)} h at the worker; your copy in ${TASKS}. ${o.persistence.continuation[0].toUpperCase() + o.persistence.continuation.slice(1)}.`].join("\n");
}
// The authorization about to be signed, in plain terms.
export const authorizing = (au, o) => [`Authorize task ${au.task_id} on ${o.worker.label}:`,
  `  "${au.task.prompt}"`,
  `  files  ${au.inputs.length} as ${[...new Set(au.inputs.map((i) => i.label))].join("/")}, ${au.inputs.reduce((s, i) => s + i.bytes, 0)} bytes: ${au.inputs.slice(0, 8).map((i) => i.path).join(", ")}${au.inputs.length > 8 ? ", …" : ""}`,
  `  model  ${au.model}; tools ${au.capabilities.tools.join(", ")}; network none${au.task.check ? `; afterwards the worker runs: ${au.task.check}` : ""}`,
  `  cap    ${fmt(au.cap)} reserved from your gift now; valid until ${new Date(au.expires).toLocaleTimeString()}`].join("\n");

const files = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== ".git").flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name), base) : [path.join(dir, e.name)]);

// Commission: the authorization names this worker, its offer, the files (by hash) and the cap. Only these leave.
// authorize() builds the authorization and upload without sending anything (a preview shows it); commission() sends it.
export function authorize(o, { prompt, repo, label, cap, check: chk, model = o.inference.models[0], minutes = 60 }) {
  const c = gift(), name = path.basename(path.resolve(repo));
  const blobs = files(path.resolve(repo)).sort().map((f) => ({ path: `${name}/${path.relative(path.resolve(repo), f)}`, data: fs.readFileSync(f) }));
  const inputs = blobs.map((b) => ({ path: b.path, sha256: sha(b.data), bytes: b.data.length, label }));
  const authorization = { v: V, type: "authorization", task_id: crypto.randomBytes(16).toString("hex"), account: c.account, device: c.device, worker: o.worker.peer, offer_id: o.offer_id, tariff_version: o.tariff.version,
    task: { prompt, resource: o.resources[0].id, ...(chk && { check: chk }) }, inputs, inputs_root: h(inputs), model, capabilities: { tools: o.runtime.tools, egress: [] }, cap, expires: Date.now() + minutes * 60e3, ts: Date.now() };
  check("authorization", authorization);
  return { authorization, body: { authorization, inputs: blobs.map((b) => ({ path: b.path, b64: b.data.toString("base64") })) } };
}
export async function commission(g, o, opts) {
  const { authorization, body } = authorize(o, opts);
  save({ task_id: authorization.task_id, peer: gift().peer, offer: o, body, last_seq: 0 });
  return { authorization, handle: await call(g, "commission", authorization.task_id, body, authorization.task_id) };
}
// Retry: the stored body again under the same idempotency key; the worker answers with the existing task.
export const retry = (g, id) => call(g, "commission", id, record(id).body, id);

const line = (e) => {
  const d = e.data;
  if (e.kind === "state") return `● ${d.state}${d.reason ? `: ${d.reason}` : ""}${d.charged !== undefined ? ` (charged ${fmt(d.charged)}, released ${fmt(d.released)})` : ""}${d.cap ? ` (cap ${fmt(d.cap)} reserved)` : ""}`;
  if (e.kind === "charge") return d.kind === "inference" || d.charged + 1e4 > d.cap ? `  $ ${d.kind} ${fmt(d.amount)}, ${fmt(d.charged)} of ${fmt(d.cap)}` : null;
  if (e.kind === "control") return `● control: ${d.control === "human" ? "you (the agent is paused)" : "the agent"}`;
  if (e.kind === "instruct") return `› you: ${d.text}`;
  if (e.kind === "bash") return `› you $ ${d.command}`;
  if (e.kind === "error") return `✗ ${d.message}`;
  if (d.kind === "assistant") return d.text || d.error ? `agent: ${d.text}${d.error ? ` ✗ ${d.error}` : ""}` : null;
  if (d.kind === "tool_start") return `  ▸ ${d.tool} ${JSON.stringify(d.args).slice(0, 160)}`;
  if (d.kind === "tool_end") return `    ${d.error ? "✗ " : ""}${d.result.trim().split("\n").slice(0, 6).join("\n    ")}`;
  if (d.kind === "response" && d.command === "bash") return `    ${String(d.output ?? "").trim().split("\n").slice(0, 12).join("\n    ")}${d.exit !== undefined ? `\n    exit ${d.exit}` : ""}`;
  return null;
};

// Watch from the last event this computer saw, printing as it goes. Resolves with the completion, or on detach.
export async function watch(g, id, out = console.log) {
  const r = record(id);
  if (r.last_seq) out(`(reconnected: ${r.last_seq} events seen before, continuing from ${r.last_seq + 1})`);
  let completion = null;
  await call(g, "watch", id, { from_seq: r.last_seq + 1 }, undefined, (f) => {
    if (f.end) { completion = f.completion; return true; }
    const l = line(f.event);
    if (l) out(l);
    r.last_seq = f.event.seq; save(r);
  });
  return completion;
}

// Live attachment: events stream in; the user's lines go to the same task.
//   text → steer (or a new prompt when the agent is idle)   /take /release   /bash <cmd>   /stop   /status   /detach
export async function attach(g, id) {
  const rl = readline.createInterface({ input: process.stdin });
  let detached = false;
  const done = new Promise((resolve) => rl.on("line", async (l) => {
    l = l.trim();
    if (!l) return;
    try {
      if (l === "/detach") { detached = true; console.log("Detached. The task keeps running at the worker; abalone tasks attach " + id + " reconnects."); return resolve(); }
      if (l === "/take" || l === "/release") return console.log(`control: ${(await call(g, l.slice(1), id)).control}`);
      if (l === "/stop") return await call(g, "stop", id, { reason: "stopped by the client" }, `stop:${id}`);
      if (l === "/status") { const s = await call(g, "status", id); return console.log(`${s.state}, control ${s.control}, charged ${fmt(s.usage.charged)} of ${fmt(s.usage.cap)} (execution ${fmt(s.usage.execution.charge)}, inference ${fmt(s.usage.inference.charge)})`); }
      const msg_id = crypto.randomBytes(8).toString("hex");
      if (l.startsWith("/bash ")) return await call(g, "bash", id, { msg_id, command: l.slice(6) });
      await call(g, "instruct", id, { msg_id, text: l, mode: "steer" });
    } catch (e) { console.log(`✗ ${e.message}`); }
  }));
  const completion = await Promise.race([watch(g, id), done]);
  rl.close();
  if (detached || !completion) return null;
  return completion;
}

// Collect: the bundle, written under <STATE>/tasks/<id>/bundle/, with its own hashes checked. This is an integrity
// check of what arrived; the receipt verifier is what checks the worker's signature and evidence.
export async function collect(g, id) {
  const { files: fl } = await call(g, "collect", id);
  const B = path.join(TASKS, id, "bundle");
  for (const f of fl) { fs.mkdirSync(path.dirname(path.join(B, f.path)), { recursive: true }); fs.writeFileSync(path.join(B, f.path), Buffer.from(f.b64, "base64")); }
  const index = JSON.parse(fs.readFileSync(path.join(B, "bundle.json"), "utf8")), c = JSON.parse(fs.readFileSync(path.join(B, "completion.json"), "utf8"));
  for (const [p, s] of Object.entries(index.files)) if (sha(fs.readFileSync(path.join(B, p))) !== s) throw new Error(`✗ bundle file ${p} does not match bundle.json`);
  for (const o of c.outputs) if (sha(fs.readFileSync(path.join(B, "outputs", o.path))) !== o.sha256) throw new Error(`✗ output ${o.path} does not match the completion`);
  if (c.task_id !== id || c.auth_hash !== h(record(id).body.authorization)) throw new Error("✗ the bundle is for a different task or authorization");
  return { dir: B, completion: c };
}

export function summary(c, dir) {
  const u = c.usage;
  return [`Task ${c.task_id}: ${c.status}${c.reason ? ` (${c.reason})` : ""}`,
    `${u.sponsored ? "Sponsored development run (zero-priced execution)" : "Paid (gift credit)"}. Charged ${fmt(u.charged)} of the ${fmt(u.cap)} cap: execution ${fmt(u.execution.charge)} for ${u.execution.seconds} s, inference ${fmt(u.inference.charge)} for ${u.inference.calls} calls; released ${fmt(u.released)}${u.sponsored ? " (sponsored development offer)" : ""}. Settled in the worker's ledger: ${u.settled ? "yes" : "no"}.`,
    ...(c.settlement ? [`Settlement: ${c.settlement.entry} in ${c.settlement.ledger}, line ${c.settlement.entry_sha256.slice(0, 16)}…: reserved ${fmt(c.settlement.reserved)}, charged ${fmt(c.settlement.charged)}, released ${fmt(c.settlement.released)}`] : []),
    `Outputs: ${c.outputs.map((o) => `${o.path} (${o.bytes} B)`).join(", ") || "none"}`,
    ...(dir ? [`Bundle: ${dir}  (offline check: the receipt verifier)`] : [])].join("\n");
}
