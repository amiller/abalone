// The gift network's transport: js-libp2p with Noise, TCP, AutoNAT, DCUtR hole punching and circuit relay v2.
//   /abalone/attest/1  right after Noise, one way (peer → client). The client sends a fresh nonce; the peer answers with
//                      evidence binding its PeerId (the Noise identity) to an admitted measurement: a macOS App Attest
//                      enrollment over "abalone-peer/1|<PeerId>" plus an assertion over
//                      "abalone-attest/1|<PeerId>|<client PeerId>|<nonce>". Naming the client's PeerId keeps a live peer
//                      from serving as an assertion oracle for some other connection. The client closes the connection
//                      unless it verifies. Clients carry no measurement; device signatures authorize their requests.
//   /abalone/redeem/1, /abalone/infer/1, /abalone/status/1
//                      one request per stream: {method, url, headers, body}, answered by {status, headers}, then {data}
//                      frames, then {end}. Each protocol accepts only its own requests (gating per protocol).
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { webSockets } from "@libp2p/websockets";
import net from "node:net";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { autoNAT } from "@libp2p/autonat";
import { dcutr } from "@libp2p/dcutr";
import { ping } from "@libp2p/ping";
import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { lpStream, pbStream } from "@libp2p/utils";
import { multiaddr } from "@multiformats/multiaddr";
const { HopMessage, Status } = await import(new URL("./pb/index.js", import.meta.resolve("@libp2p/circuit-relay-v2"))); // not exported
import { verifyAssertion, verifyAttestation } from "./appattest.mjs";
import { verifyMacRunner } from "./vendor/macrunner.mjs";
import { runnerJson } from "./macrunner.mjs";

const ATTEST = "/abalone/attest/1";
const PROTOCOLS = { "/abalone/redeem/1": ["POST /redeem"], "/abalone/infer/1": ["GET /v1/attestation/report", "GET /v1/signature", "POST /v1/chat/completions"], "/abalone/status/1": ["POST /admin"] };
const protocolFor = (method, url) => Object.keys(PROTOCOLS).find((p) => PROTOCOLS[p].includes(`${method} ${url.split("?")[0]}`));
const FRAME = 40 << 20; // a commission carries its inputs (≤ 20 MiB, base64)
const send = (lp, obj) => lp.write(Buffer.from(JSON.stringify(obj)));
const recv = async (lp) => JSON.parse(Buffer.from((await lp.read()).subarray()).toString());

export const node = (listen = [], extra = {}, privateKey) => { let p; return p = createLibp2p({
  ...(privateKey && { privateKey }),
  // Nobody is relayed to themselves: this makes the relay answer watchRelay's self-CONNECT probe with CONNECTION_FAILED.
  connectionGater: { denyInboundRelayedConnection: async (_relay, from) => from.equals((await p).peerId) },
  addresses: { listen },
  // An onion rendezvous or a quick tunnel can take tens of seconds; the default 5 s dial budget cuts them off.
  connectionManager: { dialTimeout: 90_000, addressDialTimeout: 60_000 },
  transports: [tcp(), webSockets(), circuitRelayTransport()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: { identify: identify(), autoNAT: autoNAT(), dcutr: dcutr(), ping: ping(), ...extra },
}); };

// The minimal relay we would run (public TCP, circuit relay v2 with no data or duration cap for reserved peers).
export const relay = (listen, privateKey, announce = []) => createLibp2p({
  ...(privateKey && { privateKey }),
  addresses: { listen, announce },
  transports: [tcp(), webSockets(), circuitRelayTransport()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: { identify: identify(), autoNAT: autoNAT(), dcutr: dcutr(), ping: ping(), relay: circuitRelayServer({ reservations: { applyDefaultLimit: false } }) },
});

// Evidence on the Mac: the approved App Attest probe (an Apple-signed, hardened-runtime app whose CDHash is admitted).
function probe(app, mode, keyFile, clientData) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "abalone-attest-"));
  fs.writeFileSync(path.join(d, "c"), clientData);
  const r = spawnSync("open", ["-n", "-W", app, "--args", mode, path.join(d, "out"), path.join(d, "c"), keyFile], { encoding: "utf8" });
  const err = path.join(d, "out/error.txt");
  if (fs.existsSync(err)) throw new Error(`App Attest ${mode} failed: ${fs.readFileSync(err, "utf8")}`);
  if (r.status !== 0 || !fs.existsSync(path.join(d, "out/done.txt"))) throw new Error(`App Attest probe did not complete: ${r.stderr}`);
  const out = Object.fromEntries(["attestation.cbor", "assertion.cbor", "keyId.txt"].filter((f) => fs.existsSync(path.join(d, "out", f))).map((f) => [f, fs.readFileSync(path.join(d, "out", f))]));
  fs.rmSync(d, { recursive: true });
  return out;
}

