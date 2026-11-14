// Serves dist/ and the PingPay pass-through. deno run --allow-net --allow-read=. server.ts [port]
import { nearPay } from "./near-pay.mjs";
const root = new URL("./dist/", import.meta.url);
const types: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8", json: "application/json; charset=utf-8", svg: "image/svg+xml", webp: "image/webp",
  png: "image/png", wasm: "application/wasm", woff2: "font/woff2" };

export default async function handler(req: Request) {
  const path = decodeURIComponent(new URL(req.url).pathname);
  if (path.startsWith("/near-pay/")) return await nearPay(req);
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const parts = path.split("/").filter(Boolean);
  if (parts.some((p) => p.startsWith(".") || /[\\\0]/.test(p))) return new Response("Invalid path", { status: 400 });
  const file = parts.join("/") || "index.html", type = types[file.split(".").pop() ?? ""];
  if (!type) return new Response("Not found", { status: 404 });
  try {
    const bytes = await Deno.readFile(new URL(file, root));
    return new Response(req.method === "HEAD" ? null : bytes, { headers: { "content-type": type, "cache-control": "no-cache",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound || e instanceof Deno.errors.IsADirectory) return new Response("Not found", { status: 404 });
    throw e;
  }
}

if (import.meta.main) Deno.serve({ hostname: "127.0.0.1", port: Number(Deno.args[0] ?? "8789") }, handler);
