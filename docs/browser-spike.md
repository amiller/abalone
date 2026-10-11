# Browser extension research spike

`abalone browser-spike` runs the bundled Pi with Playwright MCP against an
existing Chromium session. This is an explicit experiment outside the normal
Abalone session: the owned host and the selected model provider are trusted.
Provider admission, encrypted inference, incognito and the normal browser grant
broker are not applied. Browser content is sent to the chosen model provider.

## Prepare Chrome

Use the [upstream Playwright extension](https://github.com/microsoft/playwright/tree/main/packages/extension).
For an unpacked source build, open `chrome://extensions`, enable Developer mode,
choose **Load unpacked**, and select the built folder containing `manifest.json`.
The source directory containing TypeScript is not itself the unpacked build.
Keep the build at a stable path and reload the extension after changing it.

Run the agent and Chrome on the same computer. The first browser action opens
an approval page where you select a tab. Each client has a tab group; disconnect
from the extension status page. Keep one agent session running to avoid repeated
connection pages and group churn. Browser connection setup can take focus.

The extension requests broad Chrome permissions. Its selected-tab/group scope
is enforced by extension code, not a Chrome sandbox per tab. An approved relay
has powerful access; this does not contain hostile software running as your OS
user. A profile token skips connection approval. Leave it unset unless that is
your intended workflow; do not put tokens in Git, command arguments or recordings.

## Start the spike

Use a built development checkout (see [CONTRIBUTING](../CONTRIBUTING.md)). Select
an existing provider/model explicitly:

```sh
bin/abalone browser-spike --model your-provider/your-model
```

The spike reads selected provider credentials/model configuration from
`~/.pi/agent`; `--agent-dir <directory>` selects a different configuration source.
If the provider needs an extension, load exactly that reviewed file:

```sh
bin/abalone browser-spike --model your-provider/your-model \
  --provider-extension /absolute/path/to/provider-extension.mjs
```

A saved default model is insufficient when this Pi checkout has not loaded its
provider. Register the provider explicitly and use a valid credential; an OAuth
refresh rejection requires signing in again. Do not silently fall back to a
provider with a different privacy contract.

For a single task:

```sh
bin/abalone browser-spike --model your-provider/your-model \
  -p 'Read my selected tab and summarize it.'
```

The command pins `@playwright/mcp@0.0.83`, exposes only that server's tools and
disables ambient extensions, skills and prompt templates. Before inference it waits
up to two minutes for browser tools; startup failure exits without sending the task. An explicitly loaded
provider extension is trusted code. The selected provider's auth/model entries
and an optional literal Playwright token are copied into a temporary mode-0700
configuration directory with mode-0600 files. The directory is removed on normal
exit/error/signalled child exit; abrupt launcher termination can leave it behind.
The command does not save a Pi conversation. Browser profiles, terminal output,
provider-side retention and files written by browser tools can persist.

It can use `PLAYWRIGHT_MCP_EXTENSION_TOKEN` from the runtime environment or the
literal token in `mcpServers.playwright.env` of the source `mcp.json`. Other MCP
servers and resource settings are not copied. No shell/filesystem tools are
exposed, but powerful browser tools such as evaluation remain available.

## Acceptance and remaining work

### Experimental normal-session extension transport

The research branch also supports `/browser grant --extension` in a normal
Abalone session. Launch `bin/abalone --model nearai/z-ai/glm-5.3-flash`, then
run that command. Approve the Playwright extension connection in Chrome, select
the existing tab, and confirm Abalone's site/action grant. Use the unpacked
Playwright extension **0.4.0, protocol 2**. This adapter speaks its internal
Chrome-method relay directly; Playwright MCP is not part of this route.
`ABALONE_BROWSER_EXTENSION_OPENER` optionally selects an executable that receives
the connection URL as its sole argument; the default is `xdg-open`. This URL
contains temporary pairing authority and should not be logged or recorded.

Abalone's existing CDP bridge executes the four browser operations and enforces
the grant. NEAR uses the existing admitted encrypted message-text tool protocol;
native MCP definitions/arguments are not sent to NEAR. The loopback WebSocket
relay requires a random connection path and the extension's origin, attaches
only the initially selected tab, and ignores additional tabs/popups. It does not
open a general Chrome debugging port or enable automatic profile-token pairing.
Same-user hostile processes remain outside this security claim.

`/browser take`, `give`, `stop`, `detach`, `reconnect` and `revoke` retain their
normal meanings. Reconnect requires fresh extension pairing; selecting a different
tab invalidates the old target rather than silently granting the new one.
Strict incognito continues to refuse browser grants. Existing Fetch interception
does not cover WebSockets, WebRTC, service workers or popups; this adapter does
not broaden that claim. The internal protocol and pinned extension need review
and compatibility checks before integration or release. The standalone
`browser-spike` command above remains outside provider admission and is a
different experiment.

Use a synthetic signed-in mailbox for repeatable demonstrations. Verify that a
real model finds the search field, types the query, submits it and reports the
actual matching subjects. A scripted response is not evidence of model-driven
browser task completion. Record continuous terminal/browser footage in a bounded
isolated environment and disclose preinstalled builds, manual connection approval,
real inference and synthetic accounts.

This spike does not vendor the extension or qualify a browser security boundary.
A product integration needs explicit runtime pairing, user-visible tab/site
scope, takeover/disconnect enforcement, navigation checks, and the declared
inference/retention contract. Keep it separate from strict incognito until those
contracts have been reviewed.
