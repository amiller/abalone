// NEAR AI Cloud, per model, before the first prompt byte (fails closed). Ported from Andrew's
// hermes-agent-near-ai E2EE transport and _nearai-verifier:
//   gateway: TDX quote (Intel PCS, default TCB UpToDate), report_data = sha256(signing_address || tls_spki) || nonce,
//            and the prompt channel is pinned to that SPKI;
//   model:   ≥1 attestation; default each TDX quote UpToDate, report_data = sha256(signing_address || tls_spki) (or pad32(address)) || nonce,
//            keccak(signing_public_key) = signing_address, GPU evidence nonce + NVIDIA NRAS verdict,
//            app_compose measured into RTMR3;
//   E2EE:    message contents encrypted to the model's attested key (secp256k1 ECDH + HKDF + AES-GCM).
// A model with no TEE attestation (NEAR proxies Anthropic, OpenAI, Google, ...) is ○ outside: refused.
// Reported, not gating: compose hash in the reviewed anchor (anchors/nearai_mainnet.json), os_image_hash.
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT } from "./config.mjs";
import { keccak256 } from "./keccak.mjs";
import { secp256k1 } from "@noble/curves/secp256k1.js";

const require = createRequire(path.join(ROOT, "aci", "package.json"));
export const { INTEL_PCS_URL } = require("@phala/dcap-qvl");
// @phala/dcap-qvl fetches Intel PCS collateral with `const fetch = globalThis.fetch`, captured when its module loads,
// and takes no fetch argument. The seam: load a separate copy of it per fetch implementation, with globalThis.fetch
// set to that implementation only for the duration of the load. The global is restored before anything else runs.
const qvls = new Map();
export function qvl(http) {
  if (!qvls.has(http)) {
    const saved = globalThis.fetch;
    for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}@phala${path.sep}dcap-qvl${path.sep}`)) delete require.cache[k];
    globalThis.fetch = http;
    try { qvls.set(http, require("@phala/dcap-qvl")); } finally { globalThis.fetch = saved; }
  }
  return qvls.get(http);
}
const { verifyComposeMeasurement } = await import(path.join(ROOT, "aci/verifier-ts/dist/index.js"));
const { createPinnedTransport } = await import(path.join(ROOT, "aci/verifier-ts/dist/node/transport.js"));
const NRAS = "https://nras.attestation.nvidia.com/v3/attest/gpu";
// NRAS signs its verdict as an ES384 JWT. The keys are in the issuer's JWKS, each with an x5c chain: a short-lived leaf
// (about 2 days) under "NVIDIA Attestation Service GPU Intermediate 004", issued by "NVIDIA Attestation Service CA 001",
// which the JWKS does not carry. The pin is that intermediate's SHA-256 fingerprint (valid to 2029-12-08; all 72 keys in
// the JWKS chained to it on 2026-10-08). A new intermediate is refused until it is reviewed and added here.
const NRAS_ISS = "https://nras.attestation.nvidia.com";
const NRAS_INTERMEDIATES = ["2D:F8:90:7C:F4:D6:C2:77:B8:55:D4:07:EC:17:8A:64:99:30:A8:E7:3F:72:94:E8:FC:E6:6E:6E:E2:7C:51:75"];
const jwkss = new Map(); // http → the issuer's JWKS, fetched once per process
const anchor = JSON.parse(fs.readFileSync(path.join(ROOT, "anchors/nearai_mainnet.json"), "utf8"));
const anchored = new Set(JSON.stringify(anchor.models).match(/[0-9a-f]{64}/g));

function must(ok, what) { if (!ok) throw new Error(`✗ refused: NEAR attestation: ${what}`); }

export const OUT_OF_DATE_TRIAL_POLICY = "UpToDate-or-OutOfDate-with-warning";
async function quote(hex, nonce, first32, who, tcb, http, details) {
  must(["UpToDate", "reported", OUT_OF_DATE_TRIAL_POLICY].includes(tcb), `${who} TCB policy "${tcb}" is not UpToDate, reported or ${OUT_OF_DATE_TRIAL_POLICY}`);
  const v = await qvl(http).getCollateralAndVerify(Buffer.from(hex, "hex"), INTEL_PCS_URL);
  if (tcb === "UpToDate") must(v.status === "UpToDate", `${who} TCB status ${v.status} is not UpToDate (${(v.advisory_ids ?? []).join(", ")})`);
  if (tcb === OUT_OF_DATE_TRIAL_POLICY) must(["UpToDate", "OutOfDate"].includes(v.status), `${who} TCB status ${v.status} is outside the explicit trial exception`);
  const rd = Buffer.from(v.report.asTd10().reportData);
  must(rd.subarray(0, 32).equals(first32), `${who} report_data does not bind its signing address`);
  must(rd.subarray(32, 64).toString("hex") === nonce, `${who} report_data does not carry our nonce`);
  if (details) { details.status = v.status; details.advisoryIds = [...(v.advisory_ids ?? [])]; }
  return `${v.status}${v.advisory_ids?.length ? " " + v.advisory_ids.join(",") : ""}`;
}

// The verdict and how far it was checked: "signature checked", or "signature not checked: <why>" only when the JWKS
// cannot be fetched. Any other failure (algorithm, unknown key, chain off the pin, signature, issuer, times, nonce) refuses.
export async function gpu(ma, nonce, http, requireSignature = false) {
  const payload = JSON.parse(ma.nvidia_payload);
  must(payload.nonce.toLowerCase() === nonce, "GPU evidence nonce is not ours");
  const r = await http(NRAS, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: ma.nvidia_payload });
  must(r.ok, `NVIDIA NRAS answered HTTP ${r.status}`);
  const jwt = (await r.json())[0][1];
  const [h64, p64, s64] = jwt.split("."), head = JSON.parse(Buffer.from(h64, "base64url")), claims = JSON.parse(Buffer.from(p64, "base64url"));
  must(head.alg === "ES384", `NRAS token algorithm ${head.alg} is not ES384`);
  must(claims.iss === NRAS_ISS, `NRAS token issuer ${claims.iss} is not ${NRAS_ISS}`);
  // Cached per process; fetched again once when the token names a key the cached copy lacks (NVIDIA rotates keys daily).
  const load = () => {
    if (!jwkss.has(http)) jwkss.set(http, http(`${NRAS_ISS}/.well-known/jwks.json`).then(async (j) => { if (!j.ok) throw new Error(`HTTP ${j.status}`); return j.json(); })
      .catch((e) => { jwkss.delete(http); return { unavailable: `${NRAS_ISS} JWKS: ${e.cause?.code ?? e.message}` }; }));
    return jwkss.get(http);
  };
  let jwks = await load();
  if (!jwks.unavailable && !jwks.keys.some((k) => k.kid === head.kid)) { jwkss.delete(http); jwks = await load(); }
  if (requireSignature) must(!jwks.unavailable, "NVIDIA verdict signature is required; its JWKS is unavailable");
  let checked = "signature not checked: " + jwks.unavailable;
  if (!jwks.unavailable) {
    const key = jwks.keys.find((k) => k.kid === head.kid);
    must(key, `NRAS token key ${head.kid} is not in NVIDIA's JWKS`);
    const [leaf, inter] = key.x5c.map((b) => new crypto.X509Certificate(Buffer.from(b, "base64")));
    must(inter && NRAS_INTERMEDIATES.includes(inter.fingerprint256), `NRAS key ${head.kid} does not chain to the pinned NVIDIA intermediate`);
    const at = new Date(claims.iat * 1000);
    must(leaf.verify(inter.publicKey) && new Date(leaf.validFrom) <= at && at <= new Date(leaf.validTo), `NRAS key ${head.kid}: its certificate is not signed by the intermediate or was not valid when the token was issued`);
    must(crypto.verify("sha384", Buffer.from(`${h64}.${p64}`), { key: leaf.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s64, "base64url")), "NRAS token signature does not verify");
    checked = "signature checked";
  }
  const now = Date.now() / 1000;
  must(claims.iat <= now + 300 && claims.nbf <= now + 300 && now < claims.exp, `NRAS token is not valid now (iat ${claims.iat}, nbf ${claims.nbf}, exp ${claims.exp})`);
  must(claims.eat_nonce?.toLowerCase() === nonce, "NRAS token is not bound to our nonce");
  must(claims["x-nvidia-overall-att-result"] === true, "NVIDIA NRAS verdict is not true");
  return `GPU: NVIDIA verdict (${checked})`;
}

