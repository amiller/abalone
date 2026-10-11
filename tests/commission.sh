#!/usr/bin/env bash
# Track C: a redeemed gift commissions agent tasks on a worker peer over libp2p (docs/protocols/task-v1.md).
# Live NEAR (z-ai/glm-5.3-flash) through the peer; spend: about a cent of inference per run.
#   tests/commission.sh                 starts a relay and a dev worker peer here (local executor, 200 µ$/s)
#   TASK_RUNNER=1 tests/commission.sh  the worker peer runs in Mac-runner mode in its own network namespace against
#                                       tests/fixtures/stub-runner.mjs, so tasks go through the runner.local task API
#   TASK_PEER=<multiaddr> GIFT=<token> tests/commission.sh
#                                       against an existing worker: redeems GIFT there (the client side only)
#   CLIENT=<dir>                        reuse a client dir that already redeemed GIFT (a rerun after a worker failure)
#   KEEP=<dir>                          copies the client's task records, bundles and logs there before cleanup
# Exits non-zero if any check fails.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
W="$(mktemp -d /tmp/abc.XXXX)"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
mkdir -p "$W/config/curated" "$W/i" "$W/l" "$W/r"
cp "$root/providers.json" "$root/policy.json" "$W/config/"; cp "$root/curated/manifest.json" "$W/config/curated/"
STUB_IMAGE="stub-task@sha256:$(printf '0%.0s' {1..64})"   # the stub runner's task "image", admitted only in this test's config
[[ -z ${TASK_PEER:-} ]] && node -e 'const f=process.argv[1],p=require(f);p.peers.admit.dev=true;p.peers.admit.task.images.push(process.argv[2].split("@")[1]);require("fs").writeFileSync(f,JSON.stringify(p,null,1))' "$W/config/providers.json" "$STUB_IMAGE"
[[ -z ${TASK_PEER:-} ]] && ABALONE_CONFIG="$W/config" node "$root/tools/rehash-manifest.mjs" > /dev/null   # only the local peer needs it
export ABALONE_CONFIG="$W/config"
ab() { ABALONE_DIR="$W/r" "$root/bin/abalone" "$@"; }
waitfor() { for _ in $(seq 120); do grep -q "$2" "$1" && return 0; sleep 1; done; return 1; }
state() { ab tasks status "$1" 2>&1 | head -1; }
until_state() { for _ in $(seq ${3:-300}); do state "$1" | grep -q "$2" && return 0; sleep 2; done; return 1; }
trap 'kill ${relay:-} ${peer:-} ${stub:-} 2>/dev/null; [[ -n ${KEEP:-} ]] && mkdir -p "$KEEP" && cp -r "$W/r" "$W"/*.log "$KEEP/"; rm -rf "$W"' EXIT

if [[ -z ${TASK_PEER:-} ]]; then
  "$root/bin/abalone" node relay --listen /ip4/127.0.0.1/tcp/0 > "$W/relay.log" 2>&1 & relay=$!
  waitfor "$W/relay.log" "/tcp/" || { cat "$W/relay.log"; exit 1; }
  R=$(grep -o "/ip4/127.0.0.1/tcp/[0-9]*/p2p/[A-Za-z0-9]*" "$W/relay.log" | head -1)
  ISS=$(ABALONE_DIR="$W/i" "$root/bin/abalone" gift --issuer-pub)
  if [[ -n ${TASK_RUNNER:-} ]]; then
    mkdir -p "$W/runner"
    node "$root/tests/fixtures/stub-runner.mjs" "$W/runner/egress.sock" "$W/runner" > "$W/runner/log" 2>&1 & stub=$!
    waitfor "$W/runner/log" "stub runner on" || { cat "$W/runner/log"; exit 1; }
    cp "$W/runner/compose" "$W/l/.abalone-persistent"
    ABALONE_DIR="$W/peerhome" ABALONE_RUNNER_SOCK="$W/runner/egress.sock" unshare -rn sh -c 'ip link set lo up && exec "$0" "$@"' "$root/bin/abalone" node serve --relay "$R" --evidence macrunner --reserve 2usd --ledger "$W/l" --issuer "$ISS" --tasks independent --task-rate 200 --task-image "$STUB_IMAGE" > "$W/peer.log" 2>&1 & peer=$!
  else
    "$root/bin/abalone" node serve --listen /ip4/127.0.0.1/tcp/0 --relay "$R" --evidence dev --reserve 2usd --ledger "$W/l" --issuer "$ISS" --tasks independent --task-rate 200 > "$W/peer.log" 2>&1 & peer=$!
  fi
  waitfor "$W/peer.log" "p2p-circuit" || { cat "$W/peer.log"; exit 1; }
  TASK_PEER=$(grep -o "/ip4/127.0.0.1/tcp/[0-9]*/p2p/[A-Za-z0-9]*/p2p-circuit/p2p/[A-Za-z0-9]*" "$W/peer.log" | tail -1)
  ABALONE_DIR="$W/i" "$root/bin/abalone" gift --setup 2usd > /dev/null
  GIFT=$(ABALONE_DIR="$W/i" "$root/bin/abalone" gift 1usd --peer "$TASK_PEER" | grep -o "g1[^ ]*\.[^ ]*")
