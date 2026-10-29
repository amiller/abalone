#!/bin/bash
# Cross-build zkool_graphql from Zkool 6.34.0 (the same release as the desktop wallet) for aarch64 bookworm, in Docker.
# usage: build-zkool-graphql.sh WORKDIR   output: WORKDIR/zkool_graphql (stripped)
# Needs git and Docker. The build is not known to be reproducible; the script prints the hash for the record.
set -euo pipefail
W=$(mkdir -p "$1" && cd "$1" && pwd); TAG=zkool-v6.34.0; COMMIT=51df4f0b356a886d5d2308811f215366ab648d65
mkdir -p "$W/cargo" "$W/rustup"
[ -d "$W/src" ] || git clone -q --depth 1 --branch $TAG https://github.com/hhanh00/zkool2.git "$W/src"
[ "$(git -C "$W/src" rev-parse HEAD)" = "$COMMIT" ] || { echo "$W/src is not $TAG at $COMMIT" >&2; exit 1; }
docker run --rm -v "$W:/w" -e CARGO_HOME=/w/cargo -e RUSTUP_HOME=/w/rustup debian:bookworm bash -euo pipefail -c '
dpkg --add-architecture arm64; apt-get -qq update
apt-get -qq install -y --no-install-recommends ca-certificates curl git build-essential pkg-config protobuf-compiler perl make \
  gcc-aarch64-linux-gnu g++-aarch64-linux-gnu binutils-aarch64-linux-gnu libc6-dev-arm64-cross libssl-dev:arm64 >/dev/null
[ -x /w/cargo/bin/rustup ] || curl -fsSL https://sh.rustup.rs | sh -s -- -y -q --default-toolchain none --no-modify-path
export PATH=/w/cargo/bin:$PATH; cd /w/src
rustup target add aarch64-unknown-linux-gnu
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
  CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++ AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar \
  PKG_CONFIG_ALLOW_CROSS=1 PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig
cargo build --locked --release --target aarch64-unknown-linux-gnu --bin zkool_graphql --no-default-features \
  --features graphql,bundled-sapling-params --manifest-path rust/Cargo.toml
aarch64-linux-gnu-strip -o /w/zkool_graphql target/aarch64-unknown-linux-gnu/release/zkool_graphql
chown -R '"$(id -u):$(id -g)"' /w/src/target /w/cargo /w/rustup /w/zkool_graphql'
sha256sum "$W/zkool_graphql"
