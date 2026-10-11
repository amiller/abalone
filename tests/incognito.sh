#!/usr/bin/env bash
# Strict incognito (abalone --incognito, docs/protocols/trace-store.md), offline with the stub-e2ee model:
#   entry refusals; a private read plus an offline test run; destination and mode facts; a plaintext-marker scan of
#   state, run and temp dirs; fresh-process open; wrong passphrase, wrong key, key export/import into a fresh state dir;
#   corrupted, reordered, truncated and header-edited traces; an interrupted close (launcher SIGKILL); --with-trace;
#   .abalone/ outside the workspace and the notebook; sandbox argv hides the keys; delete.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
export STUB_SCRIPT="$root/tests/fixtures/scripts/incognito.mjs"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
ab() { "$root/bin/abalone" "$@"; }
pw() { ABALONE_PASSPHRASE_FD=3 "$root/bin/abalone" "$@" 3<<<"${PW:-correct horse}"; }
drive() { node "$root/tests/incognito-drive.mjs" stub-e2ee/script "$@" --keep-trace; }
M="MARK-$(head -c6 /dev/urandom | od -An -tx1 | tr -d ' \n' | tr a-f A-F)"
W="$ABALONE_DIR/work"; mkdir -p "$W"; cd "$W"
O=$(mktemp -d) # the test's own captures of the session's terminal output (plaintext by design: the terminal limit)
echo "client codename $M owes 4410" > secret.txt; printf 'grep -q MARK secret.txt && echo TESTS PASS\n' > test.sh
start="$ABALONE_DIR/.start"; touch "$start"

out=$(ab --incognito "$W" --keep-trace </dev/null 2>&1); check "retained trace requires deliberate key setup before launch" '[[ $out == *"no terminal to ask for the trace key passphrase"* ]]'
# Default session-only uses the same real sandbox but no key or transcript writer.
node "$root/tests/incognito-drive.mjs" stub-e2ee/script "please check secret.txt and run the tests" > "$O/ephemeral-events" 2> "$O/ephemeral-error"
check "default incognito does useful work without key or retained transcript" 'grep -q TESTS\ PASS "$O/ephemeral-events" && [[ ! -d .abalone/traces && ! -f $ABALONE_DIR/keys/trace-active ]] && grep -q "No conversation trace retained" "$O/ephemeral-error"'
check "default keeps no Pi history or plaintext marker in state/runtime" '[[ ! -d $ABALONE_DIR/agent/sessions && ! -d $ABALONE_DIR/notebook ]] && ! grep -rlF "$M" "$ABALONE_DIR" --exclude=secret.txt --exclude-dir=work'
pw trace key init > /dev/null
check "key files are outside the folder; the identity is age-encrypted" '[[ -f $(ls "$ABALONE_DIR"/keys/trace-*.pub) ]] && head -c 40 "$ABALONE_DIR"/keys/trace-*.age | grep -q "age-encryption.org/v1" && ! grep -rq AGE-SECRET-KEY "$ABALONE_DIR/keys"'
out=$(ab --incognito "$W" --model runner/claude 2>&1); check "an outside model is refused at entry" '[[ $out == *"not a ⌂ local or ◈ admitted provider"* ]]'
out=$(ab "$W" --with-trace x 2>&1); check "--with-trace without --incognito is refused" '[[ $out == *"works only with --incognito"* ]]'
out=$(ab --incognito "$W" --continue 2>&1); check "--continue is refused in incognito" '[[ $out == *"keeps no Pi session"* ]]'

