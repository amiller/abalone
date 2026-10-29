#!/bin/bash
# Fetch the Zkool 6.34.0 desktop wallet for aarch64 and the trixie libraries it needs on bookworm; lay out /opt/zkool.
# usage: fetch-zkool.sh KEYRING WORKDIR   output: WORKDIR/root/opt/zkool
#   KEYRING  Debian's archive keyring (the stick's /usr/share/keyrings/debian-archive-keyring.gpg); its hash is pinned
# Needs curl, gpgv, xz, dpkg-deb and patchelf. Library versions come from Debian's signed indexes; a version that
# has left the index is refused.
set -euo pipefail
KEYRING=$1; H=$(mkdir -p "$2" && cd "$2" && pwd); D=$H/download; R=$H/root; W=$H/work
echo "506b815cbb32d9b6066b4a2aa524071e071761e7e7f68c3ac74f3061ba852017  $KEYRING" | sha256sum -c --quiet
mkdir -p "$D"; rm -rf "$R" "$W"; mkdir -p "$W"

fetch() { [ -f "$D/$2" ] || { curl -fsSL -o "$D/$2.part" "$1"; mv "$D/$2.part" "$D/$2"; }; echo "$3  $D/$2" | sha256sum -c --quiet; }

fetch https://github.com/hhanh00/zkool2/releases/download/zkool-v6.34.0/zkool-6.34.0%2B383-aarch64.deb \
  zkool-6.34.0+383-aarch64.deb c772f2385333885e0e74c9579ff1c754d1ccce988c8df42ff4afdc56916ca2b5

# Signed index -> Packages.xz hash -> exact package version's Filename and SHA256.
index() { # suite
  curl -fsSL -o "$W/$1.InRelease" "https://deb.debian.org/debian/dists/$1/InRelease"
  gpgv --keyring "$KEYRING" --output "$W/$1.Release" "$W/$1.InRelease"
  local h; h=$(awk '/^SHA256:/{s=1;next} /^[^ ]/{s=0} s && $3=="main/binary-arm64/Packages.xz"{print $1}' "$W/$1.Release")
  [ -n "$h" ]
  curl -fsSL -o "$W/$1.Packages.xz" "https://deb.debian.org/debian/dists/$1/main/binary-arm64/Packages.xz"
  echo "$h  $W/$1.Packages.xz" | sha256sum -c --quiet
  xz -dc "$W/$1.Packages.xz" > "$W/$1.Packages"
}
deb() { # suite package version sha256
  local rec fn
  rec=$(awk -v RS= -F '\n' -v p="Package: $2" -v v="Version: $3" '{a=b=0; for(i=1;i<=NF;i++){a+=$i==p; b+=$i==v}} a&&b' "$W/$1.Packages")
  fn=$(sed -n 's/^Filename: //p' <<<"$rec")
  [ -n "$fn" ] && [ "$(sed -n 's/^SHA256: //p' <<<"$rec")" = "$4" ] || { echo "$2 $3 $4 not in signed $1 index" >&2; exit 1; }
  fetch "https://deb.debian.org/debian/$fn" "$(basename "$fn")" "$4"
  dpkg-deb -x "$D/$(basename "$fn")" "$W/x-$2"
}
index trixie; index bookworm
deb trixie libc6 2.41-12+deb13u4 8784eda966b189c777a384dac5ce009e8fc9b52d006926c5a013e7fa8aa688cc
deb trixie libstdc++6 14.2.0-19 6669b0c52a2e7c6af9adfdabce3ff6e286065cdfbc7b85280862b5f799daebee
deb trixie libglib2.0-0t64 2.84.4-3~deb13u5 d446f0ea85fb9dc411219ce861e59e5eabe1981c796918771a7d2aa97cc72481
deb trixie libmount1 2.41.5-0+deb13u1 14e2d555459f3c0b1442bb49dd2d266ea202a003198c86f65508a1dbfaa18732
deb trixie libblkid1 2.41.5-0+deb13u1 d7d122b4c7a0a8ae6135a1687c9c4ce80a88f9e498c01998f634dd32caab9016
deb bookworm libopengl0 1.6.0-1 4b3c6b3bc25530290cf231acac4c85b8806dda53ab6376ab22b3ec511b4fb7a0

Z=$R/opt/zkool
dpkg-deb -x "$D/zkool-6.34.0+383-aarch64.deb" "$W/zkool"
mkdir -p "$R/opt"; cp -a "$W/zkool/opt/zkool" "$Z"
patchelf --set-interpreter /opt/zkool/lib/ld-linux-aarch64.so.1 --force-rpath --set-rpath '$ORIGIN/lib' "$Z/zkool"
for x in "$W"/x-*; do find "$x/usr/lib/aarch64-linux-gnu" -maxdepth 1 -name '*.so*' ! -type d -exec cp -a -t "$Z/lib" {} +; done
chmod 0755 "$R"; find "$R" -type d -exec chmod 0755 {} +; find "$R" -type f -exec chmod 0644 {} +
chmod 0755 "$Z/zkool" "$Z/lib/ld-linux-aarch64.so.1"
rm -rf "$W"
