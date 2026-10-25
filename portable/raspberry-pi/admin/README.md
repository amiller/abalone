# Dsmack demo Wi-Fi and administrator SSH

This offline personalization enables saved Wi-Fi and key-only root SSH at every
boot, before vault unlock. The root administrator is a trusted maintenance
principal with access to the whole machine. The agent and workspace UI retain
their existing permissions and Tor egress policy.

Keep NetworkManager masked. Networkd continues to own DHCP on eth0 and gains
wlan0; a dedicated wpa_supplicant process associates wlan0 using the private
configuration. A fixed Wi-Fi-only rfkill unblock runs after the firewall
loads; Bluetooth is unchanged. The existing vendor SSH/user first-boot helpers stay masked.
A separate SSH unit uses its own fixed configuration, disables forwarding and
password authentication, and accepts only the supplied Ed25519 public keys.

`generatePolicy({torUid, dhcpUid, lanAdmin:true})` adds inbound SSH only on
eth0/wlan0 from RFC1918 IPv4 networks. Its return exception requires UID0,
conntrack reply direction, TCP source port22, and the same interface/address
bounds. Other application connections, including root outbound connections,
retain the Tor policy. No off-box IPv6 or forwarding is added. This deliberately
exposes trusted administrator access to the local network; it is not a sandbox
against an administrator.

Render the policy with the recorded `/etc/tor-guest/uids` values using
[render-policy.mjs](render-policy.mjs). Copy that public policy and its SHA256 to
a root-owned directory on the maintenance host. Run [personalize.py](personalize.py)
with `--root` pointing to the admitted, offline mounted USB root, `--policy-file`,
`--policy-sha256`, `--wifi-file`, and `--authorized-keys`. The default checks
without writing; `--apply` writes and enables the two services. The caller must
first bind the USB identity and preserve its boot partition and encrypted vault.
This script does not select or mount any device, start services, or touch EEPROM.

Wi-Fi JSON has exactly `version:1`, `keyManagement:"wpa-psk"`, `ssid`, and `psk`.
Private input files and their immediate directory must belong to the invoking
root user and have no group/other access. Authorized keys are Ed25519 public
keys only; comments are discarded and arbitrary key options are refused.
Wi-Fi secrets are converted into a hex SSID and derived PSK and written0600.
The script generates a unique SSH host key in the private target using the
maintenance host's ssh-keygen. Never put Wi-Fi configuration, host private keys,
automation private keys, or personalized filesystem images into public source
or release bundles. The automation private key stays on the operator host. Saved Wi-Fi credentials and
the SSH host key live outside the encrypted vault so they work before unlock;
someone holding the USB can read those files offline.

A partial apply is a maintenance failure: preserve evidence and inspect it;
preexisting personalization or temporary paths are refused instead of silently
regenerating identity. File changes are atomic individually, not as a filesystem
transaction. Only enablement occurs after all configuration writes.

Source tests cover strict private schemas and the fixed policy shape. A real
isolated network-namespace SSH handshake and negative agent-egress checks are
required before installing the policy. Saved association, pre-unlock SSH and
reboot persistence still require the actual Pi/Wi-Fi run.

For an unprivileged guestfish/COW-image pipeline, use
[build_payload.py](build_payload.py) instead. It takes the same private input
paths and public policy hash, plus a fresh `--payload-dir` under an owner-only
0700 directory. It writes ten owner-only files and a private version1 manifest
with fixed target paths, required root ownership/modes, one directory definition,
and two enablement symlinks. It generates a unique host key without mounting or
opening any image. The image controller must validate existing target identities,
install/chown the exact files, and preserve the boot partition and encrypted
vault. The payload contains secrets and must never join a public source archive.
Normal wpa_supplicant journal messages remain available for diagnosis; no debug
or key-dump flags are enabled.
