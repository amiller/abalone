#!/usr/bin/env bash
# The interactive session in a real terminal (tmux, 80x24, NO_COLOR), with the stub private reader and stub runner:
# the footer strip, the model picker's place labels, the pour prompt with its choices visible, Enter on the first
# choice continuing privately, and /evidence. Screens are saved next to ABALONE_DIR for review.
set -uo pipefail
# A private tmux server: a user's attached tmux (window-size latest) would otherwise resize these sessions.
tmux() { command tmux -L "abalone-tui-$$" "$@"; }
. "$(dirname "$0")/lib/env.sh"; stubcfg
export STUB_SCRIPT="$root/tests/fixtures/scripts/first-crack.mjs"
standing claude '[]'
mkdir -p "$ABALONE_DIR/work" && cp "$root/tests/fixtures/docs/tenancy-renewal.txt" "$ABALONE_DIR/work/"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
(cd "$ABALONE_DIR/work" && "$root/bin/abalone" ask --model stub/script tenancy-renewal.txt "When is the form due?" > ../ask.txt 2>&1) || cat "$ABALONE_DIR/ask.txt"
t=abalone-tui-$$
screen() { tmux capture-pane -t $t -p "$@"; }
wait_for() { for _ in $(seq 60); do screen | grep -q -- "$1" && return 0; sleep 0.5; done; echo "timed out waiting for: $1"; screen; return 1; }
tmux new-session -d -s $t -x 80 -y 24 "cd $ABALONE_DIR/work && NO_COLOR=1 ABALONE_NO_CANARIES=1 ABALONE_DIR=$ABALONE_DIR ABALONE_CONFIG=$ABALONE_CONFIG STUB_SCRIPT=$STUB_SCRIPT ABALONE_RUNNER_CLAUDE=$ABALONE_RUNNER_CLAUDE $root/bin/abalone sandbox --model stub/script; sleep 60"
trap 'tmux kill-server 2>/dev/null' EXIT

wait_for "nothing shared"
foot=$(screen | grep -v '^\s*$' | tail -1); screen -e > "$ABALONE_DIR/screen-start.txt"; screen > "$ABALONE_DIR/screen-start-plain.txt"
head -8 "$ABALONE_DIR/screen-start-plain.txt"
check "the first screen is abalone's: where you are, the model and its place, the hints; no Pi self-description or skill and extension lists" \
  'tr -s "\n " " " < "$ABALONE_DIR/screen-start-plain.txt" | grep -q " abalone · [^ ]*/work (1 entries) · abalone reads files here on this computer" && grep -q "^ Model: ◈ attested script, not yet checked · /model to change" "$ABALONE_DIR/screen-start-plain.txt" && grep -q "^ @file to include a file · /model to choose where work runs · /folder to switch" "$ABALONE_DIR/screen-start-plain.txt" && ! grep -q "Pi can explain\|\[Skills\]\|\[Extensions\]\|Warning: fd\|Warning: ripgrep" "$ABALONE_DIR/screen-start-plain.txt"'
echo "  footer: $foot"
check "footer: one line within 80 columns, friend-readable place, sharing and canaries off (spend is in /evidence) ($foot)" '[[ $foot == "◈ attested script, not yet checked · nothing shared · no canaries" ]]'
check "footer: no color escapes with NO_COLOR (only the terminal's resets)" '! grep -v "^\s*$" "$ABALONE_DIR/screen-start.txt" | tail -1 | grep -qP "\x1b\[(?!0m|39m|49m)[0-9;]*m"'

tmux send-keys -t $t "/model" Enter; wait_for "Model Name"
screen > "$ABALONE_DIR/screen-model.txt"; grep "\[stub\]\|\[runner\]" "$ABALONE_DIR/screen-model.txt"
check "the model picker lists each model with its place" \
  'grep -q "script \[stub\] ◈ attested: checked before the first byte$" "$ABALONE_DIR/screen-model.txt" && grep -q "claude \[runner\] ○ outside: your claude login, sandboxed runner$" "$ABALONE_DIR/screen-model.txt"'
tmux send-keys -t $t Escape; sleep 0.5
tmux send-keys -t $t "/model runner/claude" Enter; wait_for "read first by"

tmux send-keys -t $t "@tenancy-renewal.txt If I do nothing, what happens to my tenancy?"; sleep 0.3; tmux send-keys -t $t Enter
wait_for "REVIEW DISCLOSURE"
screen > "$ABALONE_DIR/screen-pour.txt"; cat "$ABALONE_DIR/screen-pour.txt"
check "the pour prompt fits 80x24 with its choices on screen, continue privately selected" \
  'grep -q "^> continue privately <   edit     send once     details$" "$ABALONE_DIR/screen-pour.txt" && grep -q "^| Under a typical residential tenancy" "$ABALONE_DIR/screen-pour.txt"'
tmux send-keys -t $t Enter; wait_for "was not sent"
check "Enter on the first choice continues privately: nothing sent, no runner run" '[[ ! -d $ABALONE_DIR/runs ]] && grep -q "\"label\":\"not sent\"" "$ABALONE_DIR/disclosures.jsonl"'

