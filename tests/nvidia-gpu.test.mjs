// Local NVIDIA GPU evidence verification (lib/nvidia-gpu.mjs) against the GPU evidence in one recorded live NEAR attestation
// (tests/fixtures/near/attestation.json, tools/record-near-fixture.mjs), with the RIMs and OCSP answers recorded with it and
// NVIDIA NRAS's verdict on the same evidence. Network is cut; the recorded OCSP nonces are injected (tests/lib/replay.mjs).
// Answers NVIDIA's genuine chain cannot produce (revoked, unknown, unauthorised responder, wrong CertID, a rogue root, a
// non-CA intermediate) come from throwaway openssl certificates and openssl's OCSP responder made here.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { replayer, recordedOcspNonce, ocspRequests } from "./lib/replay-nvidia.mjs";

globalThis.fetch = (url) => { throw new Error(`network is cut in this test: ${url}`); };
const g = await import("../lib/nvidia-gpu.mjs");
const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/near/nvidia-local-attestation.json", import.meta.url), "utf8"));
const realNow = Date.now, at = (t) => (Date.now = () => t), T0 = Date.parse(fx.recorded);
at(T0);
const payload = fx.report.model_attestations[0].nvidia_payload, gpus = JSON.parse(payload).evidence_list;
const replay = replayer(fx), ocspNonce = recordedOcspNonce(fx);
const verify = (http = replay(), p = payload, nonce = fx.nonce) => g.verifyGpuEvidence(p, nonce, http, { ocspNonce });
const edited = (f) => { const p = JSON.parse(payload); f(p); return JSON.stringify(p); };
const rims = Object.fromEntries(fx.http.filter((h) => h.url.includes("/v1/rim/")).map((h) => JSON.parse(Buffer.from(h.body, "base64"))).map((j) => [j.id.startsWith("NV_GPU_DRIVER") ? "driver" : "vbios", j]));
const xml = (which) => Buffer.from(rims[which].rim, "base64").toString("utf8");
const version = (which) => xml(which).match(/colloquialVersion="([^"]*)"/)[1];
// Serves the driver RIM with its XML passed through f.
const driverRim = (f) => replay((r) => {
  if (!r.url.endsWith(rims.driver.id)) return r;
  return { ...r, body: JSON.stringify({ ...rims.driver, rim: Buffer.from(f(xml("driver"))).toString("base64") }) };
});
const flip = (b, i) => { const c = Buffer.from(b); c[i] ^= 1; return c; };
const deviceCerts = (e) => Buffer.from(e.certificate, "base64").toString().match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);

