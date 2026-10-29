#!/bin/bash
# Offline check that pi-deploy try leaves the modes of existing directories alone (fake pi-ssh, temp root).
# usage: bash test-pi-deploy.sh
set -euo pipefail
T=$(cd "$(dirname "$0")" && pwd); W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$W/bin" "$W/src/opt/portable" "$W/root/opt"; chmod 0700 "$W/src" "$W/src/opt"; echo x > "$W/src/opt/portable/f"
chmod 0755 "$W/root" "$W/root/opt"
cp "$T/pi-deploy" "$W/bin/"
cat > "$W/bin/pi-ssh" <<FAKE
#!/bin/sh
shift
case "\$*" in
  *sha256sum*) sed "s#  /#  $W/root/#" | sha256sum -c --quiet ;;
  *) sh -c "\$(echo "\$*" | sed "s#-C / #-C $W/root #")" ;;
esac
FAKE
chmod +x "$W/bin/pi-ssh"
mode() { stat -c %a "$1"; }
# The old extraction copies the payload's 0700 directory modes onto the target.
mkdir -p "$W/old/opt"; chmod 0755 "$W/old" "$W/old/opt"
tar -C "$W/src" -cf - . | tar -C "$W/old" -xpf -
[ "$(mode "$W/old")" = 700 ] && [ "$(mode "$W/old/opt")" = 700 ] || { echo "FAIL: old behavior not reproduced" >&2; exit 1; }
"$W/bin/pi-deploy" try "$W/src" 2>/dev/null
[ "$(mode "$W/root")" = 755 ] && [ "$(mode "$W/root/opt")" = 755 ] || { echo "FAIL: pi-deploy changed directory modes" >&2; exit 1; }
[ "$(cat "$W/root/opt/portable/f")" = x ]
echo "ok pi-deploy try keeps existing directory modes"
