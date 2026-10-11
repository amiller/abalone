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
cat > "$R/build/abalone/tools/coupon-first-use.mjs" <<'JS'
console.log("synthetic first-use entry " + JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), state: process.env.ABALONE_DIR, home: process.env.HOME, ambientKey: Boolean(process.env.NEAR_API_KEY), ambientOptions: Boolean(process.env.NODE_OPTIONS) }));
JS
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
# Friend inputs are public; a fake entrypoint records only path/boolean metadata.
mkdir -p "$R/h4" "$R/h5" "$R/public"
printf '{"issuer":{"pin":"issuer-pin.json","approval":"staging-approval.json"}}' > "$R/public/trial.json"
for name in issuer-pin.json staging-approval.json readiness.json; do printf '{}' > "$R/public/$name"; done
python3 "$root/tools/render-installer.py" --rev aaaaaaa --artifact-sha256 "$(sha256sum "$R/abalone-test.tar.gz" | cut -d' ' -f1)" --base https://example.org/friend --trial-dir "$R/public" --out "$R/friend-install.sh"
cp "$R/abalone-test.tar.gz" "$R/public/abalone-aaaaaaa.tar.gz"
mkdir -p "$R/curl-stub"
printf '#!/bin/sh\nexec "%s" -fsSL "file://%s/${2##*/}" -o "$4"\n' "$(command -v curl)" "$R/public" > "$R/curl-stub/curl"
chmod +x "$R/curl-stub/curl"
out5=$(HOME="$R/h4" PATH="$R/curl-stub:$PATH" NEAR_API_KEY=SECRET_FIXTURE sh "$R/friend-install.sh" --friend --keep-trace 2>&1); code5=$?
check "friend pins public inputs, opens fresh workspace and strips ambient key before normal wrapper" '[[ $code5 == 0 && $out5 == *"synthetic first-use entry"* && $out5 == *"--keep-trace"* && $out5 == *"\"ambientKey\":false"* && $out5 == *"session."* && $out5 != *"SECRET_FIXTURE"* ]]'
printf 'tamper' >> "$R/public/issuer-pin.json"
out6=$(HOME="$R/h5" PATH="$R/curl-stub:$PATH" sh "$R/friend-install.sh" --friend 2>&1); code6=$?
check "tampered public pin refuses before gift entry or first-use launch" '[[ $code6 != 0 && $out6 == *"No gift was requested"* && $out6 != *"synthetic first-use entry"* ]]'
out7=$(HOME="$R/h5" sh "$R/install.sh" --friend 2>&1); code7=$?
check "installer without friend pins refuses without download or entry" '[[ $code7 != 0 && $out7 == *"no reviewed friend bundle"* && $out7 != *"Installed"* ]]'
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
