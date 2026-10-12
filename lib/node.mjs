// abalone peer serve: one full gift peer. It holds this machine's configured NEAR key, keeps the ledger for its
// slice of each gift, and forwards device-signed requests to NEAR over its own attested, SPKI-pinned channel.
// Transport is libp2p (lib/p2p.mjs); this file is the peer's request handling.
// Ledger: <dir>/ledger.jsonl, append-only, replayed at start. Every durable change (fund, claim, debit) is appended
// before it is acknowledged. A gift reaches the peer only at redeem, as the issuer-signed grant carried with the code;
// the peer claims it against its reserve (the prepaid credit declared with --reserve). Balances are kept per (account, slice), and this peer serves only the slice it
// owns (its slice key), so moving balance between peers can be added without changing existing entries.
// One process (a lock file in the ledger dir), one event loop, and requests serialized per account: two copies of a
// peer or two concurrent requests cannot both spend the same balance. Holds for in-flight requests live
// in memory; a peer that dies mid-request records no debit for it (the friend is not charged; the funder absorbs it).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PEER_DIR, providers } from "./config.mjs";
import { account, fmt, pubHex, requestMsg, sha, verify } from "./gift.mjs";
import { checkReport, reportNonce, verifyNearModel, withKey } from "./near.mjs";
import { evidenceSource, servePeer } from "./p2p.mjs";
import { loopbackTo, onlyThroughRunner, runnerFetch, runnerJson } from "./macrunner.mjs";
import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { ChainError, registry } from "./chain.mjs";
import { taskService } from "./task.mjs";

// With a chain (contracts/src/CouponRegistry.sol), every claim and every spending window is checkpointed before the
// peer acts on it: the snapshot (all ledger entries, encrypted to this peer's slice key) rides in calldata, and the
// peer waits for the safe head. A window lets an account spend up to WINDOW past its last checkpoint; a restart
// restores the last checkpoint and writes off each open window in full, so no account is ever served past its amount.
// When half a window is spent, the next one is checkpointed in the background, so the safe-head delay does not
// stall a turn; a turn that outruns its renewal waits, showing "confirming credit", and is never served beyond it.
// ABALONE_WINDOW_MICRO overrides the window size (tests).
const WINDOW = Number(process.env.ABALONE_WINDOW_MICRO ?? 250000); // µ$
// Optimistic first window: once a claim's checkpoint is included (the unsafe head), the peer serves up to OPTIMISTIC
// at its own risk while the claim waits for the safe head. If the claim is lost (a reorg, or another peer's claim
// lands first), the peer stops serving that account; its loss is what it served, at most OPTIMISTIC per lost race,
// and nothing beyond what was served is charged to the issuer's credit.
const OPTIMISTIC = 50000; // µ$

const ed25519FromSeed = (hex) => crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(hex, "hex")]), format: "der", type: "pkcs8" });

const FORWARD = ["content-type", "x-signing-algo", "x-client-pub-key", "x-model-pub-key"];

class Refusal extends Error { constructor(status, message) { super(message); this.status = status; } }
const refuse = (status, message) => { throw new Refusal(status, message); };
// Request bodies carry gift codes and device signatures: a parse error must never echo them (V8 quotes its input).
const json = (body) => { try { return JSON.parse(body); } catch { refuse(400, "malformed JSON body"); } };
const nearCfg = () => providers().admitted.find((a) => a.id === "nearai");
const deviceAuth = (req, bodyHash) => ({ account: req.headers["x-abalone-account"], ts: req.headers["x-abalone-ts"], idem: req.headers["x-abalone-idem"] ?? "", sig: req.headers["x-abalone-sig"] ?? "", method: req.method, url: req.url, bodyHash });