// What a peer shows in /abalone/attest/1:
//   macrunner  the Mac runner attests the process holding the keys (CDHash + compose hash), over runner.local/attest;
//   appattest  a separate probe app's App Attest key (it does not cover this process; kept until the runner passes);
//   dev        unattested, refused by clients unless their policy admits dev peers (tests only).
export function evidenceSource(kind, peerId, app) {
  if (kind === "dev") return () => ({ type: "dev" });
  if (kind === "macrunner") return (nonce, remote) => runnerJson("/attest", { data: `abalone-attest/1|${peerId}|${remote}|${nonce}` });
  if (kind !== "appattest") throw new Error(`unknown evidence ${kind}`);
  let keyFile, enrollment, queue = Promise.resolve();
  const enroll = () => {
    keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "abalone-key-")), "key.txt");
    const e = probe(app, "enroll", keyFile, `abalone-peer/1|${peerId}`);
    enrollment = { attestation: e["attestation.cbor"].toString("base64"), keyId: e["keyId.txt"].toString().trim() };
  };
  enroll();
  setInterval(() => (queue = queue.then(enroll)), 6 * 3600e3).unref(); // clients refuse enrollments older than 12 h
  return (nonce, remote) => (queue = queue.then(() => ({ type: "appattest", ...enrollment, assertion: probe(app, "assert", keyFile, `abalone-attest/1|${peerId}|${remote}|${nonce}`)["assertion.cbor"].toString("base64") })));
}

// Mac peers are ◈ attested with hardware profile hw:edge: their sealed state is readable by the Mac's owner (the runner's KMS master is on the
// owner's disk), so clients send them only released and open data, and they run only their owner's own keys.
export function verifyEvidence(ev, peerId, self, nonce, admit) {
  const expect = `abalone-attest/1|${peerId}|${self}|${nonce}`;
  if (ev.type === "dev") { if (!admit.dev) throw new Error(`✗ refused: peer ${peerId} is an unattested development peer`); return { place: "⌂ dev (unattested)", tier: "dev" }; }
  if (ev.type === "macrunner") return { place: "◈ attested (Mac runner)", tier: "hw:edge", ...verifyMacRunner(ev, { cdhashes: admit.macrunner.cdhashes, composeHashes: admit.macrunner.composeHashes, expectData: expect }) };
  if (ev.type !== "appattest") throw new Error(`✗ refused: peer ${peerId} offers no admitted evidence (${ev.type})`);
  const a = verifyAttestation(Buffer.from(ev.attestation, "base64"), ev.keyId, Buffer.from(`abalone-peer/1|${peerId}`), admit.appattest);
  const s = verifyAssertion(Buffer.from(ev.assertion, "base64"), Buffer.from(expect), a.publicKey, admit.appattest);
  return { place: "◈ attested (App Attest probe; does not cover the peer process)", tier: "hw:edge", cdhash: s.cdhash };
}

// Test only: ABALONE_PEER_WIRE_LOG names a file that gets every request this peer receives and every frame it sends
// back, as the peer's own code sees them after Noise (tests/gift-session.sh looks for canaries in it).
const wire = (o) => process.env.ABALONE_PEER_WIRE_LOG && fs.appendFileSync(process.env.ABALONE_PEER_WIRE_LOG, JSON.stringify(o) + "\n");