tmux send-keys -t $t "/evidence" Enter; wait_for "Evidence (from abalone"
screen > "$ABALONE_DIR/screen-evidence.txt"
check "/evidence names where each resource runs, and the spend" 'grep -q "spent this session: \$0.0000 at list price" "$ABALONE_DIR/screen-evidence.txt" && grep -q "selected model: ○ outside runner/claude" "$ABALONE_DIR/screen-evidence.txt" && grep -q "private reader for outside models: ◈ attested stub/script" "$ABALONE_DIR/screen-evidence.txt"'
tmux send-keys -t $t "/notebook" Enter; wait_for "Project default"
screen > "$ABALONE_DIR/screen-notebook.txt"
tmux send-keys -t $t "/search renewal form" Enter; wait_for "\[source line\]"
screen > "$ABALONE_DIR/screen-search.txt"
check "/notebook and /search read the private notebook in the session" 'grep -q "tenancy-renewal.txt: 1 questions" "$ABALONE_DIR/screen-notebook.txt" && grep -q "^ \[source line\] src-[0-9a-f]*:L19: To accept, sign and return the enclosed" "$ABALONE_DIR/screen-search.txt"'
tmux send-keys -t $t "/redeem g1notacode" Enter; wait_for "This code looks incomplete"
screen > "$ABALONE_DIR/screen-redeem.txt"; grep -v "^\s*$" "$ABALONE_DIR/screen-redeem.txt" | tail -4
check "/redeem runs the CLI's redeem through the launcher and shows its friend-readable error" 'grep -q "Error: This code looks incomplete" "$ABALONE_DIR/screen-redeem.txt"'
tmux send-keys -t $t "/about" Enter; wait_for "abalone is built on Pi"
screen > "$ABALONE_DIR/screen-about.txt"
check "/about holds what the first screen left out: Pi, built-in Tor, the missing fd/rg tools and their effect, the curated components" 'grep -q "^ abalone is built on Pi" "$ABALONE_DIR/screen-about.txt" && grep -q "^ Tor: built in (Arti compiled to WebAssembly" "$ABALONE_DIR/screen-about.txt" && grep -q "^ fd: \(installed\|not installed, so @ autocomplete lists fewer files\)" "$ABALONE_DIR/screen-about.txt" && grep -q "tests/fixtures/scripts" "$ABALONE_DIR/screen-about.txt"'
other=$(mktemp -d) && echo "synthetic" > "$other/notes.txt"   # outside ABALONE_DIR: /folder refuses abalone's own state
tmux send-keys -t $t "/folder $ABALONE_DIR" Enter; wait_for "Switch to"; sleep 1; tmux send-keys -t $t Enter; wait_for "holds or is inside abalone's own code or"
check "/folder refuses abalone's own state directory" 'screen | grep -q "Error: .* holds or is inside abalone.s own code or"'
tmux send-keys -t $t "/cost" Enter; wait_for "This session: "
tmux send-keys -t $t "/privacy" Enter; wait_for "More: /privacy --details"
screen > "$ABALONE_DIR/screen-privacy-plain.txt"
check "/privacy lists this session's own connections (the egress log carries the session's run id)" 'tr -s "\n " " " < "$ABALONE_DIR/screen-privacy-plain.txt" | grep -q "This session.s connections from this computer: "'
check "/privacy speaks plainly: what is kept, where, who sees your words; no operator, devNode or first-crack jargon" 'tr -s "\n " " " < "$ABALONE_DIR/screen-privacy-plain.txt" | grep -q "Who can see your words: - This computer: everything." && ! grep -qiw "S0\|devNode\|first-crack\|FMSPC" "$ABALONE_DIR/screen-privacy-plain.txt"'
tmux send-keys -t $t "/privacy --details" Enter; wait_for "Limits:"
screen > "$ABALONE_DIR/screen-privacy.txt"
check "/privacy --details has the technical version" 'tr -s "\n " " " < "$ABALONE_DIR/screen-privacy.txt" | grep -q "plaintext at rest: private-out/, agent/sessions/" && grep -q "^ Limits:" "$ABALONE_DIR/screen-privacy.txt"'
tmux send-keys -t $t "switch to another folder" Enter; wait_for "To work in another folder, type /folder"
check "\"switch to another folder\" in plain words points to /folder and is not sent to the model" 'screen | grep -q "To work in another folder, type /folder"'
tmux send-keys -t $t "/folder" Enter; wait_for "Work in which folder?"
screen > "$ABALONE_DIR/screen-folder-picker.txt"
check "bare /folder opens a picker: recent folders and a path prompt" 'grep -q "Type a path…" "$ABALONE_DIR/screen-folder-picker.txt"'
tmux send-keys -t $t Escape; sleep 1
# Code changed mid-session (here: the config copy's recorded hash): /folder says so and the session stays open.
cp "$ABALONE_CONFIG/curated/manifest.json" "$ABALONE_DIR/manifest.bak"
node -e 'const f=process.argv[1],m=JSON.parse(require("fs").readFileSync(f));m.entries[0].sha256="0".repeat(64);require("fs").writeFileSync(f,JSON.stringify(m))' "$ABALONE_CONFIG/curated/manifest.json"
tmux send-keys -t $t "/folder $other" Enter; wait_for "Switch to $other"; sleep 1; tmux send-keys -t $t Enter; wait_for "You are still in"
screen > "$ABALONE_DIR/screen-folder-refused.txt"; cp "$ABALONE_DIR/manifest.bak" "$ABALONE_CONFIG/curated/manifest.json"
check "changed code: /folder explains what it means and what to do, and the session stays open" 'tr -s "\n " " " < "$ABALONE_DIR/screen-folder-refused.txt" | grep -q "abalone.s own code changed since it was verified" && grep -q "rehash-manifest.mjs\|reinstall" "$ABALONE_DIR/screen-folder-refused.txt" && screen | grep -q "nothing shared"'

