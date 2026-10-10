#!/usr/bin/env bash
# Hardened-mode transport, as one user (the separate user needs sudo; see docs/threat-model.md): abalone-mcp --listen
# serves MCP on a 0660 unix socket, and bin/abalone-connect is a working stdio MCP server for the caller.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
sock="$XDG_RUNTIME_DIR/abalone-test-$$.sock"; mkdir -p "$ABALONE_DIR/folder"; cd "$ABALONE_DIR/folder"
"$root/bin/abalone-mcp" --listen "$sock" --model stub/script & srv=$!
for _ in $(seq 50); do [[ -S $sock ]] && break; sleep 0.1; done
out=$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | timeout 20 "$root/bin/abalone-connect" "$sock" | head -2)
mode=$(stat -c %a "$sock"); kill $srv; rm -f "$sock"
check "the socket is 0660, so only the callers' group can connect ($mode)" '[[ $mode == 660 ]]'
check "initialize and tools/list over abalone-connect" '[[ $(sed -n 1p <<<"$out") == *"\"serverInfo\":{\"name\":\"abalone\""* && $(sed -n 2p <<<"$out") == *"ask_abalone"*"pour_status"* ]]'
echo "mcp-socket: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
