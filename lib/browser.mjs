// The browser bridge (notes/contracts/browser-grant.md). It runs in the launcher, outside the Pi sandbox, holds the
// DevTools (CDP) connection to the one tab the user granted, and checks every agent op against that grant. The session
// reaches it only through <run>/browser.sock. Nothing here reads cookies, storage or another tab's content.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { STATE, log } from "./config.mjs";

export const PROFILE_DIR = path.join(STATE, "browser"); // hidden from the Pi sandbox (lib/sandbox.mjs piArgv)
const PROFILE = path.join(PROFILE_DIR, "profile");
const MAX_TEXT = 12_000;
export const AGENT_OPS = { page: "observe", goto: "navigate", click: "click", type: "type" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const inScope = (host, sites) => sites.some((s) => host === s || host.endsWith(`.${s}`));
const hostOf = (u) => { try { return new URL(u).hostname || u; } catch { return u; } };

// CDP over a transport: `write` sends one message; the transport calls back with each message and on close.
function cdp(open) {
  const pending = new Map(), events = new Set();
  let n = 0;
  const t = open((m) => {
    const d = JSON.parse(m);
    if (!d.id) return events.forEach((h) => h(d));
    const p = pending.get(d.id); pending.delete(d.id);
    d.error ? p.rej(new Error(`${p.method}: ${d.error.message}`)) : p.res(d.result);
  }, () => { c.closed = true; pending.forEach((p) => p.rej(new Error("the browser connection closed"))); pending.clear(); events.forEach((h) => h({ method: "closed" })); });
  const c = { events, close: t.close, ready: t.ready, closed: false,
    send: (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++n; pending.set(id, { res, rej, method }); t.write(JSON.stringify({ id, method, params, sessionId })); }) };
  return c;
}

// Attach mode: the user's Chrome, on the DevTools port they opened (any local process of theirs can use that port too).
async function attachTo(port) {
  const v = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
  const c = cdp((message, closed) => {
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    ws.onmessage = (m) => message(m.data);
    ws.onclose = closed;
    return { write: (m) => ws.send(m), close: () => ws.close(),
      ready: new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`cannot connect to the browser on 127.0.0.1:${port}`)); }) };
  });
  await c.ready;
  return c;
}

// Profile mode: abalone starts Chromium on its own profile with --remote-debugging-pipe, so CDP runs over this
// process's fds 3 and 4 and there is no DevTools port at all. Chromium exits when the launcher does; the profile stays.
async function launchProfile() {
  fs.mkdirSync(PROFILE, { recursive: true });
  const child = spawn(process.env.ABALONE_BROWSER ?? "/usr/bin/chromium", [`--user-data-dir=${PROFILE}`, "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check",
    ...(process.env.ABALONE_BROWSER_HEADLESS === "1" ? ["--headless=new"] : []), "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const c = cdp((message, closed) => {
    let buf = "";
    child.stdio[4].on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\0")) >= 0) { message(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.on("exit", closed);
    child.stdio[3].on("error", () => {}); // a write after exit; the exit handler has already failed every pending call
    return { write: (m) => child.stdio[3].write(m + "\0"), close: () => child.kill(), ready: Promise.resolve() };
  });
  const v = await c.send("Browser.getVersion").catch((e) => { throw new Error(`chromium exited at once (${e.message}): is the abalone profile ${PROFILE} already open in another Chromium window or abalone session?`); });
  c.product = v.product;
  return c;
}

