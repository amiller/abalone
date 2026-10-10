// The Mac runner's guest interface (edge-tee release-work/apple-attest-p2p/runner/notes/abalone-node-interface.md),
// all over one unix socket: provider requests as plain HTTP with the real Host (the runner injects the key and pins the
// provider's TLS), runner.local/{attest,key,provider-quote}, and HTTP CONNECT host:port for allowlisted TCP.
import http from "node:http";
import https from "node:https";
import net from "node:net";

export const SOCK = process.env.ABALONE_RUNNER_SOCK ?? "/run/egress.sock";

// Runner mode's assertion: nothing in the guest reaches the network except through runnerFetch on SOCK. A direct
// fetch, or any node:http/https request not on the runner socket, throws naming the URL.
export function onlyThroughRunner() {
  globalThis.fetch = (url) => { throw new Error(`✗ refused: a direct fetch of ${url} in runner mode; every request must go through the runner socket`); };
  const orig = http.request;
  http.request = (o, ...rest) => { if (typeof o !== "object" || o instanceof URL || o.socketPath !== SOCK) throw new Error(`✗ refused: an http request to ${o?.href ?? o?.host ?? o} not on the runner socket`); return orig(o, ...rest); };
  http.get = () => { throw new Error("✗ refused: http.get in runner mode"); };
  https.request = https.get = (o) => { throw new Error(`✗ refused: an https request to ${o?.href ?? o?.host ?? o} in runner mode`); };
}

// fetch(url) over the runner socket: the URL's host becomes the Host header; the runner decides where it goes.
// The runner's own refusals (text/plain "runner refused: …" or "runner upstream error: …") become errors named as
// such; upstream answers, including upstream errors, pass through unchanged.
// A delivery retry, not a fallback: Apple's Containerization relay can hand the runner a zero-byte guest connection while
// a task VM boots, and the runner closes it unanswered. A request whose connection closed before any response byte
// never reached the runner, so it is sent again on a new connection, at most 3 attempts, each logged. Any response byte,
// or any other error, ends it: nothing is retried after the runner could have acted.
export async function runnerFetch(url, init = {}) {
  let r;
  for (let attempt = 1; ; attempt++) {
    try { r = await rawFetch(url, init); break; }
    catch (e) {
      if (!e.zeroBytes) throw e;
      if (attempt === 3) throw new Error(`${init.method ?? "GET"} ${url}: the runner closed the connection before any response byte, 3 times; giving up`);
      console.error(`runner: ${init.method ?? "GET"} ${url} closed with no response byte (attempt ${attempt} of 3); sending again`);
    }
  }
  if (r.ok || !(r.headers.get("content-type") ?? "").startsWith("text/plain")) return r;
  const text = (await r.text()).trim();
  if (!text.startsWith("runner ")) return new Response(text, { status: r.status, headers: r.headers });
  throw Object.assign(new Error(`runner refused (${r.status}): ${text.slice(0, 300)}`), { runner: true, status: 502 });
}
function rawFetch(url, init) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    // agent: false: the runner closes each connection after one response, so no socket is reused. Every failure names
    // the URL, because the guest has no other way to tell which upstream hung.
    const fail = (e) => new Error(`${init.method ?? "GET"} ${url} via the runner socket ${SOCK}: ${e.message}`);
    const req = http.request({ socketPath: SOCK, agent: false, method: init.method ?? "GET", path: u.pathname + u.search, headers: { ...Object.fromEntries(new Headers(init.headers)), host: u.host } }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : v);
      // The body as a web stream whose errors name the URL. A runner that closes the connection after the headers but
      // before the body ends shows up here (Node raises it from socketCloseListener as a bare "aborted").
      const body = new ReadableStream({
        start(c) { res.on("data", (d) => c.enqueue(new Uint8Array(d))); res.on("end", () => c.close()); res.on("error", (e) => c.error(fail(new Error(`response body cut off after ${res.statusCode} ${res.headers["content-length"] ? `(content-length ${res.headers["content-length"]})` : res.headers["transfer-encoding"] ?? "(no length)"}: ${e.message}`)))); },
        cancel() { res.destroy(); },
      });
      resolve(new Response([204, 304].includes(res.statusCode) ? null : body, { status: res.statusCode, headers: h }));
    });
    let answered = false;
    req.on("response", () => (answered = true));
    req.on("error", (e) => reject(Object.assign(fail(e), { zeroBytes: !answered && (req.socket?.bytesRead ?? 0) === 0 })));
    req.end(init.body);
  });
}

export async function runnerJson(path, body) {
  const r = await runnerFetch(`http://runner.local${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`runner.local${path}: HTTP ${r.status} ${t.trim().slice(0, 300)}`);
  return JSON.parse(t);
}

// A raw TCP tunnel through the runner (CONNECT, only to the compose's egress.tcp entries).
export function tunnel(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(SOCK);
    let head = Buffer.alloc(0);
    s.once("error", reject);
    s.on("connect", () => s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    const onData = (d) => {
      head = Buffer.concat([head, d]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      s.off("data", onData);
      const line = head.subarray(0, end).toString().split("\r\n")[0];
      if (line.split(" ")[1] !== "200") { s.destroy(); return reject(new Error(`runner refused CONNECT ${host}:${port}: ${line}`)); }
      const rest = head.subarray(end + 4);
      if (rest.length) s.unshift(rest);
      resolve(s);
    };
    s.on("data", onData);
  });
}

// The guest has no NIC: a relay is reached through a loopback listener that tunnels each connection via CONNECT.
export async function loopbackTo(host, port) {
  const server = net.createServer(async (c) => {
    c.pause();
    try { const t = await tunnel(host, port); c.pipe(t).pipe(c); c.resume(); t.on("error", () => c.destroy()); c.on("error", () => t.destroy()); }
    catch { c.destroy(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server.address().port;
}