drive "please check secret.txt and run the tests" > $O/ev1 2> $O/err1 || { cat $O/err1; fail=1; }
ev() { node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse); console.log(eval("(es=>"+process.argv[2]+")")(l))' "$1" "$2"; }
answer=$(ev $O/ev1 'es.filter(e=>e.type==="message_end"&&e.message.role==="assistant").at(-1).message.content[0].text')
check "useful work: the private file was read and the test ran in the sandbox" '[[ $answer == *"$M"* && $answer == *"TESTS PASS"* && $answer == *"exit 0"* ]]'
check "destination: the sent-to line names the ◈ model, and the strip says strict incognito" '[[ $(ev $O/ev1 "es.filter(e=>e.method===\"notify\").map(e=>e.message).join(\"|\")") == *"sent to: stub-e2ee TEE"* && $(ev $O/ev1 "es.filter(e=>e.method===\"setStatus\").map(e=>e.statusText).join(\"|\")") == *"incognito"* ]]'
check "close says in four short lines what was kept, what was not, and the one reopen command, with no absolute path" 'sed -n "/^Strict incognito closed/,\$p" $O/err1 > $O/close; [[ $(wc -l < $O/close) == 4 ]] && grep -q "^Kept: an encrypted trace in .abalone/traces/ ([0-9]* records)" $O/close && grep -q "^Not kept: " $O/close && grep -q "^Reopen: abalone --incognito . --with-trace [0-9a-f]*$" $O/close && ! grep -q "/tmp\|$HOME" $O/close'
id=$(ls .abalone/traces | sed -E 's/^[^-]+-//; s/\.trace$//'); T=".abalone/traces/$(ls .abalone/traces)"
check "one trace, encrypted: no plaintext marker in it" '[[ $(ls .abalone/traces | wc -l) == 1 ]] && ! grep -q "$M" "$T" && ! grep -q "TESTS PASS" "$T"'
hits=$( { grep -rlF "$M" "$ABALONE_DIR" --exclude=secret.txt; find /tmp "${XDG_RUNTIME_DIR}" -xdev -type f -newer "$start" -readable 2>/dev/null | xargs -r grep -lF "$M" 2>/dev/null; } | grep -v "^$O/" | sort -u)
check "marker scan: nothing under ABALONE_DIR (sessions, notebook, logs, keys), the runtime dir or new /tmp files holds it" '[[ -z $hits ]] || { echo "$hits"; false; }'
check "no Pi session dir and no notebook were written" '[[ ! -d $ABALONE_DIR/agent/sessions && ! -d $ABALONE_DIR/notebook ]]'

o=$(pw trace open "$W" "$id"); check "fresh-process open recovers the conversation, closed, matching the high-water mark" '[[ $o == *"$M"* && $o == *"TESTS PASS"* && $o == *"closed cleanly"* && $o == *"matches this computer"* ]]'
o=$(PW=wrong pw trace open "$W" "$id" 2>&1); check "wrong passphrase is refused, nothing printed" '[[ $o == *"wrong passphrase"* && $o != *"$M"* ]]'
o=$(ab trace list "$W"); check "trace list works without the key" '[[ $o == *"$id"* && $o == *closed* ]]'

# A copy of the project carries no key. In a fresh state dir: wrong key, then export/import recovery.
C="$ABALONE_DIR/copy"; cp -r "$W" "$C"
check "the copied project holds no key material" '! grep -rqE "AGE-SECRET-KEY|age-encryption.org/v1\s*$" "$C" --exclude-dir=traces'
ident=$(pw trace key export); F2=$(mktemp -d)
o=$(ABALONE_DIR=$F2 bash -c "$(declare -f pw); root=$root; pw trace key init >/dev/null; pw trace open '$C' '$id'" 2>&1)
check "wrong key: names the trace's key and the one present" '[[ $o == *"encrypted to trace key"* && $o == *"Import the right one"* ]]'
F3=$(mktemp -d); o=$(ABALONE_DIR=$F3 bash -c "$(declare -f pw); root=$root; echo '$ident' | PW=newpass pw trace key import && PW=newpass pw trace open '$C' '$id'" 2>&1)
check "recovery: export, import into a fresh ABALONE_DIR under a new passphrase, open (no high-water mark there, said so)" '[[ $o == *"$M"* && $o == *"no high-water mark"* ]]'

