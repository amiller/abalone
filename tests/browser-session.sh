#!/usr/bin/env bash
# The browser journey inside the real session (bin/abalone over RPC, sandboxed Pi, the launcher's bridge), with the
# in-content stub model: /browser grant on the fixture site, the model's page/type/click ops, a refused off-grant goto,
# take/give and detach/reconnect commands, the strip, the profile hidden from the sandbox, and nothing secret in the trace.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
export STUB_SCRIPT="$root/tests/fixtures/scripts/browser.mjs" ABALONE_BROWSER_HEADLESS=1
fail=0; check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
mkdir -p "$ABALONE_DIR/work" && cd "$ABALONE_DIR/work" && echo "a note" > notes.txt
node -e 'import(process.argv[1]).then(async (m) => { const s = await m.serve(); console.log(s.port); setInterval(() => {}, 1e6); })' "$root/tests/fixtures/browser/serve.mjs" > ../port &
srv=$!; trap 'kill $srv' EXIT
for _ in $(seq 50); do [[ -s ../port ]] && break; sleep 0.1; done; port=$(cat ../port)
cat > ../steps.json <<J
[{"cmd": "/browser grant --open http://127.0.0.1:$port/form.html --sites 127.0.0.1"},
 {"prompt": "what can you use"},
 {"prompt": "browse page"},
 {"prompt": "browse type {\"ref\": \"e1\", \"text\": \"Ada Lovelace\"}"},
 {"prompt": "browse click {\"ref\": \"e6\"}"},
 {"prompt": "browse goto {\"url\": \"http://localhost:$port/steal\"}"},
 {"prompt": "browse read {\"path\": \"x\"}"},
 {"prompt": "browse read {\"path\": \"notes.txt\"}"},
 {"prompt": "browse goto {\"url\": \"http://127.0.0.1:$port/slow\"}", "during": {"after": "slow", "ms": 700, "abort": true}},
 {"cmd": "/browser take"},
 {"prompt": "browse page"},
 {"cmd": "/browser give"},
 {"cmd": "/browser detach"},
 {"prompt": "browse page"},
 {"cmd": "/browser reconnect"},
 {"cmd": "/browser"}]
J
timeout 120 node "$root/tests/browser-session.mjs" stub-e2ee/script ../steps.json > ../ev 2>../err || cat ../err
shown() { node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")) { const e=JSON.parse(l);
  if (e.type==="extension_ui_request"&&e.method==="notify") console.log("NOTICE", e.message);
  if (e.type==="extension_ui_request"&&e.method==="setStatus"&&e.statusKey==="abalone") console.log("STRIP", e.statusText);
  if (e.type==="message_end"&&e.message.role==="assistant") console.log("MODEL", e.message.content.filter(c=>c.type==="text").map(c=>c.text).join(""), e.message.stopReason==="stop"?"":`[${e.message.stopReason}: ${e.message.errorMessage}]`);
  if (e.type==="entry_appended"&&e.entry.customType==="abalone-tool") for (const r of e.entry.details.results) console.log("TOOL", r.request, r.output.split("\n")[0]);
  if (e.type==="response"&&!e.success) console.log("ERROR", e.error) }' ../ev; }
shown > ../shown; cat ../shown | cut -c1-220
check "grant notice names identity, tab host, sites, actions" 'grep -q "^NOTICE browser: abalone profile (.*Chrome/[0-9.]*; DevTools pipe to abalone.s launcher only; no port), one tab, now on 127.0.0.1; sites 127.0.0.1 and their subdomains; may observe, navigate, click, type; until" ../shown'
check "the model's system prompt carries the grant" 'grep -q "^MODEL browser in prompt: abalone profile .*now on 127.0.0.1; sites 127.0.0.1" ../shown'
check "page: the form, read by the bridge, back to the model" 'grep -q "e1 text \"Customer name:\" value=\"\"" ../shown'
check "type then click submit: the site echoed the post" 'grep -q "custname=Ada Lovelace" ../shown'
check "goto off-grant refused" 'grep -q "not executed: localhost is outside the grant (127.0.0.1)" ../shown'
check "file tools still work alongside (read of a missing file is an ordinary error)" 'grep -q "error: ENOENT\|no such file" ../shown'
check "the sent-to line counts files read in earlier turns as still in the conversation" 'grep -q "files read into it: notes.txt; the conversation already holds x$" ../shown && grep -q "^NOTICE sent to: .* no new files; the conversation already holds x, notes.txt" ../shown'
check "Esc during a slow goto: the op is stopped, and the run ends there with no model call and no error" 'grep -q "^TOOL .*slow.* not executed: stopped by the user$" ../shown && [[ $(sed -n "/^TOOL .*slow/,/^NOTICE you have control/p" ../shown | grep -c "^MODEL\|^ERROR") == 0 ]]'
check "take: the agent is refused while the human has control" 'grep -q "not executed: the user has control of the browser; they hand it back with /browser give" ../shown'
check "detach: refused while detached; reconnect reattaches" 'grep -q "not executed: the browser is detached; the user rejoins it with /browser reconnect" ../shown && grep -q "NOTICE reattached to abalone profile, tab on 127.0.0.1" ../shown'
# RPC's strip is rendered at 80 columns: the browser segment keeps its control state (short form) while decoration is dropped.
check "the strip carries the browser segment from the grant on, with its control state, including while detached" '[[ $(sed -n "/^NOTICE browser: abalone profile/,\$p" ../shown | grep -c "^STRIP") == $(sed -n "/^NOTICE browser: abalone profile/,\$p" ../shown | grep -c "^STRIP .*browser \(agent\|detached\|you have control\)") ]] && grep -q "^STRIP .*browser detached" ../shown'
check "sent-to line names the pages read" 'grep -q "browser pages read into it: 127.0.0.1" ../shown'
check "the cookie the site set never reaches the session trace or logs" '! grep -rq "COOKIE-MARKER-5f1e" "$ABALONE_DIR/agent" "$ABALONE_DIR"/*.jsonl ../ev'
check "browser.jsonl: grant, ops, take, give, detach, reconnect, no typed text" 'for e in grant op take give detach reconnect; do grep -q "\"event\":\"$e\"" "$ABALONE_DIR/browser.jsonl" || exit 1; done; ! grep -q "Ada Lovelace" "$ABALONE_DIR/browser.jsonl"'
# The sandboxed Pi process cannot see the profile: run a sandbox listing like the session's.
check "the abalone profile is an empty tmpfs inside the Pi sandbox" '[[ -n $(ls "$ABALONE_DIR/browser/profile") ]] && [[ -z $(node --input-type=module -e "import { piArgv } from \"$root/lib/sandbox.mjs\"; import { spawnSync } from \"node:child_process\"; import fs from \"node:fs\"; const run = fs.mkdtempSync(\"$ABALONE_DIR/r-\"); process.stdout.write(spawnSync(\"bwrap\", [...piArgv(run, [], process.cwd()), \"ls\", \"-A\", \"$ABALONE_DIR/browser\"], { encoding: \"utf8\" }).stdout)") ]]'
check "profile mode opened no DevTools port, and Chromium exited with the session" '[[ ! -e "$ABALONE_DIR/browser/profile/DevToolsActivePort" ]] && sleep 1 && ! pgrep -f -- "--user-data-dir=$ABALONE_DIR/browser/profile" > /dev/null'
echo "browser-session: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
