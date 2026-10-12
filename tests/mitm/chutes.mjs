// Logging MITM for api.chutes.ai (own CA): records each request as Chutes' API receives it after TLS (method, path,
// content type, body base64; never the authorization header) and relays it. Mode file: "pass", or "nonce" (forwards an
// evidence request with another nonce, so the genuine quote is bound to someone else's).
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";

const [certFile, keyFile, logFile, modeFile] = process.argv.slice(2);
https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, (req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks), mode = fs.readFileSync(modeFile, "utf8").trim();
    fs.appendFileSync(logFile, JSON.stringify({ method: req.method, url: req.url, type: req.headers["content-type"] ?? null, instance: req.headers["x-instance-id"] ?? null, body: body.toString("base64") }) + "\n");
    const path = mode === "nonce" && req.url.includes("/evidence?") ? req.url.replace(/nonce=[0-9a-f]{64}/, `nonce=${crypto.randomBytes(32).toString("hex")}`) : req.url;
    const headers = { ...req.headers, host: "api.chutes.ai", "accept-encoding": "identity" };
    const up = https.request({ host: "api.chutes.ai", path, method: req.method, headers }, (u) => { res.writeHead(u.statusCode, u.headers); u.pipe(res); });
    up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
    up.end(body);
  });
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
