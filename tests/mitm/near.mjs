// Logging MITM for NEAR AI Cloud and NVIDIA NRAS. Terminates TLS with its own cert, logs every connection and request byte,
// relays to the real upstream and changes one thing, per the mode read from <modeFile> at each request:
//   nonce: forwards the attestation request with a different nonce (the genuine report is bound to someone else's)
//   model: renames model_name in each model attestation of the genuine report
//   gpu:   (NRAS) sets x-nvidia-overall-att-result false in the genuine NRAS JWT payload
//   pass:  nothing (spki case and witnesses: only the TLS key differs)
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";

const [certFile, keyFile, logFile, upstreamHost, modeFile] = process.argv.slice(2);
const log = fs.createWriteStream(logFile, { flags: "a" });
const report = (u) => u.startsWith("/v1/attestation/report");

function rewrite(url, data, tamper) {
  if (tamper === "model" && report(url)) {
    const r = JSON.parse(data);
    for (const ma of r.model_attestations) ma.model_name = "tampered/model";
    return JSON.stringify(r);
  }
  if (tamper === "gpu" && url.startsWith("/v3/attest/gpu")) {
    const r = JSON.parse(data), [h, p, s] = r[0][1].split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    claims["x-nvidia-overall-att-result"] = false;
    r[0][1] = [h, Buffer.from(JSON.stringify(claims)).toString("base64url"), s].join(".");
    return JSON.stringify(r);
  }
  return data;
}

const server = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, (req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks), tamper = fs.readFileSync(modeFile, "utf8").trim();
    log.write(JSON.stringify({ method: req.method, url: req.url, port: req.socket.remotePort, body: body.toString("utf8") }) + "\n");
    const path = tamper === "nonce" && report(req.url) ? req.url.replace(/nonce=[0-9a-f]{64}/, `nonce=${crypto.randomBytes(32).toString("hex")}`) : req.url;
    const up = https.request({ host: upstreamHost, path, method: req.method, headers: { ...req.headers, host: upstreamHost, "accept-encoding": "identity" } }, (upRes) => {
      const out = [];
      upRes.on("data", (c) => out.push(c));
      upRes.on("end", () => {
        const data = upRes.statusCode === 200 ? rewrite(req.url, Buffer.concat(out).toString("utf8"), tamper) : Buffer.concat(out);
        const headers = { ...upRes.headers };
        delete headers["content-length"];
        delete headers["transfer-encoding"];
        res.writeHead(upRes.statusCode, headers);
        res.end(data);
      });
    });
    up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
    up.end(body);
  });
});
// Every TCP connection is logged too: one that carries no request is a TLS handshake the client refused (an SPKI pin).
server.on("connection", (sock) => log.write(JSON.stringify({ conn: sock.remotePort }) + "\n"));
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
