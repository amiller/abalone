// A stand-in for the Mac runner's guest socket (notes/abalone-node-interface.md in edge-tee), for tests on Linux:
//   POST runner.local/attest  → {type: "dev", assertClientData} with a stub compose hash, written to <dir>/compose
//                               (no App Attest here, so clients must admit dev peers)
//   POST runner.local/key     → HKDF(master, "mac-compose-get-key/1|" + path), master in <dir>/master (stable)
//   GET  runner.local/provider-quote?host=cloud-api.near.ai → the exact NEAR report bytes it fetched (model STUB_MODEL)
//   CONNECT host:port         → raw TCP tunnel
//   runner.local/task/{start,status,stop,collect} and CONNECT task-<id>.runner.local:1
//                             → the task API of docs/protocols/runner-task.md, with bin/task-guest.mjs run as a
//                               plain local process (no VM, no isolation, no receipts: guest/ holds only app-compose.json)
//   anything else             → forwarded to https://<Host><path>; the NEAR key from the node keystore is injected
//                               (chat requests reserve max_tokens from a per-boot budget of STUB_BUDGET tokens, default
//                               200000, and are refused 402 "exceeds remaining per-boot budget" past it, as the runner),
//                               unless <dir>/refuse names that path: then 502 text/plain "runner refused: …", as the real runner
// STUB_DROP_FIRST=N closes the first N guest connections with zero bytes, like Apple's relay during a task VM boot.
// usage: node stub-runner.mjs <socket path> <dir>. Every forwarded request is appended to <dir>/proxy.jsonl.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { tarPack, tarUnpack } from "../../lib/task.mjs";
const [sock, dir] = process.argv.slice(2);
const store = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".abalone/node/keys.json"), "utf8"));
const KEY = store.keys.find((k) => k.provider === "nearai" && k.label === store.active.nearai).key;
const masterFile = path.join(dir, "master");
if (!fs.existsSync(masterFile)) fs.writeFileSync(masterFile, crypto.randomBytes(32), { mode: 0o600 });
const master = fs.readFileSync(masterFile);
const log = (e) => fs.appendFileSync(path.join(dir, "proxy.jsonl"), JSON.stringify(e) + "\n");
let quote, budget = Number(process.env.STUB_BUDGET ?? 200000);
const COMPOSE = "stub-compose-" + crypto.createHash("sha256").update(master).digest("hex").slice(0, 16);
fs.writeFileSync(path.join(dir, "compose"), COMPOSE);
// One stub process is one guest boot: its boot data carries a fresh nonce, as the runner's does.
const BOOT = Buffer.from(JSON.stringify({ compose_hash: COMPOSE, domain: "mac-compose-boot/1", nonce: crypto.randomBytes(16).toString("hex") })).toString("base64");
// Like the real runner, one request per connection: every response closes its connection.
const server = http.createServer(async (req, res) => {
  res.shouldKeepAlive = false;
  const body = await new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (req.headers.host === "runner.local") {
    if (u.pathname === "/attest") return res.end(JSON.stringify({ type: "dev", bootClientData: BOOT, assertClientData: Buffer.from(JSON.stringify({ compose_hash: COMPOSE, data: JSON.parse(body).data, domain: "mac-compose-assert/1" })).toString("base64") }));
    if (u.pathname === "/key") return res.end(JSON.stringify({ key: Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), `mac-compose-get-key/1|${JSON.parse(body).path}`, 32)).toString("hex") }));
    if (u.pathname === "/provider-quote") {
      quote ??= fetch(`https://cloud-api.near.ai/v1/attestation/report?model=${encodeURIComponent(process.env.STUB_MODEL ?? "z-ai/glm-5.3-flash")}&nonce=${crypto.randomBytes(32).toString("hex")}&signing_algo=ecdsa&include_tls_fingerprint=true`, { headers: { authorization: `Bearer ${KEY}` } }).then((r) => r.text());
      return res.end(await quote);
    }
    if (u.pathname.startsWith("/task/")) return task(u, body, res);
    res.writeHead(404); return res.end();
  }
  log({ host: req.headers.host, method: req.method, path: u.pathname, auth_from_guest: !!req.headers.authorization });
  const refuse = path.join(dir, "refuse");
  if (fs.existsSync(refuse) && fs.readFileSync(refuse, "utf8").trim() === u.pathname) { res.writeHead(502, { "content-type": "text/plain" }); return res.end("runner refused: provider quote for cloud-api.near.ai not verified: HTTP 401\n"); }
  if (u.pathname === "/v1/chat/completions") {
    const want = JSON.parse(body).max_tokens ?? JSON.parse(body).max_completion_tokens ?? 0;
    if (want > budget) { res.writeHead(402, { "content-type": "text/plain" }); return res.end(`runner refused: max_tokens ${want} exceeds remaining per-boot budget ${budget}\n`); }
    budget -= want;
  }
  const headers = { ...req.headers };
  delete headers.host; delete headers["content-length"]; delete headers.connection;
  if (req.headers.host === "cloud-api.near.ai") headers.authorization = `Bearer ${KEY}`;
  const r = await fetch(`https://${req.headers.host}${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
  const h = Object.fromEntries(r.headers);
  delete h["content-length"]; delete h["content-encoding"]; delete h["transfer-encoding"];
  res.writeHead(r.status, h);
  if (r.body) for await (const c of r.body) res.write(c);
  res.end();
});
// Task guests: started on /task/start, their stdout buffered until a CONNECT attaches.
const tasks = new Map();
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
function task(u, body, res) {
  const q = u.searchParams.get("id") ?? (body.length ? JSON.parse(body).task_id : null), t = tasks.get(q), json = (o, st = 200) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (u.pathname === "/task/start") {
    const b = JSON.parse(body), bytes = JSON.stringify(b.compose), compose_hash = crypto.createHash("sha256").update(bytes).digest("hex");
    if (t) return t.compose_hash === compose_hash ? json({ task_id: q, compose_hash, state: t.state }) : json({ error: "task_id reused with another compose" }, 409);
    const d = path.join(dir, "tasks", q);
    for (const f of tarUnpack(Buffer.from(b.inputs_tar_b64, "base64"))) { fs.mkdirSync(path.dirname(path.join(d, "in", f.path)), { recursive: true }); fs.writeFileSync(path.join(d, "in", f.path), f.data); }
    for (const n of ["out", "work", "state", "guest"]) fs.mkdirSync(path.join(d, n), { recursive: true });
    fs.writeFileSync(path.join(d, "guest/app-compose.json"), bytes);
    const p = spawn(process.execPath, [path.resolve(import.meta.dirname, "../../bin/task-guest.mjs")], { env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TASK_IN: path.join(d, "in"), TASK_OUT: path.join(d, "out"), TASK_WORK: path.join(d, "work"), TASK_STATE: path.join(d, "state") }, stdio: ["pipe", "pipe", "inherit"] });
    const nt = { compose_hash, d, p, state: "running", t0: Date.now(), buf: [], sock: null };
    p.stdout.on("data", (x) => nt.sock ? nt.sock.write(x) : nt.buf.push(x));
    p.on("exit", (code) => { nt.state = nt.stopped ? "stopped" : "exited"; nt.exit_code = code; nt.wall = (Date.now() - nt.t0) / 1000; nt.sock?.end(); });
    tasks.set(q, nt);
    return json({ task_id: q, compose_hash, state: "booting" });
  }
  if (!t) return json({ error: `no task ${q}` }, 404);
  if (u.pathname === "/task/status") return json({ state: t.state, started_at: t.t0, wall_seconds: t.wall ?? (Date.now() - t.t0) / 1000, exit_code: t.exit_code ?? null, reason: t.stopped ? "stopped" : null });
  if (u.pathname === "/task/stop") { t.stopped = true; setTimeout(() => t.p.kill("SIGKILL"), JSON.parse(body).grace_seconds * 1000); t.p.kill("SIGTERM"); return json({ ok: true }); }
  if (u.pathname === "/task/collect") {
    if (t.state === "running") return json({ error: "still running" }, 409);
    // As the runner: one tar, guest/ entries then out/ entries; the /out tar alone is its suffix.
    const files = ["guest", "out"].flatMap((n) => walk(path.join(t.d, n)).map((f) => ({ path: path.relative(t.d, f), data: fs.readFileSync(f) })).sort((a, b) => a.path.localeCompare(b.path)));
    res.writeHead(200, { "content-type": "application/x-tar" }); return res.end(tarPack(files));
  }
  json({ error: "unknown task route" }, 404);
}
server.on("connect", (req, client, head) => {
  const [host, port] = req.url.split(":");
  const tm = /^task-([0-9a-f]{32})\.runner\.local$/.exec(host);
  if (tm) {
    const t = tasks.get(tm[1]);
    if (!t || t.sock) { client.end("HTTP/1.1 409 Conflict\r\n\r\n"); return; }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    t.sock = client; for (const x of t.buf.splice(0)) client.write(x);
    if (head.length) t.p.stdin.write(head);
    client.pipe(t.p.stdin, { end: false });
    client.on("close", () => { t.sock = null; }); client.on("error", () => {});
    if (t.state !== "running") client.end();
    return;
  }
  log({ connect: req.url });
  const up = net.connect(Number(port), host, () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) up.write(head); up.pipe(client).pipe(up); });
  up.on("error", () => client.destroy()); client.on("error", () => up.destroy());
});
let drops = Number(process.env.STUB_DROP_FIRST ?? 0);
server.on("connection", (s) => { if (drops > 0) { drops--; log({ dropped: "zero-byte close" }); s.destroy(); } });
fs.rmSync(sock, { force: true });
server.listen(sock, () => console.log(`stub runner on ${sock}`));
