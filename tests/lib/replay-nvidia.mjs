// Replays a recording from tools/record-near-fixture.mjs: each response by URL, method and request body (a binary body
// as "base64:…"). The verifier draws NVIDIA OCSP nonces at random, so a replay passes recordedOcspNonce explicitly: the
// nonce of the recorded request about that certificate (the last 32 bytes of the request).
export const requestKey = (b) => (b == null ? null : typeof b === "string" ? b : "base64:" + Buffer.from(b).toString("base64"));
export const replayer = (fx) => (edit = (r) => r) => async (url, init = {}) => {
  const r = fx.http.find((h) => h.url === String(url) && h.method === (init.method ?? "GET") && (h.request ?? null) === requestKey(init.body));
  if (!r) throw new Error(`no recorded response for ${init.method ?? "GET"} ${url}`);
  const e = edit({ ...r, body: Buffer.from(r.body, "base64") });
  return new Response(e.body, { status: e.status, headers: e.headers });
};
export const ocspRequests = (fx) => fx.http.filter((h) => h.url.includes("ocsp.ndis")).map((h) => Buffer.from(h.request.slice(7), "base64"));
export const recordedOcspNonce = (fx) => (cert) => {
  const req = ocspRequests(fx).find((q) => q.includes(Buffer.from(cert.serialNumber, "hex")));
  if (!req) throw new Error(`no recorded OCSP request for ${cert.subject}`);
  return req.subarray(-32);
};
