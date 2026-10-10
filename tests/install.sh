#!/usr/bin/env bash
# tools/install.sh.in against a stub release (file:// base, a stub abalone that echoes its arguments): installing with no
# gift code succeeds and says how to start and how to redeem later; with a code it redeems.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
R=$(mktemp -d); mkdir -p "$R/build/abalone/bin"
printf '#!/bin/sh\necho "stub abalone $*"\n' > "$R/build/abalone/bin/abalone"; chmod +x "$R/build/abalone/bin/abalone"
mkdir -p "$R/build/abalone/tools"
printf 'console.log("synthetic first-use entry " + JSON.stringify(process.argv.slice(2)));\n' > "$R/build/abalone/tools/coupon-first-use.mjs"
tar -C "$R/build" -czf "$R/abalone-test.tar.gz" abalone
sed -e "s|@REV@|test|g" -e "s|@SHA256@|$(sha256sum "$R/abalone-test.tar.gz" | cut -d' ' -f1)|g" -e "s|@BASE@|file://$R|g" "$root/tools/install.sh.in" > "$R/install.sh"
mkdir -p "$R/h1" "$R/h2"
out1=$(cd "$R/h1" && HOME="$R/h1" ABALONE_PLANT_CANARIES=no sh "$R/install.sh" 2>&1); code1=$?
echo "$out1" | sed 's/^/  /'
check "no gift code: exit 0, installed, with how to start and how to redeem later" '[[ $code1 == 0 && $out1 == *"Installed abalone test."* && $out1 == *"No gift redeemed. If someone sends you one later: abalone redeem"* && $out1 == *"Start with: abalone"* && -L $R/h1/.local/bin/abalone ]]'
out2=$(cd "$R/h2" && HOME="$R/h2" ABALONE_PLANT_CANARIES=no sh "$R/install.sh" --peer /ip4/1.2.3.4/tcp/1/p2p/x g1CODE.grant 2>&1); code2=$?
check "with a gift code it redeems it" '[[ $code2 == 0 && $out2 == *"stub abalone redeem --peer /ip4/1.2.3.4/tcp/1/p2p/x g1CODE.grant"* ]]'
mkdir -p "$R/h3"; printf '{}' > "$R/public-trial.json"
out3=$(cd "$R/h3" && HOME="$R/h3" sh "$R/install.sh" --trial "$R/public-trial.json" 2>&1); code3=$?
check "public trial installation starts the /4 first-use entry with no legacy redeem or generic session" '[[ $code3 == 0 && $out3 == *"synthetic first-use entry"* && $out3 == *"run"* && $out3 == *"--bundle"* && $out3 != *"stub abalone redeem"* && $out3 != *"Start with: abalone"* ]]'
out4=$(HOME="$R/h3" sh "$R/install.sh" --trial relative.json 2>&1); code4=$?
check "trial refuses relative/missing public bundle before gift entry" '[[ $code4 != 0 && $out4 == *"path must be absolute"* ]]'
# tools/release.sh in a throwaway clone (this checkout's release.sh copied in), with npm stubbed: install.sh only with a base.
git clone -q --shared "$root" "$R/repo" && cp "$root/tools/release.sh" "$R/repo/tools/"
mkdir -p "$R/stub" && printf '#!/bin/sh\nexit 0\n' > "$R/stub/npm" && chmod +x "$R/stub/npm"
rev=$(git -C "$R/repo" rev-parse --short HEAD) rel="$R/repo/local-data/release"
o=$(PATH="$R/stub:$PATH" "$R/repo/tools/release.sh" 2>&1)
check "release.sh without a base URL writes the tarball and no install.sh, and says how to get one" '[[ -f $rel/$rev/abalone-$rev.tar.gz && ! -e $rel/$rev/install.sh && $o == *"no base URL given, so no install.sh"* ]]'
PATH="$R/stub:$PATH" "$R/repo/tools/release.sh" HEAD https://example.org/r > /dev/null 2>&1
check "release.sh with a base URL pins it in install.sh" 'grep -q "curl -fsSL \"https://example.org/r/abalone-$rev.tar.gz\"" $rel/$rev/install.sh'
rm -rf "$R"
echo "install: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
