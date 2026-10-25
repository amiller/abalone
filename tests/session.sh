#!/usr/bin/env bash
# The sandboxed session (bin/abalone sandbox), driven over Pi's RPC mode with the stub private reader
# (tests/fixtures/scripts/first-crack.mjs as policy.json mediator) and the stub runner (stub-claude.sh):
#   1. outside model selected + a private fixture file mentioned → the pour prompt appears, after the private side read it;
#   2. continue privately sends nothing (strace connect + execve);
#   3. edit, then send: the exact edited bytes reach the runner;
#   4. a private-model turn never touches the runner, and abalone adds the mentioned file to its request;
#   5. a standing policy lets an in-policy pour go without a prompt; an image is refused before anything leaves;
#   6. the strip fits 80 columns with no escape bytes.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
export STUB_SCRIPT="$root/tests/fixtures/scripts/first-crack.mjs"
inet() { grep -oP 'sin6?_port=htons\(\K[1-9][0-9]*\).*?(inet_addr\("|AF_INET6, ")[^"]+' "$1" | sed -E 's/\).*"/ /' | awk '{print $2":"$1}' | sort -u; }
ev() { node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse); console.log(eval("(es=>"+process.argv[2]+")")(l))' "$1" "$2"; }
answer='es.filter(e=>e.type==="message_end"&&e.message.role==="assistant").at(-1).message'
last() { node -e 'const l=require("fs").readFileSync("disclosures.jsonl","utf8").trim().split("\n").at(-1); console.log(eval("(r=>"+process.argv[1]+")")(JSON.parse(l)))' "$1"; }
opens() { grep -c '"domain":"open"' agents.jsonl; }
fail=0
notes='es.filter(e=>e.method==="notify").map(e=>e.message).join("\\n")'
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
drive() { node "$root/tests/session-drive.mjs" "$@"; }
mkdir -p "$ABALONE_DIR/work" && cp "$root/tests/fixtures/docs/tenancy-renewal.txt" "$ABALONE_DIR/work/" && cd "$ABALONE_DIR/work"
unset ABALONE_NO_CANARIES; "$root/bin/abalone" canary init . > /dev/null
q="@tenancy-renewal.txt If I do nothing, what happens to my tenancy?"
standing claude '[]'

CHOICES='["continue privately"]' strace -f -e trace=connect,execve -o ../trace1 node "$root/tests/session-drive.mjs" runner/claude "$q" > ../ev1 2>../err1 || cat ../err1
cd "$ABALONE_DIR"
sel='es.find(e=>e.type==="extension_ui_request"&&e.method==="select")'
ev ev1 "$sel.title"
check "outside model + mentioned file: the pour prompt appears with the exact text, destination and choices" \
  '[[ $(ev ev1 "$sel.title.split(\"\\n\")[0]") =~ ^REVIEW\ DISCLOSURE\ d-[0-9a-f]{8}:\ NOT\ SENT$ ]] && ev ev1 "$sel.title" | grep -q "^  to     runner:claude, outside abalone" && ev ev1 "$sel.title" | grep -q "^| Under a typical residential tenancy" && [[ $(ev ev1 "$sel.options.join(\"|\")") == "continue privately|edit|send once|details" ]]'
check "the private side read the file first (its answer quotes L19 and L21 of the mention)" \
  'ev ev1 "$answer.content[0].text" | grep -q "return the signed form by 15 November 2026 \[L19\]" && grep -q "\"event\":\"first-crack\".*tenancy-renewal.txt" agents.jsonl'
echo "  inet connects: [$(inet trace1 | tr '\n' ' ')]  runner execs: $(grep -c 'execve(".*stub-claude' trace1)"
check "continue privately sends nothing: no inet connect, no runner started, no run dir" '[[ -z $(inet trace1) ]] && ! grep -q "execve(\".*stub-claude" trace1 && [[ $(opens) == 0 ]]'
check "continue privately is logged as not sent, with the payload's hash and size but not its text, and said in the transcript" \
  '! grep -q "\"payload\":" disclosures.jsonl && [[ $(last r.payload_sha256) =~ ^[0-9a-f]{64}$ ]] && [[ $(wc -l < disclosures.jsonl) == 1 && $(last r.label) == "not sent" && $(last r.approval) == declined ]] && ev ev1 "$answer.content[0].text" | grep -q "was \*\*not sent\*\*: you chose to continue privately"'
