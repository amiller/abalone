// The synthetic provider sees a socket capability, never the provider credential.
import http from "node:http";

export const couponSocketFetch = (socketPath) => async (_url, init) => new Promise((resolve, reject) => {
  const error = () => new Error("The coupon session broker is unavailable. Keep the original process open; do not claim with new keys.");
  if (init.signal?.aborted) { reject(error()); return; }
  const request = http.request({ socketPath, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", authorization: "Bearer coupon-session" } }, (r) => {
    const chunks = []; let bytes = 0;
    r.on("data", (c) => { bytes += c.length; if (bytes > 2 * 1024 * 1024) request.destroy(); else chunks.push(c); });
    r.on("error", () => reject(error()));
    r.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: r.statusCode ?? 502, headers: { "content-type": String(r.headers["content-type"] ?? "application/json") } })));
  });
  const abort = () => request.destroy(error());
  const timer = setTimeout(abort, 150_000); timer.unref();
  init.signal?.addEventListener("abort", abort, { once: true });
  request.on("error", () => reject(error()));
  request.on("close", () => { clearTimeout(timer); init.signal?.removeEventListener("abort", abort); });
  if (init.signal?.aborted) { abort(); return; }
  request.end(init.body);
});
