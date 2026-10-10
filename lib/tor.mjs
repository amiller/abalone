// Tor built into abalone: Arti compiled to WebAssembly (tor-js 0.4.1, MIT OR Apache-2.0), run by the launcher, which
// has the network; the sandbox has none. A transport is { name, status, fetch(url, init) }; /fetch's sealed route uses
// this one, and the same seam can later carry provider or gift-peer traffic. A Tor failure is an error: nothing ever
// goes out on the direct route instead.
// Adapted from Agent Boost src/tor/route.ts (MIT, (c) 2026 dmarzzz): the empty-Arti-state workaround, the persisted
// 0700 state dir, the closing socket provider, the bootstrap deadline and the check.torproject.org verification.
import fs from "node:fs";

export const CHECK = "https://check.torproject.org/api/ip";

// tor-js can persist empty Arti state records on a clean shutdown, which Arti rejects as corrupt at the next bootstrap.
// Only empty "state:" values are treated as absent; the directory cache stays reusable across launches.
const ignoreEmptyArtiState = (inner) => {
  const usable = (key, value) => value !== null && !(key.startsWith("state:") && value.length === 0);
  return { get: async (k) => { const v = await inner.get(k); return usable(k, v) ? v : null; }, set: (k, v) => inner.set(k, v),
    delete: (k) => inner.delete(k), keys: (p) => inner.keys(p), getAll: async (p) => (await inner.getAll(p)).filter(([k, v]) => usable(k, v)) };
};

const deadline = (p, ms, message) => {
  let t;
  return Promise.race([p, new Promise((_, reject) => (t = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(t));
};

// client: a TorClient-shaped stub for tests; otherwise tor-js starts on first use (bootstrap can take a minute or two).
export function torTransport({ dataDir, client, bootstrapMs = 120_000, requestMs = 120_000, onStatus = () => {} }) {
  let c = client, starting = null, status = "off";
  const set = (s) => { status = s; onStatus(s); };
  const start = () => (starting ??= (async () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(dataDir).isSymbolicLink()) throw new Error(`Tor state ${dataDir} is a symlink`);
    fs.chmodSync(dataDir, 0o700);
    set("bootstrapping");
    try {
      if (!c) {
        const { ArtiSocketProvider, TorClient, storage } = await import("tor-js/wasm-file");
        // tor-js does not close direct sockets when the client closes; this provider does.
        class Closing extends ArtiSocketProvider {
          open = new Set();
          async connect(target) { const s = await super.connect(target); this.open.add(s); s.closed.then(() => this.open.delete(s)); return s; }
          close() { for (const s of this.open) s.close(); this.open.clear(); super.close(); }
        }
        c = new TorClient({ storage: storage.addLocking(ignoreEmptyArtiState(new storage.FilesystemStorage(dataDir)), "abalone-tor"), logLevel: "error", socketProvider: new Closing() });
      }
      await deadline(c.ready(), bootstrapMs, `Tor did not finish starting within ${bootstrapMs / 1000} s`);
      set("ready");
    } catch (e) {
      set("failed"); c?.close(); c = undefined; starting = null;
      throw new Error(`Tor failed: ${e.message}. Nothing was sent, and nothing goes out on the direct route instead.`);
    }
  })());
  return {
    name: "Tor (built in)",
    get status() { return status; },
    async fetch(url, init = {}) {
      await start();
      try { return await deadline(c.fetch(url, init), requestMs, "the request through Tor timed out"); }
      catch (e) { throw new Error(`Tor request failed: ${e.message}. Nothing goes out on the direct route instead.`); }
    },
    close() { c?.close(); c = undefined; starting = null; set("off"); },
  };
}

// The response body, at most `max` bytes.
export async function bounded(res, max) {
  const chunks = []; let n = 0;
  for await (const chunk of res.body) { n += chunk.byteLength; if (n > max) throw new Error(`more than ${max} bytes; nothing was saved`); chunks.push(chunk); }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}