tamper() { cp -r "$W" "$1"; python3 -c "$2" "$1/$T"; pw trace open "$1" "$id" 2>&1; }
o=$(tamper "$ABALONE_DIR/t1" 'import sys;p=sys.argv[1];l=open(p).read().split("\n");s=l[2];l[2]=s[:10]+("A" if s[10]!="A" else "B")+s[11:];open(p,"w").write("\n".join(l))')
check "corrupted record: frame 1 fails authentication, nothing printed" '[[ $o == *"frame 1 failed authentication"* && $o != *"$M"* ]]'
o=$(tamper "$ABALONE_DIR/t2" 'import sys;p=sys.argv[1];l=open(p).read().split("\n");l[1],l[2]=l[2],l[1];open(p,"w").write("\n".join(l))')
check "reordered frames are refused" '[[ $o == *"frame 0 failed authentication"* ]]'
o=$(tamper "$ABALONE_DIR/t3" 'import sys;p=sys.argv[1];l=open(p).read().split("\n");del l[-2];open(p,"w").write("\n".join(l))')
check "dropping the final frame: refused as truncated against the high-water mark" '[[ $o == *"truncated or rolled back"* ]]'
o=$(tamper "$ABALONE_DIR/t4" 'import sys,json;p=sys.argv[1];l=open(p).read().split("\n");h=json.loads(l[0]);h["ss"]=("B" if h["ss"][0]=="A" else "A")+h["ss"][1:];l[0]=json.dumps(h,separators=(",",":"));open(p,"w").write("\n".join(l))')
check "edited header: frames no longer authenticate" '[[ $o == *"failed authentication"* ]]'
cp -r "$W" "$ABALONE_DIR/t6"; mv "$ABALONE_DIR/t6/$T" "$ABALONE_DIR/t6/.abalone/traces/20990101T000000Z-0000000000000000.trace"
o=$(pw trace open "$ABALONE_DIR/t6" 0000000000000000 2>&1); check "a file renamed to another id is refused" '[[ $o == *"the header names trace $id"* ]]'

# Interrupted close: the launcher is killed (SIGKILL) after the turn; Pi dies with it (bwrap --die-with-parent).
mkfifo "$ABALONE_DIR/in"; "$root/bin/abalone" --mode rpc --incognito --keep-trace --model stub-e2ee/script < "$ABALONE_DIR/in" > $O/ev2 2>$O/err2 & lp=$!
exec 4> "$ABALONE_DIR/in"; echo '{"id":"p1","type":"prompt","message":"please check secret.txt and run the tests"}' >&4
for i in $(seq 100); do grep -q agent_settled $O/ev2 && break; sleep 0.2; done
kill -9 $lp; exec 4>&-; wait $lp 2>/dev/null
id2=$(ls -t .abalone/traces | head -1 | sed -E 's/^[^-]+-//; s/\.trace$//')
o=$(pw trace open "$W" "$id2"); check "interrupted close: records recovered, reported NOT CLOSED" '[[ $o == *"TESTS PASS"* && $o == *"NOT CLOSED"* ]]'
o=$(ab trace list "$W"); check "trace list shows it not closed" '[[ $o == *"$id2"*"not closed"* ]]'

# Explicit reopen into a new session: a new trace, the old conversation shown and in context.
o=$(ABALONE_PASSPHRASE_FD=3 drive "context? what do you see" --with-trace "$id" 3<<<"correct horse" 2>$O/err3)
check "--with-trace: the reopened conversation is in the new session's context" '[[ $(ev <(echo "$o") "es.filter(e=>e.type===\"message_end\"&&e.message.role===\"assistant\").at(-1).message.content[0].text") == "reopened=true marker=$M" ]]'
shown=$(node --input-type=module -e "const t = await import(\"$root/lib/trace.mjs\"), { history } = await import(\"$root/lib/ui/tool-display.mjs\"); console.log(history(\"$id\", (await t.open(t.find(\"$W\", \"$id\").file, \"correct horse\")).records))")
check "--with-trace shows the old conversation as marked earlier history, tool steps summarized as in a live turn" '[[ $shown == "Earlier history: trace $id, reopened with --with-trace (closed "*"None of this is happening now."* && $shown == *"you: please check secret.txt"* && $shown == *"  Completed · read secret.txt"* && $shown == *"  Completed · \$ sh test.sh"* && $shown != *"<tool_call>"* && $shown != *"abalone-tool:"* ]]'
id3=$(ls -t .abalone/traces | head -1 | sed -E 's/^[^-]+-//; s/\.trace$//')
check "--with-trace writes a new trace (new key), never the old one" '[[ $id3 != "$id" && $(pw trace open "$W" "$id3") == *"You unlocked trace $id"* ]]'
drive "context? fresh" > $O/ev4 2>/dev/null
drive "mode? are you recording" > $O/ev7 2>/dev/null
check "I7: the system prompt states strict incognito from the launcher's descriptor" '[[ $(ev $O/ev7 "es.filter(e=>e.type===\"message_end\"&&e.message.role===\"assistant\").at(-1).message.content[0].text") == "incognito=true" ]]'
check "a session without --with-trace gets no old trace in context" '[[ $(ev $O/ev4 "es.filter(e=>e.type===\"message_end\"&&e.message.role===\"assistant\").at(-1).message.content[0].text") == "reopened=false marker=none" ]]'

