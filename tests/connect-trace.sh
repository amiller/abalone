#!/usr/bin/env bash
# Trace every connect() of a sealed session; fail if a TCP destination is not an admitted host.
# Port-0 connects are getaddrinfo route probes (no packets); port 53 is the launcher's resolver lookups for
# admitted hosts (inside the sandbox there is no resolver). 127.0.0.1 is the egress to a ⌂ local model port.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"
printf dummy | devkey redpill t; printf dummy | devkey phala t
out="$(mktemp -d)"
if [[ "${1:-}" == --tui ]]; then
  # Interactive session on a pty for 30s, then SIGINT: covers TUI-only startup network paths.
  shift
  timeout -s INT 30 script -qec "strace -f -e trace=connect -o $out/trace $root/bin/abalone sandbox $*" /dev/null > "$out/stdout" 2>&1
else
  strace -f -e trace=connect -o "$out/trace" "$root/bin/abalone" sandbox "$@" < /dev/null > "$out/stdout" 2>&1
fi
echo "session exit $?: $(tail -c 200 "$out/stdout")"
hosts=$(node -e 'const p=require(process.argv[1]); console.log([...p.admitted.flatMap(a=>a.hosts), ...p.verifierHosts].join(" "))' "$root/providers.json")
declare -A allowed
for h in $hosts; do for ip in $(getent ahosts "$h" | awk '{print $1}' | sort -u); do allowed[$ip]+="$h "; done; done
bad=0
while read -r n port ip; do
  if [[ -n "${allowed[$ip]:-}" ]]; then echo "ok   $ip:$port (${allowed[$ip]% }) x$n"
  elif [[ "$port" == 53 && "$ip" == 127.0.0.53 ]]; then echo "dns  $ip:$port x$n"
  elif [[ "$ip" == 127.0.0.1 ]]; then echo "local $ip:$port x$n"
  else echo "BAD  $ip:$port x$n"; bad=1; fi
done < <(grep -oP 'sin6?_port=htons\(\K[1-9][0-9]*\).*?(inet_addr\("|AF_INET6, ")[^"]+' "$out/trace" | sed -E 's/\).*"/ /' | sort | uniq -c | awk '{print $1, $2, $3}')
exit $bad
