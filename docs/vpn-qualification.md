# VPN routing qualification

The gift release requires one explicitly tested OS/VPN profile. Abalone's
loopback-only Pi sandbox and admitted-host egress do not establish that profile:
the launcher opens upstream sockets using host routing. Peer TCP/WebSocket,
relay/direct upgrades, provider verification, RPC and installer traffic must all
be covered. See [release acceptance](release.md).

## Disposable route-loss fixture

On Linux with unprivileged user/network namespaces and iproute2, nftables,
Python 3 and util-linux installed, run from the repository root:

```sh
bash tests/vpn-route-boundary.sh
```

This fixture creates isolated user, mount and network namespaces and a private
`/run`. It does not change the host firewall, routes, VPN or installed packages.
It creates ordinary and simulated tunnel paths to a synthetic sink. A namespace
firewall allows only the simulated tunnel interface. The ordinary path is first
proved usable as a positive control. Then IPv4/IPv6 TCP and UDP port 53 payloads
must succeed on the protected route, fail after tunnel loss and fallback to the
ordinary route, and succeed after restoration. The sink must record all twelve
positive payloads and none of the four denied payloads. Failure is nonzero;
missing tools or disabled namespaces are not reported as passing.

The simulated tunnel is a veth link, not an encrypted VPN. UDP port 53 probes test
packet routing, not a real DNS resolver. This fixture does not run libp2p,
provider TLS, inference, or the coupon journey. It establishes the routing-model
test and a working positive control, not production VPN coverage.

## Remaining acceptance

Select the actual OS/VPN profile and test the whole launcher/process tree with
synthetic private data. Include installation/bootstrap, DNS resolution and IPv6,
peer relay/direct fallback, attestation collateral and RPC. Observe traffic on
the physical interface as well as inside the sandbox, with a deliberate bypass
positive control. Disconnect/reconnect the VPN and change interfaces while
claiming and using the service. Unsupported or lost protection must not silently
fall back to ordinary routing. Record what the VPN/OS enforces and what Abalone
enforces; do not claim anonymity or sponsor/provider unlinkability.
