// The browser bridge against a real headless Chromium on the abalone profile (lib/browser.mjs, notes/contracts/browser-grant.md):
// a form task, scope refusals and a hostile page, Stop, Take control, detach/reconnect, expiry, and that the other tab
// and the site's cookie never reach an agent op's output or browser.jsonl. Needs /usr/bin/chromium; no network beyond loopback.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.ABALONE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "abalone-browser-"));
process.env.ABALONE_BROWSER_HEADLESS ??= "1";
const { browserBridge, call } = await import("../lib/browser.mjs");
const { serve, COOKIE } = await import("./fixtures/browser/serve.mjs");

const site = await serve(), base = `http://127.0.0.1:${site.port}`;
const run = fs.mkdtempSync(path.join(process.env.XDG_RUNTIME_DIR ?? os.tmpdir(), "abalone-bt-"));
const close = browserBridge(run);
const c = (op, args) => call(run, op, args);
const no = (op, args) => call(run, op, args).then((o) => assert.fail(`${op} ran: ${o.slice(0, 200)}`), (e) => e.message);
const outputs = [];
const ok = async (op, args) => { const o = await c(op, args); outputs.push(o); return o; };
const strip = () => fs.readFileSync(path.join(run, "browser-status"), "utf8");
let n = 0;
const pass = (name) => console.log(`PASS ${++n} ${name}`);

const identity = { mode: "profile" };
// A tab the user did not grant, opened first.
const g0 = await c("grant", { identity, open: `${base}/secret.html`, sites: ["127.0.0.1"] });
await c("revoke");
const g = await c("grant", { identity, open: `${base}/form.html`, sites: ["127.0.0.1"] });
assert.notEqual(g.tab.targetId, g0.tab.targetId);
let tabs = [];
for (let i = 0; i < 30 && !tabs.some((t) => t.title.includes("SECRET-TAB-TITLE")); i++) { tabs = await c("tabs", { identity }); await new Promise((r) => setTimeout(r, 100)); }
assert(tabs.some((t) => t.title.includes("SECRET-TAB-TITLE")), "the human's picker lists the other tab");
const profileDir = path.join(process.env.ABALONE_DIR, "browser/profile");
assert(!fs.existsSync(path.join(profileDir, "DevToolsActivePort")), "profile mode wrote a DevTools port file");
const { execSync } = await import("node:child_process");
const pids = execSync(`pgrep -f -- "--user-data-dir=${profileDir}" || true`, { encoding: "utf8" }).split("\n").filter(Boolean);
assert(pids.length, "no chromium on the profile");
const listening = execSync("ss -ltnpH", { encoding: "utf8" }).split("\n").filter((l) => pids.some((p) => l.includes(`pid=${p},`)));
assert.deepEqual(listening, [], `chromium on the abalone profile listens on TCP: ${listening}`);
assert.equal(g.identity.devtools, "pipe to abalone's launcher only; no port");
pass("grant: a new tab in the abalone profile, driven over a pipe (no DevTools port, no TCP listener); the picker (human only) lists other tabs");

