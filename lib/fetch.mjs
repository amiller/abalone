// /fetch: the user brings a public document into the workspace. The URL is a disclosure (it says what you read), so
// abalone decides the route: public (this machine fetches directly) only for a URL that reveals nothing beyond which
// public paper it is, sealed otherwise: abalone's built-in Tor (lib/tor.mjs), so the request is not tied to this
// machine's address. A sensitive URL never goes out publicly without the user's answer, and a Tor failure never turns
// into a public fetch. The sandbox stays without network: the launcher fetches (bin/abalone.mjs ctl "fetch").
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { canaries } from "./gate.mjs";
import { bounded } from "./tor.mjs";

const ARXIV = /^\/(abs|pdf)\/(\d{4}\.\d{4,5}(v\d+)?)(\.pdf)?$/;
// Sensitive topics (pour-planning step 3): health, legal, financial, personal.
const TOPICS = { health: /diagnos|cancer|hiv|pregnan|abortion|therap|medicat|symptom|disease|mental|psychiat|addict|clinic/i,
  legal: /lawsuit|divorce|custody|arrest|evict|lawyer|attorney|court|immigra|asylum|visa/i,
  financial: /bank|loan|debt|salary|tax|bankrupt|mortgage|credit|invoice|payroll/i,
  personal: /passport|ssn|social.security|address|phone|birth|@[a-z0-9-]+\.[a-z]/i };

// arxiv:2410.12345 → its PDF; anything else must be an https URL.
export function resolve(arg) {
  const m = arg.match(/^arxiv:(\d{4}\.\d{4,5}(v\d+)?)$/i);
  const url = new URL(m ? `https://arxiv.org/pdf/${m[1]}` : arg);
  if (url.protocol !== "https:") throw new Error(`/fetch takes https URLs or arxiv:<id>, not ${url.protocol}`);
  return url;
}

// { route, reason }: public only for a bare arXiv paper URL; everything else is sealed, with the reason in words.
export function decide(url, cwd) {
  const text = decodeURIComponent(`${url.hostname}${url.pathname}${url.search}`).toLowerCase();
  const topic = Object.entries(TOPICS).find(([, re]) => re.test(text))?.[0];
  if (topic) return { route: "sealed", reason: `the address mentions a ${topic} topic` };
  const word = fs.readdirSync(cwd).map((f) => path.parse(f).name.toLowerCase()).find((n) => n.length >= 4 && text.includes(n));
  if (word) return { route: "sealed", reason: `the address contains "${word}", the name of a file in this folder` };
  if (canaries().some((c) => text.includes(c.value.toLowerCase()))) return { route: "sealed", reason: "the address contains a canary value from your private material" };
  if (url.hostname === "arxiv.org" && ARXIV.test(url.pathname) && !url.search) return { route: "public", reason: "it is a public arXiv paper ID, which says only which paper you read" };
  if (url.search) return { route: "sealed", reason: "the address carries a query, which may say what you are looking for" };
  return { route: "sealed", reason: `${url.hostname} is not on the public allowlist (arxiv.org), so abalone does not assume the address is harmless` };
}


export const fileName = (url) => {
  const m = url.hostname === "arxiv.org" && url.pathname.match(ARXIV);
  return m ? `arxiv-${m[2]}.pdf` : (path.basename(url.pathname) || url.hostname).replace(/[^\w.-]/g, "_");
};

// Launcher side: download over https into the workspace, at most 20 MB. Public: curl from this machine (for tests only,
// ABALONE_FETCH_CURL_ARGS, a JSON array, points it at a stub server and its CA). Sealed: the Tor transport, or an error.
const MAX = 20_000_000;
export async function download(url, route, cwd, tor) {
  const file = path.join(cwd, fileName(url));
  if (fs.existsSync(file)) throw new Error(`${path.basename(file)} is already in this folder; nothing was fetched`);
  if (route === "sealed") {
    const res = await tor.fetch(url.href, { method: "GET" });
    if (!res.ok) throw new Error(`${url.hostname} answered HTTP ${res.status} through Tor; nothing was saved`);
    fs.writeFileSync(file, await bounded(res, MAX));
    return { file: path.basename(file), bytes: fs.statSync(file).size, via: `sealed (${tor.name})` };
  }
  const r = spawnSync("curl", ["-sSfL", "--proto", "=https", "--proto-redir", "=https", "--max-filesize", String(MAX), "--max-time", "120",
    ...JSON.parse(process.env.ABALONE_FETCH_CURL_ARGS ?? "[]"), "-o", file, "--", url.href], { encoding: "utf8" });
  if (r.status !== 0) { fs.rmSync(file, { force: true }); throw new Error(`fetch failed (curl exit ${r.status}): ${r.stderr.trim()}`); }
  return { file: path.basename(file), bytes: fs.statSync(file).size, via: "public" };
}
