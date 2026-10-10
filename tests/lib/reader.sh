# The loopback reader stub (tests/fixtures/local-reader.mjs) as the ⌂ local provider "ollama" in $ABALONE_CONFIG.
node "$root/tests/fixtures/local-reader.mjs" > "$ABALONE_DIR/port" & srv=$!
trap 'kill $srv' EXIT
until [[ -s $ABALONE_DIR/port ]]; do sleep 0.1; done
port=$(cat "$ABALONE_DIR/port")
node -e 'const f=process.argv[1],p=JSON.parse(require("fs").readFileSync(f));p.local=[{id:"ollama",baseUrl:process.argv[2]}];require("fs").writeFileSync(f,JSON.stringify(p))' "$ABALONE_CONFIG/providers.json" "http://127.0.0.1:$port/v1"
# inet destinations in an strace connect log, minus port-0 route probes
inet() { grep -oP 'sin6?_port=htons\(\K[1-9][0-9]*\).*?(inet_addr\("|AF_INET6, ")[^"]+' "$1" | sed -E 's/\).*"/ /' | awk '{print $2":"$1}' | sort -u; }
