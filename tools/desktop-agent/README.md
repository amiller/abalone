# Native desktop development session

Run the normal Pi terminal UI against a local Zai broker, without an OS image or
QEMU. Reuse a built native SDK and Node 24. The desktop extension uses the shared
Pi broker adapter and Unix HTTP client; it imports no portable platform code.

This is an explicitly trusted **same-user development profile**. The agent and
broker have the operator's account authority. There is no Tor enforcement,
sandbox, wallet authority or protection of the key from other same-user
processes. A separate broker keeps the key out of Pi settings and prompts; it
is not a substitute for OS isolation. Cost metadata is unknown; SDK zeros are
placeholders. The profile permits eight requests with up to 2048 output tokens
each, and a session lasts at most 30 minutes. These are not dollar caps.

## Start and attach

The trusted caller supplies one existing Zai provider record through inherited
FD4, then runs:

```sh
python3 tools/desktop-agent/start.py \
  --node /path/to/node24/bin/node \
  --sdk /path/to/pi/packages/coding-agent/dist/index.js \
  --runtime /path/to/new-private-runtime \
  --workspace /path/to/disposable-workspace
```

The record has `provider: "zai"`, `model: "glm-5.3"` and `apiKey`; only the broker
receives it. Use an existing trusted descriptor producer. Do not put a real key
in the command, environment, task prompt or a checked-in file. Missing credentials
fail; the launcher does not provision accounts or discover ambient API keys.

After its readiness message:

```sh
tmux -L dsmack-desktop attach -t dsmack-desktop
```

The launcher owns a dedicated tmux server with an empty configuration and clean
environment; it does not use the operator's default server or plugins.

Native Pi has ordinary read, Bash, edit and write tools. Ctrl+B then D detaches
without ending it; Ctrl+D in the empty Pi editor exits. The owner supervisor stops
the broker when the session ends or its lifetime expires. No automatic model
request retries are enabled, including after an ambiguous error. A new session
requires deliberate credential intake and a new private runtime directory.

The launcher disables session retention, ambient extensions, MCP, skills, prompt
and context files, automatic retry and compaction. Its temporary settings and
workspace are ordinary local files; this profile does not claim amnesia.

## Offline checks

```sh
node --test tools/desktop-agent/broker.test.mjs
python3 portable/raspberry-pi/image/tests/test-runtime-stage.py
```

The broker fixture uses an explicit test-only process preload for fake fetch.
Production never loads that preload or accepts an upstream URL from requests.
The shared adapter's existing portable profile tests cover unchanged fixed
USB provider selection and the 1024-token portable profile. Native SDK checks
require the existing matching SDK; a skipped SDK check is not qualification.