check "every pour-screen line fits 80 columns and holds no escape byte" '! ev ev1 "$sel.title" | awk "length > 80" | grep -q . && ! ev ev1 "$sel.title" | grep -qP "\x1b"'
status='es.filter(e=>e.method==="setStatus"&&e.statusKey==="abalone").at(-1).statusText'
ev ev1 "$status"
check "the strip: one line, at most 80 columns, no escape bytes, outside model shown with its private reader" \
  '[[ $(ev ev1 "$status" | wc -l) == 1 && $(ev ev1 "$status" | wc -m) -le 81 ]] && ! ev ev1 "$status" | grep -qP "\x1b" && ev ev1 "$status" | grep -q "^○ outside runner/claude, read first by ◈ script · nothing shared$"'

rm -f "$root/runner-home/test/received"
cd work
CHOICES="[\"edit\", {\"editor\": \"$root/tests/fixtures/edited-pour.txt\"}, \"send once\"]" drive runner/claude "$q" > ../ev2 2>../err2 || cat ../err2
cd "$ABALONE_DIR"
printf 'Another agent asks the question below. Answer it directly: you have no tools and no files.\n\n' | cat - "$root/tests/fixtures/edited-pour.txt" > expected-received
check "edit, then send: one runner run; the released record and the bytes the runner received are the edited text" \
  '[[ $(opens) == 1 && $(last r.label) == released && $(last r.approval) == user-once && $(last r.edited) == true ]] && node -e "process.exit(Buffer.from(JSON.parse(require(\"fs\").readFileSync(\"disclosures.jsonl\",\"utf8\").trim().split(\"\\n\").at(-1)).payload).equals(require(\"fs\").readFileSync(process.argv[1]))?0:1)" "$root/tests/fixtures/edited-pour.txt" && cmp "$root/runner-home/test/received" expected-received && [[ $(last r.payload_sha256) == $(sha256sum < "$root/tests/fixtures/edited-pour.txt" | cut -d" " -f1) ]]'
check "the runner's scratch dir (holding the pour) is removed when the run ends" '[[ -z $(ls runs 2>/dev/null) ]]'
check "edit, then send: the prompt was shown again with the edited text before send" \
  '[[ $(ev ev2 "es.filter(e=>e.method===\"select\").length") == 2 ]] && ev ev2 "es.filter(e=>e.method===\"select\")[1].title" | grep -q "^| In England, when a fixed-term residential tenancy ends" && ev ev2 "es.filter(e=>e.method===\"select\")[1].title" | grep -q "(written before your edit)"'
check "the reply is labelled open and checked privately" \
  'ev ev2 "$answer.content[0].text" | grep -q "^\*\*Open reply\*\* from runner:claude (outside, untrusted, not yet checked):" && ev ev2 "$answer.content[0].text" | grep -q "^> stub answer to" && ev ev2 "$answer.content[0].text" | grep -q "^\*\*Private check\*\* by ◈ attested stub/script"'

before=$(wc -l < disclosures.jsonl); nb0=$(grep -c '"kind":"conclusion"' notebook/records.jsonl 2>/dev/null)
cd work
strace -f -e trace=connect,execve -o ../trace3 node "$root/tests/session-drive.mjs" stub/script "$q" > ../ev3 2>../err3 || cat ../err3
cd "$ABALONE_DIR"
check "a private-model turn proceeds normally (the mention read by abalone into the request): no dialog, no runner exec, no new run, nothing logged as a pour" \
  '[[ $(ev ev3 "es.filter(e=>e.method===\"select\").length") == 0 && -z $(inet trace3) ]] && ! grep -q "execve(\".*stub-claude" trace3 && [[ $(opens) == 1 && $(wc -l < disclosures.jsonl) == $before ]] && ev ev3 "$answer.content[0].text" | grep -q "^private model turn, file read by abalone: yes$"'
check "the session writes the notebook: the private @file turn is saved, and a new process finds it" \
  '[[ $(( $(grep -c "\"kind\":\"conclusion\"" notebook/records.jsonl) - ${nb0:-0} )) == 1 ]] && "$root/bin/abalone" notebook search renewal form | grep -q "^\[source line\] src-[0-9a-f]*:L19: To accept" && "$root/bin/abalone" notebook search file read by abalone | grep -q "^\[model conclusion\]"'

