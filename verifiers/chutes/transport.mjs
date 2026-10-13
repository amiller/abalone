// Chutes, direct, per instance, before the first prompt byte (fails closed). Wire format as in NEAR cloud-api
// (crates/inference_providers/src/attested/chutes/{client,e2ee,report_data}.rs) and Chutes' own client
// (chutesai/e2ee-test src/e2eeClient.ts, wasm/src/lib.rs):
//   instance: GET /e2e/instances/<chute> lists each instance's ML-KEM-768 e2e_pubkey and single-use invoke nonces;
//   evidence: GET /instances/<id>/evidence?nonce=<ours>: TDX quote (Intel PCS; debug TDs refused by dcap-qvl; TCB per policy),
//             report_data[0:32] = sha256(nonce || e2e_pubkey) over the strings as sent, [32:64] = sha256(SPKI of its certificate),
//             MRTD + RTMR0-3 equal to one row of verifiers/chutes/chutes_measurements.json, GPU evidence through NVIDIA NRAS with
//             report_data[0:32] as its nonce;
//   E2EE:     the whole OpenAI request, gzipped, sealed to that e2e_pubkey (ML-KEM-768 → HKDF-SHA256 → ChaCha20-Poly1305),
//             POSTed to /e2e/invoke with X-Instance-Id; the reply is sealed to a per-request ML-KEM key carried inside it.
// Not established: what the chute's serving code does with the decrypted prompt, or which model answers (chutesai/chutes#75).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { INTEL_PCS_URL, gpu, qvl } from "./attestation.mjs";

export const API = "https://api.chutes.ai";
export const anchor = JSON.parse(fs.readFileSync(new URL("./chutes_measurements.json", import.meta.url), "utf8"));
const sha256 = (...b) => b.reduce((h, x) => h.update(x), crypto.createHash("sha256")).digest();
function must(ok, what) { if (!ok) throw new Error(`✗ refused: Chutes attestation: ${what}`); }

// ev: the /instances/<id>/evidence answer to `nonce` (it carries no instance id; report_data binds the key instead);
// inst: that instance's /e2e/instances entry.
export async function checkEvidence(ev, nonce, inst, policy = {}, http = fetch) {
  must(Buffer.from(inst.e2e_pubkey, "base64").length === 1184, "e2e_pubkey is not an ML-KEM-768 key");
  const tcb = policy.tcb ?? "UpToDate";
  must(["UpToDate", "reported"].includes(tcb), `policy.tcb "${tcb}" is not UpToDate or reported`);
  const v = await qvl(http).getCollateralAndVerify(Buffer.from(ev.quote, "base64"), INTEL_PCS_URL);
  if (tcb === "UpToDate") must(v.status === "UpToDate", `instance TCB status ${v.status} is not UpToDate (${(v.advisory_ids ?? []).join(", ")})`);
  const td = v.report.asTd10(), rd = Buffer.from(td.reportData), hex = (b) => Buffer.from(b).toString("hex");
  const bound = sha256(nonce, inst.e2e_pubkey);
  must(rd.subarray(0, 32).equals(bound), "report_data does not bind our nonce and this e2e_pubkey");
  const cert = new crypto.X509Certificate(Buffer.from(ev.certificate, "base64"));
  must(rd.subarray(32, 64).equals(sha256(cert.publicKey.export({ type: "spki", format: "der" }))), "report_data does not bind the evidence certificate's key");
  const regs = { mrtd: hex(td.mrTd), rtmr0: hex(td.rtMr0), rtmr1: hex(td.rtMr1), rtmr2: hex(td.rtMr2), rtmr3: hex(td.rtMr3) };
  const row = anchor.rows.find((r) => Object.keys(regs).every((k) => r[k] === regs[k]));
  must(row, `measurements (MRTD ${regs.mrtd.slice(0, 16)}…, RTMR3 ${regs.rtmr3.slice(0, 16)}…) match no row of verifiers/chutes/chutes_measurements.json (captured ${anchor.captured_at})`);
  const gpus = ev.gpu_evidence ?? [];
  must(gpus.length && gpus.every((g) => g.arch === gpus[0].arch), "no GPU evidence, or GPUs of mixed architecture");
  const payload = JSON.stringify({ nonce: bound.toString("hex"), arch: gpus[0].arch, evidence_list: gpus.map((g) => ({ certificate: g.certificate, evidence: g.evidence })) });
  const verdict = await gpu({ nvidia_payload: payload }, bound.toString("hex"), http, policy.gpuSignature === "required")
    .catch((e) => { throw new Error(e.message.replace("NEAR attestation", "Chutes attestation")); });
  const status = `${v.status}${v.advisory_ids?.length ? " " + v.advisory_ids.join(",") : ""}`;
  return {
    instance_id: inst.instance_id, instance_id_source: "Chutes' label, not attested (the quote binds the ML-KEM key, not the id)", nonce, e2e_pubkey_sha256: sha256(inst.e2e_pubkey).toString("hex"), cert_spki_sha256: rd.subarray(32, 64).toString("hex"),
    model_tcb: [status], model_tcb_statuses: [v.status], model_tcb_advisory_ids: [[...(v.advisory_ids ?? [])]], model_tcb_policy: tcb, gateway_tcb: null,
    measurement: `${row.name} v${row.version} (anchor captured ${anchor.captured_at})`, ...regs,
    gpu: `${verdict}, ${gpus.length}× ${gpus[0].arch}`,
  };
}

