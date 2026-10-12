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
sed -e "s|@REV@|test|g" -e "s|@SHA256@|$(sha256sum "$R/abalone-test.tar.gz" | cut -d' ' -f1)|g" -e "s|@BASE@|file://$R|g" -e "s|@ARTIFACT_BASE@|file://$R|g" "$root/tools/install.sh.in" > "$R/install.sh"
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
printf '{"platform":"linux-node24-bubblewrap","issuer":{"pin":"issuer-pin.json","approval":"staging-approval.json"}}' > "$R/public/trial.json"
for name in issuer-pin.json staging-approval.json readiness.json; do printf '{}' > "$R/public/$name"; done
python3 "$root/tools/render-installer.py" --rev aaaaaaa --artifact-sha256 "$(sha256sum "$R/abalone-test.tar.gz" | cut -d' ' -f1)" --base https://example.org/friend --trial-dir "$R/public" --out "$R/friend-install.sh"
cp "$R/abalone-test.tar.gz" "$R/public/abalone-aaaaaaa.tar.gz"
mkdir -p "$R/curl-stub"
printf '#!/bin/sh\nprintf "%%s\\n" "$2" >> "%s"\nexec "%s" -fsSL "file://%s/${2##*/}" -o "$4"\n' "$R/requested-urls" "$(command -v curl)" "$R/public" > "$R/curl-stub/curl"
chmod +x "$R/curl-stub/curl"
out5=$(HOME="$R/h4" PATH="$R/curl-stub:$PATH" NEAR_API_KEY=SECRET_FIXTURE sh "$R/friend-install.sh" --friend --keep-trace 2>&1); code5=$?
check "friend pins public inputs, opens fresh workspace and strips ambient key before normal wrapper" '[[ $code5 == 0 && $out5 == *"synthetic first-use entry"* && $out5 == *"--keep-trace"* && $out5 == *"\"ambientKey\":false"* && $out5 == *"session."* && $out5 != *"SECRET_FIXTURE"* ]]'
printf 'tamper' >> "$R/public/issuer-pin.json"
out6=$(HOME="$R/h5" PATH="$R/curl-stub:$PATH" sh "$R/friend-install.sh" --friend 2>&1); code6=$?
check "tampered public pin refuses before gift entry or first-use launch" '[[ $code6 != 0 && $out6 == *"No gift was requested"* && $out6 != *"synthetic first-use entry"* ]]'
out7=$(HOME="$R/h5" sh "$R/install.sh" --friend 2>&1); code7=$?
check "installer without friend pins refuses without download or entry" '[[ $code7 != 0 && $out7 == *"no reviewed friend bundle"* && $out7 != *"Installed"* ]]'
# Owned-host selection is from the pinned public manifest, never a failed sandbox.
printf '{"platform":"linux-node24-owned-host","issuer":{"pin":"issuer-pin.json","approval":"staging-approval.json"}}' > "$R/public/trial.json"
printf '{}' > "$R/public/issuer-pin.json"
python3 "$root/tools/render-installer.py" --rev bbbbbbb --artifact-sha256 "$(sha256sum "$R/abalone-test.tar.gz" | cut -d' ' -f1)" --base https://example.org/friend --trial-dir "$R/public" --out "$R/owned-install.sh"
cp "$R/abalone-test.tar.gz" "$R/public/abalone-bbbbbbb.tar.gz"
mkdir -p "$R/owned-path" "$R/h6"
for cmd in node tar gzip sha256sum bash sh uname id mkdir mktemp rmdir ln env rm; do ln -s "$(command -v "$cmd")" "$R/owned-path/$cmd"; done
cp "$R/curl-stub/curl" "$R/owned-path/curl"
out8=$(HOME="$R/h6" PATH="$R/owned-path" sh "$R/owned-install.sh" --friend 2>&1); code8=$?
check "explicit owned-host friend runs without bubblewrap and discloses ordinary-account access" '[[ $code8 == 0 && $out8 == *"no OS isolation"* && $out8 == *"synthetic first-use entry"* && $out8 != *"SECRET_FIXTURE"* ]]'
# A new bundle can reuse the exact archive from an older immutable release.
python3 "$root/tools/render-installer.py" --rev bbbbbbb --artifact-sha256 "$(sha256sum "$R/abalone-test.tar.gz" | cut -d' ' -f1)" --base https://example.org/new-bundle --artifact-base https://example.org/existing-runtime --trial-dir "$R/public" --out "$R/split-install.sh"
mkdir "$R/h9"
: > "$R/requested-urls"
split_out=$(HOME="$R/h9" PATH="$R/owned-path" sh "$R/split-install.sh" --friend 2>&1); split_code=$?
check "separate artifact base acquires the pinned old archive and all new bundle inputs" '[[ $split_code == 0 && $split_out == *"synthetic first-use entry"* ]] && [[ $(head -n 1 "$R/requested-urls") == https://example.org/existing-runtime/abalone-bbbbbbb.tar.gz ]] && [[ $(tail -n +2 "$R/requested-urls" | wc -l) == 4 ]] && ! tail -n +2 "$R/requested-urls" | grep -v "^https://example.org/new-bundle/"'
python3 "$root/tools/render-installer.py" --rev bbbbbbb --artifact-sha256 "$(sha256sum "$R/abalone-test.tar.gz" | cut -d' ' -f1)" --base https://example.org/new-bundle --artifact-base 'https://example.org/old?token=secret' --out "$R/refused-artifact-base.sh" > "$R/artifact-base-refusal" 2>&1; artifact_base_code=$?
check "separate artifact base rejects query credentials before writing an installer" '[[ $artifact_base_code != 0 && ! -e $R/refused-artifact-base.sh ]]'
mkdir "$R/h7"
out9=$(HOME="$R/h7" PATH="$R/owned-path" sh "$R/friend-install.sh" --friend 2>&1); code9=$?
check "isolated friend still refuses absent bubblewrap without fallback" '[[ $code9 != 0 && $out9 == *"requires bubblewrap"* && $out9 != *"synthetic first-use entry"* ]]'
printf '{"platform":"unknown","issuer":{"pin":"issuer-pin.json","approval":"staging-approval.json"}}' > "$R/public/trial.json"
python3 "$root/tools/render-installer.py" --rev ccccccc --artifact-sha256 "$(sha256sum "$R/abalone-test.tar.gz" | cut -d' ' -f1)" --base https://example.org/friend --trial-dir "$R/public" --out "$R/refused-install.sh" > "$R/render-refusal" 2>&1; code10=$?
check "renderer refuses unknown platform before creating installer" '[[ $code10 != 0 && ! -e $R/refused-install.sh ]]'
mkdir "$R/h8" "$R/tar-fail"
printf '#!/bin/sh\nexit 1\n' > "$R/tar-fail/tar"; chmod +x "$R/tar-fail/tar"
out10=$(HOME="$R/h8" PATH="$R/tar-fail:$R/owned-path" sh "$R/owned-install.sh" --friend 2>&1); code11=$?
check "failed extraction refuses before installed claim or entry" '[[ $code11 != 0 && $out10 == *"could not be extracted"* && $out10 != *"Installed abalone"* && $out10 != *"synthetic first-use entry"* ]]'
# --credit: install-only owned-host entry. A credit-capable stub archive records any launch in $R/launched; uname and
# id are the real host's (Linux x86_64, non-root) except where a mock directory is put first on PATH.
mkdir -p "$R/cbuild/abalone/bin" "$R/cbuild/abalone/lib" "$R/cbuild/abalone/tools" "$R/cpub" "$R/cpath" "$R/cwork"
printf '#!/bin/sh\necho "$*" >> "%s"\n' "$R/launched" > "$R/cbuild/abalone/bin/abalone"; chmod +x "$R/cbuild/abalone/bin/abalone"
cp "$R/build/abalone/tools/coupon-first-use.mjs" "$R/cbuild/abalone/tools/"
echo 'export {};' > "$R/cbuild/abalone/lib/credit.mjs"; echo 'export {};' > "$R/cbuild/abalone/lib/credit-store.mjs"
ln -s credit.mjs "$R/cbuild/abalone/lib/credit-link.mjs"
tar -C "$R/cbuild" -czf "$R/cpub/abalone-ddddddd.tar.gz" abalone
cp "$R/abalone-test.tar.gz" "$R/cpub/abalone-eeeeeee.tar.gz"
printf '{"platform":"linux-node24-owned-host","issuer":{"pin":"issuer-pin.json","approval":"staging-approval.json"}}' > "$R/cpub/trial.json"
for name in issuer-pin.json staging-approval.json readiness.json; do printf '{"%s":1}' "$name" > "$R/cpub/$name"; done
csha=$(sha256sum "$R/cpub/abalone-ddddddd.tar.gz" | cut -d' ' -f1)
python3 "$root/tools/render-installer.py" --rev ddddddd --artifact-sha256 "$csha" --base https://example.org/credit --trial-dir "$R/cpub" --out "$R/credit-install.sh"
python3 "$root/tools/render-installer.py" --rev eeeeeee --artifact-sha256 "$(sha256sum "$R/abalone-test.tar.gz" | cut -d' ' -f1)" --base https://example.org/credit --artifact-base https://example.org/old --trial-dir "$R/cpub" --out "$R/old-credit-install.sh"
bid=$(for n in trial.json issuer-pin.json staging-approval.json readiness.json; do sha256sum "$R/cpub/$n" | cut -d' ' -f1; done | sha256sum | cut -c1-16)
printf '#!/bin/sh\nurl= out=\nwhile [ $# -gt 0 ]; do case "$1" in https://*) url=$1 ;; -o) out=$2; shift ;; esac; shift; done\nprintf "%%s\\n" "$url" >> "%s"\nexec "%s" -fsSL "file://%s/${url##*/}" -o "$out"\n' "$R/curls" "$(command -v curl)" "$R/cpub" > "$R/cpath/curl"; chmod +x "$R/cpath/curl"
for cmd in node tar gzip sha256sum bash sh uname id mkdir mktemp ln env rm flock find sort sed cut mv cat; do ln -s "$(command -v "$cmd")" "$R/cpath/$cmd"; done
credit() { local home=$1; shift; mkdir -p "$home"; (cd "$R/cwork" && HOME="$home" PATH="$PATH_C" NEAR_API_KEY=SECRET_FIXTURE "$@" 2>&1); }
PATH_C="$R/cpath"
H="$R/credit home"; A="$H/.abalone-app/ddddddd"; B="$A/public-credit/$bid"
: > "$R/curls"
c1=$(credit "$H" sh "$R/credit-install.sh" --credit); cc1=$?
echo "$c1" | sed 's/^/  /'
check "credit installs owned-host runtime without bubblewrap and prints exact trial and launcher paths" '[[ $cc1 == 0 && $c1 == *"Public credit trial: $B/trial.json"* && $c1 == *"Launcher: $H/.local/bin/abalone"* && $c1 == *"credit inspect --trial '"'"'$B/trial.json'"'"' --stdin"* && $(readlink "$H/.local/bin/abalone") == "$A/abalone/bin/abalone" && $c1 != *SECRET_FIXTURE* ]]'
check "credit saves the four pinned public files and a receipt binding artifact and file digests" 'ok=1; for n in trial.json issuer-pin.json staging-approval.json readiness.json; do cmp -s "$R/cpub/$n" "$B/$n" || ok=0; done; [[ $ok == 1 ]] && grep -q "\"artifactSha256\":\"$csha\"" "$B/receipt.json" && grep -q "\"runtimeTreeSha256\":\"[0-9a-f]\{64\}\"" "$B/receipt.json" && [[ $(stat -c %a "$B") == 700 ]]'
check "credit launches nothing: no launcher run, first-use, canary, redemption or credit state" '[[ ! -e $R/launched && $c1 != *"synthetic first-use"* && -z $(ls -A "$R/cwork") && ! -e "$H/.abalone" && ! -e "$H/.abalone-friend" ]]'
check "credit downloads exactly the pinned archive and four public inputs" '[[ $(wc -l < "$R/curls") == 5 && $(head -n 1 "$R/curls") == https://example.org/credit/abalone-ddddddd.tar.gz ]] && [[ -z $(ls -A "$H/.abalone-app" | grep credit-stage) ]]'
c2=$(credit "$H" sh "$R/credit-install.sh" --credit); cc2=$?
check "repeat credit install revalidates the identical install and still launches nothing" '[[ $cc2 == 0 && $c2 == *"Public credit trial: $B/trial.json"* && ! -e $R/launched ]]'
echo tamper >> "$A/abalone/lib/credit.mjs"
c3=$(credit "$H" sh "$R/credit-install.sh" --credit); cc3=$?
check "modified existing runtime is refused and left untouched" '[[ $cc3 != 0 && $c3 == *"does not match the verified ddddddd release"* && $(tail -n 1 "$A/abalone/lib/credit.mjs") == tamper && ! -e $R/launched ]]'
H2="$R/credit h2"; A2="$H2/.abalone-app/ddddddd"; B2="$A2/public-credit/$bid"
credit "$H2" sh "$R/credit-install.sh" --credit > /dev/null
rm "$A2/abalone/lib/credit-store.mjs"
c4=$(credit "$H2" sh "$R/credit-install.sh" --credit); cc4=$?
check "partial existing runtime is refused, not silently trusted" '[[ $cc4 != 0 && $c4 == *"does not match the verified"* && ! -e $A2/abalone/lib/credit-store.mjs ]]'
H3="$R/credit h3"; A3="$H3/.abalone-app/ddddddd"; B3="$A3/public-credit/$bid"
credit "$H3" sh "$R/credit-install.sh" --credit > /dev/null
echo extra > "$A3/abalone/lib/extra.mjs"
c5=$(credit "$H3" sh "$R/credit-install.sh" --credit); cc5=$?
check "existing runtime with an extra file is refused" '[[ $cc5 != 0 && $c5 == *"does not match the verified"* ]]'
rm "$A3/abalone/lib/extra.mjs"; chmod go+w "$A3/abalone/lib/credit.mjs"
c5c=$(credit "$H3" sh "$R/credit-install.sh" --credit); cc5c=$?
check "existing runtime with a widened file mode is refused" '[[ $cc5c != 0 && $c5c == *"re-permissioned"* ]]'
chmod go-w "$A3/abalone/lib/credit.mjs"; ln -sf /etc/passwd "$A3/abalone/lib/credit-link.mjs"
c5b=$(credit "$H3" sh "$R/credit-install.sh" --credit); cc5b=$?
check "existing runtime with a redirected symlink is refused" '[[ $cc5b != 0 && $c5b == *"does not match the verified"* ]]'
ln -sfn credit.mjs "$A3/abalone/lib/credit-link.mjs"
printf '{}' > "$B3/issuer-pin.json"
c6=$(credit "$H3" sh "$R/credit-install.sh" --credit); cc6=$?
check "modified existing public bundle is refused and left untouched" '[[ $cc6 != 0 && $c6 == *"differs from this installer"* && $(cat "$B3/issuer-pin.json") == "{}" ]]'
cp "$R/cpub/issuer-pin.json" "$R/pin.orig"; printf 'tamper' >> "$R/cpub/issuer-pin.json"
c7=$(credit "$H" sh "$R/credit-install.sh" --credit); cc7=$?
H4="$R/credit h4"
c7b=$(credit "$H4" sh "$R/credit-install.sh" --credit); cc7b=$?
check "bad pinned public file fails closed: prior valid bundle intact, nothing new published or launched" '[[ $cc7 != 0 && $c7 == *"issuer-pin.json does not match this installer"* && $cc7b != 0 ]] && cmp -s "$R/pin.orig" "$B/issuer-pin.json" && [[ ! -e "$H4/.abalone-app/ddddddd/abalone" && ! -e "$H4/.local/bin/abalone" && ! -e $R/launched ]] && [[ -z $(ls -A "$H4/.abalone-app" | grep credit-stage) ]]'
cp "$R/pin.orig" "$R/cpub/issuer-pin.json"
H5="$R/credit h5"; mkdir -p "$H5/.abalone-app/ddddddd" "$R/elsewhere"; ln -s "$R/elsewhere" "$H5/.abalone-app/ddddddd/public-credit"
c8=$(credit "$H5" sh "$R/credit-install.sh" --credit); cc8=$?
check "symlinked bundle destination is refused before writing through it" '[[ $cc8 != 0 && $c8 == *"is a symlink"* && -z $(ls -A "$R/elsewhere") ]]'
H6="$R/credit h6"; mkdir -p "$H6/.local/bin"; echo mine > "$H6/.local/bin/abalone"
c9=$(credit "$H6" sh "$R/credit-install.sh" --credit); cc9=$?
check "an existing non-symlink launcher is refused and kept" '[[ $cc9 != 0 && $c9 == *"is not a symlink"* && $(cat "$H6/.local/bin/abalone") == mine && ! -e "$H6/.abalone-app/ddddddd/abalone" ]]'
: > "$R/curls"
c10=$(credit "$R/credit h7" sh "$R/friend-install.sh" --credit); cc10=$?
check "bubblewrap-profile pins are refused for --credit before any download" '[[ $cc10 != 0 && $c10 == *"needs the trusted linux-node24-owned-host profile"* && ! -s $R/curls && ! -e "$R/credit h7/.abalone-app" ]]'
c11=$(credit "$R/credit h7" sh "$R/install.sh" --credit); cc11=$?
check "installer without public credit pins refuses" '[[ $cc11 != 0 && $c11 == *"no fully pinned public credit bundle"* && ! -e "$R/credit h7/.abalone-app" ]]'
c12=$(credit "$R/credit h7" sh "$R/credit-install.sh" --credit --peer x g1CODE.grant); cc12=$?
check "--credit with extra arguments refuses" '[[ $cc12 != 0 && $c12 == *"Usage: install.sh --credit"* && $c12 != *g1CODE* && ! -s $R/curls ]]'
mkdir "$R/noflock"; for f in "$R"/cpath/*; do [[ ${f##*/} == flock ]] || ln -s "$(readlink -f "$f")" "$R/noflock/${f##*/}"; done; rm "$R/noflock/curl"; cp "$R/cpath/curl" "$R/noflock/"
c12b=$(credit "$R/credit h7" env HOME=relative sh "$R/credit-install.sh" --credit); cc12b=$?
check "relative HOME refuses before download so printed paths stay absolute" '[[ $cc12b != 0 && $c12b == *"HOME must be an absolute path"* && ! -s $R/curls && ! -e "$R/cwork/relative" ]]'
c13=$(PATH_C="$R/noflock" credit "$R/credit h7" sh "$R/credit-install.sh" --credit); cc13=$?
check "missing flock refuses before download" '[[ $cc13 != 0 && $c13 == *"needs flock"* && ! -s $R/curls && ! -e "$R/credit h7/.abalone-app" ]]'
mkdir "$R/arm" "$R/root"
printf '#!/bin/sh\n[ "$1" = -m ] && echo aarch64 || echo Linux\n' > "$R/arm/uname"; printf '#!/bin/sh\n[ "$1" = -u ] && echo 0 || exec %s "$@"\n' "$(command -v id)" > "$R/root/id"; chmod +x "$R/arm/uname" "$R/root/id"
c14=$(PATH_C="$R/arm:$R/cpath" credit "$R/credit h7" sh "$R/credit-install.sh" --credit); cc14=$?
c15=$(PATH_C="$R/root:$R/cpath" credit "$R/credit h7" sh "$R/credit-install.sh" --credit); cc15=$?
check "mocked non-x86_64 and mocked root are refused before download" '[[ $cc14 != 0 && $c14 == *"Linux x86_64 only"* && $cc15 != 0 && $c15 == *"not root"* && ! -s $R/curls && ! -e "$R/credit h7/.abalone-app" ]]'
c16=$(credit "$R/credit h8" sh "$R/old-credit-install.sh" --credit); cc16=$?
check "a release without the durable-credit runtime is refused after verification, nothing installed" '[[ $cc16 != 0 && $c16 == *"has no durable-credit runtime"* && ! -e "$R/credit h8/.abalone-app/eeeeeee/abalone" && ! -e "$R/credit h8/.local/bin/abalone" ]]'
# tools/release.sh in a throwaway clone (this checkout's release.sh copied in), with npm stubbed: install.sh only with a base.
git clone -q --shared "$root" "$R/repo" && cp "$root/tools/release.sh" "$R/repo/tools/"
mkdir -p "$R/stub" && printf '#!/bin/sh\nexit 0\n' > "$R/stub/npm" && chmod +x "$R/stub/npm"
rev=$(git -C "$R/repo" rev-parse --short HEAD) rel="$R/repo/local-data/release"
o=$(PATH="$R/stub:$PATH" "$R/repo/tools/release.sh" 2>&1)
check "release.sh without a base URL writes the tarball and no install.sh, and says how to get one" '[[ -f $rel/$rev/abalone-$rev.tar.gz && ! -e $rel/$rev/install.sh && $o == *"no base URL given, so no install.sh"* ]]'
check "release.sh emits the scriptless friend doorway to the hosted entry and setup skill, with no versioned installer link" 'cmp -s "$rel/$rev/index.html" "$R/repo/site/friend.html" && grep -q "default-src '"'"'none'"'"'" "$rel/$rev/index.html" && grep -q "href=\"https://amiller.github.io/abalone/redeem\"" "$rel/$rev/index.html" && grep -q "skills/abalone-incognito/SKILL.md" "$rel/$rev/index.html" && ! grep -qiE "<script|location[.]hash|install[.]sh|releases/download|preview[.][0-9]" "$rel/$rev/index.html"'
tar -tzf "$rel/$rev/abalone-$rev.tar.gz" > "$R/archive-members"
check "release source archive keeps guides, protocols, setup skill and the static Pages entry without historical notes or eval results" 'grep -q "^abalone/docs/getting-started.md$" "$R/archive-members" && grep -q "^abalone/docs/protocols/coupon.md$" "$R/archive-members" && grep -q "^abalone/skills/abalone-incognito/SKILL.md$" "$R/archive-members" && grep -q "^abalone/site/redeem/index.html$" "$R/archive-members" && ! grep -qE "^abalone/(notes/|evals/results/)" "$R/archive-members"'
check "archived Pages root is the scriptless doorway to the redeem entry, not a legacy landing" 'tar -xzOf "$rel/$rev/abalone-$rev.tar.gz" abalone/site/index.html > "$R/pages-root" && cmp -s "$R/pages-root" "$R/repo/site/index.html" && grep -q "href=\"redeem/\"" "$R/pages-root" && ! grep -qiE "<script|location[.]hash|install[.]sh" "$R/pages-root"'
PATH="$R/stub:$PATH" "$R/repo/tools/release.sh" HEAD https://example.org/r > /dev/null 2>&1
check "release.sh with a base URL pins it in install.sh" 'grep -q "curl -fsSL \"https://example.org/r/abalone-$rev.tar.gz\"" $rel/$rev/install.sh'
rm -rf "$R"
echo "install: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
