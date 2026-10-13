#!/usr/bin/env bash
# M1 lockdown: ambient extensions, skills, context files and project trust stay off, flags cannot turn
# them back on, and only agents/pi/admitted.json entries with matching sha256 load.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
proj="$ABALONE_DIR/project"; agent="$ABALONE_DIR/agent"
mkdir -p "$proj/.pi/extensions" "$proj/.pi/skills/evil" "$agent/extensions" "$agent/skills/evil2"
echo "AMBIENT-AGENTS" > "$proj/AGENTS.md"; echo "AMBIENT-CLAUDE" > "$proj/CLAUDE.md"
echo "AMBIENT-SYSTEM" > "$proj/.pi/SYSTEM.md"; echo "AMBIENT-APPEND" > "$proj/.pi/APPEND_SYSTEM.md"
printf -- '---\nname: evil\ndescription: AMBIENT-SKILL\n---\nAMBIENT-SKILL\n' | tee "$proj/.pi/skills/evil/SKILL.md" > "$agent/skills/evil2/SKILL.md"
echo "AMBIENT-GLOBAL" | tee "$agent/AGENTS.md" "$agent/SYSTEM.md" "$agent/APPEND_SYSTEM.md" > /dev/null
cp "$root/tests/fixtures/evil-extension.ts" "$proj/.pi/extensions/evil.ts"; cp "$root/tests/fixtures/evil-extension.ts" "$agent/extensions/evil.ts"
echo '{"defaultProjectTrust":"always","extensions":["./extensions/evil.ts"],"skills":["./skills"]}' | tee "$proj/.pi/settings.json" > "$agent/settings.json"
cd "$proj"
out=$(STUB_SCRIPT="$root/tests/fixtures/scripts/echo-context.mjs" "$root/bin/abalone" sandbox --model stub/script -p go < /dev/null 2>&1); echo "  context: $out"
check "no ambient context, system prompt or skill reaches the model" '! grep -qE "AMBIENT-[A-Z]+=true" <<<"$out"'
check "curated skills and tools are present" '[[ $out == *pour-planning=true* && $out == *attestation-analyst=true* && $out == *ask_frontier=true* ]]'
check "no ambient extension ran" '[[ ! -e $ABALONE_DIR/EVIL-LOADED ]]'
for flags in "--approve" "-a" "--append-system-prompt AGENTS.md" "--system-prompt x" "--prompt-template x" "--theme x" \
             "-e .pi/extensions/evil.ts" "--extension $root/tests/fixtures/evil-extension.ts" "--skill .pi/skills/evil" "--skill $root/tests/fixtures/evil-skill"; do
  out=$("$root/bin/abalone" sandbox --model stub/script $flags -p go < /dev/null 2>&1); code=$?
  check "refused: $flags  ($out)" '[[ $code -ne 0 && $out == "✗ refused"* ]]'
done
out=$("$root/bin/abalone" sandbox --model stub/script --skill "$root/skills/pour-planning" -p go < /dev/null 2>&1)
check "a listed skill is admitted by flag ($out)" '[[ $out == "hello from stub" ]]'
node -e 'const f=process.argv[1],m=JSON.parse(require("fs").readFileSync(f));m.entries.find(e=>e.path=="skills/pour-planning").sha256="0".repeat(64);require("fs").writeFileSync(f,JSON.stringify(m))' "$ABALONE_CONFIG/agents/pi/admitted.json"
out=$("$root/bin/abalone" sandbox --model stub/script -p go < /dev/null 2>&1); code=$?
check "hash mismatch refuses to start ($out)" '[[ $code -ne 0 && $out == *"code changed since it was verified (skills/pour-planning)"* && $out == *"rehash-manifest.mjs"*"reinstall"* ]]'
echo "lockdown: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
