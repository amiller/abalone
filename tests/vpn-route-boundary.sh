#!/usr/bin/env bash
# Synthetic routing model only: no actual VPN, provider or coupon qualification.
set -euo pipefail
script=$(realpath "$0")
if [[ ${1:-} != --isolated ]]; then
  for tool in unshare ip nft python3 mount ss realpath; do command -v "$tool" >/dev/null; done
  exec unshare --user --map-root-user --mount --net bash "$script" --isolated
fi
# Refuse a directly invoked privileged --isolated run in the host's namespaces.
[[ $(readlink /proc/self/ns/net) != $(readlink /proc/1/ns/net) ]]
[[ $(readlink /proc/self/ns/mnt) != $(readlink /proc/1/ns/mnt) ]]
mount --make-rprivate /
mount -t tmpfs tmpfs /run
mkdir /run/netns
ip netns add recipient
ip netns add sink
trap 'ip netns pids sink | xargs -r kill; ip netns pids recipient | xargs -r kill' EXIT
for ns in recipient sink; do ip -n "$ns" link set lo up; done
for pair in 'wan0 192.0.2 1' 'vpn0 198.51.100 2'; do
  read -r dev subnet subnet6 <<< "$pair"
  ip link add "$dev" type veth peer name "${dev}s"
  ip link set "$dev" netns recipient
  ip link set "${dev}s" netns sink
  ip -n recipient addr add "$subnet.2/24" dev "$dev"
  ip -n sink addr add "$subnet.1/24" dev "${dev}s"
  ip -n recipient -6 addr add "2001:db8:$subnet6::2/64" dev "$dev" nodad
  ip -n sink -6 addr add "2001:db8:$subnet6::1/64" dev "${dev}s" nodad
  ip -n recipient link set "$dev" up
  ip -n sink link set "${dev}s" up
done
ip -n sink addr add 203.0.113.9/32 dev lo
ip -n sink -6 addr add 2001:db8:ffff::9/128 dev lo
route_via() {
  ip -n recipient route replace default via "$1.1" dev "$2"
  ip -n recipient -6 route replace default via "2001:db8:$3::1" dev "$2"
}
cat > /run/sink.py <<'PY'
import socket, threading, time
def serve(family, kind, address, port):
    s = socket.socket(family, kind)
    if family == socket.AF_INET6:
        s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    s.bind((address, port))
    if kind == socket.SOCK_STREAM:
        s.listen()
    while True:
        if kind == socket.SOCK_STREAM:
            conn, peer = s.accept()
            with conn:
                value = conn.recv(128)
                with open('/run/received', 'a') as f:
                    f.write(value.decode('ascii') + '\n')
                conn.sendall(value)
        else:
            value, peer = s.recvfrom(128)
            with open('/run/received', 'a') as f:
                f.write(value.decode('ascii') + '\n')
            s.sendto(value, peer)
for family, address in [(socket.AF_INET, '203.0.113.9'),
                        (socket.AF_INET6, '2001:db8:ffff::9')]:
    for kind, port in [(socket.SOCK_STREAM, 8443), (socket.SOCK_DGRAM, 53)]:
        threading.Thread(target=serve, args=(family, kind, address, port), daemon=True).start()
time.sleep(120)
PY
cat > /run/probe.py <<'PY'
import socket, sys, time
phase, expectation = sys.argv[1:]
for family, address, label in [(socket.AF_INET, '203.0.113.9', 'ipv4'),
                               (socket.AF_INET6, '2001:db8:ffff::9', 'ipv6')]:
    for kind, port, protocol in [(socket.SOCK_STREAM, 8443, 'tcp'),
                                 (socket.SOCK_DGRAM, 53, 'udp53')]:
        value = f'{phase}:{label}:{protocol}'.encode()
        with socket.socket(family, kind) as s:
            s.settimeout(0.5)
            try:
                s.connect((address, port))
                s.sendall(value)
                reached = s.recv(128) == value
            except OSError:
                reached = False
        assert reached == (expectation == 'allow'), (phase, label, protocol, reached)
        print(f'{phase} {label} {protocol}: {expectation}')
PY
ip netns exec sink python3 /run/sink.py &
sink_pid=$!
# Readiness checks bind all four listeners before any scored probe.
for attempt in {1..50}; do
  if [[ $(ip netns exec sink ss -lnutH | wc -l) -ge 4 ]]; then break; fi
  kill -0 "$sink_pid"
  sleep 0.05
done
[[ $(ip netns exec sink ss -lnutH | wc -l) -ge 4 ]]
route_via 192.0.2 wan0 1
ip netns exec recipient python3 /run/probe.py ordinary-positive-control allow
route_via 198.51.100 vpn0 2
ip netns exec recipient nft -f - <<'NFT'
table inet gift_boundary {
  chain output {
    type filter hook output priority 0; policy drop;
    oifname "lo" accept
    oifname "vpn0" accept
    counter drop
  }
}
NFT
ip netns exec recipient python3 /run/probe.py protected-route allow
# Simulate full tunnel loss and the host switching back to ordinary connectivity.
ip -n recipient link set vpn0 down
route_via 192.0.2 wan0 1
ip netns exec recipient python3 /run/probe.py route-loss deny
ip -n recipient link set vpn0 up
ip -n recipient -6 addr replace 2001:db8:2::2/64 dev vpn0 nodad
route_via 198.51.100 vpn0 2
ip netns exec recipient python3 /run/probe.py restored-route allow
python3 - <<'PY'
from collections import Counter
rows = open('/run/received').read().splitlines()
expected = [f'{phase}:{family}:{protocol}'
            for phase in ('ordinary-positive-control', 'protected-route', 'restored-route')
            for family in ('ipv4', 'ipv6') for protocol in ('tcp', 'udp53')]
assert Counter(rows) == Counter(expected), rows
print('PASS: sink saw every positive control and zero route-loss payloads.')
print('Scope: synthetic full-tunnel firewall model, not a VPN or gift release qualification.')
PY
