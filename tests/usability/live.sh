#!/usr/bin/env bash
# Usability gate, live part (docs/release.md): four realistic tasks in RPC mode on a real saved credit,
# using the caller's ABALONE_DIR. It spends from that credit, so it needs --live and the credit id. Writes
# local-data/usability/<run>/live.json. Run before promoting a release; the offline part is tests/usability/offline.sh.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ $# -lt 3 || $# -gt 4 || $1 != --live || $2 != --credit || ! $3 =~ ^[0-9a-f]{64}$ ]]; then
  echo "usage: tests/usability/live.sh --live --credit <64-hex credit id> [run-name]  (spends from that saved credit)" >&2; exit 2
fi
out="$root/local-data/usability/${4:-live-$(date -u +%Y%m%dT%H%M%SZ)}"; mkdir -p "$out"
exec node "$root/tests/usability/live.mjs" "$3" "$out"
