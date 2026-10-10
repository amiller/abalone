#!/usr/bin/env bash
# /fetch over RPC against a stub https server standing in for arxiv.org and example.org (its own CA; curl is pointed at it
# with ABALONE_FETCH_CURL_ARGS): an arXiv ID goes out on the public route with its reason; a sensitive URL is not
# fetched publicly without the user's answer; the fetch is logged as a disclosure; the PDF reads like any @file.
set -uo pipefail
. "$(dirname "$0")/lib/env.sh"; stubcfg
export ABALONE_NO_CANARIES=1
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
ev() { node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse); console.log(eval("(es=>"+process.argv[2]+")")(l))' "$1" "$2"; }
notes='es.filter(e=>e.method==="notify").map(e=>e.message).join("\n")'
cd "$ABALONE_DIR"; mkdir work
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=arxiv.org -addext "subjectAltName=DNS:arxiv.org,DNS:example.org" -keyout key.pem -out cert.pem 2>/dev/null
node -e '
const https = require("https"), fs = require("fs"), [cert, key, pdf, log] = process.argv.slice(1);
const s = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (q, r) => {
  fs.appendFileSync(log, `${q.headers.host} ${q.url}\n`);
  if (q.url === "/pdf/2410.12345") { r.writeHead(200, { "content-type": "application/pdf" }); return r.end(fs.readFileSync(pdf)); }
  r.writeHead(200, { "content-type": "text/html" }); r.end("<p>results</p>");
}).listen(0, "127.0.0.1", () => console.log(s.address().port));' cert.pem key.pem "$root/tests/fixtures/docs/tenancy-renewal.pdf" "$ABALONE_DIR/stub.log" > port &
stub=$!; trap 'kill $stub' EXIT
for _ in $(seq 50); do [[ -s port ]] && break; sleep 0.1; done
export ABALONE_FETCH_CURL_ARGS="[\"--connect-to\",\"arxiv.org:443:127.0.0.1:$(cat port)\",\"--connect-to\",\"example.org:443:127.0.0.1:$(cat port)\",\"--cacert\",\"$ABALONE_DIR/cert.pem\"]"
cd work
DONE='Fetched|Nothing|failed' node "$root/tests/command-drive.mjs" stub/script "/fetch arxiv:2410.12345" > ../ev1 2>../err1 || cat ../err1
CHOICES='["cancel: fetch nothing"]' DONE='Fetched|Nothing|failed' node "$root/tests/command-drive.mjs" stub/script "/fetch https://example.org/search?q=divorce+lawyer" > ../ev2 2>../err2 || cat ../err2
cd ..
ev ev1 "$notes"; ev ev2 "es.find(e=>e.method===\"select\").title"
check "an arXiv ID goes out on the public route, and the reason is shown" \
  'ev ev1 "$notes" | grep -q "via the public route, because it is a public arXiv paper ID" && cmp work/arxiv-2410.12345.pdf "$root/tests/fixtures/docs/tenancy-renewal.pdf" && grep -q "^arxiv.org /pdf/2410.12345$" stub.log'
check "the fetch is logged as a disclosure (URL, route, reason) and the file as open content" \
  'grep -q "\"via\":\"fetch\".*\"url\":\"https://arxiv.org/pdf/2410.12345\".*\"route\":\"public\"" disclosures.jsonl && grep -q "\"event\":\"fetch\".*\"file\":\"arxiv-2410.12345.pdf\".*\"label\":\"open\"" agents.jsonl'
check "a sensitive URL is offered the built-in Tor route with the reason, public only as a last explicit choice, and cancelling sends nothing" \
  'ev ev2 "es.find(e=>e.method===\"select\").title" | grep -q "via sealed route (Tor, built in), because the address mentions a legal topic" && [[ $(ev ev2 "es.find(e=>e.method===\"select\").options.join(\"|\")") == "fetch via sealed route (Tor, built in)|cancel: fetch nothing|fetch publicly instead"* ]] && ! grep -q example.org stub.log && ev ev2 "$notes" | grep -q "Nothing was fetched from example.org"'
check "the fetched PDF reads like any @file (extracted in the no-network sandbox, line-numbered)" \
  'node -e "import(\"$root/lib/mediate.mjs\").then(m=>{const f=m.mentions(\"@arxiv-2410.12345.pdf\",\"$ABALONE_DIR/work\")[0]; process.exit(/L20: To accept, sign and return/.test(f.block)?0:1)})"'
echo "fetch: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