tmux send-keys -t $t "/folder $other" Enter; wait_for "Switch to $other"
screen > "$ABALONE_DIR/screen-folder-confirm.txt"; sleep 1; tmux send-keys -t $t Enter; sleep 2; screen > "$ABALONE_DIR/screen-folder-after.txt"; wait_for "abalone · $other (1 entries)"
screen > "$ABALONE_DIR/screen-folder.txt"
check "/folder restarts abalone in the other folder, and the first screen says where it is now" 'grep -q "^ abalone · $other (1 entries) · abalone reads" "$ABALONE_DIR/screen-folder.txt"'
tmux send-keys -t $t "hello there" Enter; wait_for "private model turn"
tmux send-keys -t $t C-d; sleep 0.5; tmux send-keys -t $t C-d; wait_for "Resume with: abalone"
resume=$(screen -J | grep -o "Resume with: abalone .*" | tail -1 | sed "s/^Resume with: //; s/ *$//")
echo "  exit line: Resume with: $resume"
check "on exit abalone prints its own resume line (folder and session id)" '[[ $resume =~ ^abalone\ sandbox\ $other\ --resume\ [0-9a-f-]+$ ]]'
tmux kill-session -t $t; tmux new-session -d -s $t -x 80 -y 24 "env NO_COLOR=1 ABALONE_NO_CANARIES=1 ABALONE_DIR=$ABALONE_DIR ABALONE_CONFIG=$ABALONE_CONFIG STUB_SCRIPT=$STUB_SCRIPT ABALONE_RUNNER_CLAUDE=$ABALONE_RUNNER_CLAUDE $root/bin/abalone ${resume#abalone } --model stub/script; sleep 60"
wait_for "hello there"
check "that line resumes the conversation in that folder" 'screen | grep -q "hello there" && screen | grep -q "private model turn"'

# In-content tools (stub-e2ee, as NEAR is): the answer shows readable steps, never the raw tool-call protocol.
tmux new-session -d -s $t-tools -x 100 -y 30 "cd $ABALONE_DIR/work && NO_COLOR=1 ABALONE_NO_CANARIES=1 ABALONE_DIR=$ABALONE_DIR ABALONE_CONFIG=$ABALONE_CONFIG STUB_SCRIPT=$root/tests/fixtures/scripts/intools.mjs $root/bin/abalone sandbox --model stub-e2ee/script; sleep 60"
for _ in $(seq 60); do tmux capture-pane -t $t-tools -p | grep -q "nothing shared" && break; sleep 0.5; done
tmux send-keys -t $t-tools "what's in this folder?" Enter
for _ in $(seq 60); do tmux capture-pane -t $t-tools -p | grep -q "From abalone's tool result" && break; sleep 0.5; done
tmux capture-pane -t $t-tools -p > "$ABALONE_DIR/screen-tools.txt"; tmux kill-session -t $t-tools
check "tool use shows as a readable step (Completed · listed .) and no raw protocol text" 'grep -q "Completed · listed \." "$ABALONE_DIR/screen-tools.txt" && ! grep -q "<abalone-tool>\|<tool_call>\|arg_key" "$ABALONE_DIR/screen-tools.txt"'
# Arrival: the wordmark line is the first thing on screen, in color, at 80x34 and 80x24; no art above it.
for size in 80x34 80x24; do
  tmux new-session -d -s $t-art -x ${size%x*} -y ${size#*x} "cd $ABALONE_DIR/work && env -u NO_COLOR ABALONE_DIR=$ABALONE_DIR ABALONE_CONFIG=$ABALONE_CONFIG STUB_SCRIPT=$STUB_SCRIPT ABALONE_NO_CANARIES=1 TERM=xterm-256color $root/bin/abalone sandbox --model stub/script; sleep 60"
  for _ in $(seq 60); do tmux capture-pane -t $t-art -p | grep -q "nothing shared" && break; sleep 0.5; done
  tmux capture-pane -t $t-art -p > "$ABALONE_DIR/screen-art-$size.txt"; tmux kill-session -t $t-art
done
check "arrival: the wordmark line comes first at 80x34 and 80x24" '(for s in 80x34 80x24; do grep -m1 . "$ABALONE_DIR/screen-art-$s.txt" | grep -q "^ abalone · " || exit 1; done)'
echo "tui: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
