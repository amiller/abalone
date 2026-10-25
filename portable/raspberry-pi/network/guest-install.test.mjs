// Tests for the guest boot installer slice (guest-install.sh,
// tor-guest-load-nft.sh, units/). EXPLICIT LIMIT: everything here runs
// offline against fake trees and fake executors (fake nft, fake getent,
// fake systemctl, fake sysfs). No nft/tor/systemctl operation touches a real
// host or guest, no service is started or stopped, and passing these tests
// does NOT establish live enforcement — the cold-boot harness acceptance in
// README.md is still required. In particular: the fake nft only models the
// transaction semantics we rely on (single-file atomic apply, retained
// tables on failure); it proves nothing about real nftables, and the default
// systemd-analyze check verifies a STUB unit graph (a real staged guest root
// can be supplied via TOR_GUEST_VERIFY_ROOT for the real-graph check).
//
// The nft/torrc templates embedded in guest-install.sh are proven equal
// (modulo uid substitution) to the validated generate-policy.mjs output, so
// the installer cannot have weakened the pinned generator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePolicy } from './generate-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER = join(HERE, 'guest-install.sh');
const LOADER_SRC = join(HERE, 'tor-guest-load-nft.sh');
const FIREWALL_UNIT = join(HERE, 'units', 'tor-guest-firewall.service');
const TOR_UNIT = join(HERE, 'units', 'tor-guest.service');

const installerText = readFileSync(INSTALLER, 'utf8');
const loaderText = readFileSync(LOADER_SRC, 'utf8');
const firewallUnitText = readFileSync(FIREWALL_UNIT, 'utf8');
const torUnitText = readFileSync(TOR_UNIT, 'utf8');

