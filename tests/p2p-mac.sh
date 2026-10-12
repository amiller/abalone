#!/usr/bin/env bash
# The libp2p attest handshake with a real Mac (ssh mini-mesh), without a provider key on the Mac: a relay on this
# laptop's mesh address; on the Mac, a peer that listens on its loopback only, holds a relay reservation, and shows App
# Attest evidence from the approved probe (or the modified probe). Checks from the laptop, through the relay:
#   the approved probe's evidence verifies and names this client;
#   the modified probe (CDHash B) is refused; a client whose policy lacks the CDHash refuses; evidence for another
#   client PeerId does not verify (no assertion oracle); a gift request reaches the peer only after attestation.
set -uo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
MINI=${MINI_SSH:-mini-mesh} LAPTOP=${LAPTOP_MESH_IP:-192.168.100.2} REMOTE='~/projects/abalone-edge' RIG='~/appattest-codebinding-20260916'
W="$(mktemp -d /tmp/abm.XXXX)"
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
remote() { timeout 300 ssh "$MINI" "cd $REMOTE && $*"; }
"$root/bin/abalone" peer relay --listen "/ip4/$LAPTOP/tcp/0" > "$W/relay.log" 2>&1 & relay=$!
trap 'kill $relay 2>/dev/null; remote "kill \$(cat stub-peer.pid) 2>/dev/null" > /dev/null; rm -rf "$W"' EXIT
for _ in $(seq 30); do grep -q "/tcp/" "$W/relay.log" && break; sleep 1; done
R=$(grep -o "/ip4/$LAPTOP/tcp/[0-9]*/p2p/[A-Za-z0-9]*" "$W/relay.log" | head -1)
[[ -n $R ]] || { cat "$W/relay.log"; echo "FAIL relay did not start"; exit 1; }
timeout 300 rsync -a --delete -R bin lib node_modules package.json aci/package.json aci/node_modules aci/verifier-ts/dist aci/verifier-ts/package.json anchors providers.json policy.json curated skills tools "$MINI:projects/abalone-edge/" || { echo "FAIL cannot reach $MINI"; exit 1; }
check "the Mac holds no abalone key store" '! remote "test -e ~/.abalone/credit"'
peer() { # $1 = honest|modified; prints the peer's relayed address
  remote "kill \$(cat stub-peer.pid 2>/dev/null) 2>/dev/null; (nohup /opt/homebrew/bin/node -e '
    import(\"./lib/p2p.mjs\").then(async (m) => {
      const p = await m.servePeer({ listen: [\"/ip4/127.0.0.1/tcp/0\"], relays: [process.argv[1]], evidence: (id) => m.evidenceSource(\"appattest\", id, process.argv[2]),
        handle: (req, res) => { res.writeHead(200, { \"content-type\": \"application/json\" }); res.end(JSON.stringify({ reached: req.url })); } });
      console.log(\"PEER \" + process.argv[1] + \"/p2p-circuit/p2p/\" + p.peerId);
    })' $R $RIG/build/$1/CodeBindingProbe.app > stub-peer.log 2>&1 & echo \$! > stub-peer.pid); for i in \$(seq 90); do grep -q 'PEER\|rror' stub-peer.log && break; sleep 1; done; cat stub-peer.log" | grep -o "PEER .*" | cut -d' ' -f2
}
client() { # $1 = peer addr, $2 = policy override (JSON merged into appattest admission)
  node -e 'import(process.argv[1]).then(async (m) => {
    const pol = require(process.argv[3]).peers.admit; Object.assign(pol.appattest, JSON.parse(process.argv[4] || "{}"));
    try { const g = await m.giftClient(process.argv[2], pol); const r = await fetch(g.url + "/redeem", { method: "POST", body: "{}" });
      console.log(JSON.stringify({ ok: true, verdict: g.verdict, direct: g.direct, reply: await r.json() })); await g.close(); }
    catch (e) { console.log(JSON.stringify({ ok: false, error: e.message })); }
    process.exit(0); })' "$root/lib/p2p.mjs" "$1" "$root/providers.json" "${2:-}"
}
A=$(peer honest); echo "  approved probe peer: $A"
out=$(client "$A"); echo "  $out"
check "approved CDHash: evidence verified through the relay, and the gift protocol reached the peer" '[[ $out == *"\"ok\":true"*"67dfc08f0eca"*"\"reached\":\"/redeem\""* ]]'
out=$(client "$A" '{"cdhashes":["d91322464a3b4e528f8faec1b6ff8bb4d7b102a9a578f7ba997000750f43521c"]}'); echo "  $out"
check "a client that admits only another CDHash refuses the same peer" '[[ $out == *"\"ok\":false"*"is not admitted"* ]]'
out=$(node -e 'import(process.argv[1]).then(async (p) => { const c = await p.node(); const ma = (await import("@multiformats/multiaddr")).multiaddr(process.argv[2]);
  const conn = await c.dial(ma); const { lpStream } = await import("@libp2p/utils"); const lp = lpStream(await conn.newStream("/abalone/attest/1", { runOnLimitedConnection: true }));
  await lp.write(Buffer.from(JSON.stringify({ role: "client", nonce: "aa" }))); const ev = JSON.parse(Buffer.from((await lp.read()).subarray()).toString());
  try { p.verifyEvidence(ev, ma.getComponents().at(-1).value, "12D3KooWSomeOtherClientPeerIdxxxxxxxxxxxxxxxxxxxxxx", "aa", require(process.argv[3]).peers.admit); console.log("VERIFIED") } catch (e) { console.log(e.message) }
  await c.stop(); process.exit(0) })' "$root/lib/p2p.mjs" "$A" "$root/providers.json")
check "evidence made for one client does not verify for another client PeerId: $out" '[[ $out == *"assertion signature does not verify"* ]]'
B=$(peer modified); echo "  modified probe peer: $B"
out=$(client "$B"); echo "  $out"
check "a fresh, genuine App Attest enrollment from the modified probe (CDHash B) is refused" '[[ $out == *"\"ok\":false"*"is not admitted"* ]]'
echo "p2p-mac: $([[ $fail == 0 ]] && echo PASS || echo FAIL)"; exit $fail