standing claude '["free_text"]'
cd work
drive runner/claude "$q" > ../ev4 2>../err4 || cat ../err4
cd "$ABALONE_DIR"
check "a standing policy for runner:claude lets the in-policy pour go without a prompt, logged as standing" \
  '[[ $(ev ev4 "es.filter(e=>e.method===\"select\").length") == 0 && $(opens) == 2 && $(last r.approval) == standing ]] && ev ev4 "$answer.content[0].text" | grep -q "under your standing policy free_text"'
printf '\x89PNG\r\n\x1a\n\0\0' > work/photo.png
cd work
drive runner/claude "what is in @photo.png ?" > ../ev5 2>../err5 || cat ../err5
cd "$ABALONE_DIR"
ev ev5 "$answer.errorMessage"
check "an attachment the private side cannot read stops the turn before anything leaves" \
  '[[ $(ev ev5 "$answer.stopReason") == error && $(opens) == 2 ]] && ev ev5 "$answer.errorMessage" | grep -q "photo.png"'
cd work
drive stub/script "what is in @photo.png ?" > ../ev6 2>../err6 || cat ../err6
cd "$ABALONE_DIR"
check "with a private model too, an unreadable mention stops the turn with the reason, before the model is asked" \
  'ev ev6 "es.filter(e=>e.method===\"notify\"&&e.notifyType===\"error\").map(e=>e.message).join()" | grep -q "photo.png could not be read privately" && ! grep -q "private model turn" ev6'
cd work
CHOICES='["continue privately"]' drive runner/claude "$q NOT NEEDED" > ../ev7 2>../err7 || cat ../err7
CHOICES='["continue privately"]' drive runner/claude "$q NOTHING PERMITTED" > ../ev8 2>../err8 || cat ../err8
cd "$ABALONE_DIR"
check "the mediator never vetoes the chosen outside model: 'not needed' is advice in the prompt, and send stays offered" \
  'ev ev7 "$sel.title" | grep -q "^  advice the private agent thinks its answer suffices" && [[ $(ev ev7 "$sel.options.join(\"|\")") == "continue privately|edit|send once|details" ]]'
check "when the policy permits nothing useful, the prompt says so and offers no send" \
  'ev ev8 "$sel.title" | tr -s " \n" " " | grep -q "Send is not available: the private agent found nothing your policy permits" && [[ $(ev ev8 "$sel.options.join(\"|\")") == "continue privately|edit|details" ]]'
cd work
strace -f -e trace=connect,execve -o ../trace9 node "$root/tests/session-drive.mjs" stub/script "what's in this folder?" > ../ev9 2>../err9 || cat ../err9
cd "$ABALONE_DIR"
ev ev9 "$answer.content[0].text"
check "\"what's in this folder\" with a private model: names and sizes from abalone's local listing, nothing sent" \
  'ev ev9 "$answer.content[0].text" | grep -q "^tenancy-renewal.txt  $(stat -c %s work/tenancy-renewal.txt) bytes$" && ev ev9 "$answer.content[0].text" | grep -q "^photo.png  " && [[ -z $(inet trace9) ]] && ! grep -q "execve(\".*stub-claude" trace9'
# Tools inside the encrypted content (stub-e2ee is marked "tools": "in-content", as NEAR is).
cd work
export STUB_SCRIPT="$root/tests/fixtures/scripts/intools.mjs"
canaryfile=$(ls ref-*.txt)
for q in "who are you" "what's in this folder?" "summarize tenancy-renewal.txt" "read outside the folder" "loop" "mixed" "malformed" "glm native call" "read file $canaryfile" "grep codename"; do
  n=$(tr -cd 'a-z' <<<"${q%% *}"); case $q in "read file "*) n=readfile;; "grep codename") n=grepcodename;; esac
  strace -f -e trace=connect,execve -o "../trace-$n" node "$root/tests/session-drive.mjs" stub-e2ee/script "$q" > "../ev-$n" 2>"../err-$n" || cat "../err-$n"
done
mkdir ../drafts && cd ../drafts && echo x > notes.txt
drive stub-e2ee/script "write draft" --no-canaries > ../ev-draft1 2>../err-draft1 || cat ../err-draft1
drive stub-e2ee/script "and now?" --continue --no-canaries > ../ev-draft2 2>../err-draft2 || cat ../err-draft2
export STUB_SCRIPT="$root/tests/fixtures/scripts/first-crack.mjs"
cd "$ABALONE_DIR"
tool='es.filter(e=>e.type==="entry_appended"&&e.entry.customType==="abalone-tool").map(e=>e.entry.content).join("\n---\n")'
check "the system prompt is abalone's, carries the tool protocol for an in-content provider and the session's usage, and never calls the agent Pi" \
  '[[ $(ev ev-who "$answer.content[0].text") == "system prompt: abalone=true protocol=true usage=true sentto=true pi=false" ]]'