// app_compose is measured into the quote's RTMR3 (tcb_info.event_log replays to it; the top-level model
// event_log does not, so it is not used).
// Returns the compose hash and the app id (the DstackApp contract), both from the event log that replayed to RTMR3.
async function measured(att, who) {
  const tcb = typeof att.info.tcb_info === "string" ? JSON.parse(att.info.tcb_info) : att.info.tcb_info;
  const el = tcb.event_log ?? att.event_log;
  const m = await verifyComposeMeasurement({ attestation: { evidence: { event_log: typeof el === "string" ? el : JSON.stringify(el), app_compose: tcb.app_compose, quote: att.intel_quote } } });
  must(m.ok, `${who} compose not measured into RTMR3: ${m.checks.filter((c) => !c.ok).map((c) => c.detail).join("; ")}`);
  const app = (typeof el === "string" ? JSON.parse(el) : el).filter((e) => e.event === "app-id").map((e) => e.event_payload);
  must(app.length === 1 && /^[0-9a-f]{40}$/.test(app[0]), `${who} event log has no single app-id`);
  return { compose: m.composeHash, app: "0x" + app[0] };
}

// NEAR's code admission is its own on-chain governance: each CVM's app id is a DstackApp contract on Base, and a compose
// runs only if that contract's allowedComposeHashes holds it. abalone asks the same contract (policy.composeRegistry: a
// pinned RPC and chain id) at one block, and refuses if the RPC cannot be reached or the compose is not allowed. This
// follows NEAR's rotations without a local list; it also means NEAR's DstackApp owner decides what code runs.
async function allowedOnChain(reg, entries, http) {
  if (!reg) throw new Error("✗ refused: providers.json nearai.policy.composeRegistry is not set (the chain that admits NEAR's code)");
  let id = 0;
  const rpc = async (method, params) => {
    const r = await http(reg.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })
      .catch((e) => { throw new Error(`✗ refused: NEAR's compose registry RPC ${reg.rpc} is unreachable (${e.message}); nothing was sent`); });
    const j = await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }));
    if (j.error) throw new Error(`✗ refused: NEAR's compose registry RPC ${reg.rpc}: ${method}: ${j.error.message}`);
    return j.result;
  };
  must(Number(await rpc("eth_chainId", [])) === reg.chainId, `compose registry RPC is not chain ${reg.chainId}`);
  const block = await rpc("eth_blockNumber", []);
  for (const e of entries) {
    const out = await rpc("eth_call", [{ to: e.app, data: "0x" + keccak256(Buffer.from("allowedComposeHashes(bytes32)")).subarray(0, 4).toString("hex") + e.compose }, block]);
    must(BigInt(out) === 1n, `${e.who} compose ${e.compose.slice(0, 16)}… is not allowed by its DstackApp ${e.app} on chain ${reg.chainId} at block ${Number(block)}`);
  }
  return { chain_id: reg.chainId, rpc: reg.rpc, block: Number(block), apps: [...new Set(entries.map((e) => e.app))] };
}

