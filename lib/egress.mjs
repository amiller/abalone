// Egress for sandboxes that have no network namespace route out. Runs OUTSIDE the sandbox.
// l/<port>: raw byte pipe to 127.0.0.1:<port> (⌂ local model servers).
// h/<host>: raw byte pipe to <host>:443 (the TLS session stays end to end; used by Pi through egress-preload).
// connect.sock: HTTP CONNECT proxy admitting only `connectHosts` on 443 (used by runners through HTTPS_PROXY).
// Every connection is appended to <STATE>/egress.jsonl. ABALONE_EGRESS_REDIRECT=host=ip:port is a test hook
// standing in for a DNS/route hijack (tests/negative.sh).
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { log } from "./config.mjs";

const redirects = Object.fromEntries((process.env.ABALONE_EGRESS_REDIRECT ?? "").split(",").filter(Boolean).map((r) => r.split("=")));
const upstream = (host) => { const [h, p] = (redirects[host] ?? (host.includes(":") ? host : `${host}:443`)).split(":"); return net.connect(Number(p), h); };

let RUN = null; // the session's run dir name: /privacy shows only this session's connections
function pipe(client, host, via, head) {
  log("egress.jsonl", { run: RUN, via, host, allowed: true });
  const up = upstream(host);
  up.on("error", () => client.destroy());
  client.on("error", () => up.destroy());
  if (head) up.once("connect", () => client.write(head));
  client.pipe(up).pipe(client);
}

export async function startEgress(dir, hostList, connectHosts, localPorts, label) {
  const hosts = [...new Set(hostList)]; // two providers may share a host
  RUN = path.basename(dir);
  const long = [...hosts.map((h) => path.join(dir, "h", h)), path.join(dir, "connect.sock")].find((p) => Buffer.byteLength(p) > 107);
  if (long) throw new Error(`✗ refused: socket path ${long} is over the 107-byte unix socket limit; point XDG_RUNTIME_DIR at a shorter dir`);
  fs.mkdirSync(path.join(dir, "h"), { recursive: true });
  fs.mkdirSync(path.join(dir, "l"), { recursive: true });
  const servers = hosts.map((host) => net.createServer((c) => pipe(c, host, label)).listen(path.join(dir, "h", host)));
  // ⌂ local: l/<port> reaches 127.0.0.1:<port> and nothing else.
  for (const port of localPorts) servers.push(net.createServer((c) => pipe(c, `127.0.0.1:${port}`, "local")).listen(path.join(dir, "l", String(port))));
  servers.push(net.createServer((c) => {
    c.once("data", (buf) => {
      const m = /^CONNECT ([^:\s]+):(\d+) HTTP\/1\.[01]\r\n/.exec(buf.toString("latin1"));
      const host = m?.[1];
      if (!m || m[2] !== "443" || !connectHosts.includes(host)) {
        log("egress.jsonl", { run: RUN, via: "connect", host: host ?? null, allowed: false });
        return c.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      }
      pipe(c, host, "connect", "HTTP/1.1 200 Connection Established\r\n\r\n");
    });
  }).listen(path.join(dir, "connect.sock")));
  await Promise.all(servers.map((s) => new Promise((r) => s.listening ? r() : s.once("listening", r))));
  return () => servers.forEach((s) => s.close());
}