const RED = (s) => `\x1b[31m${s}\x1b[39m`;
export const strip = (p) => `◈ chutes ${p.model} · ${p.model_tcb.every((t) => t.startsWith("UpToDate")) ? "tcb:up-to-date" : RED(`tcb:out-of-date (${p.model_tcb.join("; ")})`)} · instance ${p.instance_id.slice(0, 8)} (Chutes' label) · Chutes sees ciphertext, sizes and timing; its serving code is not measured`;

// Chutes lists a changing subset of a chute's instances. A request goes to a listed instance already verified in this
// process; otherwise the first listed one is verified now and, if that fails, the next listed one once; then it is
// refused. Only successes are kept, so a transient failure (Intel PCS, NRAS) does not refuse the model for the process.
export async function pick(listed, verified, verify) {
  const id = (i) => i.instance_id + i.e2e_pubkey, known = listed.find((i) => verified.has(id(i)));
  if (known) return [known, await verified.get(id(known))];
  const errors = [];
  for (const inst of listed.slice(0, 2)) {
    const p = verify(inst);
    verified.set(id(inst), p);
    try { return [inst, await p]; } catch (e) { verified.delete(id(inst)); errors.push(e.message); }
  }
  throw new Error(errors.map((m, i) => (i ? m.replace(/^✗ refused: /, "") : m)).join("; next listed instance: "));
}

// Verify `inst` with a fresh nonce. get(path) fetches from API with the account's key.
export async function verifyInstance(inst, get, policy, http = fetch) {
  const nonce = crypto.randomBytes(32).toString("hex");
  return checkEvidence(await get(`/instances/${inst.instance_id}/evidence?nonce=${nonce}`), nonce, inst, policy, http);
}

const kdf = (ss, ct, info) => Buffer.from(crypto.hkdfSync("sha256", ss, ct.subarray(0, 16), info, 32));
const sealTo = (key, plain) => {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("chacha20-poly1305", key, iv, { authTagLength: 16 });
  return Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]);
};
const openWith = (key, b) => {
  const d = crypto.createDecipheriv("chacha20-poly1305", key, b.subarray(0, 12), { authTagLength: 16 });
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]);
};

// Request blob mlkem_ct(1088) || nonce(12) || ChaCha20-Poly1305(gzip(json + e2e_response_pk)) || tag(16), info "e2e-req-v1".
export function seal(pubB64, body) {
  const resp = ml_kem768.keygen(), { cipherText, sharedSecret } = ml_kem768.encapsulate(Buffer.from(pubB64, "base64"));
  const plain = zlib.gzipSync(JSON.stringify({ ...body, e2e_response_pk: Buffer.from(resp.publicKey).toString("base64") }));
  return { blob: Buffer.concat([cipherText, sealTo(kdf(sharedSecret, Buffer.from(cipherText), "e2e-req-v1"), plain)]), sk: resp.secretKey };
}

// A non-streamed reply: the same framing to our response key, info "e2e-resp-v1", gzipped.
export function open(blob, sk) {
  const ct = blob.subarray(0, 1088);
  return zlib.gunzipSync(openWith(kdf(ml_kem768.decapsulate(ct, sk), ct, "e2e-resp-v1"), blob.subarray(1088)), { maxOutputLength: 64 << 20 }).toString("utf8");
}