// A peer: serves /abalone/attest/1 and /abalone/gift/1 (route table from lib/node.mjs).
export async function servePeer({ listen, relays = [], evidence, handle, privateKey, services = {}, relayProbeMs = 60_000 }) {
  const framedServices = Object.entries(services).map(([proto, service]) => {
    const options = typeof service === "function" ? { handle: service } : service;
    const maxDataLength = options?.maxDataLength ?? FRAME;
    if (typeof options?.handle !== "function" || !Number.isSafeInteger(maxDataLength) || maxDataLength < 1 || maxDataLength > FRAME
        || (options.raw !== undefined && typeof options.raw !== "boolean")
        || (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 300_000))) throw new Error("invalid framed service configuration");
    return [proto, { ...options, maxDataLength }];
  });
  const p = await node([...listen, ...relays.map((r) => `${r}/p2p-circuit`)], {}, privateKey);
  const ev = evidence(p.peerId.toString());
  // A client that closes or resets its stream ends that stream only: one log line, never a process-wide rejection.
  const gone = (proto, stream) => (e) => console.error(`${proto} stream ${stream.id}: closed by the client (${e?.message ?? e?.type ?? e})`);
  await p.handle(ATTEST, async (stream, connection) => {
    try {
      const lp = lpStream(stream);
      const { role, nonce } = await recv(lp);
      if (role !== "client") return stream.abort(new Error("peer-to-peer membership is not implemented yet"));
      await send(lp, await ev(nonce, connection.remotePeer.toString()));
      await stream.close();
    } catch (e) { gone(ATTEST, stream)(e); }
  }, { runOnLimitedConnection: true });
  // Existing functions remain JSON callbacks. Descriptors can lower frame bounds
  // or preserve raw bytes for strict parsers. Context comes only from Noise, never
  // a request field; it authenticates a key, not roles or measured-code identity.
  for (const [proto, options] of framedServices) await p.handle(proto, async (stream, connection) => {
    const lp = lpStream(stream, { maxDataLength: options.maxDataLength });
    let timer;
    try {
      if (connection?.encryption !== "/noise" || !connection.remotePeer?.toString()) throw new Error("authenticated connection required");
      const context = Object.freeze({ remotePeer: connection.remotePeer.toString(), localPeer: p.peerId.toString(), protocol: proto, authenticated: true, transport: "noise" });
      const serviceSend = (value) => {
        if (options.raw && !(value instanceof Uint8Array)) throw new Error("raw service response must be bytes");
        const bytes = options.raw ? value : Buffer.from(JSON.stringify(value));
        if (bytes.byteLength > options.maxDataLength) throw new Error("service response exceeds frame limit");
        return lp.write(bytes);
      };
      const serviceRecv = async () => {
        const bytes = Buffer.from((await lp.read()).subarray());
        return options.raw ? bytes : JSON.parse(bytes.toString());
      };
      const operation = async () => {
        await options.handle(lp, serviceSend, serviceRecv, context);
        await stream.close();
      };
      if (options.timeoutMs === undefined) await operation();
      else await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("service request timed out");
          stream.abort(error);
          reject(error);
        }, options.timeoutMs);
      })]);
    } catch (e) {
      stream.abort(new Error("service request failed"));
      // Service exceptions may contain upstream credentials; do not log them.
      console.error(`${proto} stream ${stream.id}: service request failed`);
    } finally { clearTimeout(timer); }
  }, { runOnLimitedConnection: true });
  for (const proto of Object.keys(PROTOCOLS)) await p.handle(proto, async (stream) => {
    const lp = lpStream(stream);
    let q;
    try { q = await recv(lp); } catch (e) { return gone(proto, stream)(e); }
    wire({ in: q });
    if (protocolFor(q.method, q.url) !== proto) return stream.abort(new Error(`${q.method} ${q.url.split("?")[0]} is not part of ${proto}`));
    // If the client goes away mid-reply, the request still runs to its end (the peer settles what it actually used);
    // the remaining frames are dropped.
    let open = true, closed = false, chain = Promise.resolve();
    const lost = (e) => { if (!closed) { closed = true; gone(proto, stream)(e); } };
    const out = (o) => (wire({ out: o }), chain = chain.then(() => closed ? undefined : send(lp, o)).catch(lost));
    const res = {
      headersSent: false,
      writeHead(status, headers) { this.headersSent = true; out({ status, headers }); },
      write(c) { if (open) out({ data: Buffer.from(c).toString("base64") }); return true; },
      end(c) { if (c) this.write(c); if (open) { open = false; out({ end: true }); chain = chain.then(() => closed ? undefined : stream.close()).catch(lost); } },
      destroy() { open = false; closed = true; stream.abort(new Error("request failed")); },
      on() {},
    };
    await handle({ method: q.method, url: q.url, headers: q.headers }, res, q.body);
  }, { runOnLimitedConnection: true });
  if (relays.length) watchRelay(p, relays, relayProbeMs);
  return p;
}

