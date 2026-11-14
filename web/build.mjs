// Bundles the page into dist/: static files with relative paths, so it can be served by server.ts, any static host
// or an IPFS subdomain gateway. Set NEAR_PAY to an absolute pass-through URL for hosts without server.ts.
import { build } from "esbuild";
import { copyFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nearRequestBodyPlugin } from "./near-browser-build.mjs";

const app = dirname(fileURLToPath(import.meta.url)), dist = resolve(app, "dist");
const pi = resolve(app, "node_modules/@earendil-works/pi-web-ui/dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  absWorkingDir: app, entryPoints: { app: "app.mjs" }, bundle: true, splitting: true, format: "esm", platform: "browser",
  target: "es2022", minify: true, outdir: "dist", plugins: [nearRequestBodyPlugin()],
  alias: { process: "process/browser.js", "@pi-components": pi },
  define: { "process.env.NODE_ENV": '"production"' }, logLevel: "info",
});
const config = JSON.parse(await readFile(resolve(app, "config.json"), "utf8"));
if (process.env.NEAR_PAY) config.nearPay = process.env.NEAR_PAY;
await writeFile(resolve(dist, "config.json"), JSON.stringify(config));
await copyFile(resolve(app, "style.css"), resolve(dist, "style.css"));
await copyFile(resolve(pi, "app.css"), resolve(dist, "pi.css"));
await cp(resolve(app, "assets"), resolve(dist, "assets"), { recursive: true });
let html = await readFile(resolve(app, "index.html"), "utf8");
for (const name of ["app.js", "style.css", "pi.css"]) {
  const hash = createHash("sha256").update(await readFile(resolve(dist, name))).digest("hex").slice(0, 16);
  const hashed = name.replace(/\.(js|css)$/, `.${hash}.$1`);
  await rename(resolve(dist, name), resolve(dist, hashed));
  html = html.replaceAll(`./${name}`, `./${hashed}`);
}
await writeFile(resolve(dist, "index.html"), html);
