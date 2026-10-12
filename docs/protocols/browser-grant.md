# Browser grant contract (`org.abalone.browser-grant/1`)

This specifies the interface between `curated/abalone.ts`, the in-content tool
protocol (`lib/intools.mjs`) and the CDP browser bridge (`lib/browser.mjs`).
It is a connected-session interface; incognito refuses browser grants.

## Backend

For the bubblewrap connected-session profile, one backend: Chromium/Chrome on Linux over the DevTools protocol (CDP), spoken directly with node's built-in `WebSocket`. No playwright-core (13.6 MB) and no extension. The bridge runs in the launcher, outside the Pi sandbox, the same place `/fetch` downloads run. The sandbox reaches it only through `<run>/browser.sock`; the bash sandbox does not see the run dir.

Two identities. The user picks one per grant, and the strip names it.

| Mode | What it is | What it guarantees | What it does not |
|---|---|---|---|
| `profile` (default) | `/usr/bin/chromium --user-data-dir=<ABALONE_DIR>/browser/profile --remote-debugging-pipe`, started by the launcher on first use in a session and closed when the session ends. The user logs into sites in it once; later sessions reuse that state from disk. | Separate from the user's everyday Chrome: no shared cookies, sync or history. CDP runs over the launcher's fds 3/4: there is no DevTools port, so no other process can drive it. The profile dir is hidden from the Pi sandbox (tmpfs over it), so neither the model's tools nor the agent process can read it. | Logins persist on disk unencrypted, as Chromium stores them. One Chromium per profile: a second session cannot open it while the first holds it. |
| `attach` | A Chrome the user started with `--remote-debugging-port=<port>` (Chrome 136+ requires a non-default `--user-data-dir` for that). | The website sees the user's existing account. Only the tab the user picks is attached. | The port is the user's and is open to any program they run, not only abalone; the grant dialog and `/browser` say so. It gives the bridge control of that whole browser; the limit to one tab and the granted sites is the bridge's code, not Chrome's. Abalone never starts Chrome against the user's real profile. |

Browser identity is separate from the folder and from the model. Changing `/folder` or `/model` does not change the grant; the session restarts and the user must grant again (grants live in the launcher process for one session).

## The grant

Only the human creates, changes or revokes a grant, with `/browser grant` in the session. Nothing the model writes and nothing on a page can create or widen one.

```
{
  "contract": "org.abalone.browser-grant/1",
  "id": "bg-<8 hex>",
  "identity": { "mode": "profile" | "attach", "label": "abalone profile" | "your Chrome on 127.0.0.1:<port>", "browser": "<product from Browser.getVersion>",
                "devtools": "pipe to abalone's launcher only; no port" | "port <port>, open to any local process of this user" },
  "tab": { "targetId": "<CDP target id>", "url": "<at grant time>" },
  "sites": ["httpbin.org", "docs.python.org"],     // a host matches itself and its subdomains
  "actions": ["observe", "navigate", "click", "type"],
  "expires": "<ISO time, default 60 minutes after grant>",
  "granted": "<ISO time>"
}
```

Bridge state around it: `owner` (`agent` | `human`), `attached` (bool), `activity` (the op in flight or `idle`).

## Agent operations

The model asks for these in the in-content tool protocol. The session forwards them to the bridge, which checks, in order: a grant exists and has not expired; the bridge is attached; `owner` is `agent`; the action is in `actions`; for `goto`, the URL is http(s) and its host is in `sites`. A failed check returns `not executed: <reason>` and runs nothing. Operations are serialized; each runs only on the granted tab.

| Op | Args | Effect | Returns |
|---|---|---|---|
| `page` | optional `find` (text) or `from` (character offset) | observe | the observation below, from that point |
| `goto` | `url` | navigate the tab, wait for load | observation |
| `click` | `ref` | click element `ref` from the last observation | observation |
| `type` | `ref`, `text` | type into an input or textarea; a select and the date and time inputs get the value set directly (refused if they do not accept it), firing input/change | observation |

An observation is `url`, `title`, which characters of the page's visible text it holds (at most 12,000, with the offset to continue from), and that text, with interactive elements inline as `[e<n> <role> "<label>"]`. It is read in an isolated world, so page scripts cannot see or alter the reader. If the tab's current URL is outside `sites` (the human navigated away during Take control, say), `page` returns `not executed: the tab is on <host>, outside the grant` and nothing is read.

Scope enforcement besides the `goto` check: while the agent owns the tab, the bridge intercepts every request the tab makes (CDP `Fetch`, all URLs, request stage, each redirect hop included) and fails any to a host outside `sites`. A top-level load blocked this way makes the op report `blocked: …`, and the tab is stepped back to the granted page it came from. A `click` on a link whose target is outside `sites` is refused before the click (`blocked: e<n> links to <host>`, logged as a blocked Document), so that block does not depend on `Fetch` seeing the navigation. Blocked subresources (images, scripts, frames, fetch/XHR) are listed once in the next observation as `abalone blocked requests outside the grant to: <hosts>` and logged with their type. Not covered by `Fetch`: WebSockets, WebRTC, service workers, and popups the page opens (a new target the bridge never attaches to). While the human has control, nothing is blocked.

## Human controls

These come only from `/browser` commands, which Pi runs immediately even while the model is working.

- **Stop** (`/browser stop`, and Esc, which aborts the run): the bridge bumps an epoch. The op in flight returns `stopped by the user`, `Page.stopLoading` is sent, and queued ops are refused. Nothing more is observed until the next run asks.
- **Take control** (`/browser take`): Stop, then `owner = human`. Agent ops are refused with `the user has control of the browser; they hand it back with /browser give`. Off-scope interception is lifted, so the human can go anywhere. `/browser give` hands it back; the next observation is scope-checked as above.
- **Detach** (`/browser detach`): the bridge detaches from the tab (interception ends with it); in attach mode it also closes its connection to the user's port. The browser and tab keep running and the grant is kept but paused. `/browser reconnect` reattaches to the same identity and tab. If the tab is gone, the grant is void and the user grants again.
- **Revoke** (`/browser revoke`): drops the grant and detaches.

## What the user sees

The footer strip carries one browser segment from the bridge's status file `<run>/browser-status`: identity, tab host, owner and activity, e.g. `browser: abalone profile · httpbin.org · agent: type e3` or `browser: you have control`. `/browser` prints the whole grant, owner, attachment and expiry. The tab picker shows the human every tab's title and URL; that list is never sent to the model.

## What enters model context and traces

Into model context: a short grant summary in the system prompt (identity label, tab host, sites, actions, expiry), and the returns of the agent ops above, for the granted tab only. Never: cookies, local storage, saved passwords, the profile directory, the CDP endpoint, or any other tab's title, URL or content. The bridge has no op that reads cookies or storage.

Page text goes only to the session's current model, as an in-content tool result inside its encrypted messages. Browser ops run only for models whose tools are in-content (`◈ attested` or `⌂ local`); a mediated `○ outside` reply's tool lines are never run (existing rule in `curated/abalone.ts`). Native-tool providers get no browser tool in this version. Page text is untrusted: the protocol says so, and a page's instructions cannot reach the grant because only `/browser` changes it.

Traces follow the session's mode. In the ordinary connected mode, op requests and results are entries in the Pi session file like other tool results (local, 0600, plaintext). The bridge also appends `<ABALONE_DIR>/browser.jsonl`: grant, revoke, take, give, stop, detach, reconnect and each agent op with its host, action and outcome, but no page text and only the byte count of typed text. Incognito refuses `/browser grant`; this browser interface does not qualify the owned-host recipient profile or an extension attached to an ordinary browser profile.
