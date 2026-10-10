// Fixture site for the browser tests, on 127.0.0.1 (granted) and reachable as localhost (not granted).
// The form page sets a cookie whose value must never reach the agent; /steal counts hits that should never happen.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const COOKIE = "COOKIE-MARKER-5f1e";
export function serve() {
  const hits = { steal: 0, localhost: 0 };
  const server = http.createServer((req, res) => {
    if (req.headers.host?.startsWith("localhost")) hits.localhost++;
    const page = (name) => fs.readFileSync(path.join(import.meta.dirname, name), "utf8").replaceAll("{{PORT}}", server.address().port);
    const html = (s, h = {}) => res.writeHead(200, { "content-type": "text/html", ...h }).end(s);
    if (req.url === "/form.html") return html(page("form.html"), { "set-cookie": `sid=${COOKIE}; Path=/` });
    if (["/hostile.html", "/secret.html"].includes(req.url)) return html(page(req.url.slice(1)));
    if (req.url.startsWith("/redir")) return res.writeHead(302, { location: `http://localhost:${server.address().port}/steal?via=redir` }).end();
    // Stands in for the human during Take control: the page goes off-grant by itself after 2.5 s.
    if (req.url === "/later.html") return html(`<title>later</title><script>setTimeout(() => location = "http://localhost:${server.address().port}/secret.html", 2500)</script>`);
    if (req.url.startsWith("/slow")) return setTimeout(() => html("<title>slow</title><p>slow page</p>"), 8000);
    if (req.url.startsWith("/steal")) { hits.steal++; return html("<title>steal</title><textarea></textarea>"); }
    if (req.url === "/echo") {
      let b = "";
      req.on("data", (d) => (b += d));
      return req.on("end", () => html(`<title>Order received</title><h1>Order received</h1><pre>${[...new URLSearchParams(b)].map(([k, v]) => `${k}=${v}`).join("\n")}</pre>`));
    }
    res.writeHead(404).end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ port: server.address().port, hits, close: () => server.close() })));
}
