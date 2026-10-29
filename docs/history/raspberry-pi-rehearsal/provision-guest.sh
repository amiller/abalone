#!/usr/bin/env bash
# Run inside the disposable ARM64 guest as the rehearsal user.
set -euo pipefail
[[ $(uname -m) == aarch64 ]] || { echo 'ARM64 guest required' >&2; exit 1; }
node_version=v24.22.0
node_archive="node-$node_version-linux-arm64.tar.xz"
node_sha=fef00bb4d36e1c50104a9775a10359beee98f162b4104dd12472c75065c6a143
mkdir -p "$HOME/.local/opt" "$HOME/workspace" "$HOME/provision-cache"
cd "$HOME/provision-cache"
curl --fail --location --retry 3 "https://nodejs.org/dist/$node_version/$node_archive" -o "$node_archive"
printf '%s  %s\n' "$node_sha" "$node_archive" | sha256sum --check -
tar -xJf "$node_archive" -C "$HOME/.local/opt"
[[ -f "$HOME/portable/workspace/server.mjs" ]] || { echo 'Deploy portable/workspace first' >&2; exit 1; }
sudo tee /etc/systemd/system/portable-workspace.service >/dev/null <<UNIT
[Unit]
Description=Portable workspace rehearsal
After=local-fs.target
[Service]
User=$USER
WorkingDirectory=$HOME
ExecStart=$HOME/.local/opt/node-$node_version-linux-arm64/bin/node $HOME/portable/workspace/server.mjs --workspace $HOME/workspace
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now portable-workspace.service
if [[ ${1:-} == --kiosk ]]; then
  sudo apt-get update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xserver-xorg xinit x11-xserver-utils chromium openbox fonts-dejavu-core
  cat > "$HOME/.xinitrc" <<'XINIT'
#!/bin/sh
xset -dpms
xset s off
openbox &
exec chromium --kiosk --no-first-run --disable-session-crashed-bubble --user-data-dir=/tmp/portable-chromium http://127.0.0.1:8765
XINIT
  chmod +x "$HOME/.xinitrc"
  mkdir -p "$HOME/.config"
  cat > "$HOME/.bash_profile" <<'PROFILE'
if [ "$(tty)" = /dev/tty1 ]; then
  exec startx -- -nolisten tcp
fi
PROFILE
  sudo mkdir -p /etc/systemd/system/getty@tty1.service.d
  sudo tee /etc/systemd/system/getty@tty1.service.d/autologin.conf >/dev/null <<UNIT
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $USER --noclear %I \$TERM
UNIT
  sudo systemctl daemon-reload
  sudo systemctl restart getty@tty1.service
fi
