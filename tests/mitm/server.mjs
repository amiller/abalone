// Logging MITM for an ACI gateway. Terminates TLS with its own cert, logs every request byte, forwards upstream.
// MITM_TAMPER: spki (pass through; only the TLS key differs), compose (edit app_compose), keyset (swap in our SPKI).
import fs from "node:fs";
import https from "node:https";
import { createHash, X509Certificate } from "node:crypto";

const [certFile, keyFile, logFile, upstreamHost, tamper] = process.argv.slice(2);
const cert = fs.readFileSync(certFile);
const ourSpki = createHash("sha256").update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })).digest("hex");
const log = fs.createWriteStream(logFile, { flags: "a" });

function rewrite(body) {
  const report = JSON.parse(body);
  const ev = report.attestation.evidence;
  if (tamper === "compose") ev.app_compose = ev.app_compose.replace('"allowed_envs":[', '"allowed_envs":["INJECTED",');
  if (tamper === "keyset") {
    for (const k of report.attestation.workload_keyset.tls_public_keys) k.spki_sha256 = ourSpki;
    ev.downstream_tls_binding.spki_sha256 = ourSpki;
  }
  return JSON.stringify(report);
}

const server = https.createServer({ cert, key: fs.readFileSync(keyFile) }, (req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    log.write(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: body.toString("utf8") }) + "\n");
    const up = https.request({ host: upstreamHost, path: req.url, method: req.method, headers: { ...req.headers, host: upstreamHost, "accept-encoding": "identity" } }, (upRes) => {
      const out = [];
      upRes.on("data", (c) => out.push(c));
      upRes.on("end", () => {
        let data = Buffer.concat(out).toString("utf8");
        if (req.url.startsWith("/v1/aci/attestation") && upRes.statusCode === 200 && tamper !== "spki") data = rewrite(data);
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
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
