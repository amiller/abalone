// Structural assertions for generatePolicy output.
//
// EXPLICIT LIMIT: these tests inspect generated configuration text only.
// They do not apply nftables, start Tor, or send any packets, and passing
// them does NOT establish live enforcement in any guest. The negative
// packet-capture acceptance described in README.md is still required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePolicy } from './generate-policy.mjs';

const count = (s, needle) => s.split(needle).length - 1;

test('refuses missing, mistyped, out-of-range and equal uids', () => {
  const bad = [
    [undefined, 106],
    [143, undefined],
    [null, 106],
    [143, null],
    ['143', 106],
    [143, '106'],
    [1.5, 106],
    [NaN, 106],
    [0, 106],
    [-1, 106],
    [2 ** 32, 106],
    [143, 2 ** 32],
    [4294967295, 106],
    [143, 4294967295],
    [143n, 106],
    [Symbol('tor'), 106],
    [101, 101],
  ];
  for (const [torUid, dhcpUid] of bad) {
    assert.throws(
      () => generatePolicy({ torUid, dhcpUid }),
      /generatePolicy:/,
      `expected refusal for torUid=${String(torUid)} dhcpUid=${String(dhcpUid)}`,
    );
  }
  assert.throws(() => generatePolicy(), /torUid/);
  assert.throws(() => generatePolicy({}), /torUid/);
});

test('refusal messages name the offending field', () => {
  assert.throws(() => generatePolicy({ torUid: 0, dhcpUid: 106 }), /torUid/);
  assert.throws(() => generatePolicy({ torUid: 143, dhcpUid: 'x' }), /dhcpUid/);
  assert.throws(() => generatePolicy({ torUid: 7, dhcpUid: 7 }), /different uids/);
  assert.doesNotThrow(() => generatePolicy({ torUid: 1, dhcpUid: 4294967294 }));
  // Error formatting must not itself crash on BigInt/Symbol inputs, and the
  // message must still name the offending field (no raw JSON.stringify
  // TypeError leaking out of the refusal path).
  assert.throws(
    () => generatePolicy({ torUid: 143n, dhcpUid: 106 }),
    /generatePolicy: torUid must be an integer uid \(got bigint 143\)/,
  );
  assert.throws(
    () => generatePolicy({ torUid: 143, dhcpUid: Symbol('dhcp') }),
    /generatePolicy: dhcpUid must be an integer uid \(got symbol Symbol\(dhcp\)\)/,
  );
});

test('nftables text has dedicated tables, exemptions and redirects', () => {
  const { nftables } = generatePolicy({ torUid: 143, dhcpUid: 106 });
  assert.ok(nftables.includes('table ip tor_guest_nat'));
  assert.ok(nftables.includes('table inet tor_guest_filter'));
  assert.ok(nftables.includes('type nat hook output priority -100; policy accept;'));
  const torReturn = 'meta skuid 143 return';
  const loopExempt = 'ip daddr 127.0.0.0/8 return';
  const dnsRedirect = 'udp dport 53 redirect to :5353';
  const tcpRedirect = 'meta l4proto tcp redirect to :9040';
  for (const needle of [torReturn, loopExempt, dnsRedirect, tcpRedirect]) {
    assert.ok(nftables.includes(needle), `missing: ${needle}`);
  }
  // Loop prevention: Tor and loopback exemptions must precede both redirects.
  assert.ok(nftables.indexOf(torReturn) < nftables.indexOf(dnsRedirect));
  assert.ok(nftables.indexOf(torReturn) < nftables.indexOf(tcpRedirect));
  assert.ok(nftables.indexOf(loopExempt) < nftables.indexOf(tcpRedirect));
  // Filter table: IPv4-scoped DHCP exceptions, Tor IPv4 TCP egress, drop defaults.
  assert.ok(
    nftables.includes('meta skuid 106 meta nfproto ipv4 udp sport 68 udp dport 67 accept'),
  );
  assert.ok(
    nftables.includes('meta skuid 143 ip daddr != 127.0.0.0/8 meta l4proto tcp accept'),
  );
  assert.ok(nftables.includes('meta nfproto ipv4 udp sport 67 udp dport 68 accept'));
  // Input allows established IPv4 TCP replies only (relay return traffic);
  // exactly one ct rule, in the input chain, IPv4-and-TCP scoped.
  const establishedRule =
    'meta nfproto ipv4 ct state established meta l4proto tcp accept';
  assert.ok(nftables.includes(establishedRule));
  assert.equal(count(nftables, 'ct state established'), 1);
  // Post-DNAT accepts: the filter output chain accepts exactly the two
  // cases the nat output chain redirects — exact ct status dnat guard,
  // exact IPv4 destination 127.0.0.1 (not the loopback block), and exactly
  // the two Tor listener ports — placed after every other accept, right
  // before the chain's final drop.
  const dnatTcp = 'ct status dnat ip daddr 127.0.0.1 tcp dport 9040 accept';
  const dnatUdp = 'ct status dnat ip daddr 127.0.0.1 udp dport 5353 accept';
  const torEgress =
    'meta skuid 143 ip daddr != 127.0.0.0/8 meta l4proto tcp accept';
  const fromLastOutput = nftables.slice(nftables.lastIndexOf('chain output'));
  assert.ok(fromLastOutput.includes(dnatTcp), `missing: ${dnatTcp}`);
  assert.ok(fromLastOutput.includes(dnatUdp), `missing: ${dnatUdp}`);
  assert.equal(count(nftables, 'ct status dnat'), 2);
  assert.equal(count(nftables, 'tcp dport 9040'), 1);
  assert.equal(count(nftables, 'udp dport 5353'), 1);
  assert.equal(count(nftables, 'ip daddr 127.0.0.1 '), 2);
  assert.ok(fromLastOutput.indexOf('oifname "lo" accept') < fromLastOutput.indexOf(dnatTcp));
  assert.ok(fromLastOutput.indexOf('oifname "lo" accept') < fromLastOutput.indexOf(dnatUdp));
  assert.ok(fromLastOutput.indexOf(torEgress) < fromLastOutput.indexOf(dnatTcp));
  assert.ok(fromLastOutput.indexOf(torEgress) < fromLastOutput.indexOf(dnatUdp));
  // Never loosened: the accepts must not widen to the loopback block or
  // lose the dnat guard.
  assert.ok(!fromLastOutput.includes('127.0.0.0/8 accept'));
  // No established/ct-state exception in either output chain (nat +
  // filter): prior direct flows must not keep leaking after the policy
  // loads. `ct status dnat` above is a rewrite marker, not a state match,
  // and stays off this assertion.
  const natTable = nftables.slice(
    nftables.indexOf('table ip tor_guest_nat {'),
    nftables.indexOf('table inet tor_guest_filter {'),
  );
  assert.ok(!/ct state|established/.test(natTable));
  assert.ok(!/ct state|established/.test(fromLastOutput));
  assert.ok(nftables.includes('iifname "lo" accept'));
  assert.ok(nftables.includes('oifname "lo" accept'));
  assert.equal(count(nftables, 'policy drop;'), 3); // input, forward, output
});

