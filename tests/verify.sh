#!/usr/bin/env bash
# Every suite, labelled by what it needs. `tests/verify.sh` runs the offline and network-$0 suites (no key, no spend);
# `tests/verify.sh offline` runs only the offline ones. needs-key suites are listed with their command, never run here.
#   offline     no network at all (stub models, stub runner, loopback servers, recorded attestation)
#   network-$0  contacts real hosts with no or dummy credentials: nothing is spent
#   needs-key   a real provider key, Claude login, Mac mini, docker or anvil; spends money or needs hardware
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"; cd "$root"
suites=(
  "offline|lockdown|tests/lockdown.sh" "offline|egress|tests/egress.sh" "offline|local|tests/local.sh" "offline|mcp|tests/mcp.sh"
  "offline|mounts|tests/mounts.sh" "offline|canary|tests/canary.sh" "offline|private-work|tests/private-work.sh"
  "offline|state-modes|tests/state-modes.sh" "offline|session|tests/session.sh" "offline|notebook|tests/notebook.sh" "offline|tui|tests/tui.sh"
  "offline|documentation (local links and heading fragments)|python3 tools/check-docs.py"
  "offline|attestation eval (synthetic corpus and withheld answers)|python3 tests/attestation-eval.py"
  "offline|capability snapshot (ordinary-session diagnostic in ignored local-data)|node tools/threat-model.mjs"
  "offline|gate (metadata_only schema, encoded canaries)|node --test tests/gate.test.mjs" "offline|mcp-socket (hardened-mode transport)|tests/mcp-socket.sh"
  "offline|upstream (RedPill upstream admission, recorded sessions and receipts)|node --test tests/upstream.test.mjs"
  "offline|peer-image-smoke (node serve/relay from the peer image tree, no pi/)|tests/peer-image-smoke.sh"
  "offline|g8-offline|node --test tests/g8-offline.mjs" "offline|no-promotion|node --test tests/no-promotion.test.mjs"
  "offline|disclose|node --test tests/disclose.test.mjs" "offline|receipt|node --test tests/receipt.test.mjs" "offline|bundle (task result bundle verifier, fixture + recorded runner)|node --test tests/bundle.test.mjs"
  "offline|runner-retry (zero-byte delivery retry)|node --test tests/macrunner-retry.test.mjs"
  "offline|relay-watch (reservation dropped with the connection open)|node --test tests/relay-watch.test.mjs"
  "offline|p2p-services (authenticated peer context and bounded frames)|node --test tests/p2p-services.test.mjs"
  "offline|coupon-client (experimental prebound transport and delivery)|node --test tests/coupon.test.mjs"
  "offline|coupon-offer (versioned accepted terms and delivery binding)|node --test tests/coupon-offer.test.mjs"
  "offline|coupon-accountless (first-bearer client and winner identity binding)|node --test tests/coupon-accountless.test.mjs"
  "offline|coupon-session (recipient consent, nonreplacement and scoped broker)|node --test tests/coupon-session.test.mjs"
  "offline|coupon-attested (connection-bound issuer identity and v4 terms)|node --test tests/coupon-attested.test.mjs"
  "offline|coupon-attested-session (v4 consent, pending delivery and direct provider broker)|node --test tests/coupon-attested-session.test.mjs"
  "offline|coupon-input (responsive hidden terminal and descriptor input)|node --test tests/coupon-input.test.mjs"
  "offline|credit (durable recipient credit, original-key recovery, private store, fresh-process CLI session)|node --test tests/credit.test.mjs && node tests/credit-cli-session.mjs"
  "offline|coupon-first-use (public inputs and local VPN observations)|node --test tests/coupon-first-use.test.mjs"
  "offline|owned-host retention (tmpfs, crash, unsafe-root refusal)|node --test tests/owned-host.test.mjs"
  "offline|coupon replay boundary (real SDK and Pi synthetic request counts)|node --test tests/coupon-no-replay.test.mjs"
  "offline|coupon-near (strict real NEAR recipient adapter and credential broker)|node --test tests/coupon-near.test.mjs"
  "offline|coupon NEAR @file (actual curated context and encrypted adapter)|node tests/coupon-near-atfile.mjs"
  "offline|mac-coupon-issuer (Apple issuer binding, synthetic contract only)|node --test tests/mac-coupon-issuer.test.mjs"
  "offline|coupon-staging (signed service staging admission, exact schema)|node --test tests/coupon-staging.test.mjs"
  "offline|regress (tests/regress fixtures replayed)|tests/regress/run.sh" "offline|report (/report, abalone report)|tests/report.sh"
  "offline|fetch (/fetch routes, stub arXiv)|tests/fetch.sh" "offline|tor (built-in Tor transport, stub client)|node --test tests/tor.test.mjs"
  "offline|untrusted (peer and NEAR text)|node --test tests/untrusted.test.mjs"
  "offline|ui-states (snapshots: tool steps, incognito header, sent-to, footer, stopped step; browser commands in the prompt)|node --test tests/ui-states.test.mjs" "offline|install (no gift code; release.sh writes install.sh only with a base URL)|tests/install.sh"
  "offline|browser (CDP bridge: headless Chromium, loopback fixture site)|node tests/browser.mjs" "offline|browser-session (/browser and the in-content ops in a real session, stub model)|tests/browser-session.sh" "offline|incognito agent memory (disk-backed runtime, crash nonpersistence)|node --test tests/incognito-agent-memory.test.mjs"
  "offline|incognito (strict incognito, encrypted trace)|tests/incognito.sh"
  "offline|session-commands (slash commands and prompt per session kind)|node --test tests/session-commands.test.mjs"
  "offline|usability (cold run, credit-session commands, first screens; known-defect XFAILs)|tests/usability/offline.sh"
  "network-\$0|pour (real claude binary, no login, reaches api.anthropic.com)|tests/pour.sh" "network-\$0|tor-live (sealed /fetch says IsTor: true)|tests/tor-live.sh"
  "network-\$0|caps (real provider handshakes with dummy keys)|tests/caps.sh" "network-\$0|negative (G8, live upstreams, dummy keys)|tests/negative.sh"
  "network-\$0|keys (live 401 with dummy keys)|tests/keys.sh" "network-\$0|list-models|tests/list-models.sh" "network-\$0|connect-trace|tests/connect-trace.sh"
  "needs-key|near|tests/near.sh" "needs-key|near-thinking (default model, GLM thinking off)|tests/near-thinking.sh" "needs-key|negative-near (G8 NEAR)|tests/negative-near.sh" "needs-key|private-work-near|tests/private-work-near.sh"
  "needs-key|gift|tests/gift.sh" "needs-key|gift-chain (anvil)|tests/gift-chain.sh" "needs-key|gift-renew (anvil)|tests/gift-renew.sh"
  "needs-key|frontier-live (Claude runner login)|tests/frontier-live.sh" "needs-key|claude-code-mcp (your Claude login)|tests/claude-code-mcp.sh"
  "needs-key|demo-live|tests/demo-live.sh" "needs-key|g2-container (docker)|tests/g2-container.sh" "needs-key|p2p-mac (Mac mini)|tests/p2p-mac.sh"
)
fail=0; logs="${TMPDIR:-/tmp}/abalone-verify-$$"; mkdir -p "$logs"
for s in "${suites[@]}"; do
  IFS='|' read -r label name cmd <<<"$s"
  if [[ $label == needs-key || ( ${1:-} == offline && $label != offline ) ]]; then printf 'NOT RUN  %-10s  %s: %s\n' "$label" "$name" "$cmd"; continue; fi
  t0=$SECONDS; bash -c "$cmd" < /dev/null > "$logs/${name%% *}.log" 2>&1; code=$?
  [[ $code == 0 ]] && r=PASS || { r=FAIL; fail=1; }
  printf '%-7s  %-10s  %s (%ds; log %s)\n' "$r" "$label" "$name" $((SECONDS - t0)) "$logs/${name%% *}.log"
done
echo "verify: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
