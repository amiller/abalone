# Laptop tools for the Pi

These run on a Linux laptop on the same network as the Pi. They reach the Pi
through the administrator SSH that [admin/personalize.py](../admin/README.md)
enables, so they work before the vault is unlocked.

| Tool | What it does |
| --- | --- |
| `pi-ssh [ADDRESS] [COMMAND...]` | Root shell or command on the Pi. Without an address it pings the laptop's /24 and picks the host whose MAC matches `PI_MAC`. |
| `pi-deploy try DIR` | Copies DIR (laid out like the Pi's `/`) into the running RAM overlay and checks the hashes. A reboot drops it. |
| `pi-deploy persist DIR` | Writes DIR to the stick: adds `portable-volatile-root=off` to the kernel command line, reboots into the read-write root, unpacks, restores the command line and reboots back. |
| `pi-view [record FILE.mp4]` | Shows the Pi's HDMI output from a USB capture device, optionally recording it. |
| `demo-record OUT.mp4 [--boot]` | Types the console-and-desktop journey on the Pi with a virtual keyboard ([vkbd.py](vkbd.py)) and records the screen. |

Environment:

- `PI_KEY`: the private key whose public half went into `--authorized-keys`.
- `PI_KNOWN_HOSTS`: a known_hosts file with the stick's administrator host key
  under the name `pi`. personalize.py generates that key at
  `/etc/ssh/portable-admin-host-ed25519-key.pub` on the stick (build_payload.py
  writes it as `host-ed25519.pub`); the file holds one line,
  `pi ssh-ed25519 AAAA...`.
- `PI_MAC`: the Pi's MAC address or a prefix of it, used when no address is
  given. pi-deploy and demo-record always find the Pi this way, because its
  address can change across the reboots they cause.
- `PI_STICK_SERIAL`: the USB stick's serial as `lsblk -o SERIAL` prints it on
  the Pi. `pi-deploy persist` refuses unless exactly one disk has this serial
  and the running boot partition is on it.
- `PI_CAPTURE`: the capture device for `pi-view` and `demo-record`, for
  example `/dev/v4l/by-id/usb-<vendor>-video-index0`.

`pi-deploy persist` needs the vault locked. If it stops between the two
reboots, the stick is left in recovery mode; the original command line is in
`/boot/firmware/portable-deploy/cmdline.original` on the boot partition, and
copying it back over `/boot/firmware/cmdline.txt` restores the volatile boot.

`demo-record` reads the vault passphrase from the first line of stdin
(`demo-record out.mp4 < passphrase-file`) and types it on the Pi's keyboard.
`DRY=1` skips the camera and only checks the console text.

`bash test-pi-deploy.sh` runs `pi-deploy try` against a fake pi-ssh and a
temporary root, and checks that existing directory modes are left alone.
