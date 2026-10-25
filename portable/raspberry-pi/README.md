# Raspberry Pi portable platform

This directory owns the Raspberry Pi and ARM64 rehearsal integration. Shared
inference, funding and browser-workspace components live in sibling directories;
see the [portable overview](../README.md) and [development workflow](../DEVELOPMENT.md).
The native Pi terminal and ordinary Bash are the selected USB demo experience.
Historical rehearsal recipes below describe their own narrower scope; they are
not a fresh-install or release qualification for the integrated hardware demo.

- [Administrator enrollment](admin/README.md)
- [Clock bootstrap](clock/README.md)
- [Terminal and display](display/README.md)
- [Image assembly](image/README.md)
- [Network policy](network/README.md)
- [Encrypted storage](storage/README.md)
- [SDK runtime packaging](sdk-runtime.md)

## ARM64 portable rehearsal

Boot a disposable ARM64 development guest to validate the portable filesystem and
startup services before testing a separate Raspberry Pi USB image. This is a VM
boot spike: it does not yet contain the workspace UI, agent, payment integration,
or a Tor-only network boundary. User-mode networking permits ordinary egress.
Use synthetic work and no payment credentials.

The initial host recipe targets Ubuntu 22.04 x86_64 with `qemu-img`, `genisoimage`,
`curl`, `ssh-keygen`, `dpkg-deb`, and the shared libraries required by QEMU already
installed. ARM QEMU and EFI packages are extracted into a user-owned directory;
no system package install or existing VM changes are needed. The package versions
are pinned; if the host's authenticated apt indexes no longer offer them, review
and update the pins instead of silently substituting a different version.

Choose dedicated storage on a disk with room for the image and a sparse 12 GB
writable overlay. Heavy work belongs on a build host, not a small laptop.

```sh
export PORTABLE_REHEARSAL_DIR=/path/to/dedicated/portable-rehearsal
./portable/raspberry-pi/rehearse.sh tools
./portable/raspberry-pi/rehearse.sh image
./portable/raspberry-pi/rehearse.sh prepare
./portable/raspberry-pi/rehearse.sh run
```

Run the final command in a persistent terminal. In another terminal on that host:

```sh
export PORTABLE_REHEARSAL_DIR=/path/to/dedicated/portable-rehearsal
./portable/raspberry-pi/rehearse.sh ssh 'uname -m; cloud-init status --wait'
```

SSH is bound to host loopback port 2222 and VNC to loopback port 5901. Forward them
through SSH to inspect a remote guest. No guest password is installed; the
rehearsal generates a dedicated key in `seed/`. The guest user has passwordless
sudo inside this disposable VM. Never reuse the seed or key for a shipped image.
The base image has no graphical desktop; VNC is wired for a future workspace.

The pinned base is Debian's official
[Bookworm ARM64 generic image](https://cloud.debian.org/images/cloud/bookworm/20261006-2623/).
The script verifies its pinned SHA-512 before accepting a download or preparing
an overlay. Provenance and serial output go in `evidence/`; preserve those with
source revision and outcomes. The checksum was obtained from the publisher over
HTTPS; detached-signature verification is not implemented by this spike.

QEMU's [generic virt board](https://www.qemu.org/docs/master/system/arm/virt.html)
runs with four Cortex-A72 CPUs, 4 GB RAM, and software TCG emulation on x86. Its
firmware and virtio devices differ from a Pi. Share filesystem contents and
service definitions with the eventual Pi package, but provide machine-specific
kernel/firmware configuration. Emulated boot time does not predict Pi timing.

## Acceptance loop

1. Preserve the immutable base image; use one writable overlay per rehearsal.
2. Record serial `PORTABLE_ARM64_READY`, `uname -m`, cloud-init status, image hash,
   source revision, and the actual checks run. These establish a booted guest,
   not a working agent experience.
3. As workspace integration lands, exercise local interaction before networking,
   a real synthetic agent task, connection loss, and restart recovery.
4. Once Tor enforcement lands, independently capture egress and test failure
   closure. A Tor status label or this VM's NAT configuration is not evidence.
5. Shut down with `rehearse.sh ssh 'sudo poweroff'`. Retain logs and results;
   remove disposable images, keys, and build outputs after collecting evidence.
   A new `prepare` refuses to overwrite an existing overlay.

The hardware gate remains a separate USB boot on the target Pi, covering firmware,
display, input, USB compatibility, and three measured cold boots. Do not flash a
system disk or disturb a running Pi as part of the VM rehearsal.

## Workspace and kiosk in the disposable guest

Copy `portable/workspace/` and `portable/raspberry-pi/provision-guest.sh` into the
rehearsal user's home directory, preserving the directory layout, then run:

```sh
bash portable/raspberry-pi/provision-guest.sh --kiosk
```

This guest-only command verifies a pinned official Node 24 ARM64 archive, installs
it under `~/.local/opt`, and enables `portable-workspace.service` before installing
optional Chromium, Xorg, Openbox, and fonts from Debian's authenticated package
repositories. Omit `--kiosk` for backend-only iteration. Kiosk packages use the
configured Debian repository versions; record installed versions when qualifying
an image. This step is not a reproducible final image build.

The kiosk uses tty1 autologin as the disposable rehearsal user and opens the
loopback workspace. This convenience account has sudo; it is not the final
agent authority boundary. Do not add secrets. A graphical failure should leave
SSH available for diagnosis. Inspect `journalctl -u portable-workspace` and the
user's Xorg log. VNC displays the guest; it is not a web server port.

Copy [verify-workspace.py](verify-workspace.py) into the guest and run it with
Python 3 to exercise a real terminal via the HTTP API. It checks `uname -m`
through the PTY and closes its session. Retain its JSON output as evidence.

## SDK runtime bundle

[Package and verify the SDK runtime](sdk-runtime.md) separately from guest
provisioning. The bundle verifier exercises real SDK tools, native clipboard
binding loading and QuickJS on the machine where it runs. Host results do not
qualify another architecture; run the verifier inside the ARM guest before
connecting its workspace to the bundle. This does not perform model inference.