// Relay loss is recoverable. js-libp2p reserves a circuit slot when it starts listening, but does not redial a relay
// whose connection closed, so the peer would stay unreachable. Watch for the circuit address disappearing (connection
// closed, a refresh refused) and restart the node's listeners with backoff 1, 2, 4 … 30 s; the restart dials the
// relay through the same addresses (under the runner, the CONNECT loopback forwarders) and reserves again. Stream
// handlers stay registered across the restart. State is in p.relayState for `node status`.
// The relay can also drop the reservation while the connection stays open, and nothing tells the peer: in
// circuit-relay-v2 4.2.13 the server's TTL timer (retimeable-signal 1.0.1) leaves the first refresh's timer armed, so
// the reservation expires one TTL after the first refresh although later refreshes answered OK, and the relay answers
// clients NO_RESERVATION. So every relayProbeMs the peer asks each relay to CONNECT it to itself: NO_RESERVATION means
// the slot is gone; CONNECTION_FAILED means it is held (node()'s gater refuses the self-circuit).
function watchRelay(p, relays, probeMs) {
  const st = (p.relayState = { connected: true, losses: 0, reconnects: 0, since: new Date().toISOString() });
  const circuit = () => p.getMultiaddrs().some((a) => String(a).includes("p2p-circuit"));
  let recovering = false;
  const recover = async (why) => {
    if (recovering) return;
    recovering = true; st.connected = false; st.losses++; st.since = new Date().toISOString();
    console.error(`relay: lost (${relays.join(", ")}: ${why}); redialing`);
    for (let wait = 1; ; wait = Math.min(wait * 2, 30)) {
      await new Promise((r) => setTimeout(r, wait * 1000));
      try { await p.stop(); await p.start(); } catch (e) { console.error(`relay: redial failed (${e.message.split("\n")[0]}); next try in ${Math.min(wait * 2, 30)} s`); continue; }
      if (circuit()) break;
    }
    st.connected = true; st.reconnects++; st.since = new Date().toISOString(); recovering = false;
    console.error(`relay: reconnected and reserved again (${st.reconnects} reconnect${st.reconnects > 1 ? "s" : ""})`);
  };
  const probe = async (r) => {
    const conn = p.getConnections().find((c) => c.remotePeer.toString() === r.split("/p2p/").pop());
    if (!conn) return "no connection to the relay";
    const s = await conn.newStream("/libp2p/circuit/relay/0.2.0/hop", { signal: AbortSignal.timeout(30_000) });
    const hop = pbStream(s).pb(HopMessage);
    await hop.write({ type: HopMessage.Type.CONNECT, peer: { id: p.peerId.toMultihash().bytes, addrs: [] } });
    const { status } = await hop.read({ signal: AbortSignal.timeout(30_000) });
    await s.close();
    return status === Status.CONNECTION_FAILED ? null : `the relay answered ${status} for this peer's reservation`;
  };
  // A node stopped from outside (p.status not "started" while not recovering) is not a loss.
  const live = () => p.status === "started";
  p.addEventListener("self:peer:update", () => { if (live() && !circuit()) recover("circuit address gone"); });
  p.addEventListener("connection:close", () => setTimeout(() => { if (live() && !circuit()) recover("connection closed"); }, 500));
  setInterval(async () => {
    if (recovering || !live()) return;
    for (const r of relays) {
      const why = await probe(r).catch((e) => `probe failed: ${e.message.split("\n")[0]}`);
      if (why) return recover(why);
    }
  }, probeMs).unref();
}

// A recipient's client: dials the peer (directly, or through a relay with DCUtR upgrading when it can), verifies its
// evidence on a fresh nonce, and only then offers a loopback HTTP endpoint that carries gift requests to it.
// A gift names its peer by one or more addresses (e.g. the relay's Cloudflare wss address, then its onion). They are
// tried in order for reachability only: whichever connects, the peer's evidence is checked end to end, and a refused
// verification ends the attempt there; it never moves on to another address.
export async function giftClient(peerAddrs, admit) {
  const list = (Array.isArray(peerAddrs) ? peerAddrs : String(peerAddrs).split(",")).map((a) => a.trim()).filter(Boolean);
  const failed = [];
  for (const a of list) {
    try { return await giftClient1(a, admit); }
    catch (e) { if (/✗ refused/.test(e.message)) throw e; failed.push(`${a}: ${e.message.split("\n")[0]}`); }
  }
  throw new Error(`Couldn't reach the server that handles this gift at any of its addresses. Nothing was sent.\ndetails: ${failed.join("; ")}`);
}

