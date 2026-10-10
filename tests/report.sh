#!/usr/bin/env bash
# /report and abalone report: a session turn with a protocol error becomes tasks/issues/NNNN-<slug>.md and a replay fixture
# tests/regress/NNNN/, redacted unless asked, written locally with no network; the fixture replays through tests/regress/check.mjs.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
export STUB_SCRIPT="$root/tests/fixtures/scripts/intools.mjs" ABALONE_REPORT_DIR="$ABALONE_DIR/rep"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
mkdir -p "$ABALONE_DIR/work" && cd "$ABALONE_DIR/work"
node "$root/tests/session-drive.mjs" stub-e2ee/script "malformed secret-word-7" > ../ev 2>../err || cat ../err
f=$(ls -t "$ABALONE_DIR"/agent/sessions/*/*.jsonl | head -1)
check "the protocol error is in the local session trace, mode 0600" '[[ $(stat -c %a "$f") == 600 ]] && grep -q "\"customType\":\"protocol-error\".*{op: list}" "$f"'
strace -f -e trace=connect -o ../trace "$root/bin/abalone" report "$f" --title "Malformed tool line!" > ../out1
cat ../out1
fx="$ABALONE_REPORT_DIR/tests/regress/0001/fixture.json"
check "abalone report prints the issue and fixture paths and connects nowhere" \
  'grep -q "^Wrote $ABALONE_REPORT_DIR/tasks/issues/0001-malformed-tool-line.md$" ../out1 && ! grep -q "AF_INET" ../trace'
check "the issue follows the template" 'for h in "# 0001: Malformed tool line!" "**Reported:**" "**Status:** open." "**Severity:**" "**Where:** model \`stub-e2ee/script\`, tool protocol intools." "## Repro" "## Observed" "## Expected" "## Causes" "## Fix acceptance"; do grep -qF "$h" "$ABALONE_REPORT_DIR/tasks/issues/0001-malformed-tool-line.md" || exit 1; done'
check "the fixture is redacted by default: the user text is a placeholder; the raw reply and the protocol error are kept" \
  '! grep -q secret-word-7 "$fx" && grep -q "<user text, 23 bytes>" "$fx" && grep -qF "{op: list}" "$fx" && grep -q "\"protocol_error\"" "$fx"'
"$root/bin/abalone" report "$f" --include-text > /dev/null
check "--include-text keeps the user text, in the next number" 'grep -q secret-word-7 "$ABALONE_REPORT_DIR/tests/regress/0002/fixture.json"'
check "the generated fixture replays through the regress harness" 'node "$root/tests/regress/check.mjs" "$ABALONE_REPORT_DIR/tests/regress/0001" | grep -q "^PASS 0001 stop"'
# A command does not start an agent run (no agent_settled), so this drives RPC until the command's notification.
node -e 'const c=require("child_process").spawn(process.argv[1],["--mode","rpc","--model","stub-e2ee/script","--continue"]); let b="";
  const t=setTimeout(()=>{console.error("timed out");c.kill();process.exit(1)},60000);
  c.stdout.on("data",(d)=>{b+=d;let i;while((i=b.indexOf("\n"))>=0){const l=b.slice(0,i);b=b.slice(i+1);console.log(l);const e=JSON.parse(l);
    if(e.method==="select")c.stdin.write(JSON.stringify({type:"extension_ui_response",id:e.id,value:"redacted"})+"\n");
    if(e.method==="notify"){clearTimeout(t);c.stdin.end();}}});
  c.stdin.write(JSON.stringify({id:"p1",type:"prompt",message:"/report from the session"})+"\n")' "$root/bin/abalone" > ../ev2 2>../err2 || cat ../err2
check "/report in the session asks redacted or include text, then writes the issue through the launcher and shows the path" \
  'grep -q "\"options\":\[\"redacted\",\"include text\"\]" ../ev2 && grep -q "Wrote $ABALONE_REPORT_DIR/tasks/issues/0003-from-the-session.md" ../ev2 && ! grep -q secret-word-7 "$ABALONE_REPORT_DIR/tests/regress/0003/fixture.json"'
echo "report: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
