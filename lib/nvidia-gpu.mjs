// NVIDIA GPU attestation evidence (NEAR's nvidia_payload), verified on this computer instead of by NVIDIA NRAS.
// Mirrors NVIDIA's own local verifier: nvtrust guest_tools/gpu_verifiers/local_gpu_verifier (Python, commit 858ada9) and
// its successor attestation-sdk nv-attestation-sdk-cpp (commit 11b2bfe), under the SDK's default relying-party policy
// (claims_evaluator.cpp create_overall_result_evaluator). Per GPU:
//   device chain: 5 certificates (leaf AK … NVIDIA Device Identity CA), each signed by the next, valid now, root pinned;
//                 the leaf's TCG DICE FWID equals the report's FWID field; OCSP "good" for every certificate but leaf and root;
//   report:       SPDM 1.1 GET_MEASUREMENTS request (37 bytes, carries our nonce) || MEASUREMENTS response; ECDSA P-384
//                 SHA-384 signature (raw r||s, last 96 bytes) by the leaf key over everything before it;
//   RIMs:         driver and VBIOS reference manifests from NVIDIA's RIM service, named by the versions in the signed report;
//                 enveloped XML-DSig (C14N 1.1, ECDSA-SHA384) by a chain to the pinned NVIDIA CoRIM signing Root CA, OCSP
//                 "good" for every certificate but the root, colloquialVersion equal to the report's version;
//   measurements: every active RIM measurement (driver and VBIOS never at one index) equals one of its alternatives in the
//                 report; index 35 is skipped only when the report says NVDEC0 is disabled, as NVIDIA does.
// Revocation: with revocation "skip" (ABALONE_GPU_REVOCATION=skip, the user's explicit choice) no OCSP request is made and
// the verdict says so; every other check is unchanged.
// OCSP: a fresh random nonce in each request and in the signed response, the responder authorised by the certificate's issuer, the
// response current (thisUpdate..nextUpdate). Every failure refuses; nothing here falls back to NRAS or skips a check.
import crypto from "node:crypto";

export const RIM_URL = "https://rim.attestation.nvidia.com/v1/rim/";
export const OCSP_URL = "https://ocsp.ndis.nvidia.com/";
// Pinned roots, SHA-256 fingerprints of the PEMs shipped in nvtrust (local_gpu_verifier/src/verifier/certs/, commit 858ada9):
// verifier_device_root.pem "NVIDIA Device Identity CA" (2021-11-05..9999) and verifier_RIM_root.pem "NVIDIA CoRIM signing
// Root CA" (2023-03-16..2053-03-08). The evidence and the RIM each carry the root as their last certificate; it must be this one.
export const DEVICE_ROOT = "10:2B:F6:59:D5:41:96:14:C9:D8:E6:AE:CE:BC:80:45:4E:B2:6B:1D:F6:A7:69:AC:72:0B:9A:69:0B:16:7B:48";
export const RIM_ROOT = "12:97:7B:51:15:AC:B0:38:11:79:27:9F:FF:EB:5A:8C:4D:26:49:71:EB:B3:22:98:02:3A:46:5F:A4:1D:F5:D1";
const ARCH = { HOPPER: { fwid: "678105050401" }, BLACKWELL: { fwid: "67810505040101" } };
const SKEW = 300e3, OCSP_TTL = 3600e3; // clock skew allowed; staleness bound when a response has no nextUpdate (the C++ SDK's)

const must = (ok, what) => { if (!ok) throw new Error(`✗ refused: NVIDIA GPU evidence: ${what}`); };