// An /onion3 address is dialed through a Tor SOCKS5 proxy (ABALONE_TOR_SOCKS=host:port): the built-in tor-js offers only
// fetch(), no raw streams, so libp2p cannot ride it. A loopback listener forwards each connection through the proxy, and
// the address is rewritten to it; Noise still authenticates the relay's PeerId.
const socks = (proxy, host, port) => new Promise((resolve, reject) => {
  const [ph, pp] = proxy.split(":"), s = net.connect(Number(pp), ph);
  let step = 0, buf = Buffer.alloc(0);
  s.once("error", reject);
  s.on("connect", () => s.write(Buffer.from([5, 1, 0])));
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    if (step === 0 && buf.length >= 2) {
      if (buf[0] !== 5 || buf[1] !== 0) { s.destroy(); return reject(new Error("SOCKS proxy refused no-auth")); }
      buf = buf.subarray(2); step = 1;
      s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), Buffer.from(host), Buffer.from([port >> 8, port & 255])]));
    }
    if (step === 1 && buf.length >= 5) {
      const need = 4 + (buf[3] === 1 ? 4 : buf[3] === 4 ? 16 : 1 + buf[4]) + 2;
      if (buf.length < need) return;
      s.off("data", onData);
      if (buf[1] !== 0) { s.destroy(); return reject(new Error(`SOCKS connect to ${host}:${port} failed (code ${buf[1]})`)); }
      if (buf.length > need) s.unshift(buf.subarray(need));
      resolve(s);
    }
  };
  s.on("data", onData);
});
async function viaTor(addr) {
  const m = /^\/onion3\/([a-z2-7]{56}):(\d+)(\/.*)$/.exec(addr);
  if (!m) return addr;
  const proxy = process.env.ABALONE_TOR_SOCKS;
  if (!proxy) throw new Error("the onion address needs Tor installed: Tor Browser (ABALONE_TOR_SOCKS=127.0.0.1:9150) or tor (ABALONE_TOR_SOCKS=127.0.0.1:9050)");
  const server = net.createServer(async (c) => {
    c.pause();
    try { const t = await socks(proxy, `${m[1]}.onion`, Number(m[2])); c.pipe(t).pipe(c); c.resume(); t.on("error", () => c.destroy()); c.on("error", () => t.destroy()); }
    catch { c.destroy(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  return `/ip4/127.0.0.1/tcp/${server.address().port}${m[3]}`;
}

async function giftClient1(peerAddr, admit) {
  const c = await node();
  const ma = multiaddr(await viaTor(peerAddr)), peerId = ma.getComponents().findLast((x) => x.name === "p2p")?.value;
  if (!peerId) throw new Error(`gift peer address ${peerAddr} names no /p2p/<PeerId>`);
  const conn = await c.dial(ma).catch(async (e) => { await c.stop(); throw e; });
  const lp = lpStream(await conn.newStream(ATTEST, { runOnLimitedConnection: true }));
  const nonce = crypto.randomBytes(32).toString("hex");
  await send(lp, { role: "client", nonce });
  let verdict;
  try { verdict = verifyEvidence(await recv(lp), peerId, c.peerId.toString(), nonce, admit); } catch (e) { await c.stop(); throw e; }
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const proto = protocolFor(req.method, req.url);
    if (!proto) { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: `no gift protocol for ${req.method} ${req.url.split("?")[0]}` } })); }
    try {
      const l = lpStream(await c.dialProtocol(ma, proto, { runOnLimitedConnection: true }));
      await send(l, { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      for (;;) {
        const f = await recv(l);
        if (f.status) res.writeHead(f.status, f.headers);
        if (f.data) res.write(Buffer.from(f.data, "base64"));
        if (f.end) return res.end();
      }
    } catch (e) { res.destroy(e); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  // A framed service request: send one frame, hand each reply frame to onFrame until it returns true or the stream ends.
  const request = async (proto, q, onFrame = () => true) => {
    const l = lpStream(await c.dialProtocol(ma, proto, { runOnLimitedConnection: true }), { maxDataLength: FRAME });
    await send(l, q);
    for (;;) { let f; try { f = await recv(l); } catch (e) { if (e.name === "UnexpectedEOFError") return; throw e; } if (await onFrame(f)) return f; }
  };
  return { url: `http://127.0.0.1:${server.address().port}`, peerId, verdict, direct: !conn.limits, request, close: async () => { server.close(); await c.stop(); } };
}