# I2 in session: the outside model cannot be switched to (it can, in an ordinary session); no browser tab can be granted.
sw() { timeout 60 node "$root/tests/incognito-switch.mjs" "$@" 2>/dev/null; }
check "I2 in session: only ⌂/◈ models are offered and set_model runner/claude is refused (ordinary session: allowed)" '[[ $(sw --incognito) == *"\"available\":[\"stub/script\",\"stub-e2ee/script\"]"*"Model not found: runner/claude"* && $(sw) == *"\"set\":{\"id\":\"s\",\"type\":\"response\",\"command\":\"set_model\",\"success\":true"* ]]'
echo '[{"cmd": "/browser grant --open http://127.0.0.1:9/x --sites 127.0.0.1"}]' > $O/steps.json
timeout 60 node "$root/tests/browser-session.mjs" stub-e2ee/script $O/steps.json --incognito > $O/ev8 2>/dev/null
check "/browser grant is refused in strict incognito, at the launcher's bridge" 'grep -q "strict incognito has no browser" $O/ev8'
check "caps in incognito: no browse capability" 'ABALONE_INCOGNITO=1 node -e "import(\"'"$root"'/lib/caps.mjs\").then(c=>process.exit(c.table(process.cwd()).some(r=>r.action===\"browse\")?1:0))"'

# .abalone is outside the workspace, in every mode; the sandboxes hide the keys.
export STUB_SCRIPT="$root/tests/fixtures/scripts/intools.mjs"
node "$root/tests/session-drive.mjs" stub-e2ee/script "what's in this folder" > $O/ev5 2>/dev/null
node "$root/tests/session-drive.mjs" stub-e2ee/script "read file $T" > $O/ev6 2>/dev/null
check "ordinary session: the listing omits .abalone, a read of a trace is refused" '! grep -q "\.abalone" <(ev $O/ev5 "JSON.stringify(es.filter(e=>e.type===\"message_end\").map(e=>e.message.content))") && grep -q "abalone.s own record" $O/ev6'
check "the notebook has no record of any trace" '! grep -rqs "\.abalone\|$M" "$ABALONE_DIR/notebook"'
argv=$(node -e 'import("'"$root"'/lib/sandbox.mjs").then(s=>{const r=require("fs").mkdtempSync(require("os").tmpdir()+"/x");console.log(JSON.stringify([s.piArgv(r,[],process.cwd()),s.piArgv(r,[],process.cwd(),{incognito:true})]))})')
check "sandbox argv: keys are a tmpfs in ordinary mode; in incognito all of ABALONE_DIR is" 'node -e "const [a,b]=JSON.parse(process.argv[1]),d=process.env.ABALONE_DIR,at=(v,k,p)=>v.some((x,i)=>x===k&&v[i+1]===p); process.exit(at(a,\"--tmpfs\",d+\"/keys\")&&at(b,\"--tmpfs\",d)&&!at(b,\"--bind\",d)?0:1)" "$argv"'
check "caps in incognito: no outside answerer, ask_frontier lacks its capability" 'ABALONE_INCOGNITO=1 node -e "import(\"'"$root"'/lib/caps.mjs\").then(c=>{const t=c.table(process.cwd());process.exit(!t.some(r=>r.action===\"spawn:open\"||r.holder.startsWith(\"runner:\"))&&c.missing(t,\"ask_frontier\",{},process.cwd())&&c.document(process.cwd()).mode===\"strict-incognito\"?0:1)})"'

o=$(ab trace delete "$W" "$id"); check "leave no trace: delete removes the file and its high-water mark, and states its scope" '[[ ! -e $T && ! -e $ABALONE_DIR/trace-hwm/$id.json && $o == *"Not covered"* ]]'
exit $fail