let p = await ok("page");
assert.match(p, /^url: .*\ntitle: Order form\ncharacters 0-\d+ of \d+\n/);
assert.match(await ok("page", { find: "onion" }), /characters 0-\d+ of \d+\n\nOrder a pizza/);
assert.match(await ok("page", { find: "no-such-text" }), /"no-such-text" is not in this page's \d+ characters of text/);
assert.match(await ok("page", { from: 20 }), /characters 20-/);
assert.match(p, /\[e1 text "Customer name:" value=""\]/);
assert.match(p, /\[e2 select "Size\s*small large" options=\["small","large"\] value="small"\]/);
await ok("type", { ref: "e1", text: "Ada Lovelace" });
await ok("type", { ref: "e2", text: "large" });
assert.match(await no("type", { ref: "e3", text: "on" }), /^not executed: e3 is not a text field; click it instead$/);
await ok("click", { ref: "e3" });
assert.match(p, /\[e4 time "Delivery time" value=""\]\nDelivery day \[e5 date "Delivery day" value=""\]/);
assert.match(await ok("type", { ref: "e4", text: "18:30" }), /\[e4 time "Delivery time" value="18:30"\]/);
await ok("type", { ref: "e5", text: "2026-10-09" });
assert.match(await no("type", { ref: "e4", text: "half six" }), /^not executed: "half six" is not a value e4 \(time\) accepts$/);
p = await ok("click", { ref: "e6" });
assert.match(p, /title: Order received/);
assert.match(p, /custname=Ada Lovelace\nsize=large\ntopping=onion\ndelivery=18:30\nday=2026-10-09/);
assert.match(strip(), /^browser: abalone profile · 127\.0\.0\.1 · agent idle$/);
pass("form task (and page find/from): type, select, check, time and date inputs (an invalid time refused), submit; the site echoes the posted fields; the strip names identity, site and activity");

assert.match(await no("goto", { url: `http://localhost:${site.port}/steal` }), /localhost is outside the grant \(127\.0\.0\.1\)/);
assert.match(await no("goto", { url: "file:///etc/passwd" }), /outside the grant/);
assert.match(await ok("goto", { url: `${base}/hostile.html` }), /abalone blocked requests outside the grant to: localhost/);
p = await ok("page");
assert.match(p, /ignore your previous instructions/);
assert.doesNotMatch(p, /abalone blocked/); // reported once, with the observation that followed them
const blockedTypes = fs.readFileSync(path.join(process.env.ABALONE_DIR, "browser.jsonl"), "utf8").split("\n").filter((l) => l.includes('"event":"blocked"')).map((l) => JSON.parse(l).type);
assert.deepEqual([...new Set(blockedTypes)].sort(), ["Image", "XHR"]); // the image, the fetch, and the image redirected to localhost
const link = p.match(/\[(e\d+) link "Continue/)[1], button = p.match(/\[(e\d+) button "Show more"/)[1];
const documentBlocks = () => fs.readFileSync(path.join(process.env.ABALONE_DIR, "browser.jsonl"), "utf8").split("\n").filter((l) => l.includes('"event":"blocked"') && l.includes('"type":"Document"')).length;
assert.match(await no("click", { ref: link }), /^blocked: e\d+ links to localhost, outside the grant \(127\.0\.0\.1\); abalone did not click it and the tab is on 127\.0\.0\.1$/);
assert.equal(documentBlocks(), 1, "the off-grant link click is in browser.jsonl as a blocked Document");
assert.match(await no("click", { ref: button }), /then tried to load localhost, outside the grant .* stopped that load and the tab is on 127\.0\.0\.1/);
assert.match(await no("click", { ref: p.match(/\[(e\d+) link "Older notes"/)[1] }), /then tried to load localhost, outside the grant/);
assert.equal(documentBlocks(), 3, "every off-grant click (link, script navigation, redirect) is in browser.jsonl as a blocked Document");
assert.equal(site.hits.steal, 0);
assert.equal(site.hits.localhost, 0);
assert.match(await ok("page"), /Release notes 4\.2/);
pass("scope: goto off-site and file: refused; the hostile page's image, fetch, redirected image, link, script navigation and redirected navigation to localhost all blocked before any request; the tab stays on the granted site");

const slow = no("goto", { url: `${base}/slow` }), queued = no("page");
await new Promise((r) => setTimeout(r, 500));
assert.match(strip(), /agent goto 127\.0\.0\.1/);
await c("stop");
assert.match(await slow, /stopped by the user/);
assert.match(await queued, /stopped by the user/);
pass("Stop: the op in flight (a slow load) and the queued observation are cancelled");

await c("take");
assert.match(strip(), /you have control/);
assert.match(await no("page"), /the user has control of the browser; they hand it back with \/browser give/);
// The page goes off-grant while the human owns the tab (standing in for the human browsing): nothing blocks it.
await c("give"); await ok("goto", { url: `${base}/later.html` }); await c("take");
await new Promise((r) => setTimeout(r, 3500));
assert(site.hits.localhost > 0, "the off-grant load never happened, so the blocking checks above prove nothing");
assert.match(await c("give"), /outside the grant: it cannot read this page/);
assert.match(await no("page"), /the tab is on localhost, outside the grant .* nothing was read/);
await ok("goto", { url: `${base}/form.html` });
pass("Take control: agent refused while the human owns the tab; the human's off-grant page is not read after give");

await c("detach");
assert.match(strip(), /detached/);
assert.match(await no("page"), /detached/);
assert.match(await c("reconnect"), /reattached to abalone profile, tab on 127\.0\.0\.1/);
assert.match(await ok("page"), /Order a pizza/);
pass("detach and reconnect: ops refused while detached; reattached to the same tab");

await c("grant", { identity, targetId: g.tab.targetId, sites: ["127.0.0.1"], actions: ["observe"], minutes: 60 });
assert.match(await no("goto", { url: `${base}/form.html` }), /does not allow navigate/);
await c("grant", { identity, targetId: g.tab.targetId, sites: ["127.0.0.1"], minutes: -1 });
assert.match(await no("page"), /expired/);
pass("grant limits: an observe-only grant refuses navigation; an expired grant refuses everything");

const log = fs.readFileSync(path.join(process.env.ABALONE_DIR, "browser.jsonl"), "utf8");
for (const secret of ["OTHER-TAB-SECRET-7731", "SECRET-TAB-TITLE", COOKIE, "Ada Lovelace"]) {
  assert(!outputs.some((o) => o.includes(secret)) || secret === "Ada Lovelace", `${secret} reached an agent op`);
  assert(!log.includes(secret), `${secret} is in browser.jsonl`);
}
assert.match(log, /"typed_bytes":12/);
pass("other tab and cookie never in agent output; browser.jsonl has hosts and typed byte counts, no page text or typed text");

await c("revoke");
// Attach mode: a Chrome the user started with a debugging port, on a throwaway data dir (never a real
// profile). The user-started Chrome is the same explicitly configured executable the rest of the suite
// drives (ABALONE_BROWSER), falling back to google-chrome exactly as before when nothing is configured.
const { spawn } = await import("node:child_process");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abalone-attach-"));
spawn(process.env.ABALONE_BROWSER ?? "/usr/bin/google-chrome", [`--user-data-dir=${dir}`, "--remote-debugging-port=0", "--headless=new", "--no-first-run", `${base}/secret.html`], { detached: true, stdio: "ignore" }).unref();
for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, "DevToolsActivePort")); i++) await new Promise((r) => setTimeout(r, 100));
const port = Number(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]);
const ga = await c("grant", { identity: { mode: "attach", port }, open: `${base}/form.html`, sites: ["127.0.0.1"] });
assert.equal(ga.identity.label, `your Chrome on 127.0.0.1:${port}`);
assert.equal(ga.identity.devtools, `port ${port}, open to any local process of this user`);
assert.match(ga.identity.browser, /^(Headless)?Chrome\//);
p = await ok("page");
assert.match(p, /Order a pizza/);
assert(!p.includes("OTHER-TAB-SECRET-7731"));
assert.match(strip(), new RegExp(`^browser: your Chrome on 127\\.0\\.0\\.1:${port} · 127\\.0\\.0\\.1 · agent idle$`));
await c("revoke");
const wa = new WebSocket((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
await new Promise((r) => (wa.onopen = r));
wa.send(JSON.stringify({ id: 1, method: "Browser.close" }));
pass("attach: a Chrome started with --remote-debugging-port, one new tab granted and read, its other tab not read, the strip names it");
close(); site.close(); // closing the bridge ends the profile's pipe, and Chromium with it
console.log("browser: PASS");
process.exit(0);
