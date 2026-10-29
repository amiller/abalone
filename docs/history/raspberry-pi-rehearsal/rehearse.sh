#!/usr/bin/env bash
# Disposable ARM64 development guest; this does not enforce Tor-only egress.
set -euo pipefail
mode=${1:-help}
root=${PORTABLE_REHEARSAL_DIR:?Set PORTABLE_REHEARSAL_DIR to dedicated rehearsal storage}
mkdir -p "$root"/{tools/packages,tools/root,images,evidence,tmp}
root=$(cd "$root" && pwd)
export TMPDIR="$root/tmp"
image=debian-12-generic-arm64-20261006-2623.qcow2
image_url="https://cloud.debian.org/images/cloud/bookworm/20261006-2623/$image"
image_sha=991f0dd77ee442eb2406568fc27c537190af0c78ab211b0e2adcf568cd203aebf696b94a05e64c7e00d3e05e0e532fdd941311e34ef862ad06bc1bc69a92a3fb
qemu="$root/tools/root/usr/bin/qemu-system-aarch64"
firmware="$root/tools/root/usr/share/AAVMF"
case "$mode" in
  tools)
    cd "$root/tools/packages"
    apt-get download 'qemu-system-arm=1:6.2+dfsg-2ubuntu6.31' 'qemu-efi-aarch64=2022.02-3ubuntu0.22.04.7'
    for package in ./*.deb; do dpkg-deb -x "$package" ../root; done
    sha256sum ./*.deb > "$root/evidence/tool-packages.sha256"
    ldd "$qemu" > "$root/evidence/qemu-ldd.txt"
    if grep -q 'not found' "$root/evidence/qemu-ldd.txt"; then cat "$root/evidence/qemu-ldd.txt"; exit 1; fi
    "$qemu" --version | tee "$root/evidence/qemu-version.txt"
    ;;
  image)
    cd "$root/images"
    if [[ ! -f "$image" ]]; then
      curl --fail --location --retry 3 "$image_url" -o "$image.part"
      printf '%s  %s\n' "$image_sha" "$image.part" | sha512sum --check -
      mv "$image.part" "$image"
    fi
    printf '%s  %s\n' "$image_sha" "$image" | sha512sum --check -
    printf '%s\n%s  %s\n' "$image_url" "$image_sha" "$image" > "$root/evidence/image-provenance.txt"
    ;;
  prepare)
    [[ ! -e "$root/images/run.qcow2" ]] || { echo 'Existing run.qcow2: retain it for recovery or remove explicitly before a fresh run.' >&2; exit 1; }
    printf '%s  %s\n' "$image_sha" "$root/images/$image" | sha512sum --check -
    mkdir -p "$root/seed"
    ssh-keygen -q -t ed25519 -N '' -f "$root/seed/guest-key"
    printf 'instance-id: portable-arm64-rehearsal\nlocal-hostname: portable-rehearsal\n' > "$root/seed/meta-data"
    cat > "$root/seed/user-data" <<YAML
#cloud-config
users:
  - name: rehearsal
    groups: [sudo]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    lock_passwd: true
    ssh_authorized_keys:
      - $(cat "$root/seed/guest-key.pub")
ssh_pwauth: false
disable_root: true
runcmd:
  - [sh, -c, 'echo PORTABLE_ARM64_READY > /dev/ttyAMA0']
YAML
    genisoimage -quiet -output "$root/images/seed.iso" -volid cidata -joliet -rock "$root/seed/user-data" "$root/seed/meta-data"
    qemu-img create -f qcow2 -F qcow2 -b "$root/images/$image" "$root/images/run.qcow2" 12G
    cp "$firmware/AAVMF_VARS.fd" "$root/images/vars.fd"
    ;;
  run)
    exec "$qemu" -name portable-arm64-rehearsal \
      -machine virt -cpu cortex-a72 -accel tcg,thread=multi -smp 4 -m 4096 \
      -drive if=pflash,format=raw,readonly=on,file="$firmware/AAVMF_CODE.fd" \
      -drive if=pflash,format=raw,file="$root/images/vars.fd" \
      -drive if=none,id=os,format=qcow2,file="$root/images/run.qcow2" \
      -device virtio-blk-pci,drive=os \
      -drive if=none,id=seed,format=raw,readonly=on,file="$root/images/seed.iso" \
      -device virtio-blk-pci,drive=seed \
      -netdev user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22 \
      -device virtio-net-pci,netdev=net0 \
      -device virtio-gpu-pci -device qemu-xhci -device usb-kbd -device usb-tablet \
      -vnc 127.0.0.1:1 -serial file:"$root/evidence/serial.log" \
      -qmp unix:"$root/tmp/qmp.sock",server=on,wait=off \
      -pidfile "$root/tmp/qemu.pid" -monitor none
    ;;
  ssh)
    shift
    exec ssh -i "$root/seed/guest-key" -o IdentitiesOnly=yes \
      -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$root/seed/known_hosts" \
      -p 2222 rehearsal@127.0.0.1 "$@"
    ;;
  *) echo "Usage: PORTABLE_REHEARSAL_DIR=/dedicated/storage $0 {tools|image|prepare|run|ssh [command]}"; exit 2 ;;
esac
