// Shared Intel quote and NVIDIA verdict checks. No launcher, coupon or agent state.
import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
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
const NRAS = "https://nras.attestation.nvidia.com/v3/attest/gpu";
// NRAS signs its verdict as an ES384 JWT. The keys are in the issuer's JWKS, each with an x5c chain: a short-lived leaf
// (about 2 days) under "NVIDIA Attestation Service GPU Intermediate 004", issued by "NVIDIA Attestation Service CA 001",
// which the JWKS does not carry. The pin is that intermediate's SHA-256 fingerprint (valid to 2029-12-08; all 72 keys in
// the JWKS chained to it on 2026-10-08). A new intermediate is refused until it is reviewed and added here.
const NRAS_ISS = "https://nras.attestation.nvidia.com";
const NRAS_INTERMEDIATES = ["2D:F8:90:7C:F4:D6:C2:77:B8:55:D4:07:EC:17:8A:64:99:30:A8:E7:3F:72:94:E8:FC:E6:6E:6E:E2:7C:51:75"];
const jwkss = new Map(); // http → the issuer's JWKS, fetched once per process

function must(ok, what) { if (!ok) throw new Error(`✗ refused: NEAR attestation: ${what}`); }

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

