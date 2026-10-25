#!/bin/sh
# tor-guest-load-nft — early-boot loader for the tor-guest firewall tables.
#
# Runs inside the disposable guest as root from tor-guest-firewall.service
# (DefaultDependencies=no, Before=network-pre.target). It never starts or
# stops other services and never touches tables it does not own.
#
# Steps, each of which can only fail closed:
#   1. the installed ruleset, its sha256 sidecar and the identities file must
#      exist and be readable                                    -> exit 1
#   2. the ruleset's sha256 must match the install-time sidecar  -> exit 2
#   3. the identities file and the ruleset must agree on both
#      uids, and both accounts must still resolve to those uids
#      via getent passwd (uid drift after install = mismatch)    -> exit 3
#      AND the guarded-boot re-validation of install-time offline facts:
#      the recorded uplink must exist in the REAL /sys/class/net with
#      type 1 (plain ethernet), and `systemctl show` must report the
#      same EFFECTIVE systemd-networkd User= that was recorded (unit
#      file + drop-ins — a post-install drop-in must not silently
#      move DHCP to a different uid)                -> exit 3
#   4. nft -c -f must accept the ruleset (syntax, no apply)      -> exit 4
#   5. a single nft -f transaction replaces ONLY the two owned
#      tables (ip tor_guest_nat, inet tor_guest_filter); delete
#      lines for tables that already exist are prepended INSIDE
#      that one file, so deletes and re-definitions commit
#      together. A failed transaction aborts atomically and the
#      previously loaded tables are retained                    -> exit 5
#
# There is no stop path: the unit has no ExecStop, and this script contains
# no `nft flush` and no standalone delete command. Failure of this script
# fails tor-guest-firewall.service, whose Requires= dependencies
# (systemd-networkd, systemd-resolved, tor-guest, the workspace unit) then
# never start — the guest stays offline rather than egress without policy.
#
# Paths are overridable for offline tests (TOR_GUEST_CONF_DIR, TMPDIR,
# TOR_GUEST_SYS_CLASS_NET); nft, getent and systemctl are resolved through
# PATH so test harnesses can fake them.

set -eu

CONF_DIR="${TOR_GUEST_CONF_DIR:-/etc/tor-guest}"
NFT_FILE="$CONF_DIR/tor-guest.nft"
HASH_FILE="$NFT_FILE.sha256"
UIDS_FILE="$CONF_DIR/uids"

# The two tables this policy owns and is allowed to delete/replace. Nothing
# else in the ruleset namespace is ever named by a delete or flush here.
OWNED_TABLES="ip tor_guest_nat inet tor_guest_filter" # documentation; pairs below

die() {
    _code=$1
    shift
    echo "tor-guest-load-nft: $*" >&2
    exit "$_code"
}

for f in "$NFT_FILE" "$HASH_FILE" "$UIDS_FILE"; do
    [ -r "$f" ] || die 1 "missing config: $f not readable"
done

# --- 2. install-time hash ------------------------------------------------
hash_expected=$(awk 'NR==1 && NF { print $1; exit }' "$HASH_FILE") || true
[ -n "$hash_expected" ] || die 2 "malformed hash sidecar: $HASH_FILE"
hash_actual=$(sha256sum "$NFT_FILE" | awk '{ print $1 }')
[ "$hash_actual" = "$hash_expected" ] || die 2 "hash mismatch: $NFT_FILE != $HASH_FILE"

# --- 3. identities: file <-> ruleset <-> live passwd ----------------------
tor_account=''; tor_uid=''; dhcp_account=''; dhcp_uid=''; iface=''; iface_type=''
while IFS='=' read -r key value; do
    case "$key" in
        tor_account) tor_account=$value ;;
        tor_uid) tor_uid=$value ;;
        dhcp_account) dhcp_account=$value ;;
        dhcp_uid) dhcp_uid=$value ;;
        iface) iface=$value ;;
        iface_type) iface_type=$value ;;
    esac
done < "$UIDS_FILE"

valid_uid() {
    case "$1" in
        '' | *[!0-9]*) return 1 ;;
    esac
    [ "$1" -ge 1 ] && [ "$1" -le 4294967294 ]
}

valid_uid "$tor_uid" || die 3 "uids file: tor_uid missing or out of range"
valid_uid "$dhcp_uid" || die 3 "uids file: dhcp_uid missing or out of range"
[ "$tor_uid" != "$dhcp_uid" ] || die 3 "uids file: tor and dhcp uids equal"
case "$tor_account$dhcp_account" in
    '' | *[!A-Za-z0-9_-]*) die 3 "uids file: account names missing or invalid" ;;