check "in-content tools: \"what's in this folder\" runs list here and the answer has names and sizes; no inet, no runner" \
  'ev ev-whats "$tool" | grep -q "^tenancy-renewal.txt  $(stat -c %s work/tenancy-renewal.txt) bytes$" && ev ev-whats "$answer.content[0].text" | grep -q "^tenancy-renewal.txt  " && [[ -z $(inet trace-whats) ]] && ! grep -q "execve(\".*stub-claude" trace-whats'
check "in-content tools: read returns the file as numbered lines" 'ev ev-summarize "$tool" | grep -q "^L19: To accept, sign and return the enclosed renewal form by 15 November 2026.$"'
check "in-content tools: a path outside the workspace is refused in the result" 'ev ev-read "$tool" | grep -q "error: ../agents.jsonl is outside the workspace folder"'
check "in-content tools: a model that keeps asking is stopped after the limit" '[[ $(ev ev-loop "es.filter(e=>e.type===\"entry_appended\"&&e.entry.customType===\"abalone-tool\").length") == 13 ]] && ev ev-loop "$tool" | grep -q "tool limit for this message (12 requests) is reached"'
check "in-content tools: a reply mixing a real and an unknown tool runs the real one, shows retrying, and records the protocol error" \
  '[[ $(ev ev-mixed "es.filter(e=>e.method===\"setStatus\"&&e.statusKey===\"abalone-retry\").map(e=>e.statusText??\"-\").join()") == "◌ retrying…,-" ]] && ev ev-mixed "$tool" | grep -q "not executed: abalone has no \"browser\" tool" && ev ev-mixed "es.filter(e=>e.type===\"entry_appended\"&&e.entry.customType===\"protocol-error\").length" | grep -qx 1'
check "in-content tools: a reply with no well-formed tool line ends the turn with one sentence and /report, after one model call" \
  '[[ $(ev ev-malformed "es.filter(e=>e.type===\"message_end\"&&e.message.role===\"assistant\").length") == 1 ]] && ev ev-malformed "es.filter(e=>e.type===\"entry_appended\"&&e.entry.customType===\"abalone-note\").map(e=>e.entry.content).join()" | grep -q "^not executed: abalone couldn.t read this tool request.*Type /report to file it.$"'
check "in-content tools: GLM's native <tool_call>list…</tool_call> runs as list" 'ev ev-glm "$tool" | grep -q "^tenancy-renewal.txt  " && ev ev-glm "$answer.content[0].text" | grep -q "^From abalone.s tool result"'
cd work; drive - "hello" > ../ev10 2>../err10 || cat ../err10; cd "$ABALONE_DIR"
check "the first message's folder listing is taken once: draft.md, written on the first call, is in neither later call's listing" \
  '[[ -f drafts/draft.md ]] && (for e in ev-draft1 ev-draft2; do ev $e "$answer.content[0].text" | grep -q "^notes.txt  2 bytes$" && ! ev $e "$answer.content[0].text" | grep -q draft.md || exit 1; done)'
check "canary files are hidden from the private model: not in list, grep or the first-turn listing; read says no such file" \
  '! ev ev-whats "$tool" | grep -q "ref-" && ev ev-readfile "$tool" | grep -q "error: no such file: $canaryfile" && ! ev ev-grepcodename "$tool" | grep -q "ref-" && ! ev ev9 "$answer.content[0].text" | grep -q "ref-"'
check "the default model is providers.json \"default\" (stub/script here), not the first provider with a key" \
  '[[ $(ev ev10 "es.filter(e=>e.type===\"message_end\"&&e.message.role===\"assistant\").at(-1).message.provider + \"/\" + es.filter(e=>e.type===\"message_end\"&&e.message.role===\"assistant\").at(-1).message.model") == stub/script ]]'
check "after each answer, a \"sent to\" line from measured state: the model and place, and the files read into it" \
  'ev ev3 "$notes" | grep -q "^sent to: stub TEE (script), encrypted to the enclave abalone checked · files read into it: tenancy-renewal.txt$" && ev ev-summarize "$notes" | grep -q "files read into it: tenancy-renewal.txt$"'
echo "session: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