fi
echo "  worker: $TASK_PEER"
if [[ -n ${CLIENT:-} ]]; then rm -rf "$W/r"; cp -r "$CLIENT" "$W/r"; rm -rf "$W/r/tasks"; ab redeem --peer "$TASK_PEER" "$GIFT" > "$W/redeem.log" 2>&1
else ab redeem --peer "$TASK_PEER" "$GIFT" > "$W/redeem.log" 2>&1; fi
check "redeem: $(grep -o 'Server: .*' "$W/redeem.log")" 'grep -q "left, good until" "$W/redeem.log"'

ab offers > "$W/offer.log" 2>&1
check "offer: worker identity, reads/changes/runs/sends, inference, tariff and the cap stated" 'grep -q "^Worker .*\(independent\|owner-operated\)" "$W/offer.log" && grep -q "^Reads    only the files you send" "$W/offer.log" && grep -q "^Sends    nothing to the network" "$W/offer.log" && grep -q "^Price    execution" "$W/offer.log" && grep -q "^At cap " "$W/offer.log"'
sed 's/^/    /' "$W/offer.log"
ab offers --peer "/ip4/127.0.0.1/tcp/1/p2p/${TASK_PEER##*/}" > "$W/dead.log" 2>&1
check "worker unavailable: stated plainly, nothing sent or charged" 'grep -q "unreachable (worker_unavailable). Nothing was sent or charged" "$W/dead.log"'

# 1. The useful task: a real bug fix in a supplied repo, tests unchanged; steered live, detached, reconnected, collected.
repo="$W/task-repo"; cp -r "$root/tests/fixtures/task-repo" "$repo"
ab commission --repo "$repo" --label open --cap 0.15usd --check "cd task-repo && node test.mjs" --detach \
  "In task-repo, 'node test.mjs' fails. Find the bug in keep.mjs and fix it without changing test.mjs, then run the test." > "$W/c1.log" 2>&1
T1=$(grep -o "Commissioned task [0-9a-f]*" "$W/c1.log" | cut -d' ' -f3)
check "commission: fresh task $T1 accepted" '[[ -n $T1 ]]'
(until grep -q "● running" "$W/a1.log" 2>/dev/null; do sleep 1; done; echo "Also keep the comment above keepValues accurate."; sleep 8; echo /detach) | ab tasks attach "$T1" > "$W/a1.log" 2>&1
check "live view and steering: events arrived and the instruction is in the task's event log" 'grep -q "› you: Also keep the comment" "$W/a1.log" && grep -q "Detached" "$W/a1.log"'
ab tasks attach "$T1" < /dev/null > "$W/a2.log" 2>&1
check "reconnect: resumed after the last event seen, ran to completion and collected" 'grep -q "(reconnected: " "$W/a2.log" && grep -q "^Task $T1: completed" "$W/a2.log"'
B="$W/r/tasks/$T1/bundle"
check "useful result: the unchanged test passes on the agent's change (test.log)" 'grep -q "^PASS" "$B/outputs/test.log" && grep -q "^exit 0" "$B/outputs/test.log"'
check "tests unchanged: the patch does not touch test.mjs" '! grep -q "test.mjs" "$B/outputs/patch.diff" && grep -q "keep.mjs" "$B/outputs/patch.diff"'
check "accounting: execution and inference charged separately, settled, unused released" 'node -e "const c=require(process.argv[1]).usage;process.exit(c.execution.charge>0&&c.inference.charge>0&&c.settled&&c.charged+c.released===c.cap?0:1)" "$B/completion.json"'
check "settlement: the completion names its settle entry; reserved = cap, charged + released = reserved, the charge events sum to the charge" 'node -e "const fs=require(\"fs\"),c=require(process.argv[1]),s=c.settlement,ev=fs.readFileSync(process.argv[2],\"utf8\").split(\"\\n\").filter(Boolean).map(JSON.parse).filter(e=>e.kind===\"charge\");process.exit(s.entry===\"task:\"+c.task_id+\":settle\"&&/^[0-9a-f]{64}$/.test(s.entry_sha256)&&s.reserved===c.usage.cap&&s.charged===c.usage.charged&&s.charged+s.released===s.reserved&&ev.reduce((a,e)=>a+e.data.amount,0)===s.charged?0:1)" "$B/completion.json" "$B/events.jsonl"'
sed -n '/^Task /,$p' "$W/a2.log" | sed 's/^/    /'

# 2. Idempotent retry: commission, stop and collect again change nothing.
before=$(sha256sum "$B/bundle.json"); ab commission --retry "$T1" > "$W/retry.log" 2>&1; ab tasks collect "$T1" > /dev/null 2>&1
check "idempotent commission retry: the worker answers with the existing task" 'grep -q "existing task (completed" "$W/retry.log"'
check "idempotent collect: byte-identical bundle" '[[ "$(sha256sum "$B/bundle.json")" == "$before" ]]'