export function ledger(dir, slice) {
  const LEDGER = path.join(dir, "ledger.jsonl");
  const L = { funded: 0, accounts: new Map(), done: new Map(), entries: [] };
  L.apply = (e) => {
    L.entries.push(e);
    if (e.type === "window") L.accounts.get(e.account).covered = e.covered;
    if (e.type === "lost") L.accounts.get(e.account).lost = true;
    if (e.type === "fund") L.funded += e.amount;
    if (e.type === "claim") L.accounts.set(e.account, { account: e.account, slice: e.slice, amount: e.amount, expiry: e.expiry, from: e.from, device: e.device, spent: 0, held: 0, covered: Infinity });
    if (e.type === "debit") { L.accounts.get(e.account).spent += e.charge; L.done.set(`${e.account}:${e.idem}`, e); }
  };
  L.append = (e) => { e = { ts: new Date().toISOString(), ...e }; fs.appendFileSync(LEDGER, JSON.stringify(e) + "\n"); L.apply(e); };
  L.file = LEDGER;
  // A gift commits its full amount until it expires, then only what it spent.
  L.committed = () => [...L.accounts.values()].reduce((s, a) => s + (a.expiry < Date.now() || a.lost ? a.spent : a.amount), 0);
  L.available = () => L.funded - L.committed();
  L.remaining = (a) => a.amount - a.spent - a.held;
  fs.mkdirSync(path.join(dir, "responses"), { recursive: true, mode: 0o700 });
  if (fs.existsSync(LEDGER)) for (const l of fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean)) L.apply(JSON.parse(l));
  for (const a of L.accounts.values()) if (a.slice !== slice) throw new Error(`ledger ${LEDGER} holds a slice of another peer (${a.slice.slice(0, 12)}…)`);
  return L;
}

// Forward one chat body to NEAR and stream the reply to the client while keeping a copy.
// Returns null (after passing NEAR's error through) on a non-200, else { usage, raw }.
// With a key: over this peer's SPKI-pinned channel. Under the Mac runner (no key here): through the runner's proxy,
// which injects the key and pins NEAR's TLS itself.
async function forward(channel, key, req, res, body, model, web) {
  const headers = key ? { authorization: `Bearer ${key}` } : {};
  for (const h of FORWARD) if (req.headers[h]) headers[h] = req.headers[h];
  const v = await channel(model), url = `${nearCfg().baseUrl}/chat/completions`;
  const r = key ? await v.transport.fetch(url, { method: "POST", headers, body }) : await web(url, { method: "POST", headers, body });
  if (!r.ok) {
    if (res.headersSent) { res.destroy(); return null; } // a "confirming credit" turn already answered 200
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" }); res.end(await r.text()); return null;
  }
  if (!res.headersSent) res.writeHead(200, { "content-type": "text/event-stream" });
  const chunks = [];
  let usage = null;
  for await (const c of r.body) { chunks.push(Buffer.from(c)); res.write(c); }
  const raw = Buffer.concat(chunks);
  for (const l of raw.toString().split("\n")) if (l.startsWith("data: {")) usage = JSON.parse(l.slice(6)).usage ?? usage;
  return { usage, raw };
}
const trailer = (s) => `: abalone-charge ${JSON.stringify(s)}\n\n`;

// Until chain checkpoints exist the ledger file is the only record of claims and spending, so it must survive a
// restart: a lost ledger lets a claimed gift be claimed again. Under the runner the guest rootfs is per boot; the
// runner's persistent volume (an ext4 image per compose hash) carries a marker holding that compose hash, and the
// ledger dir must hold a marker matching the compose hash the runner attests. Elsewhere a RAM filesystem is refused. Rollback stays possible: the owner can restore an older
// ledger and re-spend what was spent since. Accepted at gift size; checkpoints are what will bound it.
export const PERSISTENT_MARKER = ".abalone-persistent";
const RAMFS = [0x01021994, 0x858458f6]; // tmpfs, ramfs
async function persistentLedger(dir, runner) {
  if (runner) {
    const marker = path.join(dir, PERSISTENT_MARKER);
    const compose = JSON.parse(Buffer.from((await runnerJson("/attest", { data: "abalone-ledger-check" })).assertClientData, "base64")).compose_hash;
    const found = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : null;
    if (found !== compose) throw new Error(`✗ refused: ledger ${dir} is not the runner's persistent volume for compose ${compose} (${PERSISTENT_MARKER}: ${found ?? "missing"}); without it a reboot would forget every claim`);
  }
  else if (RAMFS.includes(fs.statfsSync(dir).type)) throw new Error(`✗ refused: ledger ${dir} is on a RAM filesystem; a restart would forget every claim`);
}