// Run in an isolated world, so page scripts can neither see nor change it. Elements the agent may act on are kept in
// that world's globals as e1, e2, … and shown inline; everything else is visible text.
const READER = `(() => {
  const refs = globalThis.__abaloneRefs = [], out = [];
  const label = (el) => (el.getAttribute("aria-label") || el.labels?.[0]?.innerText || el.placeholder || el.innerText || el.value || el.name || el.title || "").trim().replace(/\\s+/g, " ").slice(0, 80);
  const walk = (n) => {
    if (n.nodeType === 3) return void out.push(n.textContent);
    if (n.nodeType !== 1 || ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(n.tagName) || !n.checkVisibility()) return;
    if (n.matches("a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[contenteditable=true]")) {
      refs.push(n);
      const role = n.tagName === "A" ? "link" : n.tagName === "INPUT" ? n.type : n.getAttribute("role") ?? n.tagName.toLowerCase();
      const state = ["checkbox", "radio"].includes(n.type) ? (n.checked ? " checked" : " unchecked")
        : n.tagName === "SELECT" ? " options=" + JSON.stringify([...n.options].map((o) => o.value)) + " value=" + JSON.stringify(n.value)
        : ["INPUT", "TEXTAREA"].includes(n.tagName) && !["submit", "button", "reset"].includes(n.type) ? " value=" + JSON.stringify(n.value) : "";
      return void out.push(" [e" + refs.length + " " + role + " " + JSON.stringify(label(n)) + state + "] ");
    }
    const block = !getComputedStyle(n).display.startsWith("inline");
    if (block) out.push("\\n");
    n.childNodes.forEach(walk);
    if (block) out.push("\\n");
  };
  walk(document.body);
  return { title: document.title, text: out.join("").replace(/[ \\t\\u00a0]+/g, " ").replace(/ ?\\n[\\s]*/g, "\\n").trim() };
})()`;
const element = (ref, body) => `(() => { const el = globalThis.__abaloneRefs?.[${ref - 1}];
  if (!el?.isConnected) throw new Error("e${ref} is not on the page now; observe it again with page"); ${body} })()`;

