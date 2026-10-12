#!/usr/bin/env bash
# With dummy keys for many stock providers in the environment, abalone lists only providers in providers.json.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"
devkey redpill t dummy; devkey phala t dummy
admitted=$(node -e 'console.log(require(process.argv[1]).admitted.map(a=>a.id).join(" "))' "$root/providers.json")
listed=$(OPENAI_API_KEY=dummy ANTHROPIC_API_KEY=dummy GEMINI_API_KEY=dummy OPENROUTER_API_KEY=dummy GROQ_API_KEY=dummy XAI_API_KEY=dummy \
  "$root/bin/abalone" sandbox --list-models < /dev/null | awk 'NR>1 {print $1}' | sort | uniq -c)
echo "$listed"
bad=0; [[ -n $listed ]] || { echo "no models"; bad=1; }
for p in $(awk '{print $2}' <<<"$listed"); do [[ " $admitted " == *" $p "* ]] || { echo "NOT ADMITTED: $p"; bad=1; }; done
exit $bad