// policy.gatewayTcb (providers.json): "UpToDate" gates the gateway quote's TCB like every other quote;
// "reported" records it instead. The explicit debug trial exception admits only
// cryptographically verified UpToDate or OutOfDate on the selected component.
// getReport(pathAndQuery) fetches the report: straight from NEAR with a configured key, or through a gift peer,
// which only relays it (the nonce is ours, so a relayed report verifies the same way).
// NEAR's model list marks TEE-served models by owner. The listing only places a model; verifyNearModel still gates it.
export const ATTESTED_OWNERS = ["nearai", "attested 3p"];
// Text a gift peer or NEAR supplies (": abalone-status" lines, error bodies) is untrusted: no escape sequences, controls
// or bidi characters reach the terminal, it is one line, and it is shown as what the peer says, never as a verifier field.
export const untrusted = (s) => s.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/ +/g, " ").trim().slice(0, 200);
export const peerStatus = (line) => `peer says: ${untrusted(line.slice(": abalone-status ".length))}`;
export const reportPath = (model, nonce) => `/v1/attestation/report?model=${encodeURIComponent(model)}&nonce=${nonce}&signing_algo=ecdsa&include_tls_fingerprint=true`;
export const withKey = (baseUrl, key) => (p) => fetch(new URL(baseUrl).origin + p, { headers: { authorization: `Bearer ${key}` } });
// http: the fetch used for NRAS (the peer under the Mac runner passes its runner-socket fetch). Intel PCS collateral is
// fetched inside @phala/dcap-qvl, which calls the global fetch and offers no hook; the runner-mode peer therefore
// also routes the global fetch through the runner socket (lib/node.mjs).
export async function verifyNearModel(baseUrl, model, getReport, policy = {}, http = fetch, onStage = () => {}) {
  const nonce = crypto.randomBytes(32).toString("hex");
  onStage("attestation-report-request");
  const r = await getReport(reportPath(model, nonce));
  onStage("attestation-report-response", r.status);
  if (r.status === 401 || r.status === 403) throw new Error(`NEAR attestation report refused: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  if (!r.ok) throw new Error(`✗ refused: nearai/${model} is ○ outside: NEAR serves no TEE attestation for it (HTTP ${r.status}); private agents may not use it`);
  return checkReport(await r.json(), nonce, baseUrl, model, policy, http, onStage);
}
// A report fetched by someone else (the Mac runner) is checked the same way against the nonce it carries; its
// freshness then rests on whoever chose that nonce.
export const reportNonce = (rep) => JSON.parse(rep.model_attestations[0].nvidia_payload).nonce.toLowerCase();
export async function checkReport(rep, nonce, baseUrl, model, policy = {}, http = fetch, onStage = () => {}) {
  onStage("gateway-binding");
  const gw = rep.gateway_attestation;
  must(gw?.tls_cert_fingerprint && gw.signing_algo === "ecdsa", "gateway attestation has no TLS binding");
  const addr = (a) => Buffer.from(a.replace(/^0x/i, ""), "hex");
  const gatewayVerdict = {};
  onStage("gateway-quote");
  const gatewayTcb = await quote(gw.intel_quote, nonce, crypto.createHash("sha256").update(addr(gw.signing_address)).update(Buffer.from(gw.tls_cert_fingerprint, "hex")).digest(), "gateway", policy.gatewayTcb ?? "UpToDate", http, gatewayVerdict);
  onStage("gateway-measurement");
  const gatewayM = await measured(gw, "gateway"), gatewayCompose = gatewayM.compose;
  const mas = rep.model_attestations ?? [];
  if (!mas.length) throw new Error(`✗ refused: nearai/${model} is ○ outside: no model attestation; private agents may not use it`);
  const composes = [], admitted = [{ who: "gateway", ...gatewayM }], modelTcb = [], modelVerdicts = [], gpus = [];
  for (const ma of mas) {
    onStage("model-binding");
    // NEAR also relays some models' attestations from other TEE operators (e.g. provider "chutes": quote_b64, an ML-KEM
    // e2e key, no signing address). abalone verifies only NEAR's own format so far.
    if (!ma.signing_public_key) throw new Error(`✗ refused: nearai/${model} is attested by ${ma.provider ?? "an unknown operator"} in a format abalone does not verify yet (no secp256k1 signing key; fields: ${Object.keys(ma).join(", ")}); nothing was sent`);
    must(ma.model_name === model, `model attestation is for ${ma.model_name}, not ${model}`);
    must("0x" + keccak256(Buffer.from(ma.signing_public_key, "hex")).subarray(12).toString("hex") === ma.signing_address.toLowerCase(), "signing_public_key does not hash to signing_address");
    // With include_tls_fingerprint the model binds sha256(address || its own TLS SPKI); otherwise the padded address.
    const modelVerdict = {};
    onStage("model-quote");
    await quote(ma.intel_quote, nonce, ma.tls_cert_fingerprint ? crypto.createHash("sha256").update(addr(ma.signing_address)).update(Buffer.from(ma.tls_cert_fingerprint, "hex")).digest()
      : Buffer.concat([addr(ma.signing_address), Buffer.alloc(12)]), "model", policy.modelTcb ?? "UpToDate", http, modelVerdict).then((t) => modelTcb.push(t));
    modelVerdicts.push(modelVerdict);
    onStage("nvidia-attestation");
    gpus.push(await gpu(ma, nonce, http, policy.gpuSignature === "required"));
    onStage("model-measurement");
    const mm = await measured(ma, "model");
    composes.push(mm.compose); admitted.push({ who: "model", ...mm });
  }
  onStage("compose-registry");
  const registry = await allowedOnChain(policy.composeRegistry, admitted, http);
  onStage("transport-binding");
  const pinned = createPinnedTransport({ hostname: new URL(baseUrl).hostname, spkiPins: [gw.tls_cert_fingerprint], origin: new URL(baseUrl).origin });
  return {
    signingPublicKey: mas[0].signing_public_key,
    // A failed SPKI pin becomes a 403 carrying its reason: the OpenAI client would report a thrown fetch only as
    // "Connection error." and retry it, laundering a security rejection. Other transport failures (an outage) still throw.
    transport: { close: () => pinned.close(), fetch: (input, init) => pinned.fetch(input, init).catch((e) => {
      if (!/SPKI pin mismatch/.test(e.message)) throw e;
      return new Response(JSON.stringify({ error: { message: `✗ refused: ${e.message}` } }), { status: 403, headers: { "content-type": "application/json" } });
    }) },
    profile: { model, place: "◈ attested", nonce, gateway_tcb: gatewayTcb, gateway_tcb_status: gatewayVerdict.status, gateway_tcb_advisory_ids: gatewayVerdict.advisoryIds, gateway_tcb_policy: policy.gatewayTcb ?? "UpToDate", model_tcb: modelTcb, model_tcb_statuses: modelVerdicts.map(v => v.status), model_tcb_advisory_ids: modelVerdicts.map(v => v.advisoryIds), model_tcb_policy: policy.modelTcb ?? "UpToDate", gateway_compose: gatewayCompose, tls_spki: gw.tls_cert_fingerprint, gateway_signing_address: gw.signing_address, model_signing_address: mas[0].signing_address,
      compose_hashes: composes, code: `admitted by NEAR's DstackApp governance: ${registry.apps.join(", ")} allow these composes on chain ${registry.chain_id} at block ${registry.block}`,
      compose_registry: registry, anchor: composes.every((c) => anchored.has(c)) ? "compose in reviewed anchor" : `compose not in reviewed anchor (captured ${anchor.captured_at})`,
      os_image_hash: mas[0].info.os_image_hash, gpu: [...new Set(gpus)].join("; "), custody: "unchecked" },
  };
}