// DER: one TLV at o, its children, and an encoder.
function tlv(b, o = 0) {
  must(o + 2 <= b.length, "truncated DER");
  let len = b[o + 1], h = 2;
  if (len & 0x80) { const n = len & 0x7f; must(n >= 1 && n <= 3, "bad DER length"); len = b.readUIntBE(o + 2, n); h += n; }
  must(o + h + len <= b.length, "truncated DER");
  return { t: b[o], v: b.subarray(o + h, o + h + len), raw: b.subarray(o, o + h + len), end: o + h + len };
}
const kids = (v) => { const out = []; for (let o = 0; o < v.length; o = out.at(-1).end) out.push(tlv(v, o)); return out; };
const enc = (t, ...parts) => {
  const v = Buffer.concat(parts), n = v.length;
  return Buffer.concat([Buffer.from([t]), Buffer.from(n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]), v]);
};
const hex = (b) => Buffer.from(b).toString("hex");
const gtime = (n) => {
  const m = n.v.toString().match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(?:\.\d+)?Z$/);
  must(n.t === 0x18 && m, "bad GeneralizedTime");
  return Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]);
};
// tbsCertificate fields by name (version is optional).
function tbs(cert) {
  const f = kids(kids(tlv(cert.raw).v)[0].v), x = f[0].t === 0xa0 ? 1 : 0;
  return { serial: f[x], subject: f[4 + x], spki: f[5 + x], exts: kids(f.find((k) => k.t === 0xa3)?.v ?? Buffer.alloc(0)).flatMap((s) => kids(s.v)) };
}

// A chain [leaf, ..., root]: each signed by the next, valid now, intermediates are CAs, root is the pinned one.
export function chain(certs, root, who) {
  const now = Date.now();
  must(certs.at(-1).fingerprint256 === root, `${who} certificate chain does not end at the pinned NVIDIA root`);
  certs.forEach((c, i) => {
    const up = certs[Math.min(i + 1, certs.length - 1)];
    must(c.checkIssued(up) && c.verify(up.publicKey), `${who} certificate ${i} (${c.subject.replace(/\n/g, ", ")}) is not signed by the next one`);
    must(Date.parse(c.validFrom) <= now && now <= Date.parse(c.validTo), `${who} certificate ${i} (${c.subject.replace(/\n/g, ", ")}) is not valid now (${c.validFrom} .. ${c.validTo})`);
    if (i > 0) must(c.ca, `${who} certificate ${i} is not a CA`);
  });
}

