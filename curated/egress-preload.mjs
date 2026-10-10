// Inside the Pi sandbox (no network route): TLS to an admitted host goes over its egress socket h/<host>,
// and plain connections to a forwarded loopback port go over l/<port>. Anything else fails at connect,
// because the namespace has only loopback.
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";
const dir = process.env.ABALONE_EGRESS;
const tlsConnect = tls.connect;
tls.connect = function (...args) {
  const o = typeof args[0] === "object" ? args[0] : undefined;
  const host = o?.servername || o?.host;
  if (host && !o.socket && fs.existsSync(`${dir}/h/${host}`)) args[0] = { ...o, path: `${dir}/h/${host}`, host: undefined, port: undefined, servername: host };
  return tlsConnect.apply(this, args);
};
const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"];
for (const name of ["connect", "createConnection"]) {
  const orig = net[name];
  net[name] = function (...args) {
    const o = typeof args[0] === "object" ? args[0] : undefined;
    if (o && !o.path && loopback.includes(o.host) && fs.existsSync(`${dir}/l/${o.port}`)) args[0] = { ...o, path: `${dir}/l/${o.port}`, host: undefined, port: undefined };
    return orig.apply(this, args);
  };
}
