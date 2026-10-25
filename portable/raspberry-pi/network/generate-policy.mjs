// Tor guest egress policy generator — configuration text only.
//
// generatePolicy({ torUid, dhcpUid, lanAdmin: false }) returns nftables and torrc text for a
// disposable Debian guest where:
//   - only the Tor user (torUid) may send IPv4 TCP directly (relay egress);
//   - every other user's IPv4 TCP is transparently redirected to Tor's
//     TransPort on loopback :9040;
//   - all non-Tor IPv4 UDP port 53 (DNS) is redirected to Tor's DNSPort on
//     loopback :5353;
//   - the DHCP user (dhcpUid) may additionally send IPv4 DHCP requests
//     (UDP 68->67);
//   - loopback traffic is allowed (including IPv6 loopback ::1; IPv6 is
//     dropped everywhere else);
//   - input accepts loopback, IPv4 DHCP replies and established IPv4 TCP
//     replies only — the return half of the Tor user's own outbound relay
//     connections (no new inbound connections, no UDP/ICMP, no IPv6);
//   - the filter output chain also accepts exactly the two post-DNAT cases
//     the nat output chain itself creates: packets whose conntrack entry
//     carries the DNAT status and whose rewritten destination is exactly
//     127.0.0.1 TCP 9040 (TransPort) or 127.0.0.1 UDP 5353 (DNSPort). This
//     is needed because the output hook's oifname comes from the routing
//     decision made before the destination rewrite, so `oifname "lo"`
//     cannot match redirected traffic; and
//   - everything else — off-box IPv6 and any other direct application
//     traffic — is dropped. There is no blanket conntrack "established"
//     output exception and no LAN bypass (LAN TCP from non-Tor users is
//     proxied through Tor like everything else); the post-DNAT accepts
//     above are keyed to `ct status dnat` plus an exact loopback address
//     and port, not to connection state, so they accept nothing that this
//     policy did not itself redirect.
//
// An explicit trusted lanAdmin:true adds RFC1918 inbound SSH on eth0/wlan0
// and only UID0 conntrack reply-direction TCP source-port22 return traffic.
// It never exempts agent/UI/credit egress or permits forwarding.
//
// uids must be integers in 1..4294967294; 4294967295 (UINT32_MAX, the
// (uid_t)-1 "invalid uid" sentinel) is refused.
//
// The nftables text uses dedicated tables (ip tor_guest_nat,
// inet tor_guest_filter) and never contains `flush ruleset`.
//
// Policy limits and root trust: this module only generates text. Enforcement
// happens in the guest kernel and presumes guest root is trusted — root can
// delete these tables, load different rules, or run processes under either
// uid, and nothing here constrains kernel, nftables or Tor bugs or side
// channels. Neither this module nor its tests establish live enforcement;
// the guest packet-capture acceptance in README.md is still required.

// 4294967295 (UINT32_MAX) is the (uid_t)-1 "invalid uid" sentinel, so the
// largest uid this generator will emit is 4294967294.
const MAX_UID = 4294967294;

// JSON.stringify throws on BigInt and cannot represent Symbol (and can throw
// on circular objects). Error formatting must never crash on the very invalid
// input it is trying to describe, so format those types explicitly.
function describeValue(value) {
  if (typeof value === 'bigint') return `bigint ${value}`;
  if (typeof value === 'symbol') return `symbol ${String(value)}`;
  try {
    return `${typeof value} ${JSON.stringify(value)}`;
  } catch {
    return typeof value;
  }
}

function fail(ErrorCtor, name, value, why) {
  throw new ErrorCtor(
    `generatePolicy: ${name} ${why} (got ${describeValue(value)})`,
  );
}

function checkedUid(name, value) {
  if (!Number.isInteger(value)) {
    fail(TypeError, name, value, 'must be an integer uid');
  }
  if (value <= 0 || value > MAX_UID) {
    fail(RangeError, name, value, `must be a nonzero uid in 1..${MAX_UID}`);
  }
  return value;
}