export async function serve({ key, label, issuer, model, dir = PEER_DIR, listen, relays, evidence, reserve, chain, tasks }) {
  if (tasks && chain) throw new Error("--tasks with --chain is not built: task charges do not wait for spending windows");
  // Runner mode: the guest has no NIC and no provider key. Every HTTP fetch (NEAR, NRAS, Intel PCS) goes through the
  // runner's proxy, relays through CONNECT tunnels, and the peer and slice keys come from the runner's sealed key
  // (stable across boots of the same CDHash and compose; a new runner build or compose is a new PeerId).
  const runner = evidence.kind === "macrunner";
  let privateKey;
  if (runner) {
    if (key) throw new Error("--evidence macrunner takes no provider key: the runner injects it");
    // Every fetch below is the explicit runnerFetch (lib/near.mjs gives @phala/dcap-qvl its own copy bound to it), and
    // anything else that tries the network throws.
    onlyThroughRunner();
    privateKey = await generateKeyPairFromSeed("Ed25519", Buffer.from((await runnerJson("/key", { path: "abalone/peer" })).key, "hex"));
    relays = await Promise.all(relays.map(async (r) => {
      const [hp, host, port] = /^\/ip4\/([^/]+)\/tcp\/(\d+)/.exec(r) ?? [];
      if (!hp) throw new Error(`relay ${r} must start /ip4/<addr>/tcp/<port>`);
      return r.replace(hp, `/ip4/127.0.0.1/tcp/${await loopbackTo(host, Number(port))}`);
    }));
    listen = [];
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!chain) await persistentLedger(dir, runner); // with a chain, the last checkpoint is the record
  // Two live copies sharing one reserve would break the no-overspend claim.
  // One live peer per ledger. Under the runner the guest is always PID 1 and the volume can be attached to one VM only,
  // so the lock holds the boot nonce the runner attests: another boot takes over (a crash or hard stop), the same boot
  // means a second process here and is refused. Elsewhere it holds the PID, and a holder that no longer exists is taken
  // over (Node has no flock(2); kill(pid, 0) gives the same "a dead process releases it" without a helper process).
  const lock = path.join(dir, "peer.lock");
  const me = runner ? { boot: JSON.parse(Buffer.from((await runnerJson("/attest", { data: "abalone-ledger-lock" })).bootClientData, "base64")).nonce } : { pid: process.pid };
  if (runner && !me.boot) throw new Error("✗ refused: the runner's boot data carries no nonce to lock the ledger with");
  const alive = (h) => { try { process.kill(h.pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
  if (fs.existsSync(lock)) {
    const held = JSON.parse(fs.readFileSync(lock, "utf8"));
    if (runner ? !held.boot || held.boot === me.boot : !held.pid || alive(held)) throw new Error(`✗ refused: another peer holds ${lock} (${JSON.stringify(held)}), and it is ${runner ? (held.boot ? "this same boot" : "not a runner boot") : held.pid ? "still running" : "a runner boot, whose liveness cannot be judged here"}`);
    console.error(`peer: taking over ${lock} from ${JSON.stringify(held)} (${runner ? "an earlier boot" : "no longer running"})`);
  }
  fs.writeFileSync(lock, JSON.stringify(me), { mode: 0o600, flag: fs.existsSync(lock) ? "w" : "wx" });
  process.on("exit", () => fs.rmSync(lock, { force: true }));
  for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => process.exit(0));
  // The slice key names this peer's slices in the ledger (and is what will sign Move acknowledgements).
  const sliceFile = path.join(dir, "slice.key");
  if (!runner && !fs.existsSync(sliceFile)) fs.writeFileSync(sliceFile, crypto.generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
  const slice = pubHex(runner ? ed25519FromSeed((await runnerJson("/key", { path: "abalone/slice" })).key) : crypto.createPrivateKey(fs.readFileSync(sliceFile)));
  // The chain identity, and the snapshot key (derived from the slice key, so a restarted peer can read its snapshots).
  const ethFile = path.join(dir, "eth.key");
  if (chain && !runner && !fs.existsSync(ethFile)) fs.writeFileSync(ethFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  const reg = chain && registry({ ...chain, key: runner ? (await runnerJson("/key", { path: "abalone/eth" })).key : fs.readFileSync(ethFile, "utf8") });
  const snapKey = crypto.hkdfSync("sha256", Buffer.from(runner ? (await runnerJson("/key", { path: "abalone/slice" })).key : fs.readFileSync(sliceFile)), Buffer.alloc(0), "abalone-snapshot/1", 32);
  const seal = (entries) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", Buffer.from(snapKey), iv); const ct = Buffer.concat([c.update(JSON.stringify(entries)), c.final()]); return Buffer.concat([iv, ct, c.getAuthTag()]); };
  const unseal = (b) => { const d = crypto.createDecipheriv("aes-256-gcm", Buffer.from(snapKey), b.subarray(0, 12)); d.setAuthTag(b.subarray(b.length - 16)); return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString()); };
  let n = 0n;
  if (reg) {
    if (!(await reg.isPeer())) throw new Error(`✗ refused: this peer's chain address ${reg.address} is not registered in ${chain.address}`);
    const last = await reg.lastSnapshot();
    if ((await reg.n("latest")) !== (last?.n ?? 0n)) throw new Error("✗ refused: the chain has a checkpoint of this peer newer than the safe head; start again once it is safe");
    // Restore: the ledger is exactly the last checkpoint, plus a write-off of every open window.
    if (fs.existsSync(path.join(dir, "ledger.jsonl"))) fs.renameSync(path.join(dir, "ledger.jsonl"), path.join(dir, `ledger.jsonl.before-restore-${Date.now()}`));
    if (last) { n = last.n; fs.writeFileSync(path.join(dir, "ledger.jsonl"), unseal(last.snapshot).map((e) => JSON.stringify(e) + "\n").join(""), { mode: 0o600 }); }
  }
  // The PeerId must outlive a restart (coupons name it): under the runner it comes from /key; otherwise from a seed here.
  const seedFile = path.join(dir, "peer.seed");
  if (!runner && !fs.existsSync(seedFile)) fs.writeFileSync(seedFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  if (!runner) privateKey = await generateKeyPairFromSeed("Ed25519", Buffer.from(fs.readFileSync(seedFile, "utf8"), "hex"));
  const L = ledger(dir, slice);
  if (reg) for (const a of L.accounts.values()) if (a.covered > a.spent && a.covered !== Infinity)
    L.append({ type: "debit", account: a.account, slice, idem: `writeoff-${n}`, model: null, usage: null, charge: a.covered - a.spent, hold: a.covered - a.spent, writeoff: true });
  // One checkpoint at a time. BadN means another copy of this peer moved n: take the restart path, never retry.
  // Sends go one at a time (n and the nonce are sequential); waiting for the safe head happens outside the queue.
  let ckq = Promise.resolve();
  const send = (pending, claims = []) => (ckq = ckq.catch(() => {}).then(async () => {
    try { const s = await reg.send(n + 1n, seal([...L.entries, ...pending]), claims); n += 1n; return s; }
    catch (e) {
      if (e instanceof ChainError && e.name === "BadN") { console.error(`restart: checkpoint ${n + 1n} was refused (BadN): another copy of this peer has checkpointed; exiting so a restart restores from the chain`); process.exit(3); }
      throw e;
    }
  }));
  const checkpoint = async (pending, claims = []) => reg.confirm(await send(pending, claims), claims);
  if (reserve < L.funded) throw new Error(`--reserve ${fmt(reserve)} is below the ${fmt(L.funded)} already recorded in this ledger`);
  if (reserve > L.funded) L.append({ type: "fund", amount: reserve - L.funded, provider: "nearai", key: label });
  const RESP = path.join(dir, "responses");
  const cfg = nearCfg();
  const web = runner ? runnerFetch : fetch;
  const prices = new Map((await (await web(`${cfg.baseUrl}/models`)).json()).data.map((m) => [m.id, { in: m.pricing.input, out: m.pricing.output, maxOut: m.max_output_length ?? 32768 }]));
  if (!prices.has(model)) throw new Error(`default model ${model} is not in NEAR's model list`);
  const verified = new Map();
  const channel = (m) => {
    if (!verified.has(m)) verified.set(m, (runner ? viaRunner(m) : verifyNearModel(cfg.baseUrl, m, withKey(cfg.baseUrl, key), cfg.policy)).catch((e) => { verified.delete(m); throw new Refusal(502, e.message); }));
    return verified.get(m);
  };
  // Under the runner this peer still verifies NEAR itself (its own nonce, through the proxy) and encrypts to the TEE
  // key it verified. It cannot pin NEAR's TLS (the runner terminates it to inject the key), so it also verifies the
  // exact report the runner pinned against and requires the same TEE signing key and TLS fingerprint in both.
  async function viaRunner(m) {
    const v = await verifyNearModel(cfg.baseUrl, m, (p) => web(new URL(cfg.baseUrl).origin + p), cfg.policy, web);
    const r = await web(`http://runner.local/provider-quote?host=${new URL(cfg.baseUrl).host}`);
    if (!r.ok) throw new Error(`✗ refused: the runner has no verified NEAR report: HTTP ${r.status} ${(await r.text()).trim().slice(0, 200)}`);
    const bytes = await r.text(), rep = JSON.parse(bytes), w = await checkReport(rep, reportNonce(rep), cfg.baseUrl, m, cfg.policy, web);
    if (w.signingPublicKey !== v.signingPublicKey || w.profile.tls_spki !== v.profile.tls_spki) throw new Error("✗ refused: the runner's NEAR report names a different TEE instance than the one this peer verified");
    v.profile = { ...v.profile, tls_pin: "runner (CDHash-measured)", runner_report_sha256: crypto.createHash("sha256").update(bytes).digest("hex"), runner_report_freshness: "the runner's nonce (CDHash-measured)" };
    return v;
  }
  await channel(model);
  const queues = new Map();
  // Requests on one account run one at a time.
  const serial = (acct, fn) => { const p = (queues.get(acct) ?? Promise.resolve()).then(fn, fn); queues.set(acct, p.catch(() => {})); return p; };

  const auth = (h) => {
    const a = L.accounts.get(h.account);
    if (!a?.device) refuse(401, "This gift isn't set up on this computer. Run the command from the link again.");
    if (!(Math.abs(Date.now() - Number(h.ts)) < 300e3)) refuse(401, `Stopped: this computer's clock is more than 5 minutes off.\ndetails: request ts ${h.ts}`);
    if (!verify(a.device, requestMsg(h.method, h.url, h.ts, h.idem, h.bodyHash), h.sig)) refuse(401, "This gift is set up on a different computer.\ndetails: device signature does not verify");
    if (a.expiry < Date.now()) refuse(403, `This gift expired on ${new Date(a.expiry).toDateString()}. Ask ${a.from} for a new link.`);
    return a;
  };

  const chat = (req, res, body) => { const h = deviceAuth(req, sha(body)); auth(h); return serial(h.account, () => chat1(req, res, body, h)); };
  // The next window for an account: one checkpoint in flight per account, shared by whoever needs it.
  const renew = (a, hold = 0) => {
    a.renewing ??= (async () => {
      if (a.confirming) await a.confirming;
      if (a.lost) return;
      const covered = Math.min(a.amount, Math.max(a.covered, a.spent) + Math.max(WINDOW, hold));
      await checkpoint([{ type: "window", account: a.account, covered }]);
      L.append({ type: "window", account: a.account, covered });
    })().finally(() => { a.renewing = null; });
    return a.renewing;
  };
  async function chat1(req, res, body, h) {
    const a = auth(h);
    if (!/^[0-9a-f]{32,64}$/.test(h.idem)) refuse(400, "missing or malformed x-abalone-idem");
    const b = json(body);
    if (!b.stream || !b.stream_options?.include_usage) refuse(400, "gift requests must stream with stream_options.include_usage");
    if (b.tools?.length || b.messages.some((m) => m.tool_calls || m.role === "tool")) refuse(400, "✗ refused: tool calls are not sent to NEAR (their arguments are not end-to-end encrypted)");
    const k = `${a.account}:${h.idem}`;
    if (L.done.has(k)) {
      res.writeHead(200, { "content-type": "text/event-stream", "x-abalone-replayed": "1" });
      return res.end(Buffer.concat([fs.readFileSync(path.join(RESP, `${a.account}-${h.idem}.sse`)), Buffer.from(trailer({ charge: L.done.get(k).charge, remaining: L.remaining(a), replayed: true }))]));
    }
    const price = prices.get(b.model) ?? refuse(400, `Nobody is offering this model right now. Your message was not sent and your balance didn't change.\ndetails: ${b.model} is not in NEAR's model list`);
    const hold = Math.ceil(body.length * price.in + (b.max_completion_tokens ?? b.max_tokens ?? price.maxOut) * price.out);
    const lostMsg = `Another computer redeemed this gift at the same moment and got it, so this server stopped. You were charged only for what was answered. Ask ${a.from} for a new link.`;
    if (a.lost) refuse(409, lostMsg);
    if (hold > L.remaining(a)) refuse(402, `The gift ran out. This last message was not answered and was not sent anywhere. Ask ${a.from} for a new link.\ndetails: ${fmt(L.remaining(a))} left of ${fmt(a.amount)}; this request could cost up to ${fmt(hold)}`);
    if (reg && a.spent + hold > a.covered) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": abalone-status confirming credit\n\n");
      while (a.spent + hold > a.covered && !a.lost) await (a.confirming ?? renew(a, hold));
      if (a.lost) return res.end(`data: ${JSON.stringify({ error: { message: lostMsg } })}\n\n`);
    }
    a.held += hold;
    try {
      const f = await forward(channel, key, req, res, body, b.model, web);
      if (!f) return;
      // No usage from NEAR means the actual cost is unknown: charge the hold, and record that.
      const charge = f.usage ? Math.ceil(f.usage.prompt_tokens * price.in + f.usage.completion_tokens * price.out) : hold;
      fs.writeFileSync(path.join(RESP, `${a.account}-${h.idem}.sse`), f.raw, { mode: 0o600 });
      L.append({ type: "debit", account: a.account, slice, idem: h.idem, model: b.model, usage: f.usage, charge, hold });
      a.held -= hold;
      res.end(trailer({ charge, remaining: L.remaining(a), replayed: false }));
      if (reg && !a.confirming && a.covered < a.amount && a.spent >= a.covered - WINDOW / 2) renew(a).catch((e) => console.error(`window renewal for ${a.account.slice(0, 8)} failed: ${e.message}`));
    } finally {
      if (!L.done.has(k)) a.held -= hold;
    }
  }

  function admin(body) {
    const { msg, sig } = json(body);
    if (!verify(issuer, msg, sig ?? "")) refuse(401, "not signed by the issuer this peer serves");
    const m = JSON.parse(msg);
    if (!(Math.abs(Date.now() - m.ts) < 300e3)) refuse(401, "stale issuer message");
    if (m.type === "status") return { provider: `nearai/${label}`, slice, relay: p?.relayState ?? null, funded: L.funded, committed: L.committed(), available: L.available(),
      gifts: [...L.accounts.values()].map((a) => ({ account: a.account.slice(0, 8), amount: a.amount, spent: a.spent, held: a.held, remaining: L.remaining(a), expiry: a.expiry, redeemed: !!a.device })) };
    refuse(400, `unknown issuer message ${m.type}`);
  }

  // Claim: the grant must be signed by the issuer this peer serves and name hash(code); the first claim binds the
  // device and takes the amount from the reserve, in one ledger entry.
  async function redeem(body) {
    const { code, grant, device } = json(body);
    let acct;
    try { acct = account(code); } catch (e) { refuse(400, e.message); }
    return serial(acct, () => redeem1(acct, grant, device));
  }
  async function redeem1(acct, grant, device) {
    if (!verify(issuer, grant?.msg ?? "", grant?.sig ?? "")) refuse(403, "This gift wasn't signed by the person this server works for. Ask them for a new link.\ndetails: grant signature does not verify for this peer's issuer");
    const m = JSON.parse(grant.msg);
    if (m.type !== "grant" || m.account !== acct || !Number.isSafeInteger(m.amount) || m.amount <= 0) refuse(400, "malformed grant");
    if (!/^[0-9a-f]{64}$/.test(device ?? "")) refuse(400, "malformed device key");
    if (m.expiry < Date.now()) refuse(410, `This gift expired on ${new Date(m.expiry).toDateString()}. Ask ${m.from} for a new link.`);
    const a = L.accounts.get(acct);
    if (a && a.device !== device) refuse(409, `This code was already used on another computer. If you never used it, ask ${m.from} for a new link.`);
    if (!a) {
      if (m.amount > L.available()) refuse(503, `This gift can't be set up right now: the server has no credit left to hold it. Your code still works. Ask ${m.from} about it.\ndetails: grant ${fmt(m.amount)}, reserve left ${fmt(L.available())}`);
      const claim = { type: "claim", account: acct, slice, amount: m.amount, expiry: m.expiry, from: m.from, nonce: m.nonce, device };
      const window = { type: "window", account: acct, covered: Math.min(m.amount, WINDOW) };
      // The claim's checkpoint carries the full first window; until it is safe, only the optimistic window is served.
      const sent = reg && await send([claim, window], ["0x" + acct]).catch((e) => { if (e.name === "Claimed_") refuse(409, `This code was already used on another computer. If you never used it, ask ${m.from} for a new link.\ndetails: claimed on chain by another peer`); throw e; });
      L.append(claim);
      if (reg) {
        L.append({ type: "window", account: acct, covered: Math.min(m.amount, OPTIMISTIC), optimistic: true });
        const c = L.accounts.get(acct);
        c.confirming = reg.confirm(sent, ["0x" + acct]).then(() => L.append(window), async (e) => {
          if (e.name !== "Lost") throw e;
          L.append({ type: "lost", account: acct, served: c.spent, reason: e.message });
          n = await reg.n("latest"); // the reorg rolled this peer's n back; continue from the chain's
          console.error(`claim lost for ${acct.slice(0, 8)}: ${e.message}; served ${fmt(c.spent)} at this peer's risk`);
        }).catch((e) => console.error(`claim confirmation for ${acct.slice(0, 8)} failed: ${e.message}; the account stays on its optimistic window`)).finally(() => { c.confirming = null; });
      }
    }
    const c = L.accounts.get(acct);
    return { already: !!a, amount: c.amount, remaining: L.remaining(c), expiry: c.expiry, from: c.from, model };
  }

  const routes = {
    "POST /redeem": (req, res, body) => redeem(body),
    "POST /admin": (req, res, body) => admin(body),
    "GET /v1/attestation/report": async (req, res, body) => {
      auth(deviceAuth(req, sha(body)));
      const r = await (key ? withKey(cfg.baseUrl, key) : (p) => web(new URL(cfg.baseUrl).origin + p))(req.url);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(await r.text());
    },
    // NEAR's per-chat signature, fetched for the client, which verifies it against the gateway key it attested itself.
    "GET /v1/signature": async (req, res, body) => {
      auth(deviceAuth(req, sha(body)));
      const q = new URL(req.url, "http://x").searchParams, id = q.get("chat_id") ?? "";
      if (!/^[0-9A-Za-z_-]{8,128}$/.test(id) || !prices.has(q.get("model"))) refuse(400, "malformed signature request");
      const p = `/v1/signature/${id}?model=${encodeURIComponent(q.get("model"))}&signing_algo=ecdsa`;
      const r = await (key ? withKey(cfg.baseUrl, key) : (p) => web(new URL(cfg.baseUrl).origin + p))(p);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(await r.text());
    },
    "POST /v1/chat/completions": chat,
  };
  const handle = async (req, res, body) => {
    const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    try {
      const route = routes[`${req.method} ${new URL(req.url, "http://x").pathname}`];
      if (!route) return send(404, { error: { message: "not found" } });
      const out = await route(req, res, body);
      if (out !== undefined) send(200, out);
    } catch (e) {
      // Unexpected errors: log the type and stack frames only, never the message (it can quote request data).
      const plain = e instanceof Refusal || e.runner || e instanceof ChainError; // runner and chain errors name nothing from the request
      if (!plain) console.error(`${req.method} ${req.url.split("?")[0]}: internal ${e.name}\n${e.stack.split("\n").slice(1).join("\n")}`);
      if (res.headersSent) return res.destroy();
      send(e.status ?? 500, { error: { message: plain ? e.message : `internal error (${e.name})` } });
    }
  };
  // An unexpected rejection is not swallowed: log it with its stack and the streams open at that moment, then exit
  // non-zero so the runner restarts the peer visibly. (Client stream aborts are handled in lib/p2p.mjs.)
  let p;
  process.on("unhandledRejection", (r) => {
    const open = p?.getConnections().flatMap((c) => c.streams.map((s) => `${s.protocol}#${s.id}`)) ?? [];
    console.error(`peer: unhandled rejection, exiting: ${r?.stack ?? r?.type ?? r}\nopen streams: ${open.join(", ") || "none"}`);
    process.exit(1);
  });
  // Tasks (lib/task.mjs): the offer and task services, sharing this ledger, the per-account queue and the NEAR channel.
  let svc;
  const services = tasks ? { "/abalone/offer/1": (...a) => svc.serveOffer(...a), "/abalone/task/1": (...a) => svc.serveTask(...a) } : {};
  p = await servePeer({ listen, relays, evidence: (peerId) => evidenceSource(evidence.kind, peerId, evidence.app), handle, privateKey, services });
  if (tasks) {
    const peerId = p.peerId.toString(), price = (m) => prices.get(m);
    // The offer states the evidence clients will see in the handshake: an ad-hoc runner (or the stub) attests as dev.
    const att = runner && await runnerJson("/attest", { data: "abalone-offer" });
    svc = taskService({ L, slice, dir, serial, peerId, models: [model], cfg: tasks,
      evidence: att?.type === "macrunner" ? { type: "macrunner", compose_hash: JSON.parse(Buffer.from(att.bootClientData, "base64")).compose_hash } : { type: runner ? "dev" : evidence.kind },
      infer: (body, res) => forward(channel, key, { headers: { "content-type": "application/json" } }, res, body, JSON.parse(body).model, web),
      hold: (m, body) => Math.ceil(body.length * price(m).in + JSON.parse(body).max_tokens * price(m).out),
      cost: (m, u) => Math.ceil(u.prompt_tokens * price(m).in + u.completion_tokens * price(m).out),
      // macrunner: the runner's App Attest assertion over the completion string (verifyMacRunner); otherwise an
      // Ed25519 signature by this peer's libp2p key, verifiable from the PeerId and labelled unattested.
      sign: async (data) => JSON.stringify(runner ? await runnerJson("/attest", { data }) : { type: "peer-ed25519", peer: peerId, data, sig: Buffer.from(await privateKey.sign(Buffer.from(data))).toString("hex") }) });
  }
  return { p, slice, near: (await channel(model)).profile, chain: reg && { address: reg.address, n }, offer: svc?.offer };
}