// OCSP for cert under issuer, POSTed through http, with the 32-byte request nonce n (random at runtime, as NVIDIA's are).
export async function ocsp(cert, issuer, n, http, who) {
  const h = (b) => crypto.createHash("sha384").update(b).digest();
  const key = kids(tlv(issuer.publicKey.export({ type: "spki", format: "der" })).v)[1].v.subarray(1);
  const certId = enc(0x30, Buffer.from("300d06096086480165030402020500", "hex"), enc(0x04, h(tbs(issuer).subject.raw)), enc(0x04, h(key)), tbs(cert).serial.raw);
  const nonceValue = enc(0x04, n);
  const req = enc(0x30, enc(0x30, enc(0x30, enc(0x30, certId)),
    enc(0xa2, enc(0x30, enc(0x30, Buffer.from("06092b0601050507300102", "hex"), Buffer.from("0101ff", "hex"), enc(0x04, nonceValue))))));
  const name = `${who} ${cert.subject.match(/CN=([^\n]*)/)?.[1]}`;
  const r = await http(OCSP_URL, { method: "POST", headers: { "content-type": "application/ocsp-request", accept: "application/ocsp-response" }, body: req });
  must(r.ok, `OCSP for ${name}: ${OCSP_URL} answered HTTP ${r.status}`);
  const [status, bytes] = kids(tlv(Buffer.from(await r.arrayBuffer())).v);
  must(hex(status.raw) === "0a0100" && bytes?.t === 0xa0, `OCSP for ${name}: responder status is not successful`);
  const [type, octets] = kids(kids(bytes.v)[0].v);
  must(hex(type.v) === "2b0601050507300101", `OCSP for ${name}: not a basic response`);
  const [data, alg, sig, certsTag] = kids(tlv(octets.v).v);
  must(hex(kids(alg.v)[0].v) === "2a8648ce3d040303", `OCSP for ${name}: response is not signed with ECDSA-SHA384`);
  must(certsTag?.t === 0xa0, `OCSP for ${name}: response carries no responder certificate`);
  const signer = new crypto.X509Certificate(kids(kids(certsTag.v)[0].v)[0].raw);
  const now = Date.now();
  // The responder is the issuer itself or a certificate the issuer gave the OCSPSigning purpose (RFC 6960 4.2.2.2).
  must(signer.fingerprint256 === issuer.fingerprint256 || (signer.checkIssued(issuer) && signer.verify(issuer.publicKey) && signer.keyUsage?.includes("1.3.6.1.5.5.7.3.9")),
    `OCSP for ${name}: the responder certificate is not authorised by the issuer`);
  must(Date.parse(signer.validFrom) <= now && now <= Date.parse(signer.validTo), `OCSP for ${name}: the responder certificate is not valid now`);
  must(crypto.verify("sha384", data.raw, signer.publicKey, sig.v.subarray(1)), `OCSP for ${name}: response signature does not verify`);
  const fields = kids(data.v), at = fields[0].t === 0xa0 ? 1 : 0;
  const ext = kids(fields[at + 3]?.t === 0xa1 ? fields[at + 3].v : Buffer.alloc(0)).flatMap((s) => kids(s.v)).map((e) => kids(e.v));
  must(ext.some((e) => hex(e[0].v) === "2b0601050507300102" && e.at(-1).v.equals(nonceValue)), `OCSP for ${name}: response does not carry our nonce`);
  const mine = kids(tlv(certId).v), single = kids(fields[at + 2].v).map((s) => kids(s.v))
    .find(([id]) => { const k = kids(id.v); return hex(kids(k[0].v)[0].v) === hex(kids(mine[0].v)[0].v) && [1, 2, 3].every((i) => k[i].raw.equals(mine[i].raw)); });
  must(single, `OCSP for ${name}: response is not about this certificate`);
  const [, cs, thisUpdate, next] = single;
  must(cs.t !== 0xa1, `OCSP for ${name}: certificate is REVOKED`);
  must(cs.t === 0x80, `OCSP for ${name}: certificate status is unknown`);
  const from = gtime(thisUpdate), until = next?.t === 0xa0 ? gtime(kids(next.v)[0]) : from + OCSP_TTL;
  must(from <= now + SKEW && now <= until, `OCSP for ${name}: response is not current (thisUpdate ${new Date(from).toISOString()}, valid to ${new Date(until).toISOString()})`);
}
// OCSP for every certificate from `first` to the one below the root, each against the next.
const revocation_ = (certs, first, ocspNonce, http, who, seen) => Promise.all(certs.slice(first, -1).map((c, i) => {
  const k = c.fingerprint256;
  if (!seen.has(k)) seen.set(k, ocsp(c, certs[first + i + 1], ocspNonce(c), http, who));
  return seen.get(k);
}));

// SPDM 1.1 GET_MEASUREMENTS request || MEASUREMENTS response, little-endian fields; no trailing bytes.
export function parseReport(b) {
  must(b.length > 37 + 8 + 96 && b[0] === 0x11 && b[1] === 0xe0 && b[37] === 0x11 && b[38] === 0x60, "report is not an SPDM 1.1 GET_MEASUREMENTS exchange");
  const blocks = b[41], recLen = b.readUIntLE(42, 3), rec = b.subarray(45, 45 + recLen), measurements = new Map();
  let o = 0;
  for (let i = 0; i < blocks; i++) {
    must(o + 7 <= rec.length && rec[o + 1] === 1, "measurement block is not DMTF");
    const size = rec.readUInt16LE(o + 2), valueSize = rec.readUInt16LE(o + 5);
    must(size === valueSize + 3 && o + 4 + size <= rec.length && !measurements.has(rec[o] - 1), "malformed measurement block");
    measurements.set(rec[o] - 1, rec.subarray(o + 7, o + 7 + valueSize));
    o += 4 + size;
  }
  must(blocks > 0 && o === rec.length, "measurement record is empty or has trailing bytes");
  const at = 45 + recLen + 32, opaqueLen = b.readUInt16LE(at), opaque = b.subarray(at + 2, at + 2 + opaqueLen), fields = new Map();
  must(at + 2 + opaqueLen + 96 === b.length, "report length does not match its fields");
  must(!opaque.subarray(0, 6).equals(Buffer.from("NVDAOD")), "report uses the NVDAOD opaque-data format, which this verifier does not parse yet");
  for (o = 0; o < opaque.length; ) {
    must(o + 4 <= opaque.length, "malformed opaque data");
    const type = opaque.readUInt16LE(o), len = opaque.readUInt16LE(o + 2);
    must(o + 4 + len <= opaque.length, "malformed opaque data");
    fields.set(type, opaque.subarray(o + 4, o + 4 + len));
    o += 4 + len;
  }
  const str = (t) => { must(fields.has(t), `report has no opaque field ${t}`); return fields.get(t).toString("latin1").replace(/\0+$/, ""); };
  const v = hex(Buffer.from(fields.get(6) ?? []).reverse()); // VBIOS version: NVIDIA's format_vbios_version
  must(v.length === 16, "report has no VBIOS version");
  const vbios = (v.slice(8) + v.slice(6, 8)).match(/../g).join(".").toUpperCase();
  return { nonce: b.subarray(4, 36), signed: b.subarray(0, b.length - 96), signature: b.subarray(b.length - 96), measurements, fields, str, vbios };
}