test('nftables text has no flush, separate-command reload, LAN bypass or leak', () => {
  const { nftables } = generatePolicy({ torUid: 143, dhcpUid: 106 });
  assert.ok(!/flush (ruleset|table|chain)/i.test(nftables));
  // Reload guidance must not suggest deleting tables in separate shell
  // commands; it must point at a single atomic transaction instead.
  assert.ok(!/nft delete table/.test(nftables));
  assert.ok(nftables.includes('ONE atomic transaction'));
  assert.ok(!nftables.includes('torUid'));
  assert.ok(!nftables.includes('dhcpUid'));
  assert.ok(!nftables.includes('${'));
  // No RFC1918 exemptions anywhere (no LAN bypass).
  assert.ok(!/192\.168\.|10\.0\.0|172\.(1[6-9]|2[0-9]|3[01])\./.test(nftables));
});

test('torrc binds every listener to loopback and enables automap', () => {
  const { torrc } = generatePolicy({ torUid: 143, dhcpUid: 106 });
  for (const line of [
    'SocksPort 127.0.0.1:9050',
    'TransPort 127.0.0.1:9040',
    'DNSPort 127.0.0.1:5353',
    'AutomapHostsOnResolve 1',
    'VirtualAddrNetworkIPv4 10.192.0.0/10',
    'ExitPolicy reject *:*',
  ]) {
    assert.ok(torrc.includes(line), `missing: ${line}`);
  }
  assert.ok(!torrc.includes('0.0.0.0'));
});

test('uids are interpolated and output varies with input', () => {
  const a = generatePolicy({ torUid: 143, dhcpUid: 106 });
  const b = generatePolicy({ torUid: 999, dhcpUid: 1000 });
  assert.equal(a.torUid, 143);
  assert.equal(a.dhcpUid, 106);
  assert.notEqual(a.nftables, b.nftables);
  assert.ok(b.nftables.includes('meta skuid 999 return'));
  assert.ok(
    b.nftables.includes('meta skuid 1000 meta nfproto ipv4 udp sport 68 udp dport 67 accept'),
  );
});

test('LAN administrator opt-in allows only root SSH replies on wired/Wi-Fi RFC1918', () => {
  const normal = generatePolicy({ torUid: 105, dhcpUid: 998 }).nftables;
  const admin = generatePolicy({ torUid: 105, dhcpUid: 998, lanAdmin: true }).nftables;
  assert.equal(normal.includes('ct direction reply'), false);
  assert.match(admin, /meta skuid 0 ct direction reply tcp sport 22 ip daddr \{ 10\.0\.0\.0\/8, 172\.16\.0\.0\/12, 192\.168\.0\.0\/16 \} return/);
  assert.match(admin, /iifname \{ "eth0", "wlan0" \} ip saddr .* tcp dport 22 ct state \{ new, established \} accept/);
  assert.match(admin, /meta skuid 0 oifname \{ "eth0", "wlan0" \} ip daddr .* ct direction reply ct state established tcp sport 22 accept/);
  assert.equal(admin.includes('meta skuid 970 return'), false);
  assert.match(admin, /type filter hook forward priority filter; policy drop/);
  assert.throws(() => generatePolicy({ torUid: 105, dhcpUid: 998, lanAdmin: 'yes' }), TypeError);
});