# 3. Take control and cancel, on another bounded task.
ab commission --repo "$repo" --label open --cap 0.05usd --check "cd task-repo && node test.mjs" --detach "Run the shell command 'sleep 300' and then reply done." > "$W/c2.log" 2>&1
T2=$(grep -o "Commissioned task [0-9a-f]*" "$W/c2.log" | cut -d' ' -f3)
(until grep -q "● running" "$W/a3.log" 2>/dev/null; do sleep 1; done; sleep 12; echo /take; sleep 3; echo "/bash echo human-was-here > task-repo/HUMAN.txt && cat task-repo/HUMAN.txt"; sleep 5; echo /stop; sleep 30) | ab tasks attach "$T2" > "$W/a3.log" 2>&1
check "take control: the agent paused and the human's shell command ran in the same task" 'grep -q "control: you" "$W/a3.log" && grep -q "human-was-here" "$W/a3.log"'
check "cancel: the task ended cancelled, charged and released, with partial outputs" 'grep -q "^Task $T2: cancelled" "$W/a3.log" && [[ -f $W/r/tasks/$T2/bundle/outputs/files/task-repo/HUMAN.txt ]]'
ab tasks stop "$T2" > "$W/stop2.log" 2>&1
check "idempotent stop: stopping an ended task returns it unchanged" 'grep -q "the task is cancelled" "$W/stop2.log"'

# 4. Budget enforcement.
ab commission --repo "$repo" --label open --cap 0.01usd --check "cd task-repo && node test.mjs" --detach "Run the shell command 'sleep 300' and then reply done." > "$W/c3.log" 2>&1
T3=$(grep -o "Commissioned task [0-9a-f]*" "$W/c3.log" | cut -d' ' -f3)
ab tasks attach "$T3" < /dev/null > "$W/a4.log" 2>&1
check "budget: stopped at the cap, nothing charged past it" 'grep -q "^Task $T3: budget_exhausted" "$W/a4.log" && node -e "const u=require(process.argv[1]).usage;process.exit(u.charged<=u.cap?0:1)" "$W/r/tasks/$T3/bundle/completion.json"'
sed -n '/^Task /,$p' "$W/a4.log" | sed 's/^/    /'

# 5. Scope refusals and a replayed authorization: refused before anything is reserved or started.
ABALONE_DIR="$W/r" node --input-type=module -e '
const [root, peer, t1] = process.argv.slice(1);
const p2p = await import(root + "/lib/p2p.mjs"), task = await import(root + "/lib/commission.mjs"), { h } = await import(root + "/lib/contracts/task-v1.mjs");
const g = await p2p.giftClient(peer, JSON.parse((await import("node:fs")).readFileSync(process.env.ABALONE_CONFIG + "/providers.json")).peers.admit);
const r = task.record(t1), crypto = await import("node:crypto");
const variant = (f) => { const b = structuredClone(r.body); b.authorization.task_id = crypto.randomBytes(16).toString("hex"); f(b.authorization); b.authorization.inputs_root = h(b.authorization.inputs); return b; };
const tries = {
  private_input: variant((a) => a.inputs[0].label = "private"),
  over_balance: variant((a) => a.cap = 5e6),
  egress: variant((a) => a.capabilities.egress = ["example.com"]),
  replayed_id_new_task: (() => { const b = structuredClone(r.body); b.authorization.task.prompt = "something else"; return b; })(),
};
for (const [k, b] of Object.entries(tries)) {
  try { await task.call(g, "commission", b.authorization.task_id, b, b.authorization.task_id); console.log(k, "ACCEPTED"); }
  catch (e) { console.log(k, e.code, e.message); }
}
await g.close();' "$root" "$TASK_PEER" "$T1" > "$W/refuse.log" 2>&1
sed 's/^/    /' "$W/refuse.log"
check "scope: private input refused" 'grep -q "^private_input scope .*only released and open" "$W/refuse.log"'
check "scope: cap over the gift balance refused" 'grep -q "^over_balance budget" "$W/refuse.log"'
check "scope: network beyond the offer refused" 'grep -q "^egress scope" "$W/refuse.log"'
check "replayed authorization: a used task ID with a different authorization is refused" 'grep -q "^replayed_id_new_task task_id_reused" "$W/refuse.log"'
# The issuer's own view of the account (only when this script issued the gift): what the worker's ledger says was spent
# equals the sum of the three tasks' settled charges.
if [[ -n ${ISS:-} ]]; then
  ABALONE_DIR="$W/i" node "$root/tools/reconcile-tasks.mjs" "$TASK_PEER" "$W/r/tasks" > "$W/reconcile.log" 2>&1; rc=$?
  sed 's/^/    /' "$W/reconcile.log"
  check "reconciled: each settlement adds up, and the issuer's view of the worker ledger equals the settled charges" '[[ $rc == 0 ]]'
fi
ab tasks > "$W/list.log"
check "tasks list shows all three with their ends" 'grep -c "collected" "$W/list.log" | grep -q 3'
exit $fail
