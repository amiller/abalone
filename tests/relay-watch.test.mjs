// The relay drops the peer's reservation while the connection stays open (what retimeable-signal 1.0.1 does to a
// refreshed reservation on the live relay): the peer must notice, log the loss, re-reserve and be reachable again.
import test from "node:test";
import assert from "node:assert/strict";
import { multiaddr } from "@multiformats/multiaddr";
import { node, relay, servePeer } from "../lib/p2p.mjs";

test("a reservation dropped by the relay, connection open, is detected and re-reserved", { timeout: 60_000 }, async () => {
  const log = [], err = console.error;
  console.error = (...a) => { log.push(a.join(" ")); err(...a); };
  const r = await relay(["/ip4/127.0.0.1/tcp/0"]);
  const R = String(r.getMultiaddrs()[0]);
  const p = await servePeer({ listen: [], relays: [R], evidence: () => async () => ({}), handle: () => {}, relayProbeMs: 1000 });
  const c = await node();
  const reach = async () => { const conn = await c.dial(multiaddr(`${R}/p2p-circuit/p2p/${p.peerId}`)); await conn.close(); };
  const until = async (f, ms) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((s) => setTimeout(s, 200))) if (f()) return true; return false; };
  try {
    await reach();
    await new Promise((s) => setTimeout(s, 2500));
    assert.ok(!log.some((l) => l.startsWith("relay: lost")), `a held reservation was reported lost: ${log.join(" | ")}`);
    r.services.relay.reservationStore.removeReservation(p.peerId);
    await assert.rejects(reach(), /NO_RESERVATION/);
    assert.equal(r.getConnections(p.peerId).length, 1, "the relay keeps its connection to the peer");
    assert.ok(p.getMultiaddrs().some((a) => String(a).includes("p2p-circuit")), "the peer still advertises its circuit address");
    assert.ok(await until(() => log.some((l) => l.startsWith("relay: lost") && l.includes("NO_RESERVATION")), 10_000), `no loss logged: ${log.join(" | ")}`);
    assert.ok(await until(() => log.some((l) => l.startsWith("relay: reconnected")), 15_000), `no recovery logged: ${log.join(" | ")}`);
    await reach();
  } finally {
    console.error = err;
    await Promise.all([c.stop(), p.stop(), r.stop()]);
  }
});

// The live mechanism, in the relay server's own store: each refresh answers OK with a new expiry, but the second
// refresh does not disarm the first refresh's timer, so the reservation is gone one TTL after the first refresh.
test("circuit-relay-v2 4.2.13: a reservation refreshed twice expires one TTL after the first refresh", async () => {
  const r = await relay(["/ip4/127.0.0.1/tcp/0"]), store = r.services.relay.reservationStore, peer = r.peerId, wait = (ms) => new Promise((s) => setTimeout(s, ms));
  store.reservationTtl = 400;
  try {
    store.reserve(peer, r.getMultiaddrs()[0]); await wait(200);
    store.reserve(peer, r.getMultiaddrs()[0]); await wait(200);
    assert.equal(store.reserve(peer, r.getMultiaddrs()[0]).status, "OK"); // valid, it says, until t = 800 ms
    await wait(250);
    assert.equal(store.get(peer), undefined, "expected the library bug: dropped at t = 600 ms; if this fails, retimeable-signal is fixed and the comment in lib/p2p.mjs watchRelay is out of date");
  } finally { await r.stop(); }
});