// Per-chat signature (GET /v1/signature/<chat id>?model=&signing_algo=ecdsa, measured 2026-10-08), EIP-191 personal_sign
// by a key an attested quote binds (checkReport above): signature_kind "gateway" (a plain chat) signs
// "sha256(request body):sha256(response bytes)" with the gateway's signing address; "provider_tee" (an E2EE chat)
// signs "<model>:sha256(request body):sha256(response bytes)" with the model's.
// A reply that verifies is the bytes NEAR sent for exactly this request, whoever relayed it. Null when it verifies,
// else the reason.
export function chatSignatureFails(sig, request, response, profile) {
  const expect = { gateway: profile.gateway_signing_address, provider_tee: profile.model_signing_address }[sig?.signature_kind];
  const h = (b) => crypto.createHash("sha256").update(b).digest("hex");
  if (sig?.signing_algo !== "ecdsa" || !expect) return `unexpected signature kind ${sig?.signature_kind}/${sig?.signing_algo}`;
  if (sig.text !== `${sig.signature_kind === "provider_tee" ? `${profile.model}:` : ""}${h(request)}:${h(response)}`) return "the signed request and response hashes do not match what this computer sent and received";
  const b = Buffer.from(sig.signature.replace(/^0x/, ""), "hex"), text = Buffer.from(sig.text);
  const digest = keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${text.length}`), text]));
  const pub = secp256k1.Point.fromBytes(secp256k1.recoverPublicKey(Buffer.concat([Buffer.from([b[64] - 27]), b.subarray(0, 64)]), digest, { prehash: false })).toBytes(false);
  const signer = "0x" + keccak256(Buffer.from(pub).subarray(1)).subarray(12).toString("hex");
  return signer === expect.toLowerCase() ? null : `signed by ${signer}, not the attested ${sig.signature_kind} key ${expect}`;
}

// secp256k1 ECDH + HKDF-SHA256("ecdsa_encryption") + AES-256-GCM; wire format eph_pub(65) || nonce(12) || ct || tag.
const kdf = (shared) => Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.alloc(0), "ecdsa_encryption", 32));
export function encrypt(text, pubHex) {
  const eph = crypto.createECDH("secp256k1"); eph.generateKeys();
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", kdf(eph.computeSecret(Buffer.from("04" + pubHex.replace(/^04(?=.{128}$)/, ""), "hex"))), iv);
  return Buffer.concat([eph.getPublicKey(), iv, c.update(text, "utf8"), c.final(), c.getAuthTag()]).toString("hex");
}
export function decrypt(hex, ecdh) {
  const b = Buffer.from(hex, "hex"), d = crypto.createDecipheriv("aes-256-gcm", kdf(ecdh.computeSecret(b.subarray(0, 65))), b.subarray(65, 77));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(77, b.length - 16)), d.final()]).toString("utf8");
}
