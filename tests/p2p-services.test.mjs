import test from "node:test";
import assert from "node:assert/strict";
import { lpStream } from "@libp2p/utils";
import { multiaddr } from "@multiformats/multiaddr";
import { node, servePeer } from "../lib/p2p.mjs";
import { autoNAT } from "@libp2p/autonat";

test("AutoNAT can close a reused live connection; listenless coupon transport refuses that callback without losing its Noise streams", { timeout: 15000 }, async () => {
  const host = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    "/test/retained/1": async (_lp, send, recv) => send(await recv()),
  } });
  const legacy = await node(), coupon = await node([], {}, undefined, { autoNAT: false });
  const echo = async (connection, value) => {
    const signal = AbortSignal.timeout(2000), stream = await connection.newStream("/test/retained/1", { signal });
    const lp = lpStream(stream); await lp.write(Buffer.from(JSON.stringify(value)), { signal });
    const result = JSON.parse(Buffer.from((await lp.read({ signal })).subarray()));
    await stream.close({ signal }); return result;
  };
  try {
    assert.ok(legacy.services.autoNAT, "ordinary peer behavior remains unchanged");
    assert.equal(coupon.services.autoNAT, undefined);
    const old = await legacy.dial(host.getMultiaddrs()[0]);
    assert.deepEqual(await echo(old, { info: 1 }), { info: 1 });
    // The installed dependency's real callback is given controlled public address
    // metadata, with its dial resolving to an EXISTING real Noise connection.
    // No public IP is contacted. Its finally clause closes even an address mismatch.
    const log = () => {}; log.error = log.trace = log;
    const service = autoNAT()({ logger: { forComponent: () => log },
      addressManager: { getAddresses: () => [] }, transportManager: { dialTransportForMultiaddr: () => ({}) },
      connectionManager: { openConnection: async () => old } });
    const publicAddr = multiaddr(`/ip4/8.8.8.8/tcp/443/p2p/${host.peerId}`);
    await service.handleAutonatMessage({ dial: { peer: { id: host.peerId.toMultihash().bytes, addrs: [publicAddr.bytes] } } },
      { remotePeer: host.peerId, remoteAddr: publicAddr }, { signal: AbortSignal.timeout(2000) });
    assert.notEqual(old.status, "open", "real dependency closes the reused connection");
    await assert.rejects(echo(old, { evidence: 2 }));
    const retained = await coupon.dial(host.getMultiaddrs()[0]);
    assert.equal(retained.encryption, "/noise");
    assert.equal(retained.remotePeer.toString(), host.peerId.toString());
    assert.deepEqual(await echo(retained, { info: 1 }), { info: 1 });
    const inbound = host.getConnections(coupon.peerId)[0];
    await assert.rejects(inbound.newStream("/libp2p/autonat/1.0.0", { signal: AbortSignal.timeout(2000) }));
    assert.equal(retained.status, "open");
    assert.deepEqual(await echo(retained, { evidence: 2 }), { evidence: 2 });
    assert.equal(coupon.getConnections(host.peerId).length, 1, "no replacement connection or request replay");
  } finally { await Promise.all([legacy.stop(), coupon.stop(), host.stop()]); }
});

test("framed services preserve JSON callbacks and authenticate each Noise peer independently", { timeout: 15_000 }, async () => {
  const peers = [await node(), await node()];
  const contexts = [];
  const server = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    "/test/json/1": async (_lp, send, recv, context) => {
      const request = await recv();
      contexts.push(context);
      assert.ok(Object.isFrozen(context));
      await send({ caller: context.remotePeer, claimed: request.peerId });
    },
  } });
  try {
    for (const peer of peers) {
      const stream = await peer.dialProtocol(multiaddr(String(server.getMultiaddrs()[0])), "/test/json/1");
      const lp = lpStream(stream);
      await lp.write(Buffer.from(JSON.stringify({ peerId: peers[0].peerId.toString(), authenticated: true, roles: ["sponsor"] })));
      const response = JSON.parse(Buffer.from((await lp.read()).subarray()));
      assert.equal(response.caller, peer.peerId.toString());
      await stream.close();
    }
    assert.notEqual(contexts[0].remotePeer, contexts[1].remotePeer);
    for (const context of contexts) assert.deepEqual(context, {
      remotePeer: context.remotePeer, localPeer: server.peerId.toString(), protocol: "/test/json/1", authenticated: true, transport: "noise",
    });
  } finally { await Promise.all([...peers.map((peer) => peer.stop()), server.stop()]); }
});