// Strict incognito (abalone --incognito): no tab can be granted. A page is a network destination outside ⌂ local and
// ◈ attested, and page content would carry the session's context there.
const NO_BROWSER = "✗ refused: strict incognito has no browser. A web page is a destination outside this computer and the admitted TEE; leave incognito to use /browser";
export function browserBridge(run, { incognito = false } = {}) {
  let profile = null, attached = null; // the abalone profile's pipe (kept for the session), and the attach-mode connection
  let grant = null, conn = null, session = null, subBlocked = new Set(), owner = "agent", activity = "idle", epoch = 0, chain = Promise.resolve(), world = null, url = "", loading = false, blocked = null;
  const record = (rec) => log("browser.jsonl", { run: path.basename(run), grant: grant?.id, ...rec });
  // Written whole and renamed into place, so the session's footer never reads a half-written status.
  const status = () => { const f = path.join(run, "browser-status"); fs.writeFileSync(`${f}.tmp`, !grant ? "" :
    `browser: ${grant.identity.label} · ${hostOf(url)} · ${owner === "human" ? "you have control" : !session ? "detached" : `agent ${activity}`}`); fs.renameSync(`${f}.tmp`, f); };
  const s = (method, params) => conn.send(method, params, session);

  // The connection for an identity: the profile pipe (started on first use) or one connection to the user's port.
  async function connFor(identity) {
    if (identity.mode === "attach") {
      if (attached?.port !== identity.port || attached.closed) { attached?.close(); attached = Object.assign(await attachTo(identity.port), { port: identity.port }); attached.events.add(onEvent); attached.product = (await attached.send("Browser.getVersion")).product; }
      return attached;
    }
    if (!profile || profile.closed) { profile = await launchProfile(); profile.events.add(onEvent); }
    return profile;
  }

  function onEvent(e) {
    if (e.method === "closed") { if (conn?.closed) { session = world = null; status(); } return; }
    if (e.method === "Target.detachedFromTarget" && e.params.sessionId === session) { session = world = null; return status(); }
    if (e.sessionId !== session || !session) return;
    const p = e.params, main = p?.frameId === grant.tab.targetId || p?.frame?.id === grant.tab.targetId;
    if (e.method === "Fetch.requestPaused") {
      // While the agent owns the tab, every request it makes outside the granted sites fails: page loads, redirects,
      // frames, images, scripts, fetch/XHR. (WebSockets, WebRTC, service workers and popups are not covered by Fetch.)
      const h = hostOf(p.request.url), block = owner === "agent" && !inScope(h, grant.sites);
      if (block && p.resourceType === "Document" && p.frameId === grant.tab.targetId) blocked = h;
      else if (block) subBlocked.add(h);
      if (block) record({ event: "blocked", host: h, type: p.resourceType });
      s(block ? "Fetch.failRequest" : "Fetch.continueRequest", block ? { requestId: p.requestId, errorReason: "BlockedByClient" } : { requestId: p.requestId })
        .catch((err) => record({ event: "fetch-error", error: err.message }));
    }
    if (e.method === "Page.frameNavigated" && main) { url = p.frame.unreachableUrl ?? p.frame.url; world = null; status(); }
    if (e.method === "Page.frameStartedLoading" && main) loading = true;
    if (e.method === "Page.frameStoppedLoading" && main) loading = false;
  }

  async function connect() {
    conn = await connFor(grant.identity);
    const t = (await conn.send("Target.getTargets")).targetInfos.find((t) => t.targetId === grant.tab.targetId);
    if (!t) { record({ event: "void", reason: "tab gone" }); grant = null; status(); throw new Error("the granted tab is gone, so the grant is void; grant again with /browser grant"); }
    url = t.url;
    session = (await conn.send("Target.attachToTarget", { targetId: t.targetId, flatten: true })).sessionId;
    await s("Page.enable");
    await s("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    status();
  }
  // Detach: the bridge leaves the tab (Fetch interception ends with it); attach mode also closes its connection.
  async function leave() {
    if (session && conn) await conn.send("Target.detachFromTarget", { sessionId: session });
    if (grant?.identity.mode === "attach") { attached?.close(); attached = null; }
    session = world = null;
  }

  const live = (my) => { if (my !== epoch) throw new Error("not executed: stopped by the user"); };
  // After an action: wait for a load it started (up to 20 s), checking for Stop every 100 ms.
  async function settle(my) {
    await sleep(300);
    for (let i = 0; loading && i < 200; i++) { live(my); await sleep(100); }
    live(my);
  }
  async function inWorld(expression) {
    world ??= (await s("Page.createIsolatedWorld", { frameId: grant.tab.targetId, worldName: "abalone" })).executionContextId;
    const r = await s("Runtime.evaluate", { expression, contextId: world, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0].replace(/^Error: /, "") ?? r.exceptionDetails.text);
    return r.result.value;
  }
  // The page's text from a character offset, or from just before the first match of `find`, at most MAX_TEXT of it.
  async function observe(my, { from = 0, find } = {}) {
    if (!inScope(hostOf(url), grant.sites)) throw new Error(`not executed: the tab is on ${hostOf(url)}, outside the grant (${grant.sites.join(", ")}); nothing was read`);
    const { title, text } = await inWorld(READER);
    live(my);
    const at = find === undefined ? Number(from) : text.toLowerCase().indexOf(String(find).toLowerCase());
    if (!Number.isInteger(at) || at < -1) throw new Error(`"from" must be a character offset`);
    const head = `url: ${url}\ntitle: ${title}\n`;
    if (at < 0) return `${head}"${find}" is not in this page's ${text.length} characters of text`;
    const start = find === undefined ? at : Math.max(0, at - 300), end = Math.min(text.length, start + MAX_TEXT);
    return `${head}characters ${start}-${end} of ${text.length}${end < text.length ? `; page with from=${end} continues` : ""}\n\n${text.slice(start, end)}`;
  }

  async function agent(op, a, my) {
    const action = AGENT_OPS[op];
    const refused = !grant ? "no browser is granted; the user grants one with /browser grant" : Date.now() > Date.parse(grant.expires) ? "the browser grant has expired"
      : owner === "human" ? "the user has control of the browser; they hand it back with /browser give" : !session ? "the browser is detached; the user rejoins it with /browser reconnect" : !grant.actions.includes(action) ? `the grant does not allow ${action}` : null;
    if (refused) throw new Error(`not executed: ${refused}`);
    live(my);
    const ref = a.ref === undefined ? null : Number(String(a.ref).replace(/^e/, ""));
    if (op === "click" || op === "type") if (!Number.isInteger(ref) || ref < 1) throw new Error(`"ref" must be an element like e3 from the last page observation`);
    activity = `${op}${ref ? ` e${ref}` : op === "goto" ? ` ${hostOf(a.url)}` : ""}`; blocked = null; status();
    record({ event: "op", op, host: hostOf(op === "goto" ? a.url : url), ref, typed_bytes: op === "type" ? Buffer.byteLength(String(a.text)) : undefined });
    try {
      if (op === "goto") {
        const u = new URL(a.url);
        if (!["http:", "https:"].includes(u.protocol) || !inScope(u.hostname, grant.sites)) throw new Error(`not executed: ${u.hostname || a.url} is outside the grant (${grant.sites.join(", ")})`);
        await s("Page.navigate", { url: u.href });
      }
      if (op === "click") {
        const { x, y, href } = await inWorld(element(ref, `el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, href: el.closest("a[href]")?.href };`));
        // A link off the grant is refused before the click, so the block never depends on Fetch seeing the navigation.
        if (href && !href.startsWith("javascript:") && !(/^https?:/.test(href) && inScope(hostOf(href), grant.sites))) {
          record({ event: "blocked", host: hostOf(href), type: "Document", before: "click" });
          throw new Error(`blocked: e${ref} links to ${hostOf(href)}, outside the grant (${grant.sites.join(", ")}); abalone did not click it and the tab is on ${hostOf(url)}`);
        }
        for (const type of ["mousePressed", "mouseReleased"]) await s("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
      if (op === "type") {
        if (typeof a.text !== "string") throw new Error(`"text" must be a string`);
        // A select, and the date and time inputs (which ignore inserted text), take the value directly.
        const kind = await inWorld(element(ref, `el.focus(); const v = ${JSON.stringify(a.text)};
          if (el.matches("select,input:is([type=time],[type=date],[type=datetime-local],[type=month],[type=week])")) {
            const was = el.value; el.value = v; if (el.value !== v) { el.value = was; throw new Error("not executed: " + JSON.stringify(v) + " is not a value e${ref} (" + (el.type || "select") + ") accepts"); }
            for (const t of ["input", "change"]) el.dispatchEvent(new Event(t, { bubbles: true })); return "set"; }
          if (!el.matches("input:not([type=checkbox],[type=radio],[type=submit],[type=button],[type=reset],[type=file],[type=image]),textarea,[contenteditable=true]")) throw new Error("not executed: e${ref} is not a text field; click it instead"); el.select?.(); return "text";`));
        if (kind === "text") await s("Input.insertText", { text: a.text });
      }
      await settle(my);
      if (blocked) {
        // The blocked load left Chromium's error page in the tab: step back to the granted page it came from.
        const h = await s("Page.getNavigationHistory"), cur = h.entries[h.currentIndex];
        if (!inScope(hostOf(cur.url), grant.sites) && h.currentIndex > 0) { await s("Page.navigateToHistoryEntry", { entryId: h.entries[h.currentIndex - 1].id }); await settle(my); }
        throw new Error(`blocked: the page then tried to load ${blocked}, outside the grant (${grant.sites.join(", ")}); abalone stopped that load and the tab is on ${hostOf(url)}`);
      }
      const o = await observe(my, op === "page" ? a : {});
      // Requests blocked since the last observation, then forgotten.
      const b = [...subBlocked]; subBlocked = new Set();
      return b.length ? o.replace(/\n\n/, `\nabalone blocked requests outside the grant to: ${b.join(", ")}\n\n`) : o;
    } finally { activity = "idle"; status(); }
  }

  const user = {
    async tabs({ identity }) {
      if (incognito) throw new Error(NO_BROWSER);
      return (await (await connFor(identity)).send("Target.getTargets")).targetInfos.filter((t) => t.type === "page").map(({ targetId, title, url }) => ({ targetId, title, url }));
    },
    async grant({ identity, targetId, open, sites, actions = Object.values(AGENT_OPS), minutes = 60 }) {
      if (incognito) throw new Error(NO_BROWSER);
      if (grant) await user.revoke();
      const c = await connFor(identity);
      if (open) targetId = (await c.send("Target.createTarget", { url: "about:blank" })).targetId;
      if (!sites?.length || sites.some((h) => !/^[a-z0-9.-]+$/i.test(h))) throw new Error("sites must be host names, e.g. httpbin.org,docs.python.org");
      if (!actions.length || actions.some((x) => !Object.values(AGENT_OPS).includes(x))) throw new Error(`actions must be some of ${Object.values(AGENT_OPS).join(", ")}`);
      grant = { contract: "org.abalone.browser-grant/1", id: `bg-${crypto.randomBytes(4).toString("hex")}`,
        identity: { ...identity, label: identity.mode === "attach" ? `your Chrome on 127.0.0.1:${identity.port}` : "abalone profile", browser: c.product,
          devtools: identity.mode === "attach" ? `port ${identity.port}, open to any local process of this user` : "pipe to abalone's launcher only; no port" },
        tab: { targetId }, sites, actions, expires: new Date(Date.now() + minutes * 60_000).toISOString(), granted: new Date().toISOString() };
      owner = "agent";
      await connect();
      // Opened only once attached, so the load is under the grant and settle() sees it finish.
      if (open) { await s("Page.navigate", { url: open }); await settle(epoch); }
      grant.tab.url = url;
      record({ event: "grant", identity: grant.identity, sites, actions, expires: grant.expires, host: hostOf(url) });
      return grant;
    },
    async stop() { epoch++; if (session) await s("Page.stopLoading"); record({ event: "stop" }); status(); return "stopped: the browser op in flight and any queued ones were cancelled"; },
    async take() { await user.stop(); owner = "human"; record({ event: "take" }); status(); return "you have control of the browser; the agent's browser ops are refused until /browser give"; },
    async give() { owner = "agent"; record({ event: "give", host: hostOf(url) }); status(); return `the agent has the browser again, on ${hostOf(url)}${grant && !inScope(hostOf(url), grant.sites) ? " (outside the grant: it cannot read this page)" : ""}`; },
    async detach() { await leave(); record({ event: "detach" }); status(); return "detached: the browser and tab stay open; /browser reconnect reattaches"; },
    async reconnect() { if (!grant) throw new Error("no browser is granted"); await connect(); record({ event: "reconnect" }); return `reattached to ${grant.identity.label}, tab on ${hostOf(url)}`; },
    async revoke() { await leave(); record({ event: "revoke" }); grant = null; status(); return "grant revoked and detached"; },
    async status() { return { grant, owner, attached: !!session, activity, host: hostOf(url) }; },
  };

  status();
  const server = net.createServer({ allowHalfOpen: true }, (c) => {
    let b = "";
    c.on("data", (d) => (b += d));
    c.on("end", async () => {
      const { op, args = {} } = JSON.parse(b);
      try {
        // Agent ops run one at a time, in order; Stop bumps the epoch, so queued ones are refused when their turn comes.
        const out = AGENT_OPS[op] ? await (chain = chain.catch(() => {}).then(((my) => () => agent(op, args, my))(epoch))) : Object.hasOwn(user, op) ? await user[op](args) : Promise.reject(new Error(`no browser op ${op}`));
        c.end(JSON.stringify({ ok: true, out }));
      } catch (e) { c.end(JSON.stringify({ ok: false, err: e.message })); }
    });
  }).listen(path.join(run, "browser.sock"));
  return () => { profile?.close(); attached?.close(); server.close(); };
}

// The session's side: one request over <run>/browser.sock.
export const call = (run, op, args) => new Promise((resolve, reject) => {
  let b = "";
  const s = net.connect(path.join(run, "browser.sock"), () => s.end(JSON.stringify({ op, args })));
  s.on("data", (d) => (b += d));
  s.on("error", reject);
  s.on("end", () => { const r = JSON.parse(b); r.ok ? resolve(r.out) : reject(new Error(r.err)); });
});