test("positive: the recorded evidence verifies locally, and NVIDIA NRAS's signed verdict on the same evidence agrees", async () => {
  const local = await verify();
  assert.equal(local, `GPU: 8× verified locally (HOPPER driver ${version("driver")} VBIOS ${version("vbios")})`);
  const [[, top], perGpu] = fx.nras.verdict, part = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url"));
  for (const t of [top, ...Object.values(perGpu)]) {
    const [h, p, s] = t.split("."), k = fx.nras.jwks.keys.find((k) => k.kid === JSON.parse(Buffer.from(h, "base64url")).kid);
    assert.ok(crypto.verify("sha384", Buffer.from(`${h}.${p}`), { key: new crypto.X509Certificate(Buffer.from(k.x5c[0], "base64")).publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
  }
  assert.equal(part(top)["x-nvidia-overall-att-result"], true);
  assert.equal(part(top).eat_nonce, fx.nonce);
  assert.equal(Object.keys(perGpu).length, gpus.length);
  for (const c of Object.values(perGpu).map(part)) {
    assert.equal(c.measres, "success");
    assert.equal(c["x-nvidia-gpu-driver-version"], version("driver"));
    assert.equal(c["x-nvidia-gpu-vbios-version"].toLowerCase(), version("vbios").toLowerCase());
    for (const k of ["attestation-report-signature-verified", "attestation-report-nonce-match", "driver-rim-signature-verified", "vbios-rim-signature-verified", "driver-rim-cert-validated", "vbios-rim-cert-validated", "attestation-report-cert-chain-validated"]) assert.equal(c[`x-nvidia-gpu-${k}`], true, k);
  }
});

for (const [name, run, why] of [
  ["a nonce that is not ours", () => verify(replay(), payload, "00".repeat(32)), /GPU evidence nonce is not ours/],
  ["evidence relabelled with our nonce, report bound to another", () => verify(replay(), edited((p) => { p.nonce = "11".repeat(32); for (const e of p.evidence_list) e.nonce = p.nonce; }), "11".repeat(32)), /GPU 0: attestation report does not carry our nonce/],
  ["one report byte flipped (a measurement value)", () => verify(replay(), edited((p) => { p.evidence_list[0].evidence = flip(Buffer.from(p.evidence_list[0].evidence, "base64"), 60).toString("base64"); })), /GPU 0: attestation report signature does not verify/],
  ["report signature byte flipped", () => verify(replay(), edited((p) => { const e = Buffer.from(p.evidence_list[3].evidence, "base64"); p.evidence_list[3].evidence = flip(e, e.length - 5).toString("base64"); })), /GPU 3: attestation report signature does not verify/],
  ["another GPU's device chain", () => verify(replay(), edited((p) => { p.evidence_list[0].certificate = p.evidence_list[1].certificate; })), /GPU 0: attestation report signature does not verify/],
  ["device chain of four certificates", () => verify(replay(), edited((p) => { p.evidence_list[0].certificate = Buffer.from(deviceCerts(gpus[0]).slice(0, 4).join("\n")).toString("base64"); })), /has 4 certificates, not 5/],
  ["device chain with an intermediate swapped for a RIM CA", async () => {
    const rimCa = xml("driver").match(/<ds:X509Certificate>([\s\S]*?)<\/ds:X509Certificate>/g)[1].replace(/<\/?ds:X509Certificate>/g, "").replace(/\s/g, "");
    const c = deviceCerts(gpus[0]); c[2] = new crypto.X509Certificate(Buffer.from(rimCa, "base64")).toString();
    return verify(replay(), edited((p) => { p.evidence_list[0].certificate = Buffer.from(c.join("\n")).toString("base64"); }));
  }, /GPU 0 device certificate 1 .* is not signed by the next one/],
  ["device certificates not yet valid (clock in 2019)", async () => { at(Date.parse("2019-01-01")); try { return await verify(); } finally { at(T0); } }, /GPU 0 device certificate 0 .* is not valid now/],
  ["NVIDIA OCSP answers stale (clock two days on)", async () => { at(T0 + 2 * 86400e3); try { return await verify(); } finally { at(T0); } }, /OCSP for GPU 0 device .* response is not current/],
  ["OCSP answer with a byte of its signed data flipped", () => verify(replay((r) => {
    if (!r.url.includes("ocsp.ndis")) return r;
    const i = r.body.indexOf(Buffer.from("180f32", "hex")); // producedAt GeneralizedTime "2…"
    return { ...r, body: flip(r.body, i + 16) };
  })), /OCSP for .* response signature does not verify/],
  ["OCSP answer for GPU 1's BROM certificate served for GPU 0's (same responder, other nonce)", () => {
    const about = (h, i) => Buffer.from(h.request.slice(7), "base64").includes(Buffer.from(new crypto.X509Certificate(deviceCerts(gpus[i])[1]).serialNumber, "hex"));
    const gpu1 = fx.http.find((h) => h.url.includes("ocsp.ndis") && about(h, 1));
    return verify(replay((r) => (r.url.includes("ocsp.ndis") && about(r, 0) ? { ...r, body: Buffer.from(gpu1.body, "base64") } : r)));
  }, /OCSP for GPU 0 device GH100 A01 GSP BROM: response does not carry our nonce/],
  ["NVIDIA OCSP unavailable", () => verify(replay((r) => (r.url.includes("ocsp.ndis") ? { ...r, status: 503 } : r))), /OCSP for .* answered HTTP 503/],
  ["unknown RIM id (HTTP 404)", () => verify(replay((r) => (r.url.endsWith(rims.vbios.id) ? { ...r, status: 404, body: '{"message":"RIM_NOT_FOUND"}' } : r))), new RegExp(`RIM service has no RIM ${rims.vbios.id} \\(HTTP 404\\)`)],
  ["RIM service answers with another RIM", () => verify(replay((r) => (r.url.endsWith(rims.driver.id) ? { ...r, body: Buffer.from(JSON.stringify(rims.vbios)) } : r))), /is not a TCG RIM for it/],
  ["RIM measurement value changed", () => verify(driverRim((x) => x.replace(/(ns2:Hash0=")([0-9a-f])/, (_, a, c) => a + (c === "0" ? "1" : "0")))), /RIM NV_GPU_DRIVER_\S+ content does not match its signed digest/],
  ["RIM measurement switched inactive", () => verify(driverRim((x) => x.replace('active="True"', 'active="False"'))), /content does not match its signed digest/],
  ["RIM signature value changed", () => verify(driverRim((x) => x.replace(/(<ds:SignatureValue>)(.)/, (_, a, c) => a + (c === "A" ? "B" : "A")))), /RIM NV_GPU_DRIVER_\S+ signature does not verify/],
  ["RIM with a comment injected", () => verify(driverRim((x) => x.replace("<ns0:Payload", "<!-- x --><ns0:Payload"))), /RIM uses XML features this verifier refuses/],
  ["RIM with an entity declaration", () => verify(driverRim((x) => `<!DOCTYPE s [<!ENTITY e "x">]>` + x)), /RIM uses XML features this verifier refuses/],
  ["RIM with a second Signature element", () => verify(driverRim((x) => x.replace("</SoftwareIdentity>", x.match(/<ds:Signature[\s\S]*<\/ds:Signature>/)[0] + "</SoftwareIdentity>"))), /expected one Signature/],
]) test(`refused: ${name}`, async () => { await assert.rejects(run(), why); });

test("RIM certificate validity: refused before its signer is valid and after it expires", () => {
  const signer = new crypto.X509Certificate(Buffer.from(xml("driver").match(/<ds:X509Certificate>([\s\S]*?)<\/ds:X509Certificate>/)[1].replace(/\s/g, ""), "base64"));
  try {
    for (const t of [Date.parse(signer.validFrom) - 86400e3, Date.parse(signer.validTo) + 86400e3]) {
      at(t);
      assert.throws(() => g.readRim(xml("driver"), rims.driver.id, version("driver"), "GH100"), /RIM NV_GPU_DRIVER_\S+ certificate 0 .* is not valid now/);
    }
  } finally { at(T0); }
  assert.throws(() => g.readRim(xml("driver"), rims.driver.id, "1.2.3", "GH100"), /is for another version/);
});

test("RIM chain must end at the pinned NVIDIA CoRIM root", () => {
  const certs = [...xml("driver").matchAll(/<ds:X509Certificate>[\s\S]*?<\/ds:X509Certificate>/g)].map((m) => m[0]);
  assert.throws(() => g.readRim(xml("driver").replace(certs.at(-1), ""), rims.driver.id, version("driver"), "GH100"), /does not end at the pinned NVIDIA root/);
});

test("measurements: genuine report matches its RIMs; a changed, missing or doubly claimed measurement is refused", () => {
  const rep = g.parseReport(Buffer.from(gpus[0].evidence, "base64"));
  const drv = g.readRim(xml("driver"), rims.driver.id, version("driver"), "GH100").measurements, vb = g.readRim(xml("vbios"), rims.vbios.id, version("vbios"), "GH100").measurements;
  g.compareMeasurements(drv, vb, rep, "GPU 0");
  const withMeasurements = (f) => { const m = new Map(rep.measurements); f(m); return { ...rep, measurements: m }; };
  assert.throws(() => g.compareMeasurements(drv, vb, withMeasurements((m) => m.set(1, flip(m.get(1), 0))), "GPU 0"), /measurements do not match NVIDIA's reference values at 1 \(VBIOS\)/);
  assert.throws(() => g.compareMeasurements(drv, vb, withMeasurements((m) => m.delete(21)), "GPU 0"), /at 21 \(driver\)/);
  assert.throws(() => g.compareMeasurements(new Map([...drv, [1, { ...vb.get(1) }]]), vb, rep, "GPU 0"), /driver and VBIOS RIMs both measure index 1/);
  // Index 35 is skipped only while the report says NVDEC0 is disabled (0x55), as NVIDIA does; an unknown status refuses.
  const nvdec = (v) => ({ ...withMeasurements((m) => m.set(35, Buffer.alloc(48))), fields: new Map([...rep.fields, [11, Buffer.from([v])]]) });
  g.compareMeasurements(drv, vb, nvdec(0x55), "GPU 0");
  assert.throws(() => g.compareMeasurements(drv, vb, nvdec(0xaa), "GPU 0"), /at 35 \(driver\)/);
  assert.throws(() => g.compareMeasurements(drv, vb, nvdec(0x00), "GPU 0"), /no known NVDEC0 status/);
});

// Throwaway PKI: CA with leaf (good), other (revoked) and spare (good), a delegated responder; a rogue CA and responder;
// a 5-certificate rogue device chain under its own "NVIDIA Device Identity CA"; a chain with a non-CA intermediate.
const d = fs.mkdtempSync(path.join(os.tmpdir(), "nvidia-gpu-test-"));
after(() => fs.rmSync(d, { recursive: true, force: true }));
const ssl = (...a) => execFileSync("openssl", a, { cwd: d, stdio: ["ignore", "pipe", "pipe"] });
const mk = (name, signer, { ext = "basicConstraints=critical,CA:TRUE\n", serial = "0x" + crypto.randomBytes(8).toString("hex"), cn = name } = {}) => {
  ssl("ecparam", "-name", "secp384r1", "-genkey", "-noout", "-out", `${name}.key`);
  fs.writeFileSync(`${d}/${name}.ext`, ext);
  if (signer) {
    ssl("req", "-new", "-key", `${name}.key`, "-subj", `/CN=${cn}`, "-out", `${name}.csr`);
    ssl("x509", "-req", "-in", `${name}.csr`, "-CA", `${signer}.pem`, "-CAkey", `${signer}.key`, "-set_serial", serial, "-days", "2", "-sha384", "-extfile", `${name}.ext`, "-out", `${name}.pem`);
  } else ssl("req", "-x509", "-new", "-key", `${name}.key`, "-sha384", "-subj", `/CN=${cn}`, "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE", "-out", `${name}.pem`);
  return new crypto.X509Certificate(fs.readFileSync(`${d}/${name}.pem`));
};
const leafExt = { ext: "basicConstraints=CA:FALSE\n" };
const ca = mk("ca"), leaf = mk("leaf", "ca", { ...leafExt, serial: "0x1001" }), other = mk("other", "ca", { ...leafExt, serial: "0x1002" }), spare = mk("spare", "ca", { ...leafExt, serial: "0x1003" });
const responderCert = mk("responder", "ca", { ext: "extendedKeyUsage=OCSPSigning\n" });
mk("rogue"); mk("rogueresponder", "rogue", { ext: "extendedKeyUsage=OCSPSigning\n" });
const rogueChain = [mk("r0", null, { cn: "NVIDIA Device Identity CA" })];
for (const n of ["r1", "r2", "r3"]) rogueChain.unshift(mk(n, `r${+n[1] - 1}`));
rogueChain.unshift(mk("r4", "r3", leafExt));
const nonCa = [mk("n0")]; nonCa.unshift(mk("n1", "n0", leafExt)); nonCa.unshift(mk("n2", "n1", leafExt));
const stamp = (t) => new Date(t).toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z", exp = stamp(Date.parse(leaf.validTo));
fs.writeFileSync(`${d}/index.txt`, [`V\t${exp}\t\t${leaf.serialNumber}\tunknown\t/CN=leaf`, `R\t${exp}\t${stamp(realNow())},keyCompromise\t${other.serialNumber}\tunknown\t/CN=other`, `V\t${exp}\t\t${spare.serialNumber}\tunknown\t/CN=spare`].join("\n") + "\n");
// openssl's responder for the throwaway CA; editRequest rewrites the request first, tamper the answer after.
const responder = ({ signer = "responder", md = "sha384", editRequest = (b) => b, tamper = (b) => b } = {}) => async (url, init) => {
  fs.writeFileSync(`${d}/req.der`, editRequest(Buffer.from(init.body)));
  ssl("ocsp", "-index", "index.txt", "-CA", "ca.pem", "-rsigner", `${signer}.pem`, "-rkey", `${signer}.key`, "-rmd", md, "-ndays", "1", "-reqin", "req.der", "-respout", "resp.der");
  return new Response(tamper(fs.readFileSync(`${d}/resp.der`)));
};
const ocspOf = (c, http) => g.ocsp(c, ca, crypto.randomBytes(32), http, "test");
const live = async (t, f) => { at(t); try { return await f(); } finally { at(T0); } };

test("OCSP against openssl's responder: good passes; revoked, unknown, wrong CertID, unauthorised, wrong algorithm, bad signature, stale refuse", () => live(realNow(), async () => {
  await ocspOf(leaf, responder());
  await assert.rejects(ocspOf(other, responder()), /certificate is REVOKED/);
  await assert.rejects(ocspOf(responderCert, responder()), /certificate status is unknown/);
  // The request is rewritten to ask about spare (good); the signed answer, with our nonce, is about another certificate.
  await assert.rejects(ocspOf(leaf, responder({ editRequest: (b) => Buffer.from(b.toString("hex").replace("02021001", "02021003"), "hex") })), /response is not about this certificate/);
  await assert.rejects(ocspOf(leaf, responder({ signer: "rogueresponder" })), /responder certificate is not authorised by the issuer/);
  await assert.rejects(ocspOf(spare, responder({ signer: "leaf" })), /responder certificate is not authorised by the issuer/); // issued by the CA, no OCSPSigning EKU
  await assert.rejects(ocspOf(leaf, responder({ md: "sha256" })), /response is not signed with ECDSA-SHA384/);
  await assert.rejects(ocspOf(leaf, responder({ tamper: (b) => flip(b, b.indexOf(Buffer.from("180f32", "hex")) + 16) })), /response signature does not verify/);
  at(realNow() + 36 * 3600e3); // past nextUpdate (one day), within the throwaway certificates' two days
  await assert.rejects(ocspOf(leaf, responder()), /response is not current/);
  at(realNow() - 3600e3); // before the responder certificate was issued
  await assert.rejects(ocspOf(leaf, responder()), /responder certificate is not valid now/);
}));

test("OCSP answer from the future (clock an hour before NVIDIA's thisUpdate) refuses", () => live(T0 - 3600e3, () => assert.rejects(verify(), /OCSP for GPU 0 device .* response is not current/)));

test("RIM chain's own OCSP is checked: a 503 only for the driver RIM signer refuses", async () => {
  const signer = new crypto.X509Certificate(Buffer.from(xml("driver").match(/<ds:X509Certificate>([\s\S]*?)<\/ds:X509Certificate>/)[1].replace(/\s/g, ""), "base64"));
  const about = (r) => r.url.includes("ocsp.ndis") && Buffer.from(r.request.slice(7), "base64").includes(Buffer.from(signer.serialNumber, "hex"));
  await assert.rejects(verify(replay((r) => (about(r) ? { ...r, status: 503 } : r))), /OCSP for RIM NV_GPU_DRIVER_\S+ HCC RIM L4 Signer: .* answered HTTP 503/);
});

test("device chain under a rogue root named NVIDIA Device Identity CA refuses at the pin", () =>
  assert.rejects(verify(replay(), edited((p) => { p.evidence_list[0].certificate = Buffer.from(rogueChain.map((c) => c.toString()).join("")).toString("base64"); })), /GPU 0 device certificate chain does not end at the pinned NVIDIA root/));

test("chain: a certificate signed by a non-CA intermediate refuses", () => live(realNow(), () => {
  g.chain(nonCa.slice(1), nonCa.at(-1).fingerprint256, "test");
  assert.throws(() => g.chain(nonCa, nonCa.at(-1).fingerprint256, "test"), /test certificate 1 is not a CA/);
}));

test("report with a trailing byte refuses", () =>
  assert.rejects(verify(replay(), edited((p) => { p.evidence_list[0].evidence = Buffer.concat([Buffer.from(p.evidence_list[0].evidence, "base64"), Buffer.alloc(1)]).toString("base64"); })), /GPU evidence: report length does not match its fields/));

test("FWID: the genuine leaf matches its report; a different FWID refuses", () => {
  const rep = g.parseReport(Buffer.from(gpus[0].evidence, "base64")), leafCert = new crypto.X509Certificate(deviceCerts(gpus[0])[0]);
  g.checkFwid(leafCert, rep, "HOPPER", "GPU 0");
  assert.throws(() => g.checkFwid(leafCert, { ...rep, fields: new Map([...rep.fields, [20, flip(rep.fields.get(20), 0)]]) }, "HOPPER", "GPU 0"), /FWID in the device certificate does not match the report/);
});

test("passthrough modes: GPUs in single- and multi-GPU mode at once refuse", () => {
  const rep = g.parseReport(Buffer.from(gpus[0].evidence, "base64")), mode = (v) => ({ ...rep, fields: new Map([...rep.fields, [36, Buffer.from([v, 0, 0, 0])]]) });
  g.checkModes([mode(0), mode(0)]);
  assert.throws(() => g.checkModes([mode(0), mode(1)]), /both single- and multi-GPU passthrough modes/);
});

test("measurement size must equal the RIM's declared size", () => {
  const rep = g.parseReport(Buffer.from(gpus[0].evidence, "base64"));
  const drv = g.readRim(xml("driver"), rims.driver.id, version("driver"), "GH100").measurements, vb = g.readRim(xml("vbios"), rims.vbios.id, version("vbios"), "GH100").measurements;
  assert.throws(() => g.compareMeasurements(new Map([...drv, [21, { ...drv.get(21), size: 47 }]]), vb, rep, "GPU 0"), /at 21 \(driver\)/);
});

test("RIM signature form: Reference URI and the transform list are exactly NVIDIA's", async () => {
  await assert.rejects(verify(driverRim((x) => x.replace('<ds:Reference URI="">', '<ds:Reference URI="#x">'))), /signature does not use NVIDIA's algorithms/);
  await assert.rejects(verify(driverRim((x) => x.replace('<ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>', ""))), /signature does not use NVIDIA's algorithms/);
});

test("RIM content rules after the signature: minimum-SVN records, repeated indices, another chip", () => {
  const x = xml("driver");
  g.unsignedRimMeasurements(x, "t");
  assert.throws(() => g.unsignedRimMeasurements(x.replace(' index="7" ', ' index="4096" '), "t"), /opaque-data minimum-SVN records/);
  assert.throws(() => g.unsignedRimMeasurements(x.replace(' index="1" ', ' index="0" '), "t"), /repeats measurement index 0/);
  assert.throws(() => g.readRim(x, rims.driver.id, version("driver"), "GB100"), /is for another chip than GB100/);
});

test("malformed input refuses with the prefix; a transport failure propagates unchanged", async () => {
  const bad = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n".repeat(5);
  await assert.rejects(verify(replay(), edited((p) => { p.evidence_list[0].certificate = Buffer.from(bad).toString("base64"); })), /^Error: ✗ refused: NVIDIA GPU evidence: malformed input/);
  await assert.rejects(verify(replay(), "{not json"), /✗ refused: NVIDIA GPU evidence: malformed input/);
  await assert.rejects(g.verifyGpuEvidence(payload, fx.nonce, async () => { throw new Error("connect ECONNREFUSED"); }), (e) => e.message === "connect ECONNREFUSED");
});

test("OCSP nonces are random at runtime: two verifications send different request nonces", async () => {
  const sent = [];
  for (let i = 0; i < 2; i++) await assert.rejects(g.verifyGpuEvidence(payload, fx.nonce, async (url, init) => { if (sent.length === i) sent.push(Buffer.from(init.body)); throw new Error("stop"); }), /stop/);
  assert.equal(sent.length, 2); // the first request of each run: the same certificate
  assert.notDeepEqual(sent[0].subarray(-32), sent[1].subarray(-32));
  assert.deepEqual(sent[0].subarray(0, -32), sent[1].subarray(0, -32));
  assert.ok(ocspRequests(fx).every((q) => !q.subarray(-32).equals(sent[0].subarray(-32))));
});

// Revocation-skip mode (ABALONE_GPU_REVOCATION=skip): no OCSP request at all, every other check unchanged, and it is said.
const skip = (http = replay(), p = payload, nonce = fx.nonce) => g.verifyGpuEvidence(p, nonce, http, { revocation: "skip" });
const spy = (inner = replay()) => { const urls = []; return { urls, http: (url, init) => (urls.push(String(url)), inner(url, init)) }; };

test("revocation skip: the recording verifies with no OCSP request, and the verdict says revocation was not checked", async () => {
  const s = spy(), v = await skip(s.http);
  assert.equal(v, `GPU: 8× verified locally (HOPPER driver ${version("driver")} VBIOS ${version("vbios")}); certificate revocation NOT checked (ABALONE_GPU_REVOCATION=skip)`);
  assert.equal(s.urls.filter((u) => u.includes("ocsp")).length, 0);
  assert.deepEqual([...new Set(s.urls)].sort(), [rims.driver.id, rims.vbios.id].map((id) => g.RIM_URL + id).sort());
  const on = spy(); await verify(on.http);
  assert.equal(on.urls.filter((u) => u.startsWith(g.OCSP_URL)).length, ocspRequests(fx).length); // mode off: unchanged
});

for (const [name, run, why] of [
  ["a nonce that is not ours", () => skip(replay(), payload, "00".repeat(32)), /GPU evidence nonce is not ours/],
  ["a report byte flipped", () => skip(replay(), edited((p) => { p.evidence_list[0].evidence = flip(Buffer.from(p.evidence_list[0].evidence, "base64"), 60).toString("base64"); })), /GPU 0: attestation report signature does not verify/],
  ["a rogue device chain", () => skip(replay(), edited((p) => { p.evidence_list[0].certificate = Buffer.from(rogueChain.map((c) => c.toString()).join("")).toString("base64"); })), /does not end at the pinned NVIDIA root/],
  ["a RIM measurement changed", () => g.verifyGpuEvidence(payload, fx.nonce, driverRim((x) => x.replace(/(ns2:Hash0=")([0-9a-f])/, (_, a, c) => a + (c === "0" ? "1" : "0"))), { revocation: "skip" }), /content does not match its signed digest/],
  ["a RIM signature changed", () => g.verifyGpuEvidence(payload, fx.nonce, driverRim((x) => x.replace(/(<ds:SignatureValue>)(.)/, (_, a, c) => a + (c === "A" ? "B" : "A"))), { revocation: "skip" }), /signature does not verify/],
  ["a RIM chain without its root", () => { const r = [...xml("driver").matchAll(/<ds:X509Certificate>[\s\S]*?<\/ds:X509Certificate>/g)].at(-1)[0]; return g.verifyGpuEvidence(payload, fx.nonce, driverRim((x) => x.replace(r, "")), { revocation: "skip" }); }, /does not end at the pinned NVIDIA root/],
  ["an unknown revocation mode", () => g.verifyGpuEvidence(payload, fx.nonce, replay(), { revocation: "maybe" }), /unknown revocation mode maybe/],
]) test(`revocation skip still refuses: ${name}`, async () => { await assert.rejects(run(), why); });

test('configured revocation is strict by default and skip requires exact explicit opt-in',async()=>{
 const {gpuRevocation}=await import('../lib/config.mjs');const old=process.env.ABALONE_GPU_REVOCATION;
 try{delete process.env.ABALONE_GPU_REVOCATION;assert.equal(gpuRevocation(),'required');process.env.ABALONE_GPU_REVOCATION='skip';assert.equal(gpuRevocation(),'skip');process.env.ABALONE_GPU_REVOCATION='try-then-skip';assert.throws(()=>gpuRevocation());}finally{if(old===undefined)delete process.env.ABALONE_GPU_REVOCATION;else process.env.ABALONE_GPU_REVOCATION=old;}
});