test("raw services preserve duplicate keys, reject oversized reads/writes, and sanitize errors", { timeout: 15_000 }, async () => {
  const peer = await node(), seen = [], logs = [], original = console.error;
  console.error = (...args) => logs.push(args.join(" "));
  const server = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    "/test/raw/1": { raw: true, maxDataLength: 64, handle: async (_lp, send, recv) => { const frame = await recv(); seen.push(frame); await send(frame); } },
    "/test/large/1": { maxDataLength: 64, handle: async (_lp, send) => send({ value: "x".repeat(100) }) },
    "/test/error/1": async () => { throw new Error("synthetic-private-canary"); },
    "/test/timeout/1": { timeoutMs: 100, handle: async (_lp, _send, recv) => recv() },
  } });
  const open = async (proto) => {
    const stream = await peer.dialProtocol(multiaddr(String(server.getMultiaddrs()[0])), proto);
    return { stream, lp: lpStream(stream) };
  };
  try {
    const first = await open("/test/raw/1"), bytes = Buffer.from('{"id":"a","id":"b"}');
    await first.lp.write(bytes);
    assert.deepEqual(Buffer.from((await first.lp.read()).subarray()), bytes);
    await first.stream.close();
    const oversized = await open("/test/raw/1");
    await oversized.lp.write(Buffer.alloc(65));
    await assert.rejects(oversized.lp.read({ signal: AbortSignal.timeout(2000) }));
    assert.equal(seen.length, 1, "oversized input never reached service logic");
    for (const proto of ["/test/large/1", "/test/error/1", "/test/timeout/1"]) {
      const current = await open(proto);
      await assert.rejects(current.lp.read({ signal: AbortSignal.timeout(2000) }));
    }
    assert.ok(logs.length >= 3);
    assert.ok(logs.every((line) => !line.includes("synthetic-private-canary")));
  } finally { console.error = original; await Promise.all([peer.stop(), server.stop()]); }
});

test("invalid service descriptors fail before starting a peer", async () => {
  for (const service of [{ handle() {}, maxDataLength: 0 }, { handle() {}, maxDataLength: 40 * 1024 * 1024 + 1 }, { handle() {}, raw: "yes" }, { handle() {}, timeoutMs: 0 }, {}]) {
    await assert.rejects(servePeer({ listen: [], services: { "/test/1": service } }), /invalid framed service/);
  }
});

test("server descriptor deadlines abort idle reads and stalled handlers over real streams", { timeout: 10_000 }, async () => {
  const peer = await node();
  const server = await servePeer({ listen: ["/ip4/127.0.0.1/tcp/0"], evidence: () => () => ({ type: "dev" }), services: {
    "/test/idle/1": { timeoutMs: 100, handle: async (_lp, _send, recv) => recv() },
    "/test/stall/1": { timeoutMs: 100, handle: async () => new Promise(() => {}) },
  } });
  try {
    for (const protocol of ["/test/idle/1", "/test/stall/1"]) {
      const stream = await peer.dialProtocol(multiaddr(String(server.getMultiaddrs()[0])), protocol);
      const started = Date.now();
      await assert.rejects(lpStream(stream).read({ signal: AbortSignal.timeout(2000) }), (error) => error.name !== "TimeoutError");
      assert.ok(Date.now() - started < 1000, "server aborts before the client's independent timeout");
    }
  } finally { await Promise.all([peer.stop(), server.stop()]); }
});
