#!/usr/bin/env bash
# tests/verify-collected.sh <client dir> <out dir>: verifies every collected task bundle under <client dir>/tasks offline
# (a fresh process per bundle, network cut with unshare -rn), against the client's own authorization (--expect) and a
# replay file built as bundles are accepted (--seen). Then it tampers with a copy of the first completed bundle five ways
# and requires each to be refused. Reports go to <out dir>/verify-<task>.txt and <out dir>/tamper-*.txt.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
C=$(realpath "$1") O=$(realpath -m "$2") fail=0
mkdir -p "$O"; : > "$O/seen.txt"
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
offline() { unshare -rn node "$root/bin/abalone.mjs" verify "$@"; }
expect() { node -e 'const r=require(process.argv[1]);require("fs").writeFileSync(process.argv[2],JSON.stringify(r.body.authorization))' "$C/tasks/$1/record.json" "$O/expect-$1.json"; echo "$O/expect-$1.json"; }
first=""
for d in "$C"/tasks/*/bundle; do
  id=$(basename "$(dirname "$d")")
  offline "$d" --expect "$(expect "$id")" --seen "$O/seen.txt" > "$O/verify-$id.txt" 2>&1; rc=$?
  check "verify $id offline: $(head -1 "$O/verify-$id.txt"); $(grep -m1 "^2\." "$O/verify-$id.txt")" '[[ $rc == 0 ]]'
  grep -o "^Replay record.*: .*" "$O/verify-$id.txt" | sed 's/^[^:]*: //' >> "$O/seen.txt"
  [[ -z $first ]] && grep -q '"status": "completed"' "$d/completion.json" && first=$id
done
[[ -n $first ]] || { echo "FAIL no completed bundle to tamper with"; exit 1; }
other=$(ls "$C/tasks" | grep -v "^$first$" | head -1)
B="$C/tasks/$first/bundle"
# Each tamper edits a copy and rewrites bundle.json (it is unsigned), so the refusal must come from the signed records.
tamper() {
  local name=$1 T="$O/tamper-$1"; rm -rf "$T"; cp -r "$B" "$T"; (cd "$T" && eval "$2")
  node -e 'const fs=require("fs"),c=require("crypto"),p=require("path"),d=process.argv[1],w=(x)=>fs.readdirSync(x,{withFileTypes:true}).flatMap(e=>e.isDirectory()?w(p.join(x,e.name)):[p.join(x,e.name)]);const b=JSON.parse(fs.readFileSync(d+"/bundle.json"));b.files=Object.fromEntries(w(d).map(f=>p.relative(d,f)).filter(f=>f!=="bundle.json").sort().map(f=>[f,c.createHash("sha256").update(fs.readFileSync(p.join(d,f))).digest("hex")]));fs.writeFileSync(d+"/bundle.json",JSON.stringify(b,null,1))' "$T"
  offline "$T" "${@:3}" > "$O/tamper-$name.txt" 2>&1; local rc=$?
  check "tamper $name refused: $(sed -n '/^Failures/,/^Unknowns/p' "$O/tamper-$name.txt" | grep -v "^Failures\|^Unknowns\|peer-ed25519\|no guest/" | head -1 | cut -c1-120)" '[[ $rc != 0 ]]'
}
tamper output 'printf "PASS\n" >> outputs/patch.diff'
tamper receipt-field 'node -e "const fs=require(\"fs\"),f=\"guest/receipts.jsonl\",l=fs.readFileSync(f,\"utf8\").trimEnd().split(\"\n\"),r=JSON.parse(l.at(-1)),b=JSON.parse(r.body);if(b.event!==\"exit\")throw Error(\"last receipt is not exit\");b.exit_code=7;r.body=JSON.stringify(b);l[l.length-1]=JSON.stringify(r);fs.writeFileSync(f,l.join(\"\n\")+\"\n\")"'
tamper signature 'node -e "const f=\"completion.sig\",s=JSON.parse(require(\"fs\").readFileSync(f));const k=s.assertion?\"assertion\":\"sig\";const v=Buffer.from(s[k],k===\"sig\"?\"hex\":\"base64\");v[v.length-9]^=1;s[k]=v.toString(k===\"sig\"?\"hex\":\"base64\");require(\"fs\").writeFileSync(f,JSON.stringify(s))"'
tamper wrong-binding ':' --expect "$(expect "$other")"
printf '%s %s\n' "$first" "$(printf 0%.0s {1..64})" > "$O/seen-replay.txt"
tamper replayed-authorization ':' --expect "$O/expect-$first.json" --seen "$O/seen-replay.txt"
exit $fail
