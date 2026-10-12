#!/usr/bin/env bash
# Usability gate, offline part (docs/release.md): a recipient's cold run from the
# redeem link to an open credit session (valid and expired offer) with every message recorded, the slash commands a
# credit session shows, and its first screen at 80x24 and 120x40 on light and dark terminals. Evidence goes to
# local-data/usability/<run>/. Checks that today's code fails by design are listed in XFAIL until their fix integrates;
# an XFAIL check that passes fails the gate, so the list only shrinks. The live part is tests/usability/live.sh.
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$root"
run=${1:-$(date -u +%Y%m%dT%H%M%SZ)}; out="$root/local-data/usability/$run"; mkdir -p "$out"
declare -A XFAIL=(
  [commands]="credit sessions show legacy and information-only commands"
  [cold-expired-inspect]="inspect reports offered for a closed claim window"
  [cold-expired-no-claim]="redeem claims without checking the deadline"
  [screen-120x40-light-dark-block]="nacre arrival art bakes in a near-black background"
  [screen-120x40-dark-dark-block]="nacre arrival art bakes in a near-black background"
)
node tests/usability/cold-run.mjs "$out" > "$out/checks.txt"
. "$out/session.env"
t="abalone-usability-$$"; tmux() { command tmux -L "$t" -f /dev/null "$@"; }
trap 'tmux kill-server 2>/dev/null; rm -rf $USABILITY_BASES "$out/session.env"' EXIT
for size in 80x24 120x40; do for theme in light dark; do
  # The terminal's own colours: tmux answers Pi's OSC 10/11 query from window-style (credit sessions drop COLORFGBG).
  [[ $theme == light ]] && style="bg=#ffffff,fg=#1a1a1a" || style="bg=#1a1a1a,fg=#e0e0e0"
  tmux start-server \; set -g window-style "$style" \; new-session -d -s s -x ${size%x*} -y ${size#*x} "cd $USABILITY_WORK && env -i PATH='$PATH' LANG=C.UTF-8 HOME=$HOME ABALONE_DIR=$ABALONE_DIR XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR TMPDIR=$TMPDIR \
    ABALONE_SYNTHETIC_NEAR_LOG=$ABALONE_SYNTHETIC_NEAR_LOG TERM=xterm-256color COLORTERM=truecolor \
    node --import $root/tests/fixtures/near/synthetic-near-hook.mjs $root/bin/abalone.mjs credit session --credit $USABILITY_CREDIT; sleep 60"
  # Ready: Pi's editor rule is drawn and the screen has not changed for a second.
  prev=""; for _ in $(seq 60); do sleep 1; cur=$(tmux capture-pane -t s -p -e); [[ $cur == *────* && $cur == "$prev" ]] && break; prev=$cur; done
  f="$out/screen-$size-$theme"; tmux capture-pane -t s -p -e > "$f.ansi"; tmux capture-pane -t s -p -J > "$f.txt"
  tmux kill-server
  python3 -I tests/usability/screen.py "screen-$size-$theme" ${size%x*} "$f.ansi" "$f.txt" >> "$out/checks.txt"
done; done
fail=0
while read -r result id rest; do
  id=${id%:}; why=${XFAIL[$id]:-}
  if [[ -n $why ]]; then
    [[ $result == FAIL ]] && result=XFAIL || { result=XPASS; fail=1; rest+=" -- now passes: remove it from XFAIL"; }
    rest+=" [known defect, expected until its fix integrates: $why]"
  elif [[ $result == FAIL ]]; then fail=1; fi
  echo "$result $id $rest"
done < "$out/checks.txt" | tee "$out/results.txt"
grep -q "^FAIL\|^XPASS" "$out/results.txt" && fail=1
echo "usability offline: $([[ $fail == 0 ]] && echo PASS || echo FAIL) (evidence: local-data/usability/$run)"; exit $fail