export function generatePolicy(options = {}) {
  const { torUid, dhcpUid, lanAdmin = false } = options ?? {};
  if (typeof lanAdmin !== "boolean") throw new TypeError("lanAdmin must be boolean");
  const lan = "{ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 }";
  const interfaces = '{ "eth0", "wlan0" }';
  const tor = checkedUid('torUid', torUid);
  const dhcp = checkedUid('dhcpUid', dhcpUid);
  if (tor === dhcp) {
    fail(RangeError, 'torUid/dhcpUid', tor, 'must be different uids');
  }

  const nftables = `# tor-guest.nft — generated for tor uid ${tor} / dhcp uid ${dhcp}.
# Apply inside the disposable Debian guest as root:
#   nft -f tor-guest.nft
# Reload: nft applies a whole file as ONE atomic transaction, so never run
# separate delete commands between loads (that opens a fail-open window).
# Instead, detect which dedicated tables already exist:
#   nft list table ip tor_guest_nat
#   nft list table inet tor_guest_filter
# and for each table that exists, prepend a matching "delete table ..." line
# to this file above the new definitions, then run "nft -f" on that single
# file. The deletes and new definitions commit together — no interval with
# the tables absent, no global flush, other tables untouched.

table ip tor_guest_nat {
	chain output {
		# Numeric -100 == dstnat; the symbolic name is rejected by some
		# nft versions (e.g. nftables 1.0.6: "invalid priority expression
		# value in this context") when checking a policy file.
		type nat hook output priority -100; policy accept;
		# Never redirect the Tor user's own traffic (prevents redirect loops).
		meta skuid ${tor} return
		# Loopback destinations stay local (Tor listeners, guest services).
		ip daddr 127.0.0.0/8 return
${lanAdmin ? `\t\tmeta skuid 0 ct direction reply tcp sport 22 ip daddr ${lan} return\n` : ""}		# All non-Tor IPv4 DNS -> Tor DNSPort on loopback.
		udp dport 53 redirect to :5353
		# All remaining non-Tor IPv4 TCP -> Tor TransPort on loopback.
		meta l4proto tcp redirect to :9040
	}
}

table inet tor_guest_filter {
	chain input {
		type filter hook input priority filter; policy drop;
		iifname "lo" accept
${lanAdmin ? `\t\tiifname ${interfaces} ip saddr ${lan} tcp dport 22 ct state { new, established } accept\n` : ""}		# DHCP replies (IPv4, server 67 -> client 68) only.
		meta nfproto ipv4 udp sport 67 udp dport 68 accept
		# Established IPv4 TCP replies: the return half of connections the
		# Tor user opened outbound (relay answers). No new inbound
		# connections, no UDP/ICMP replies, no IPv6 — and the output chain
		# deliberately keeps no established exception.
		meta nfproto ipv4 ct state established meta l4proto tcp accept
	}
	chain forward {
		type filter hook forward priority filter; policy drop;
	}
	chain output {
		type filter hook output priority filter; policy drop;
		oifname "lo" accept
${lanAdmin ? `\t\tmeta skuid 0 oifname ${interfaces} ip daddr ${lan} ct direction reply ct state established tcp sport 22 accept\n` : ""}		# DHCP client requests (IPv4, 68 -> 67), DHCP user only.
		meta skuid ${dhcp} meta nfproto ipv4 udp sport 68 udp dport 67 accept
		# Tor relay egress: IPv4 TCP only, never to loopback.
		meta skuid ${tor} ip daddr != 127.0.0.0/8 meta l4proto tcp accept
		# Redirected traffic after the nat rewrite: the dstnat chain above
		# rewrites the destination to 127.0.0.1 (TransPort/DNSPort), but the
		# output routing decision — and with it oifname — was made before
		# that rewrite, so the loopback accept above still sees the packet's
		# original egress interface and cannot match it. Accept only what
		# conntrack marks as DNAT'd, with the rewritten destination exactly
		# one of Tor's two loopback listeners.
		ct status dnat ip daddr 127.0.0.1 tcp dport 9040 accept
		ct status dnat ip daddr 127.0.0.1 udp dport 5353 accept
		# Everything else drops here: all IPv6, all UDP except the
		# DHCP/DNS cases above, ICMP, and any other direct traffic.
	}
}
`;

  const torrc = `# torrc — generated for a disposable Debian guest.
# Run Tor as the dedicated user that owns uid ${tor}; ports match tor-guest.nft.
SocksPort 127.0.0.1:9050
TransPort 127.0.0.1:9040
DNSPort 127.0.0.1:5353
# Map .onion and resolved hostnames into a private, non-loopback IPv4 range
# so non-Tor TCP toward those addresses is transparently proxied, not leaked.
AutomapHostsOnResolve 1
VirtualAddrNetworkIPv4 10.192.0.0/10
# This node must never be used as an exit relay.
ExitPolicy reject *:*
`;

  return { torUid: tor, dhcpUid: dhcp, nftables, torrc };
}