esac

# The ruleset must carry exactly the recorded uids (rules/config agreement:
# a partially regenerated ruleset or uids file must not load).
grep -qF "meta skuid $tor_uid return" "$NFT_FILE" ||
    die 3 "ruleset does not exempt tor uid $tor_uid"
grep -qF "meta skuid $dhcp_uid meta nfproto ipv4 udp sport 68 udp dport 67 accept" "$NFT_FILE" ||
    die 3 "ruleset does not carry the dhcp uid $dhcp_uid rule"

# Live identity check: an account renumbered after install must fail here,
# before any transaction, instead of silently loading rules for a stale uid.
live_tor=$(getent passwd "$tor_account" 2>/dev/null | awk -F: '{ print $3 }') || live_tor=''
[ "$live_tor" = "$tor_uid" ] ||
    die 3 "uid mismatch: passwd resolves $tor_account to '${live_tor:-nothing}', ruleset expects $tor_uid"
live_dhcp=$(getent passwd "$dhcp_account" 2>/dev/null | awk -F: '{ print $3 }') || live_dhcp=''
[ "$live_dhcp" = "$dhcp_uid" ] ||
    die 3 "uid mismatch: passwd resolves $dhcp_account to '${live_dhcp:-nothing}', ruleset expects $dhcp_uid"

# --- 3b. guarded-boot re-validation of install-time offline facts ----------
# The uplink and its type may have been ATTESTED offline (mounted images
# carry no sysfs). The real device is checked here, before any transaction
# and before any networking: this unit orders Before=network-pre.target and
# systemd-networkd Requires it, so a mismatch keeps the stack down.
[ -n "$iface" ] || die 3 "uids file: iface missing"
[ "$iface" != lo ] || die 3 "uids file: iface must not be lo"
case "$iface" in
    *[!A-Za-z0-9._-]* | .* | *..*) die 3 "uids file: invalid iface name '$iface'" ;;
esac
[ "$iface_type" = 1 ] ||
    die 3 "uids file: iface_type must be 1 (plain ethernet), got '${iface_type:-none}'"
SYS_NET="${TOR_GUEST_SYS_CLASS_NET:-/sys/class/net}"
[ -r "$SYS_NET/$iface/type" ] ||
    die 3 "guarded-boot check: uplink $iface not present in $SYS_NET (install recorded '$iface') — refusing before any networking"
_livetype=$(cat "$SYS_NET/$iface/type" 2>/dev/null) || _livetype=''
[ "$_livetype" = 1 ] ||
    die 3 "guarded-boot check: uplink $iface has type '${_livetype:-unknown}', not 1 (plain ethernet) — refusing before any networking"

# The EFFECTIVE networkd owner (unit file + drop-ins, as the manager applies
# them) must still be the recorded DHCP account. This is what makes an
# install-time --dhcp-account cross-check (and this recorded value) hold at
# boot: a drop-in added after install cannot silently move DHCP to another
# uid (or root) without failing the firewall load first.
_eff=$(systemctl show systemd-networkd.service --property=User --value 2>/dev/null) || _eff=''
[ -n "$_eff" ] || _eff=root
[ "$_eff" = "$dhcp_account" ] ||
    die 3 "effective systemd-networkd User='$_eff' != recorded dhcp account '$dhcp_account' — the DHCP uid ruleset would not hold; refusing before any networking"

# --- 4. syntax check (no apply) -------------------------------------------
nft -c -f "$NFT_FILE" || die 4 "syntax check failed for $NFT_FILE (not applied)"

# --- 5. atomic single-transaction replace of owned tables ------------------
TX_FILE=$(mktemp "${TMPDIR:-/run}/tor-guest-nft-tx.XXXXXX" 2>/dev/null) || TX_FILE=$(mktemp)
trap 'rm -f "$TX_FILE"' EXIT INT TERM

replaced=''
for owned in "ip tor_guest_nat" "inet tor_guest_filter"; do
    if nft list table $owned >/dev/null 2>&1; then
        echo "delete table $owned" >> "$TX_FILE"
        replaced="$replaced $owned"
    fi
done
cat "$NFT_FILE" >> "$TX_FILE"

# One nft -f = one netlink transaction. On any error the whole batch aborts
# and the previously loaded tables are retained (fail-closed, no gap).
if ! nft -f "$TX_FILE"; then
    die 5 "atomic apply failed; previously loaded tables retained"
fi

if [ -n "$replaced" ]; then
    echo "tor-guest-load-nft: atomically replaced owned tables:$replaced"
else
    echo "tor-guest-load-nft: loaded owned tables (initial install)"
fi