// RIM XML: a strict subset parser (no DTD, comments, PIs, CDATA or unknown entities: refused, never guessed at), C14N 1.1 of
// a subtree (inclusive, without comments), and the enveloped XML-DSig check NVIDIA's RIMs use.
const unescape = (s) => s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(lt|gt|amp|quot|apos));/gi, (_, x, d, n) => x ? String.fromCodePoint(parseInt(x, 16)) : d ? String.fromCodePoint(+d) : { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[n]);
function parseXml(src) {
  const s = src.replace(/\r\n?/g, "\n").replace(/^﻿?(<\?xml[^?]*\?>)?\s*/, "");
  must(!/<!|<\?|&(?!(?:#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);)/i.test(s), "RIM uses XML features this verifier refuses (DTD, comment, PI, CDATA or entity)");
  const root = { kids: [], ns: { xml: "http://www.w3.org/XML/1998/namespace" } };
  let cur = root, o = 0;
  for (const m of s.matchAll(/<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*"[^"<]*")*)\s*(\/?)>/g)) {
    const text = s.slice(o, m.index);
    must(!/[<>]/.test(text) && (cur !== root || !text.trim()), "RIM is not well-formed XML");
    if (text) cur.kids.push(unescape(text));
    o = m.index + m[0].length;
    if (m[1]) { must(cur.name === m[2] && !m[3] && !m[4], "RIM is not well-formed XML"); cur = cur.up; continue; }
    const attrs = [...m[3].matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"/g)].map(([, k, v]) => [k, unescape(v.replace(/[\t\n]/g, " "))]);
    must(new Set(attrs.map((a) => a[0])).size === attrs.length, "RIM repeats an attribute");
    const ns = { ...cur.ns };
    for (const [k, v] of attrs) if (k === "xmlns" || k.startsWith("xmlns:")) ns[k.slice(6)] = v;
    const el = { name: m[2], attrs, ns, kids: [], up: cur };
    must(cur !== root || !root.kids.length, "RIM has more than one root element");
    cur.kids.push(el);
    if (!m[4]) cur = el;
  }
  must(cur === root && !s.slice(o).trim() && root.kids.length === 1, "RIM is not well-formed XML");
  return root.kids[0];
}
const uri = (el, q, attr) => {
  const i = q.indexOf(":");
  if (i < 0) return attr ? "" : el.ns[""] ?? "";
  must(el.ns[q.slice(0, i)] !== undefined, `RIM uses an undeclared prefix ${q.slice(0, i)}`);
  return el.ns[q.slice(0, i)];
};
const local = (q) => q.split(":").at(-1);
const is = (el, ns, name) => typeof el === "object" && local(el.name) === name && uri(el, el.name) === ns;
const children = (el, ns, name) => el.kids.filter((k) => is(k, ns, name));
function c14n(el, rendered = {}, skip = null) {
  const own = Object.entries(el.ns).filter(([p, v]) => p !== "xml" && rendered[p] !== v && !(p === "" && v === "" && !rendered[""]));
  const esc = (v) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/\t/g, "&#x9;").replace(/\n/g, "&#xA;").replace(/\r/g, "&#xD;");
  const attrs = el.attrs.filter(([k]) => k !== "xmlns" && !k.startsWith("xmlns:")).map(([k, v]) => [uri(el, k, true), local(k), k, v])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const scope = { ...rendered, ...Object.fromEntries(own) };
  const body = el.kids.filter((k) => k !== skip).map((k) => typeof k === "string" ? k.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#xD;") : c14n(k, scope, skip)).join("");
  return `<${el.name}${own.sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, v]) => ` xmlns${p ? ":" + p : ""}="${esc(v)}"`).join("")}${attrs.map((a) => ` ${a[2]}="${esc(a[3])}"`).join("")}>${body}</${el.name}>`;
}
const DS = "http://www.w3.org/2000/09/xmldsig#", C14N11 = "http://www.w3.org/2006/12/xml-c14n11";
const SWID = "http://standards.iso.org/iso/19770/-2/2015/schema.xsd", SHA384NS = "http://www.w3.org/2001/04/xmlenc#sha384";
const one = (el, ns, name, what) => { const c = children(el, ns, name); must(c.length === 1, `RIM signature: expected one ${what ?? name}`); return c[0]; };
const algo = (el) => el.attrs.find(([k]) => k === "Algorithm")?.[1];
const text = (el) => el.kids.join("").replace(/\s/g, "");

// Authenticate and read one RIM document (no network): its certificate chain (checked, revocation not yet) and its
// measurements (index → { active, size, values }), all from the signed content.
export function readRim(xml, id, version, product) {
  const doc = parseXml(xml);
  must(is(doc, SWID, "SoftwareIdentity"), `RIM ${id} is not a SWID tag`);
  const sig = one(doc, DS, "Signature"), si = one(sig, DS, "SignedInfo"), ref = one(si, DS, "Reference");
  must(algo(one(si, DS, "CanonicalizationMethod")) === C14N11 && algo(one(si, DS, "SignatureMethod")) === "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha384"
    && ref.attrs.find(([k]) => k === "URI")?.[1] === "" && algo(one(ref, DS, "DigestMethod")) === "http://www.w3.org/2001/04/xmldsig-more#sha384"
    && children(one(ref, DS, "Transforms"), DS, "Transform").map(algo).join(" ") === `${DS}enveloped-signature ${C14N11}`, `RIM ${id} signature does not use NVIDIA's algorithms (enveloped, C14N 1.1, ECDSA-SHA384) over the whole document`);
  must(doc.kids.filter((k) => is(k, DS, "Signature")).length === 1 && children(si, DS, "Reference").length === 1, `RIM ${id} has more than one signature or reference`);
  must(crypto.createHash("sha384").update(c14n(doc, {}, sig)).digest("base64") === text(one(ref, DS, "DigestValue")), `RIM ${id} content does not match its signed digest`);
  const certs = children(one(one(sig, DS, "KeyInfo"), DS, "X509Data"), DS, "X509Certificate").map((c) => new crypto.X509Certificate(Buffer.from(text(c), "base64")));
  must(certs.length >= 2, `RIM ${id} carries no certificate chain`);
  must(crypto.verify("sha384", Buffer.from(c14n(si)), { key: certs[0].publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(text(one(sig, DS, "SignatureValue")), "base64")), `RIM ${id} signature does not verify`);
  chain(certs, RIM_ROOT, `RIM ${id}`);
  const meta = one(doc, SWID, "Meta", "Meta");
  must(meta.attrs.find(([k]) => k === "colloquialVersion")?.[1].toLowerCase() === version.toLowerCase(), `RIM ${id} is for another version`);
  must(meta.attrs.find(([k]) => k === "product")?.[1] === product, `RIM ${id} is for another chip than ${product}`);
  return { certs, measurements: measurementsOf(doc, id) };
}
// The measurements (index → { active, size, values }) of a parsed RIM; readRim calls it only after the signature verifies.
function measurementsOf(doc, id) {
  const out = new Map();
  for (const res of children(one(doc, SWID, "Payload", "Payload"), SWID, "Resource")) {
    const a = Object.fromEntries(res.attrs.map(([k, v]) => [uri(res, k, true) + "|" + local(k), v]));
    must(a["|type"] === "Measurement" && /^\d+$/.test(a["|index"]) && /^[1-9]\d*$/.test(a["|alternatives"]) && /^\d+$/.test(a["|size"]) && ["True", "False"].includes(a["|active"]), `RIM ${id} has a malformed measurement`);
    must(+a["|index"] < 0x1000, `RIM ${id} carries opaque-data minimum-SVN records, which this verifier does not evaluate yet`);
    must(!out.has(+a["|index"]), `RIM ${id} repeats measurement index ${a["|index"]}`);
    const values = Array.from({ length: +a["|alternatives"] }, (_, i) => a[`${SHA384NS}|Hash${i}`]);
    must(values.every((v) => /^([0-9a-f]{2})+$/i.test(v ?? "")), `RIM ${id} measurement ${a["|index"]} lacks a hash alternative`);
    out.set(+a["|index"], { active: a["|active"] === "True", size: +a["|size"], values: values.map((v) => v.toLowerCase()) });
  }
  must(out.size, `RIM ${id} has no measurements`);
  return out;
}
async function rim(id, version, product, revoke, http) {
  const r = await http(RIM_URL + id, { headers: { accept: "application/json" } });
  must(r.ok, `NVIDIA RIM service has no RIM ${id} (HTTP ${r.status})`);
  const j = await r.json().catch(() => ({}));
  must(j.id === id && j.rim_format === "TCG" && typeof j.rim === "string", `RIM service answer for ${id} is not a TCG RIM for it`);
  const { certs, measurements } = readRim(Buffer.from(j.rim, "base64").toString("utf8"), id, version, product);
  await revoke(certs, 0, `RIM ${id}`);
  return measurements;
}

// Every active RIM measurement equals one of its alternatives in the report (NVIDIA skips index 35 when NVDEC0 is off).
export function compareMeasurements(drv, vb, rep, who) {
  const nvdec = rep.fields.get(11)?.[0];
  must(nvdec === 0xaa || nvdec === 0x55, `${who}: report has no known NVDEC0 status`);
  const bad = [];
  for (const [src, m] of [["driver", drv], ["VBIOS", vb]]) for (const [i, gm] of m) {
    if (!gm.active) continue;
    must(!(src === "VBIOS" && drv.get(i)?.active), `${who}: driver and VBIOS RIMs both measure index ${i}`);
    if (i === 35 && nvdec === 0x55) continue;
    const got = rep.measurements.get(i);
    if (!got || got.length !== gm.size || !gm.values.includes(hex(got))) bad.push(`${i} (${src})`);
  }
  must(!bad.length, `${who}: measurements do not match NVIDIA's reference values at ${bad.join(", ")}`);
}

// The leaf's TCG DICE FWID equals the report's FWID field, when the report has one (NVIDIA skips the check otherwise).
export function checkFwid(leaf, rep, arch, who) {
  if (!rep.fields.has(20)) return;
  const ext = tbs(leaf).exts.map((x) => kids(x.v)).find((x) => hex(x[0].v) === ARCH[arch].fwid);
  must(ext, `${who}: device certificate has no FWID`);
  const fwid = arch === "HOPPER" ? ext.at(-1).v.subarray(-48) : kids(kids(kids(kids(ext.at(-1).v)[0].v).find((k) => k.t === 0xa6).v)[0].v)[1].v;
  must(fwid.equals(rep.fields.get(20)), `${who}: FWID in the device certificate does not match the report`);
}
// GPUs in single- (0) and multi-GPU (1) passthrough modes at once refuse, as NVIDIA's verifier does.
export function checkModes(reps) {
  const modes = new Set(reps.filter((r) => r.fields.has(36)).map((r) => r.fields.get(36).readUIntLE(0, r.fields.get(36).length)));
  must(!(modes.has(0) && modes.has(1)), "GPUs are in both single- and multi-GPU passthrough modes");
}
// For tests only: the RIM measurement reader, without the signature check that readRim runs first.
export const unsignedRimMeasurements = (xml, id) => measurementsOf(parseXml(xml), id);

export const REVOCATION_SKIPPED = "certificate revocation NOT checked (ABALONE_GPU_REVOCATION=skip)";
// payload: NEAR's nvidia_payload JSON string; nonce: our 32-byte hex nonce; http: the fetch for RIM and OCSP (a transport
// failure propagates as is); revocation: "required" or "skip"; ocspNonce(cert): the OCSP request nonce, random unless a
// test replays a recording. Anything else that goes wrong, malformed input included, refuses with the "✗ refused" prefix.
export async function verifyGpuEvidence(payload, nonce, http, { revocation = "required", ocspNonce = () => crypto.randomBytes(32) } = {}) {
  must(["required", "skip"].includes(revocation), `unknown revocation mode ${revocation}`);
  const net = (url, init) => http(url, init).catch((e) => { throw Object.assign(e, { transport: true }); });
  const seen = new Map(), revoke = revocation === "skip" ? async () => {} : (certs, first, who) => revocation_(certs, first, ocspNonce, net, who, seen);
  try { return await verify(payload, nonce, net, revoke) + (revocation === "skip" ? `; ${REVOCATION_SKIPPED}` : ""); }
  catch (e) { throw e.transport || e.message.startsWith("✗ refused") ? e : new Error(`✗ refused: NVIDIA GPU evidence: malformed input (${e.message})`); }
}
async function verify(payload, nonce, http, revoke) {
  const p = JSON.parse(payload);
  must(p.nonce?.toLowerCase() === nonce && Array.isArray(p.evidence_list) && p.evidence_list.length, "GPU evidence nonce is not ours");
  const rims = new Map(), reps = [], out = [];
  for (const [g, e] of p.evidence_list.entries()) {
    const arch = ARCH[e.arch], who = `GPU ${g}`;
    must(arch && e.arch === p.arch && e.nonce?.toLowerCase() === nonce, `${who}: architecture ${e.arch} is not supported or its nonce is not ours`);
    const pem = Buffer.from(e.certificate, "base64").toString().match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    must(pem.length === 5, `${who}: device certificate chain has ${pem.length} certificates, not 5`);
    const certs = pem.map((c) => new crypto.X509Certificate(c));
    chain(certs, DEVICE_ROOT, `${who} device`);
    const rep = parseReport(Buffer.from(e.evidence, "base64"));
    must(hex(rep.nonce) === nonce, `${who}: attestation report does not carry our nonce`);
    must(crypto.verify("sha384", rep.signed, { key: certs[0].publicKey, dsaEncoding: "ieee-p1363" }, rep.signature), `${who}: attestation report signature does not verify`);
    checkFwid(certs[0], rep, e.arch, who);
    await revoke(certs, 1, `${who} device`);
    const driver = rep.str(3), project = rep.str(17).toUpperCase(), projectSku = rep.str(18).toUpperCase(), chipSku = rep.str(15).toUpperCase();
    const chip = e.arch === "HOPPER" ? "GH100" : rep.str(35), driverId = e.arch === "HOPPER" ? `NV_GPU_DRIVER_GH100_${driver}` : `NV_GPU_CC_DRIVER_${chip}_${driver}`;
    const vbiosId = `NV_GPU_VBIOS_${project}_${projectSku}_${chipSku}_${rep.vbios.replace(/\./g, "")}`;
    for (const [id, v] of [[driverId, driver], [vbiosId, rep.vbios]]) {
      must(/^[A-Za-z0-9_.-]+$/.test(id), `${who}: report names an invalid RIM id ${JSON.stringify(id)}`);
      if (!rims.has(id)) rims.set(id, rim(id, v, chip, revoke, http));
    }
    compareMeasurements(...(await Promise.all([rims.get(driverId), rims.get(vbiosId)])), rep, who);
    reps.push(rep);
    out.push(`${e.arch} driver ${driver} VBIOS ${rep.vbios}`);
  }
  checkModes(reps);
  const kinds = [...new Set(out)];
  return `GPU: ${p.evidence_list.length}× verified locally (${kinds.join("; ")})`;
}