const sh = (script, args, env) =>
  spawnSync('/bin/sh', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

// ---------------------------------------------------------------------------
// 1. The embedded templates are the validated generator's output.
// ---------------------------------------------------------------------------
function extractTemplate(marker) {
  const re = new RegExp(`cat <<'${marker}'\\n([\\s\\S]*?)\\n${marker}\\n`);
  const m = installerText.match(re);
  assert.ok(m, `template marker ${marker} not found in installer`);
  return `${m[1]}\n`;
}

test('installer nft template is generate-policy.mjs output modulo uids', () => {
  const generated = generatePolicy({ torUid: 1101, dhcpUid: 1102 }).nftables;
  const templated = generated
    .replaceAll('1101', '__TOR_UID__')
    .replaceAll('1102', '__DHCP_UID__');
  assert.equal(extractTemplate('NFT_TEMPLATE_EOF'), templated);
});

test('installer torrc template is generate-policy.mjs output modulo uids', () => {
  const generated = generatePolicy({ torUid: 1101, dhcpUid: 1102 }).torrc;
  const templated = generated
    .replaceAll('1101', '__TOR_UID__')
    .replaceAll('1102', '__DHCP_UID__');
  assert.equal(extractTemplate('TORRC_TEMPLATE_EOF'), templated);
});

// ---------------------------------------------------------------------------
// 2. Unit files: exact directives, no stop path, no network-online gating.
// ---------------------------------------------------------------------------
test('firewall unit carries the early, fail-closed directive set', () => {
  for (const line of [
    'DefaultDependencies=no',
    'Wants=network-pre.target',
    'After=systemd-sysusers.service systemd-modules-load.service',
    'Before=network-pre.target shutdown.target',
    'Conflicts=shutdown.target',
    'Type=oneshot',
    'ExecStart=/usr/local/sbin/tor-guest-load-nft',
    'RemainAfterExit=yes',
  ]) {
    assert.ok(firewallUnitText.includes(line), `missing: ${line}`);
  }
  assert.ok(!/^ExecStop/m.test(firewallUnitText));
  assert.ok(!/flush/i.test(firewallUnitText));
});

test('tor unit is firewall-gated, capability-free and waits on nothing', () => {
  for (const line of [
    'Requires=tor-guest-firewall.service',
    'After=tor-guest-firewall.service',
    'User=__TOR_USER__',
    'ExecStart=/usr/bin/tor -f /etc/tor-guest/torrc',
    'StateDirectory=tor-guest',
    'CapabilityBoundingSet=',
  ]) {
    assert.ok(torUnitText.includes(line), `missing: ${line}`);
  }
  assert.ok(!/^RestrictAddressFamilies=.*AF_PACKET/m.test(torUnitText));
  assert.ok(!/^After=.*network-online/m.test(torUnitText));
  assert.ok(!/^Wants=.*network-online/m.test(torUnitText));
  assert.ok(!/^WantedBy=.*network-online/m.test(torUnitText));
  assert.ok(!/^\s*ntp/i.test(torUnitText));
  assert.ok(!/^ExecStop/m.test(torUnitText));
});

test('installer grants no capabilities and assumes no default uids', () => {
  // No numeric uid defaults anywhere (the observed bookworm values 104/998
  // must never be baked in; identities are resolved from the target).
  for (const forbidden of [
    /tor_uid=104\b/,
    /dhcp_uid=998\b/,
    /TOR_ACCOUNT=\d/,
    /DHCP_ACCOUNT=\d/,
  ]) {
    assert.ok(!forbidden.test(installerText), `hardcoded identity: ${forbidden}`);
  }
  // The gating drop-in is Requires+After, and the workspace is never given a
  // network-online or Tor bootstrap wait.
  const dropin = installerText.match(/write_gating_dropin[\s\S]*?^}/m)[0];
  assert.ok(dropin.includes('Requires=tor-guest-firewall.service'));
  assert.ok(dropin.includes('After=tor-guest-firewall.service'));
  assert.ok(!/network-online/.test(dropin));
  assert.ok(!installerText.includes('setcap'));
  assert.ok(!/sudoers/.test(installerText));
  // Migration set: NetworkManager images, dhcpcd, stock tor, and the stock
  // nftables.service (whose ExecStop flushes the whole ruleset).
  for (const u of [
    'NetworkManager.service',
    'dhcpcd.service',
    'tor.service',
    'nftables.service',
  ]) {
    assert.ok(installerText.includes(u), `migration set missing ${u}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Loader behavior with a fake nft executor and fake getent.
// ---------------------------------------------------------------------------
const FAKE_NFT = `#!/bin/sh
# fake nft: table membership state in $FAKE_NFT_STATE ("fam tbl" per line),
# argv log in $FAKE_NFT_LOG, last applied file copied to $FAKE_NFT_LAST_TX.
# Files containing "# INVALID" fail both -c and -f. Files containing
# "# APPLY-FAIL" pass -c but fail the -f apply, leaving state unchanged.
set -eu
log=\${FAKE_NFT_LOG:?}; st=\${FAKE_NFT_STATE:?}
printf '%s\\n' "$*" >>"$log"
case "\${1-}" in
  list)
    [ "$#" -eq 4 ] || exit 2
    if grep -qxF "$3 $4" "$st" 2>/dev/null; then exit 0; else exit 1; fi
    ;;
  -c|-f)
    file=''
    for a in "$@"; do file=$a; done
    if grep -q '# INVALID' "$file"; then
      echo "fake-nft: syntax error in $file" >&2; exit 1
    fi
    [ "$1" = -c ] && exit 0
    if grep -q '# APPLY-FAIL' "$file"; then
      echo "fake-nft: apply refused" >&2; exit 1
    fi
    if awk -v st="$st" '
        /^delete table / { del[$3" "$4]=1; next }
        /^table /        { keep[$2" "$3]=1; next }
        END {
          while ((getline l < st) > 0) {
            split(l, p, " ")
            if (!((p[1]" "p[2]) in del)) print p[1]" "p[2] > st".new"
          }
          for (k in keep) print k > st".new"
        }' "$file"; then mv "$st.new" "$st"; else exit 1; fi
    if [ -n "\${FAKE_NFT_LAST_TX:-}" ]; then cp "$file" "$FAKE_NFT_LAST_TX"; fi
    exit 0
    ;;
  *) echo "fake-nft: unsupported: $*" >&2; exit 2 ;;
esac
`;

const FAKE_GETENT = `#!/bin/sh
set -eu
[ "$#" -eq 2 ] || exit 2
[ "$1" = passwd ] || exit 2
entry=$(awk -F: -v n="$2" '$1 == n { print; exit }' "\${FAKE_PASSWD:?}") || exit 2
[ -n "$entry" ] || exit 2
printf '%s\\n' "$entry"
`;

// fake systemctl: only `show <unit> --property=User --value` is supported,
// answering from FAKE_NETWORKD_USER (empty string = no User=, i.e. root).
const FAKE_SYSTEMCTL = `#!/bin/sh
set -eu
if [ "\${1-}" = show ]; then
  printf '%s\\n' "\${FAKE_NETWORKD_USER-}"
  exit 0
fi
echo "fake-systemctl: unsupported: $*" >&2
exit 2
`;

function makeLoaderFixture(t, opts = {}) {
  const {
    torUid = 143,
    dhcpUid = 106,
    torAccount = 'debian-tor',
    dhcpAccount = 'systemd-network',
    torUidInPasswd = null, // defaults to torUid
    dhcpUidInPasswd = null, // defaults to dhcpUid
    uidsFileOverride = null,
    appendToRules = '',
    iface = 'eth0',
    ifaceType = '1',
    ifaceSysfs = '1', // value in the fake sysfs; null = no sysfs entry at all
    effectiveNetworkdUser = null, // defaults to dhcpAccount
  } = opts;
  const dir = mkdtempSync(join(tmpdir(), 'tor-guest-loader-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const confDir = join(dir, 'conf');
  const binDir = join(dir, 'bin');
  const sysNet = join(dir, 'sysnet');
  mkdirSync(confDir);
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'nft'), FAKE_NFT);
  writeFileSync(join(binDir, 'getent'), FAKE_GETENT);
  writeFileSync(join(binDir, 'systemctl'), FAKE_SYSTEMCTL);
  chmodSync(join(binDir, 'nft'), 0o755);
  chmodSync(join(binDir, 'getent'), 0o755);
  chmodSync(join(binDir, 'systemctl'), 0o755);
  if (ifaceSysfs !== null) {
    mkdirSync(join(sysNet, iface), { recursive: true });
    writeFileSync(join(sysNet, iface, 'type'), `${ifaceSysfs}\n`);
  }

  const rules =
    generatePolicy({ torUid, dhcpUid }).nftables + appendToRules;
  writeFileSync(join(confDir, 'tor-guest.nft'), rules);
  const hash = createHash('sha256').update(rules).digest('hex');
  writeFileSync(join(confDir, 'tor-guest.nft.sha256'), `${hash}  tor-guest.nft\n`);
  const uids =
    uidsFileOverride ??
    `tor_account=${torAccount}\ntor_uid=${torUid}\ndhcp_account=${dhcpAccount}\ndhcp_uid=${dhcpUid}\niface=${iface}\niface_type=${ifaceType}\n`;
  writeFileSync(join(confDir, 'uids'), uids);

  const passwdPath = join(dir, 'passwd');
  const tu = torUidInPasswd ?? torUid;
  const du = dhcpUidInPasswd ?? dhcpUid;
  writeFileSync(
    passwdPath,
    `root:x:0:0:root:/root:/bin/sh\n` +
      `${torAccount}:x:${tu}:${tu}:tor:/var/lib/tor:/usr/sbin/nologin\n` +
      `${dhcpAccount}:x:${du}:${du}:net:/:/usr/sbin/nologin\n` +
      `agent:x:1000:1000:agent:/home/agent:/bin/sh\n`,
  );

  const logPath = join(dir, 'nft.log');
  const statePath = join(dir, 'nft.state');
  const lastTxPath = join(dir, 'last-tx');
  writeFileSync(statePath, '');
  const env = {
    PATH: `${binDir}:${process.env.PATH}`,
    TOR_GUEST_CONF_DIR: confDir,
    TOR_GUEST_SYS_CLASS_NET: sysNet,
    TMPDIR: dir,
    FAKE_NFT_LOG: logPath,
    FAKE_NFT_STATE: statePath,
    FAKE_NFT_LAST_TX: lastTxPath,
    FAKE_PASSWD: passwdPath,
    FAKE_NETWORKD_USER: effectiveNetworkdUser ?? dhcpAccount,
  };
  return { dir, confDir, env, logPath, statePath, lastTxPath };
}

const readLog = (p) =>
  existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
const appliedCalls = (lines) => lines.filter((l) => l.startsWith('-f '));

test('loader first load: one atomic transaction, no deletes, no flush', (t) => {
  const f = makeLoaderFixture(t);
  const r = sh(LOADER_SRC, [], f.env);
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const calls = readLog(f.logPath);
  // exactly one apply; the syntax check precedes it
  const applies = appliedCalls(calls);
  assert.equal(applies.length, 1);
  assert.ok(calls.findIndex((c) => c.startsWith('-c ')) < calls.indexOf(applies[0]));
  // no delete lines on a virgin system, no flush anywhere
  const tx = readFileSync(f.lastTxPath, 'utf8');
  assert.ok(!/^delete table /m.test(tx));
  assert.ok(calls.every((c) => !/flush/.test(c)));
  assert.equal(readLog(f.statePath).sort().join('\n'), ['inet tor_guest_filter', 'ip tor_guest_nat'].sort().join('\n'));
  assert.match(r.stdout, /loaded owned tables/);
});

test('loader reload: deletes and definitions inside ONE nft -f file', (t) => {
  const f = makeLoaderFixture(t);
  assert.equal(sh(LOADER_SRC, [], f.env).status, 0);
  const log2 = f.logPath;
  rmSync(log2); // fresh log for the second run
  const r = sh(LOADER_SRC, [], f.env);
  assert.equal(r.status, 0, r.stderr);
  const calls = readLog(log2);
  const applies = appliedCalls(calls);
  assert.equal(applies.length, 1, 'reload must be a single transaction');
  assert.ok(calls.some((c) => c === 'list table ip tor_guest_nat'));
  assert.ok(calls.some((c) => c === 'list table inet tor_guest_filter'));
  // The single -f file carries the deletes for ONLY the owned tables,
  // immediately followed by the full ruleset (atomic replace).
  const tx = readFileSync(f.lastTxPath, 'utf8');
  const deletes = tx.match(/^delete table .*$/gm) ?? [];
  assert.deepEqual(deletes.sort(), ['delete table inet tor_guest_filter', 'delete table ip tor_guest_nat']);
  assert.ok(tx.indexOf('delete table ip tor_guest_nat') < tx.indexOf('table ip tor_guest_nat {'));
  assert.ok(tx.indexOf('delete table inet tor_guest_filter') < tx.indexOf('table inet tor_guest_filter {'));
  assert.ok(tx.includes('meta skuid 143 return'));
  // no flush COMMAND anywhere in the transaction (comments explain, not act)
  assert.ok(!/^\s*(nft\s+)?flush\b/m.test(tx));
  assert.match(r.stdout, /atomically replaced/);
});

test('loader has no stop path: no flush, no standalone delete, no ExecStop', () => {
  // comments may explain the prohibitions; the executable lines may not
  // contain them
  const code = loaderText
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
  assert.ok(!/nft\s+flush|flush\s+(ruleset|table|chain)/.test(code));
  // the only nft invocations are the probe, the check and the one apply
  assert.ok(!/^nft (delete|flush|add)/m.test(code));
  assert.ok(code.includes('trap \'rm -f "$TX_FILE"\''));
  assert.ok(!/^ExecStop/m.test(firewallUnitText));
});

test('invalid rules are retained: -c failure aborts before any apply', (t) => {
  const f = makeLoaderFixture(t, { appendToRules: '# INVALID marker\n' });
  // seed the "running" tables first, with a valid config
  const seed = makeLoaderFixture(t);
  assert.equal(sh(LOADER_SRC, [], seed.env).status, 0);
  cpState(seed.statePath, f.statePath);
  const before = readFileSync(f.statePath, 'utf8');
  const r = sh(LOADER_SRC, [], f.env);
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /syntax check failed/);
  assert.equal(appliedCalls(readLog(f.logPath)).length, 0);
  assert.equal(readFileSync(f.statePath, 'utf8'), before);
});

test('failed apply transaction retains the previously loaded tables', (t) => {
  const f = makeLoaderFixture(t, { appendToRules: '# APPLY-FAIL marker\n' });
  const seed = makeLoaderFixture(t);
  assert.equal(sh(LOADER_SRC, [], seed.env).status, 0);
  cpState(seed.statePath, f.statePath);
  const before = readFileSync(f.statePath, 'utf8');
  const r = sh(LOADER_SRC, [], f.env);
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /tables retained/);
  assert.equal(appliedCalls(readLog(f.logPath)).length, 1);
  assert.equal(readFileSync(f.statePath, 'utf8'), before);
});

test('uid drift after install fails closed before any nft apply', (t) => {
  const f = makeLoaderFixture(t, { torUidInPasswd: 999 });
  const r = sh(LOADER_SRC, [], f.env);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /uid mismatch.*expects 143/);
  assert.equal(readLog(f.logPath).length, 0);
  const f2 = makeLoaderFixture(t, { dhcpUidInPasswd: 42 });
  const r2 = sh(LOADER_SRC, [], f2.env);
  assert.equal(r2.status, 3, r2.stderr);
  assert.equal(readLog(f2.logPath).length, 0);
});

test('guarded boot: uplink must exist with type 1 and the effective networkd owner must match, before any nft call', (t) => {
  // uplink missing from live sysfs (the offline attestation was wrong)
  const f = makeLoaderFixture(t, { ifaceSysfs: null });
  const r = sh(LOADER_SRC, [], f.env);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /uplink eth0 not present in .*sysnet.*before any networking/);
  assert.equal(readLog(f.logPath).length, 0, 'no nft call may happen');
  // uplink present but not plain ethernet
  const f2 = makeLoaderFixture(t, { ifaceSysfs: '771' });
  const r2 = sh(LOADER_SRC, [], f2.env);
  assert.equal(r2.status, 3, r2.stderr);
  assert.match(r2.stderr, /type '771', not 1/);
  assert.equal(readLog(f2.logPath).length, 0);
  // effective networkd owner drifted (e.g. a drop-in added after install)
  const f3 = makeLoaderFixture(t, { effectiveNetworkdUser: 'rogue' });
  const r3 = sh(LOADER_SRC, [], f3.env);
  assert.equal(r3.status, 3, r3.stderr);
  assert.match(r3.stderr, /effective systemd-networkd User='rogue' != recorded dhcp account 'systemd-network'/);
  assert.equal(readLog(f3.logPath).length, 0);
  // empty effective owner (no User= anywhere) means root: also refused
  const f4 = makeLoaderFixture(t, { effectiveNetworkdUser: '' });
  const r4 = sh(LOADER_SRC, [], f4.env);
  assert.equal(r4.status, 3, r4.stderr);
  assert.match(r4.stderr, /User='root' != recorded dhcp account/);
  assert.equal(readLog(f4.logPath).length, 0);
  // consistent state reaches the single atomic apply
  const f5 = makeLoaderFixture(t);
  const r5 = sh(LOADER_SRC, [], f5.env);
  assert.equal(r5.status, 0, r5.stderr);
  assert.equal(appliedCalls(readLog(f5.logPath)).length, 1);
});

test('ruleset/uids disagreement and missing or tampered config refuse', (t) => {
  // uids file edited to a uid the ruleset does not carry
  const f = makeLoaderFixture(t, {
    uidsFileOverride: 'tor_account=debian-tor\ntor_uid=777\ndhcp_account=systemd-network\ndhcp_uid=106\n',
  });
  const r = sh(LOADER_SRC, [], f.env);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /does not exempt tor uid 777/);
  // tampered ruleset (hash mismatch) — no nft invocation at all
  const f2 = makeLoaderFixture(t);
  writeFileSync(join(f2.confDir, 'tor-guest.nft'), generatePolicy({ torUid: 143, dhcpUid: 106 }).nftables + '\n# extra\n');
  const r2 = sh(LOADER_SRC, [], f2.env);
  assert.equal(r2.status, 2, r2.stderr);
  assert.match(r2.stderr, /hash mismatch/);
  assert.equal(readLog(f2.logPath).length, 0);
  // missing identities file
  const f3 = makeLoaderFixture(t);
  rmSync(join(f3.confDir, 'uids'));
  const r3 = sh(LOADER_SRC, [], f3.env);
  assert.equal(r3.status, 1, r3.stderr);
  assert.match(r3.stderr, /missing config/);
});

function cpState(from, to) {
  writeFileSync(to, readFileSync(from, 'utf8'));
}

// ---------------------------------------------------------------------------
// 4. Installer end-to-end into a fake offline guest tree.
// ---------------------------------------------------------------------------
function makeFakeRoot(t, opts = {}) {
  const {
    torUid = 143,
    dhcpUid = 106,
    networkdUser = 'systemd-network',
    includeResolved = true,
    workspaceUnit = 'abalone-workspace.service',
    includeNM = true,
    includeNftables = true,
    includeStockTor = true,
    cloud = true,
    firstrun = false,
    iface = 'eth0',
    sysfs = '1', // value for sys/class/net/<iface>/type; null = no sysfs (mounted image)
    resolv = 'nm', // 'nm' | 'stub' | 'file' | 'none'
    networkdDropins = [], // [{ name, text }] under etc/systemd/system/systemd-networkd.service.d/
    extraPasswd = [],
    dropTorAccount = false,
  } = opts;
  const root = mkdtempSync(join(tmpdir(), 'tor-guest-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mk = (...p) => {
    mkdirSync(join(root, ...p), { recursive: true });
    return join(root, ...p);
  };
  const unit = (dir, name, text) => writeFileSync(join(mk(...dir), name), text);
  const stubUnit = (name) =>
    `[Unit]\nDescription=${name} stub\n\n[Service]\nExecStart=/bin/true\n\n[Install]\nWantedBy=multi-user.target\n`;
  const installUnit = '[Install]\nWantedBy=multi-user.target\n';

  mk('etc', 'systemd', 'system');
  mk('usr', 'lib', 'systemd', 'system');
  mk('usr', 'bin');
  mk('usr', 'sbin');
  mk('boot');
  if (sysfs !== null) writeFileSync(join(mk('sys', 'class', 'net', iface), 'type'), `${sysfs}\n`);
  if (resolv === 'nm') {
    symlinkSync('/run/NetworkManager/resolv.conf', join(root, 'etc', 'resolv.conf'));
  } else if (resolv === 'stub') {
    symlinkSync('/run/systemd/resolve/stub-resolv.conf', join(root, 'etc', 'resolv.conf'));
  } else if (resolv === 'file') {
    writeFileSync(join(root, 'etc', 'resolv.conf'), 'nameserver 10.0.0.1\n');
  }
  for (const { name, text } of networkdDropins) {
    writeFileSync(join(mk('etc', 'systemd', 'system', 'systemd-networkd.service.d'), name), text);
  }
  if (firstrun) writeFileSync(join(root, 'boot', 'firstrun.sh'), '#!/bin/sh\n');
  if (cloud) mk('etc', 'cloud', 'cloud.cfg.d');

  const passwdLines = [
    'root:x:0:0:root:/root:/bin/sh',
    dropTorAccount ? null : `debian-tor:x:${torUid}:${torUid}:tor:/var/lib/tor:/usr/sbin/nologin`,
    networkdUser && networkdUser !== 'root'
      ? `${networkdUser}:x:${dhcpUid}:${dhcpUid}:net:/:/usr/sbin/nologin`
      : null,
    ...extraPasswd,
    'agent:x:1000:1000:agent:/home/agent:/bin/sh',
  ].filter(Boolean);
  writeFileSync(join(root, 'etc', 'passwd'), `${passwdLines.join('\n')}\n`);

  if (networkdUser) {
    writeFileSync(
      join(root, 'usr', 'lib', 'systemd', 'system', 'systemd-networkd.service'),
      `[Unit]\nDescription=stub networkd\n\n[Service]\nUser=${networkdUser}\nExecStart=/bin/true\n\n${installUnit}\n`,
    );
  } else {
    writeFileSync(
      join(root, 'usr', 'lib', 'systemd', 'system', 'systemd-networkd.service'),
      `[Unit]\nDescription=stub networkd\n\n[Service]\nExecStart=/bin/true\n\n${installUnit}\n`,
    );
  }
  if (includeResolved)
    unit(['usr', 'lib', 'systemd', 'system'], 'systemd-resolved.service', stubUnit('systemd-resolved.service'));
  if (includeNM) {
    unit(['usr', 'lib', 'systemd', 'system'], 'NetworkManager.service', stubUnit('NetworkManager.service'));
    unit(['usr', 'lib', 'systemd', 'system'], 'NetworkManager-wait-online.service', stubUnit('NetworkManager-wait-online.service'));
  }
  if (includeNftables)
    unit(['usr', 'lib', 'systemd', 'system'], 'nftables.service', stubUnit('nftables.service'));
  if (includeStockTor)
    unit(['usr', 'lib', 'systemd', 'system'], 'tor.service', stubUnit('tor.service'));
  if (workspaceUnit)
    unit(['usr', 'lib', 'systemd', 'system'], workspaceUnit, stubUnit(workspaceUnit));

  writeFileSync(join(root, 'usr', 'bin', 'tor'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'usr', 'bin', 'tor'), 0o755);
  writeFileSync(join(root, 'usr', 'sbin', 'nft'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'usr', 'sbin', 'nft'), 0o755);
  return root;
}

const runInstaller = (root, args) =>
  sh(INSTALLER, ['--root', root, ...args]);

test('installer builds the full stack in a mounted offline image (no sysfs, attested interface)', async (t) => {
  // a mounted/staged image has an EMPTY /sys: the interface can only be
  // attested offline (explicit reviewed metadata) and is validated against
  // the real sysfs by the loader on every guarded boot
  const root = makeFakeRoot(t, { sysfs: null }); // tor uid 143 / networkd uid 106 — NOT 104/998
  const r = runInstaller(root, [
    '--interface', 'eth0', '--yes-disposable', '--interface-type', '1',
    '--workspace-unit', 'abalone-workspace.service',
  ]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /tor  : debian-tor  uid 143/);
  assert.match(r.stdout, /dhcp : systemd-network  uid 106/);
  assert.match(r.stdout, /ATTESTED offline/);

  const conf = join(root, 'etc', 'tor-guest');
  const nft = readFileSync(join(conf, 'tor-guest.nft'), 'utf8');
  assert.ok(nft.includes('meta skuid 143 return'));
  assert.ok(nft.includes('meta skuid 106 meta nfproto ipv4 udp sport 68 udp dport 67 accept'));
  assert.ok(!nft.includes('__TOR_UID__') && !nft.includes('__DHCP_UID__'));
  assert.ok(!/\b(104|998)\b/.test(nft), 'must not embed assumed default uids');
  assert.ok(!/flush (ruleset|table|chain)/.test(nft));

  const torrc = readFileSync(join(conf, 'torrc'), 'utf8');
  assert.ok(torrc.includes('ExitPolicy reject *:*'));
  assert.ok(torrc.includes('DataDirectory /var/lib/tor-guest'));
  assert.ok(torrc.includes('Log notice stdout'));
  // the appended tail must not override or weaken the generated policy
  const tail = torrc.slice(torrc.indexOf('Appended by guest-install.sh'));
  for (const banned of ['Port ', 'ExitPolicy', 'Address', 'Bridge', 'Socks', 'VirtualAddr']) {
    assert.ok(!tail.includes(banned), `appended torrc tail must not set ${banned}`);
  }

  const uids = readFileSync(join(conf, 'uids'), 'utf8');
  assert.equal(
    uids,
    '# tor-guest resolved identities (install-time; re-verified by the\n' +
      '# loader on every boot; mismatch refuses to load)\n' +
      'tor_account=debian-tor\ntor_uid=143\ndhcp_account=systemd-network\ndhcp_uid=106\n' +
      'iface=eth0\niface_type=1\n',
  );
  // hash sidecars verify
  const sum = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
  assert.match(readFileSync(join(conf, 'tor-guest.nft.sha256'), 'utf8'), new RegExp(`^${sum(join(conf, 'tor-guest.nft'))}  tor-guest\\.nft$`, 'm'));
  assert.match(readFileSync(join(conf, 'torrc.sha256'), 'utf8'), new RegExp(`^${sum(join(conf, 'torrc'))}  torrc$`, 'm'));

  // loader + units installed; tor unit account substituted
  const loaderDst = join(root, 'usr', 'local', 'sbin', 'tor-guest-load-nft');
  assert.ok(existsSync(loaderDst));
  assert.equal(readFileSync(loaderDst, 'utf8'), loaderText);
  const fwUnitDst = readFileSync(join(root, 'etc', 'systemd', 'system', 'tor-guest-firewall.service'), 'utf8');
  assert.equal(fwUnitDst, firewallUnitText);
  const torUnitDst = readFileSync(join(root, 'etc', 'systemd', 'system', 'tor-guest.service'), 'utf8');
  assert.ok(torUnitDst.includes('User=debian-tor'));
  assert.ok(!torUnitDst.includes('__TOR_USER__'));

  // explicit Requires/After drop-ins on every gated consumer
  const dropin = (u) =>
    readFileSync(join(root, 'etc', 'systemd', 'system', `${u}.d`, '20-tor-guest-firewall.conf'), 'utf8');
  for (const u of ['systemd-networkd.service', 'systemd-resolved.service', 'abalone-workspace.service']) {
    assert.ok(dropin(u).includes('Requires=tor-guest-firewall.service'), `${u} drop-in missing Requires=`);
    assert.ok(dropin(u).includes('After=tor-guest-firewall.service'), `${u} drop-in missing After=`);
    assert.ok(!/network-online/.test(dropin(u)));
  }

  // deterministic single-interface networkd config; precedence enforced by
  // refusal/retirement, not by hoping 10- wins
  const network = readFileSync(join(root, 'etc', 'systemd', 'network', '10-tor-guest-uplink.network'), 'utf8');
  assert.ok(network.includes('Name=eth0'));
  assert.ok(network.includes('REFUSED (or retired)'), 'network file must state the enforced precedence');
  for (const line of ['DHCP=ipv4', 'IPv6AcceptRA=no', 'LinkLocalAddressing=no', 'LLDP=no', 'LLMNR=no', 'MulticastDNS=no']) {
    assert.ok(network.includes(line), `network file missing ${line}`);
  }

  // migration: masked to /dev/null, cloud-init network regen disabled
  const systemDir = join(root, 'etc', 'systemd', 'system');
  for (const u of ['NetworkManager.service', 'NetworkManager-wait-online.service', 'tor.service', 'nftables.service']) {
    assert.equal(readlinkSync(join(systemDir, u)), '/dev/null', `${u} not masked`);
  }
  const cloudCfg = join(root, 'etc', 'cloud', 'cloud.cfg.d', '99-tor-guest-disable-network-config.cfg');
  assert.ok(readFileSync(cloudCfg, 'utf8').includes('network: {config: disabled}'));

  // resolver: resolved is present in this image — enabled, gated, and the
  // dead NM resolv.conf is retired (moved, recorded) and replaced by the stub
  assert.equal(readlinkSync(join(root, 'etc', 'resolv.conf')), '/run/systemd/resolve/stub-resolv.conf');
  const manifest = readFileSync(join(root, 'etc', 'tor-guest', 'retired-network.txt'), 'utf8');
  assert.match(
    manifest,
    /^symlink->\/run\/NetworkManager\/resolv\.conf  resolver-replacement  etc\/resolv\.conf$/m,
  );
  assert.ok(
    lstatSync(join(root, 'var', 'lib', 'tor-guest', 'retired-network', 'etc', 'resolv.conf')).isSymbolicLink(),
    'retired NM resolv.conf must be preserved (moved, not deleted)',
  );

  // enabled for next boot; nothing was started (offline tree). The wants
  // entries are symlinks with tree-absolute targets (valid inside the
  // guest tree, not on this host), so assert on the link, not its target.
  const wants = join(systemDir, 'multi-user.target.wants');
  for (const u of ['systemd-networkd.service', 'systemd-resolved.service', 'tor-guest-firewall.service', 'tor-guest.service']) {
    assert.ok(lstatSync(join(wants, u), { throwIfNoEntry: false })?.isSymbolicLink(), `${u} not enabled`);
  }
});

test('installer refuses every unconfirmed, mismatched or regenerating target', async (t) => {
  const expectRefusal = (root, args, re) => {
    const r = runInstaller(root, args);
    assert.notEqual(r.status, 0, `expected refusal for ${args.join(' ')}`);
    assert.match(r.stderr, re);
  };

  const base = makeFakeRoot(t);
  expectRefusal(base, ['--interface', 'eth0'], /--yes-disposable/);
  assert.ok(!existsSync(join(base, 'etc', 'tor-guest')), 'refusal must not write anything');
  expectRefusal(base, ['--interface', 'lo', '--yes-disposable'], /refusing --interface lo/);
  expectRefusal(base, ['--interface', 'wlan9', '--yes-disposable'], /carries no sysfs for wlan9.*--interface-type/);

  const nonEther = makeFakeRoot(t, { sysfs: '771' });
  expectRefusal(nonEther, ['--interface', 'eth0', '--yes-disposable'], /type 771, not 1/);

  const asRoot = makeFakeRoot(t, { networkdUser: null }); // no User= line -> root
  expectRefusal(asRoot, ['--interface', 'eth0', '--yes-disposable'], /as root \(effective User=root\)/);

  const noTor = makeFakeRoot(t, { dropTorAccount: true });
  expectRefusal(noTor, ['--interface', 'eth0', '--yes-disposable'], /not in .*passwd|uid invalid/);

  const ws = makeFakeRoot(t, { workspaceUnit: null });
  expectRefusal(ws, ['--interface', 'eth0', '--yes-disposable', '--workspace-unit', 'nope.service'], /workspace unit nope\.service not found/);

  const first = makeFakeRoot(t, { firstrun: true });
  expectRefusal(first, ['--interface', 'eth0', '--yes-disposable'], /firstrun\.sh present/);

  const noNft = makeFakeRoot(t);
  rmSync(join(noNft, 'usr', 'sbin', 'nft'));
  expectRefusal(noNft, ['--interface', 'eth0', '--yes-disposable'], /nft binary not found/);
});

// ---------------------------------------------------------------------------
// 4b. Offline interface attestation, precedence enforcement, effective owner,
//     resolver path (all against offline fake trees; no sysfs faking of the
//     host, no live anything).
// ---------------------------------------------------------------------------
const STD_ARGS = ['--interface', 'eth0', '--yes-disposable'];

function writeNetFile(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

test('offline image without sysfs: interface requires explicit reviewed metadata, recorded for boot validation', async (t) => {
  const root = makeFakeRoot(t, { sysfs: null });
  // no metadata -> refuse before writing anything
  const r0 = runInstaller(root, STD_ARGS);
  assert.notEqual(r0.status, 0);
  assert.match(r0.stderr, /carries no sysfs for eth0.*pass --interface-type 1/);
  assert.ok(!existsSync(join(root, 'etc', 'tor-guest')));
  // only ARPHRD_ETHER is accepted
  const r1 = runInstaller(root, [...STD_ARGS, '--interface-type', '6']);
  assert.notEqual(r1.status, 0);
  assert.match(r1.stderr, /--interface-type must be 1/);
  // attested metadata -> success, recorded, and the boot re-validation is
  // the loader's job (tested in the loader section)
  const r = runInstaller(root, [...STD_ARGS, '--interface-type', '1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ATTESTED offline.*re-validates/);
  const uids = readFileSync(join(root, 'etc', 'tor-guest', 'uids'), 'utf8');
  assert.match(uids, /\niface=eth0\niface_type=1\n$/);
});

test('staged sysfs information is verified when present', async (t) => {
  const ok = makeFakeRoot(t, { sysfs: '1' });
  assert.equal(runInstaller(ok, STD_ARGS).status, 0);
  const bad = makeFakeRoot(t, { sysfs: '771' });
  assert.match(runInstaller(bad, STD_ARGS).stderr, /staged tree says interface eth0 has type 771/);
});

test('networkd config precedence: earlier matching config is refused in every dir, or explicitly retired', async (t) => {
  const cases = [
    { rel: 'etc/systemd/network/05-lan.network', text: '[Match]\nName=eth0\n\n[Network]\nDHCP=yes\n' },
    { rel: 'etc/systemd/network/05-any.network', text: '[Network]\nDHCP=yes\n' }, // no [Match] -> match-all
    { rel: 'usr/lib/systemd/network/01-wild.network', text: '[Match]\nName=eth*\n\n[Network]\nDHCP=yes\n' },
    { rel: 'run/systemd/network/00-runtime.network', text: '[Match]\nName=eth0,en*\n\n[Network]\nDHCP=yes\n' },
    { rel: 'etc/systemd/network/73-usb-net-by-mac.link', text: '[Match]\nOriginalName=*\n\n[Link]\nNamePolicy=mac\n' },
    { rel: 'etc/systemd/network/20-rename.link', text: '[Match]\nName=eth0\n\n[Link]\nName=uplink0\n' },
    { rel: 'etc/systemd/network/20-claim.netdev', text: '[NetDev]\nName=eth0\nKind=dummy\n' },
  ];
  for (const c of cases) {
    const base = `--interface eth0 conflict ${c.rel}`;
    // default: refusal, naming the file, before any mutation
    const root = makeFakeRoot(t, { resolv: 'stub' });
    writeNetFile(root, c.rel, c.text);
    const r = runInstaller(root, STD_ARGS);
    assert.notEqual(r.status, 0, base);
    assert.match(r.stderr, /refusing: existing networkd config/, base);
    assert.ok(`${r.stdout}${r.stderr}`.includes(c.rel), `${base}: refusal must name the file`);
    // explicit retirement: moved (never deleted), recorded, install proceeds
    const root2 = makeFakeRoot(t, { resolv: 'stub' });
    writeNetFile(root2, c.rel, c.text);
    const before = readFileSync(join(root2, c.rel), 'utf8');
    const r2 = runInstaller(root2, [...STD_ARGS, '--retire-network-conflicts']);
    assert.equal(r2.status, 0, `${base}: ${r2.stderr}`);
    assert.ok(!existsSync(join(root2, c.rel)), `${base}: conflict must be gone from its dir`);
    const retired = join(root2, 'var', 'lib', 'tor-guest', 'retired-network', c.rel);
    assert.equal(readFileSync(retired, 'utf8'), before, `${base}: retired file must be preserved byte-for-byte`);
    const manifest = readFileSync(join(root2, 'etc', 'tor-guest', 'retired-network.txt'), 'utf8');
    assert.match(manifest, new RegExp(`^[0-9a-f]{64}  network-conflict  ${c.rel.replaceAll('/', '/')}$`, 'm'), base);
  }
});

test('non-conflicting networkd config is left in place (later, non-matching, or name-preserving)', async (t) => {
  const root = makeFakeRoot(t, { resolv: 'stub' });
  // later-sorting and non-matching: can never win (first lexical match wins)
  writeNetFile(root, 'usr/lib/systemd/network/80-vm-virtio.network', '[Match]\nName=virtio\n\n[Network]\nDHCP=yes\n');
  writeNetFile(root, 'usr/lib/systemd/network/90-late.network', '[Match]\nName=eth0\n\n[Network]\nDHCP=yes\n');
  // matches the uplink but demonstrably keeps the name (first policy 'keep')
  writeNetFile(
    root,
    'usr/lib/systemd/network/99-default.link',
    '[Match]\nOriginalName=*\n\n[Link]\nNamePolicy=keep kernel database onboard slot path\nMACPolicy=persistent\n',
  );
  const r = runInstaller(root, STD_ARGS);
  assert.equal(r.status, 0, r.stderr);
  for (const rel of [
    'usr/lib/systemd/network/80-vm-virtio.network',
    'usr/lib/systemd/network/90-late.network',
    'usr/lib/systemd/network/99-default.link',
  ]) {
    assert.ok(existsSync(join(root, rel)), `${rel} must not be touched`);
  }
  assert.ok(!existsSync(join(root, 'etc', 'tor-guest', 'retired-network.txt')), 'nothing may be retired');
});

test('effective networkd owner spans unit + drop-ins; --dhcp-account cannot bypass it', async (t) => {
  const netdhcp = 'netdhcp:x:150:150:net:/:/usr/sbin/nologin';
  const dropin = { name: '10-user.conf', text: '[Service]\nUser=netdhcp\n' };
  // inferred = effective value across the drop-in
  const root = makeFakeRoot(t, { networkdDropins: [dropin], extraPasswd: [netdhcp] });
  const r = runInstaller(root, STD_ARGS);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dhcp : netdhcp  uid 150  \(effective systemd-networkd owner/);
  assert.match(readFileSync(join(root, 'etc', 'tor-guest', 'uids'), 'utf8'), /dhcp_account=netdhcp\ndhcp_uid=150\n/);
  const nft = readFileSync(join(root, 'etc', 'tor-guest', 'tor-guest.nft'), 'utf8');
  assert.ok(nft.includes('meta skuid 150 meta nfproto ipv4 udp sport 68 udp dport 67 accept'));
  // explicit account that is NOT the effective owner: refused
  const root2 = makeFakeRoot(t, { networkdDropins: [dropin], extraPasswd: [netdhcp] });
  const rb = runInstaller(root2, [...STD_ARGS, '--dhcp-account', 'systemd-network']);
  assert.notEqual(rb.status, 0);
  assert.match(rb.stderr, /resolves to User='netdhcp'/);
  // a drop-in moving DHCP back to root: refused
  const root3 = makeFakeRoot(t, {
    networkdDropins: [{ name: '99-root.conf', text: '[Service]\nUser=root\n' }],
  });
  const rr = runInstaller(root3, STD_ARGS);
  assert.notEqual(rr.status, 0);
  assert.match(rr.stderr, /as root \(effective User=root\)/);
});

test('resolver path: NM-era resolv.conf is retired; resolved is enabled+gated with the stub', async (t) => {
  const root = makeFakeRoot(t, { resolv: 'nm' }); // systemd-resolved present by default
  const r = runInstaller(root, STD_ARGS);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readlinkSync(join(root, 'etc', 'resolv.conf')), '/run/systemd/resolve/stub-resolv.conf');
  assert.ok(
    lstatSync(join(root, 'etc', 'systemd', 'system', 'systemd-resolved.service.d', '20-tor-guest-firewall.conf')).isFile(),
  );
  assert.ok(
    lstatSync(join(root, 'etc', 'systemd', 'system', 'multi-user.target.wants', 'systemd-resolved.service')).isSymbolicLink(),
    'resolved must be enabled',
  );
  const manifest = readFileSync(join(root, 'etc', 'tor-guest', 'retired-network.txt'), 'utf8');
  assert.match(manifest, /^symlink->\/run\/NetworkManager\/resolv\.conf  resolver-replacement  etc\/resolv\.conf$/m);
});

test('resolver path without systemd-resolved in the image: fail-closed sentinel resolv.conf', async (t) => {
  const root = makeFakeRoot(t, { includeResolved: false, resolv: 'file' });
  const r = runInstaller(root, STD_ARGS);
  assert.equal(r.status, 0, r.stderr);
  const rc = readFileSync(join(root, 'etc', 'resolv.conf'), 'utf8');
  assert.match(rc, /^nameserver 192\.0\.2\.1$/m);
  assert.match(rc, /resolves nothing/);
  assert.match(rc, /Do not replace/);
  // the old dhcpcd/NM-era file is retired byte-for-byte, not deleted
  const retired = readFileSync(join(root, 'var', 'lib', 'tor-guest', 'retired-network', 'etc', 'resolv.conf'), 'utf8');
  assert.equal(retired, 'nameserver 10.0.0.1\n');
  const manifest = readFileSync(join(root, 'etc', 'tor-guest', 'retired-network.txt'), 'utf8');
  assert.match(manifest, /^[0-9a-f]{64}  resolver-replacement  etc\/resolv\.conf$/m);
  // and no resolved drop-in/enable for a unit that does not exist
  assert.ok(!existsSync(join(root, 'etc', 'systemd', 'system', 'systemd-resolved.service.d')));
  assert.ok(!existsSync(join(root, 'etc', 'systemd', 'system', 'multi-user.target.wants', 'systemd-resolved.service')));
});

test('resolver fixture: the nat chain makes both resolver paths go through Tor DNS (text fixture, not live proof)', () => {
  // Order matters: Tor's own traffic returns first, loopback stays local,
  // THEN app/translated DNS is redirected to the DNSPort. This is what makes
  // (a) resolved's upstream queries and (b) the 192.0.2.1 sentinel both
  // resolve through Tor, while Tor's own DNSPort traffic (loopback) is never
  // redirected. Structural text fixture of the pinned generator's output.
  const { nftables } = generatePolicy({ torUid: 143, dhcpUid: 106 });
  const nat = nftables.slice(nftables.indexOf('table ip tor_guest_nat'));
  const order = [
    'meta skuid 143 return',
    'ip daddr 127.0.0.0/8 return',
    'udp dport 53 redirect to :5353',
    'meta l4proto tcp redirect to :9040',
  ].map((l) => nat.indexOf(l));
  assert.ok(order.every((i) => i >= 0), 'all four nat rules must exist');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'nat rules must appear in this order');
  // Tor's upstream resolution/relay egress is tor-uid IPv4 TCP; and no NTP
  // (or any other UDP) exception exists anywhere in the ruleset
  assert.ok(nftables.includes('meta skuid 143 ip daddr != 127.0.0.0/8 meta l4proto tcp accept'));
  assert.ok(!/dport 123/.test(nftables), 'no NTP exception may be added');
  assert.ok(!/ntp/i.test(nftables));
});

// ---------------------------------------------------------------------------
// 5. Offline unit verification with systemd-analyze (no unit is started).
//    Default scope is a STUB unit graph; a real staged guest root can be
//    supplied with TOR_GUEST_VERIFY_ROOT for the real-graph check below.
// ---------------------------------------------------------------------------
test('systemd-analyze verify accepts the shipped units against a stub unit graph (offline)', async (t) => {
  const systemdAnalyze = spawnSync('systemd-analyze', ['--version']);
  if (systemdAnalyze.error || systemdAnalyze.status !== 0) {
    t.skip('systemd-analyze not available on this host');
    return;
  }
  const root = makeFakeRoot(t);
  const r = runInstaller(root, ['--interface', 'eth0', '--yes-disposable', '--workspace-unit', 'abalone-workspace.service']);
  assert.equal(r.status, 0, r.stderr);

  // Minimal stubs for the units referenced by ordering directives, so verify
  // checks OUR units against a complete (if tiny) offline tree. ExecStart
  // stubs point at /bin/true, which exists on any verify host.
  const sysd = join(root, 'usr', 'lib', 'systemd', 'system');
  for (const u of ['network-pre.target', 'shutdown.target', 'multi-user.target', 'sysinit.target', 'basic.target']) {
    writeFileSync(join(sysd, u), `[Unit]\nDescription=${u} stub\n`);
  }
  for (const u of ['systemd-sysusers.service', 'systemd-modules-load.service']) {
    writeFileSync(
      join(sysd, u),
      `[Unit]\nDescription=${u} stub\n\n[Service]\nType=oneshot\nExecStart=/bin/true\nRemainAfterExit=yes\n`,
    );
  }
  writeFileSync(join(root, 'etc', 'machine-id'), '0123456789abcdef0123456789abcdef\n');

  // Host systemd (249) rejects `verify --root`; SYSTEMD_UNIT_PATH scopes unit
  // resolution to the tree instead. Nothing is started — verify only checks
  // syntax, directives and the dependency graph.
  const v = spawnSync(
    'systemd-analyze',
    [
      'verify',
      'tor-guest-firewall.service',
      'tor-guest.service',
      'systemd-networkd.service',
      'systemd-resolved.service',
      'abalone-workspace.service',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        SYSTEMD_UNIT_PATH: `${join(root, 'etc', 'systemd', 'system')}:${join(root, 'usr', 'lib', 'systemd', 'system')}`,
      },
    },
  );
  // The only acceptable findings are the two ExecStart binaries that exist
  // in the guest but never on the verify host — everything else is a real
  // unit problem and must fail the test.
  const guestOnly = [
    /tor-guest-firewall\.service: Command \/usr\/local\/sbin\/tor-guest-load-nft is not executable/,
    /tor-guest\.service: Command \/usr\/bin\/tor is not executable/,
  ];
  const findings = `${v.stdout}\n${v.stderr}`
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !guestOnly.some((re) => re.test(l)));
  assert.deepEqual(
    findings,
    [],
    `systemd-analyze verify found real problems:\n${findings.join('\n')}`,
  );
});

// Opt-in: verify the shipped units against the REAL unit graph of a staged
// guest root (e.g. a mounted clone image: TOR_GUEST_VERIFY_ROOT=/mnt/clone).
// Read-only: nothing in the staged root is modified. The staged root's own
// targets/drop-ins resolve the dependency graph; because systemd-analyze
// resolves ExecStart paths against the VERIFY HOST (systemd 249 has no
// `verify --root`), 'Command ... is not executable' findings are expected
// host-vs-guest artifacts and are the only allowlisted class here. This test
// makes the default stub scope above explicit: without the env var it SKIPS
// and claims nothing about the real image's graph.
test('systemd-analyze verify against a real staged guest root (opt-in via TOR_GUEST_VERIFY_ROOT)', async (t) => {
  const realRoot = process.env.TOR_GUEST_VERIFY_ROOT;
  if (!realRoot || !existsSync(realRoot)) {
    t.skip('no real staged guest root provided (set TOR_GUEST_VERIFY_ROOT=/mnt/clone); the default scope above is the stub graph only');
    return;
  }
  const systemdAnalyze = spawnSync('systemd-analyze', ['--version']);
  if (systemdAnalyze.error || systemdAnalyze.status !== 0) {
    t.skip('systemd-analyze not available on this host');
    return;
  }
  const dirs = ['etc/systemd/system', 'run/systemd/system', 'usr/lib/systemd/system', 'lib/systemd/system']
    .map((d) => join(realRoot, d))
    .filter((d) => existsSync(d));
  const units = ['tor-guest-firewall.service', 'tor-guest.service', 'systemd-networkd.service'];
  const v = spawnSync('systemd-analyze', ['verify', ...units], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SYSTEMD_UNIT_PATH: [join(HERE, 'units'), ...dirs].join(':'),
    },
  });
  const findings = `${v.stdout}\n${v.stderr}`
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/: Command .* is not executable/.test(l));
  assert.deepEqual(
    findings,
    [],
    `real-root systemd-analyze verify found real problems in ${realRoot}:\n${findings.join('\n')}`,
  );
});

// Independent adversarial fixtures: evidence copy only, not implementation edits.
test('independent: earlier negated Name matcher is refused', (t) => {
  const root = makeFakeRoot(t);
  const dir = join(root, 'etc/systemd/network');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '01-negated.network'), '[Match]\nName=!lo\n[Network]\nDHCP=yes\nLLDP=yes\n');
  const result = runInstaller(root, ['--interface', 'eth0', '--yes-disposable']);
  assert.notEqual(result.status, 0, 'Installer accepted earlier Name=!lo configuration that matches eth0');
});
test('independent: own network file overriding drop-in is refused', (t) => {
  const root = makeFakeRoot(t);
  const dir = join(root, 'etc/systemd/network/10-tor-guest-uplink.network.d');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '90-existing.conf'), '[Network]\nLLDP=yes\nEmitLLDP=yes\nIPv6AcceptRA=yes\n');
  const result = runInstaller(root, ['--interface', 'eth0', '--yes-disposable']);
  assert.notEqual(result.status, 0, 'Installer accepted drop-in overriding its asserted network policy');
});

for (const [label, contents] of [
  ['empty name reset', '[Match]\nName=lo\nName=\n[Network]\nDHCP=yes\n'],
  ['quoted name', '[Match]\nName="eth0"\n[Network]\nDHCP=yes\n'],
  ['whitespace name', '[Match]\n  Name = eth0\n[Network]\nDHCP=yes\n'],
]) {
  test(`independent: refuses ${label} before target mutation`, (t) => {
    const root = makeFakeRoot(t);
    const dir = join(root, 'etc/systemd/network'); mkdirSync(dir, {recursive:true});
    writeFileSync(join(dir, '01-existing.network'), contents);
    const result = runInstaller(root, ['--interface', 'eth0', '--yes-disposable']);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(join(root, 'etc/tor-guest/uids')), false);
  });
}
test('independent: retirement flag cannot bypass drop-in ambiguity', (t) => {
  const root = makeFakeRoot(t);
  const dir = join(root, 'usr/local/lib/systemd/network/10-tor-guest-uplink.network.d');
  mkdirSync(dir, {recursive:true});
  writeFileSync(join(dir, '90-override.conf'), '[Network]\nEmitLLDP=yes\n');
  const result = runInstaller(root, ['--interface', 'eth0', '--yes-disposable', '--retire-network-conflicts']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /unsupported networkd drop-in/);
  assert.equal(existsSync(join(root, 'etc/tor-guest/uids')), false);
});

for (const directory of ['etc/netplan', 'run/netplan', 'lib/netplan']) {
  test(`independent: persistent ${directory} YAML refused despite retirement`, (t) => {
    const root = makeFakeRoot(t);
    const dir = join(root, directory); mkdirSync(dir, {recursive:true});
    writeFileSync(join(dir, '50-cloud-init.yaml'), 'network:\n  version: 2\n  ethernets:\n    eth0:\n      dhcp4: true\n');
    const result = runInstaller(root, ['--interface', 'eth0', '--yes-disposable', '--retire-network-conflicts']);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /persistent netplan input/);
    assert.equal(existsSync(join(root, 'etc/tor-guest/uids')), false);
  });
}
