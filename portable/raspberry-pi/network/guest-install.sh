#!/bin/sh
# guest-install.sh — install the tor-guest boot stack into a DISPOSABLE guest.
#
# Target: an expendable, cloned Debian or Raspberry Pi OS Bookworm ARM guest
# (systemd-networkd or NetworkManager-based — both paths below). The installer
# is offline: it resolves identities from the target's own /etc/passwd and
# unit files, generates the root-owned nft ruleset, torrc and sha256 sidecars
# at INSTALL time, and copies the loader and units. Nothing here runs Node,
# downloads anything, or starts any service. uids are NEVER hardcoded: the
# observed bookworm values (tor 104 / networkd 998) differ from image to
# image, so both identities are resolved and verified, and any mismatch or
# unresolvable account aborts the install.
#
# The nft/torrc templates below are generated text: the test suite proves
# they are byte-identical (modulo uid substitution) to the output of
# generate-policy.mjs, whose validated sha256 is pinned in the job record —
# this installer must not weaken them.
#
# Usage (from a checkout of portable/raspberry-pi/network/, inside the clone as root, or
# against an offline tree with --root):
#   ./guest-install.sh --interface <name> --yes-disposable \
#       [--root <dir>] [--workspace-unit <name.service>] \
#       [--tor-account debian-tor] [--dhcp-account <account>] \
#       [--interface-type 1] [--retire-network-conflicts]
#
# --interface  required; the guest's uplink. Detected/verified, never guessed.
#              LIVE target: it must exist under /sys/class/net and be a plain
#              ethernet device (type 1). OFFLINE trees usually carry no sysfs
#              (a mounted image has an empty /sys): pass --interface-type 1
#              as explicit reviewed interface metadata. The attested type is
#              recorded and the loader re-validates the REAL device against
#              /sys/class/net on every guarded boot, before any networking.
# --yes-disposable
#              required confirmation that the target is an expendable clone:
#              the installer masks stock network managers, stock tor and the
#              stock nftables.service.
# --root       install into an offline tree (default / = live target).
# --workspace-unit
#              optional unit to gate on the firewall (Requires/After drop-in);
#              it must already exist in the target — the workspace/agent
#              account itself is owned by the storage slice, not this
#              installer, which grants no account anything.
# --dhcp-account
#              names the account that owns systemd-networkd's DHCP frames.
#              It must equal the EFFECTIVE networkd User= (unit file plus
#              drop-ins, as the manager would apply them) — the flag is a
#              cross-check, not a bypass of that verification.
# --interface-type
#              explicit reviewed interface metadata for offline installs
#              (ARPHRD value; only 1 = plain ethernet is accepted here).
# --retire-network-conflicts
#              without it the installer REFUSES when existing networkd config
#              would win the uplink over ours (matching .network sorting
#              before 10-tor-guest-uplink.network, .link that can rename the
#              interface, .netdev naming it) in ANY search dir (/etc, /run,
#              /usr/lib, /lib). With it those files are MOVED (never deleted)
#              to /var/lib/tor-guest/retired-network/ and recorded in
#              /etc/tor-guest/retired-network.txt.

set -eu

SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) ||
    { echo "guest-install: cannot locate source directory" >&2; exit 1; }

die() { echo "guest-install: ERROR: $*" >&2; exit 1; }
info() { echo "guest-install: $*"; }

usage() {
    sed -n '2,59p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

IFACE=''
ROOT=''
WORKSPACE_UNIT=''
TOR_ACCOUNT=debian-tor
DHCP_ACCOUNT=''
DHCP_ACCOUNT_GIVEN=0
IFACE_TYPE_OPT=''
RETIRE_CONFLICTS=0
CONFIRM=0
while [ $# -gt 0 ]; do
    case $1 in
        --interface) [ $# -ge 2 ] || die "--interface needs a value"; IFACE=$2; shift 2 ;;
        --root) [ $# -ge 2 ] || die "--root needs a value"; ROOT=$2; shift 2 ;;
        --workspace-unit) [ $# -ge 2 ] || die "--workspace-unit needs a value"; WORKSPACE_UNIT=$2; shift 2 ;;
        --tor-account) [ $# -ge 2 ] || die "--tor-account needs a value"; TOR_ACCOUNT=$2; shift 2 ;;
        --dhcp-account) [ $# -ge 2 ] || die "--dhcp-account needs a value"; DHCP_ACCOUNT=$2; DHCP_ACCOUNT_GIVEN=1; shift 2 ;;
        --interface-type) [ $# -ge 2 ] || die "--interface-type needs a value"; IFACE_TYPE_OPT=$2; shift 2 ;;
        --retire-network-conflicts) RETIRE_CONFLICTS=1; shift ;;
        --yes-disposable) CONFIRM=1; shift ;;
        -h|--help) usage 0 ;;
        *) usage 1 >&2 ;;
    esac
done

[ "$CONFIRM" = 1 ] || die "refusing to run: pass --yes-disposable. This installer rewires networking and masks stock services; it is only for an expendable cloned guest (see README.md)."

[ -n "$IFACE" ] || die "--interface is required (the uplink is detected/verified, never guessed)"
case $IFACE in
    lo) die "refusing --interface lo" ;;
    *[!A-Za-z0-9._-]* | '' | .* | *..*) die "invalid interface name: $IFACE" ;;
esac
case $TOR_ACCOUNT in *[!A-Za-z0-9_-]* | '') die "invalid --tor-account name" ;; esac
if [ -n "$DHCP_ACCOUNT" ]; then
    case $DHCP_ACCOUNT in *[!A-Za-z0-9_-]* | '') die "invalid --dhcp-account name" ;; esac
fi
case $IFACE_TYPE_OPT in
    '' | 1) ;;
    *) die "--interface-type must be 1 (ARPHRD_ETHER, plain ethernet); this stack takes no other uplink type" ;;
esac
if [ -n "$WORKSPACE_UNIT" ]; then
    case $WORKSPACE_UNIT in
        *.service | *.target | *.socket) : ;;
        *) die "--workspace-unit must name a unit file (e.g. foo.service)" ;;
    esac
    case $WORKSPACE_UNIT in *[!A-Za-z0-9.@_-]* | '' | *..*) die "invalid unit name: $WORKSPACE_UNIT" ;; esac
fi

[ -n "$ROOT" ] || ROOT=/
case $ROOT in
    /*) ;;
    *) ROOT=$(pwd)/$ROOT ;;
esac

LIVE=0
if [ "$ROOT" = / ] && [ -d /run/systemd/system ]; then LIVE=1; fi
if [ "$LIVE" = 1 ] && [ "$(id -u)" != 0 ]; then
    die "live install into / must run as root (use --root <dir> for offline trees)"
fi

PASSWD_FILE="$ROOT/etc/passwd"
[ -r "$PASSWD_FILE" ] || die "no passwd file at $PASSWD_FILE — is this a guest tree?"

uid_of() { awk -F: -v n="$1" '$1 == n { print $3; exit }' "$PASSWD_FILE"; }
valid_uid() {
    case $1 in '' | *[!0-9]*) return 1 ;; esac
    [ "$1" -ge 1 ] && [ "$1" -le 4294967294 ]
}

# unit search across the target's systemd directories (etc > run > usr/lib/lib)
find_unit() {
    _u=$1
    for _d in etc/systemd/system run/systemd/system usr/lib/systemd/system lib/systemd/system; do
        if [ -f "$ROOT/$_d/$_u" ]; then
            printf '%s\n' "$ROOT/$_d/$_u"
            return 0
        fi
    done
    return 1
}

# --- identities: resolve, never assume (no default 104/998) ---------------
tor_uid=$(uid_of "$TOR_ACCOUNT")
valid_uid "$tor_uid" ||
    die "tor account '$TOR_ACCOUNT' not in $PASSWD_FILE or uid invalid — resolve the real account (no default uid is assumed)"

NETWORKD_FILE=$(find_unit systemd-networkd.service) ||
    die "systemd-networkd.service not found in target — this stack requires systemd-networkd (the installer migrates NetworkManager images to it)"

# Effective networkd owner: the User= the manager would actually apply = the
# last User= across the unit file plus every drop-in (systemd drop-in
# semantics: for each drop-in filename the highest-priority directory's copy
# counts — /etc over /run over /usr/lib|/lib — and the kept drop-ins apply in
# filename order after the unit file, later assignments overriding earlier
# ones). The loader re-checks the live effective owner with `systemctl show`
# on every boot; this install-time computation must agree with it.
# (Accounts are resolved from the TARGET's passwd — never the host's.)
effective_networkd_user() {
    _eff=''
    _v=$(sed -n 's/^User=//p' "$NETWORKD_FILE" | tail -n 1)
    [ -n "$_v" ] && _eff=$_v
    _list=$(mktemp) || return 1
    for _spec in '3 etc/systemd/system' '2 run/systemd/system' '1 usr/lib/systemd/system' '1 lib/systemd/system'; do
        _p=${_spec%% *}
        _d=${_spec#* }
        _dd="$ROOT/$_d/systemd-networkd.service.d"
        [ -d "$_dd" ] || continue
        for _c in "$_dd"/*.conf; do
            [ -f "$_c" ] || continue
            printf '%s %s %s\n' "$_p" "${_c##*/}" "$_c" >> "$_list"
        done
    done
    # per drop-in name keep the highest-priority copy, then apply in filename order
    while IFS=' ' read -r _ _ _c; do
        [ -f "$_c" ] || continue
        _v=$(sed -n 's/^User=//p' "$_c" | tail -n 1)
        [ -n "$_v" ] && _eff=$_v
    done <<EOF
$(sort -k2,2 -k1,1rn "$_list" | awk '!seen[$2]++' | sort -k2,2)
EOF
    rm -f "$_list"
    printf '%s\n' "$_eff"
}
NETWORKD_EFF_USER=$(effective_networkd_user) ||
    die "cannot compute the effective systemd-networkd User= (unit + drop-ins)"
[ -n "$NETWORKD_EFF_USER" ] || NETWORKD_EFF_USER=root
if [ "$DHCP_ACCOUNT_GIVEN" = 1 ]; then
    if [ "$DHCP_ACCOUNT" != "$NETWORKD_EFF_USER" ]; then
        die "--dhcp-account '$DHCP_ACCOUNT' is not the effective systemd-networkd owner: the target's unit graph (unit file + drop-ins) resolves to User='$NETWORKD_EFF_USER'. The DHCP owner is a fact of the target, not an override — fix the drop-in or pass the real effective account"
    fi
else
    DHCP_ACCOUNT=$NETWORKD_EFF_USER
fi
if [ "$DHCP_ACCOUNT" = root ] || [ "$DHCP_ACCOUNT" = 0 ]; then
    die "systemd-networkd would run DHCP as root (effective User=$NETWORKD_EFF_USER): the policy requires a dedicated non-root DHCP owner whose uid the ruleset can pin — refusing rather than weakening the rules"
fi
dhcp_uid=$(uid_of "$DHCP_ACCOUNT")
valid_uid "$dhcp_uid" ||
    die "dhcp account '$DHCP_ACCOUNT' (effective systemd-networkd owner) not in passwd or uid invalid — the target must define this account"
[ "$dhcp_uid" != "$tor_uid" ] ||
    die "tor ($TOR_ACCOUNT) and dhcp ($DHCP_ACCOUNT) resolve to the same uid $tor_uid — refusing"

# --- uplink: verified live, or explicitly attested offline and re-validated
# against the guest's REAL /sys on every guarded boot. No host sysfs is ever
# bind-mounted into an offline tree to fake validation — that would prove
# nothing about the guest's actual device.
IFACE_TYPE=''
IFACE_ATTESTED=0
IFACE_DIR="$ROOT/sys/class/net/$IFACE"
if [ "$LIVE" = 1 ]; then
    [ -d "$IFACE_DIR" ] || die "interface $IFACE not present in /sys/class/net — pass the actual uplink name"
    [ -r "$IFACE_DIR/type" ] && [ "$(cat "$IFACE_DIR/type")" = 1 ] ||
        die "interface $IFACE is not a plain ethernet device (type != 1) — refusing"
    IFACE_TYPE=1
else
    SYSFS_TYPE=''
    if [ -r "$IFACE_DIR/type" ]; then
        SYSFS_TYPE=$(cat "$IFACE_DIR/type")
    fi
    if [ -n "$SYSFS_TYPE" ]; then
        # a staged tree that carries sysfs info (e.g. a snapshot) is checked
        [ "$SYSFS_TYPE" = 1 ] ||
            die "staged tree says interface $IFACE has type $SYSFS_TYPE, not 1 (plain ethernet) — refusing"
        IFACE_TYPE=1
    elif [ -n "$IFACE_TYPE_OPT" ]; then
        # explicit reviewed metadata for trees without sysfs (the normal
        # mounted-image case): recorded in /etc/tor-guest/uids and re-validated
        # by the loader against the real /sys before any networking, every boot
        IFACE_TYPE=$IFACE_TYPE_OPT
        IFACE_ATTESTED=1
    else
        die "offline tree carries no sysfs for $IFACE ($IFACE_DIR/type unreadable — mounted images have an empty /sys): pass --interface-type 1 as explicit reviewed interface metadata; the loader re-validates the real device before networking on every guarded boot"
    fi
    if [ -n "$SYSFS_TYPE" ] && [ -n "$IFACE_TYPE_OPT" ] && [ "$SYSFS_TYPE" != "$IFACE_TYPE_OPT" ]; then
        die "--interface-type $IFACE_TYPE_OPT contradicts the staged sysfs type $SYSFS_TYPE for $IFACE"
    fi
fi

# --- guards against config regeneration ------------------------------------
# Netplan generates /run/systemd/network again at every boot. Retiring its
# current output is insufficient; require explicit image normalization first.
for _nd in etc/netplan run/netplan lib/netplan; do
    for _ny in "$ROOT/$_nd"/*.yaml; do
        [ -s "$_ny" ] || continue
        die "persistent netplan input $_ny can regenerate competing networkd config: preserve and move it outside netplan search paths before installing; --retire-network-conflicts does not bypass this guard"
    done
done
if [ -e "$ROOT/boot/firstrun.sh" ]; then
    die "boot/firstrun.sh present: the image's first-boot customization would regenerate network config — boot the gold image once, then install into the clone"
fi
for p in usr/sbin/nft sbin/nft usr/bin/nft; do
    if [ -x "$ROOT/$p" ]; then NFT_PRESENT=1; break; fi
done
[ "${NFT_PRESENT:-0}" = 1 ] || die "nft binary not found in target — the loader requires it"
[ -x "$ROOT/usr/bin/tor" ] || die "/usr/bin/tor not present in target — install the tor package in the guest image first"
[ -f "$SRC_DIR/tor-guest-load-nft.sh" ] || die "missing $SRC_DIR/tor-guest-load-nft.sh"
[ -f "$SRC_DIR/units/tor-guest-firewall.service" ] || die "missing units/tor-guest-firewall.service"
[ -f "$SRC_DIR/units/tor-guest.service" ] || die "missing units/tor-guest.service"

info "resolved identities (install-time, from target passwd):"
info "  tor  : $TOR_ACCOUNT  uid $tor_uid"
info "  dhcp : $DHCP_ACCOUNT  uid $dhcp_uid  (effective systemd-networkd owner: unit + drop-ins)"
if [ "$LIVE" = 1 ]; then
    info "verified uplink: $IFACE (live sysfs type $IFACE_TYPE, ethernet)"
elif [ "$IFACE_ATTESTED" = 1 ]; then
    info "uplink $IFACE: type $IFACE_TYPE ATTESTED offline (reviewed metadata); the loader re-validates /sys/class/net/$IFACE before any networking on every guarded boot"
else
    info "verified uplink: $IFACE (staged sysfs type $IFACE_TYPE, ethernet)"
fi
info "mode: $([ "$LIVE" = 1 ] && echo 'live target /' || echo "offline tree $ROOT")"

systemctl_do() {
    if [ "$LIVE" = 1 ]; then
        systemctl "$@"
    else
        systemctl --root="$ROOT" "$@"
    fi
}

if [ "$LIVE" = 1 ] && systemctl is-active --quiet nftables.service 2>/dev/null; then
    die "nftables.service is active: its stop/reload flushes the entire ruleset. Install into a freshly booted clone instead."
fi

# --- networkd config precedence: refuse (or explicitly retire) anything
# that can win the uplink over 10-tor-guest-uplink.network -----------------
# Per systemd.network(5) the first LEXICALLY matching .network file wins, so
# only files sorting before ours can take the interface — but they can, from
# ANY search dir (/etc, /run, /usr/lib, /lib; same-name files in higher dirs
# shadow ours only if they are OUR name, which we skip). A .link file can
# rename the interface out from under our Name= match (the first matching
# .link applies; this stack ships none). A .netdev declaring the uplink name
# collides with it. Detection is conservative and evaluated offline:
#   .network — a [Match] with no Name= key matches EVERY interface; with
#              Name= globs (OR across lines and comma lists) the file can
#              only match if some glob matches, because every match key must
#              hold.
#   .link    — matches if [Match] has no OriginalName=/Name= (match-all) or
#              a glob matches; rename risk if [Link] Name= differs from the
#              uplink or NamePolicy='s first token is not "keep".
#   .netdev  — [NetDev] Name= equal to the uplink.
NETWORK_BASENAME=10-tor-guest-uplink.network
CONFLICTS=''

netd_dirs() { # unique networkd config dirs (handles lib -> usr/lib aliasing)
    _seen=''
    for _d in etc/systemd/network run/systemd/network usr/local/lib/systemd/network usr/lib/systemd/network lib/systemd/network; do
        [ -d "$ROOT/$_d" ] || continue
        _real=$(CDPATH= cd -- "$ROOT/$_d" 2>/dev/null && pwd -P) || continue
        case " $_seen " in
            *" $_real "*) continue ;;
        esac
        _seen="$_seen $_real"
        printf '%s\n' "$ROOT/$_d"
    done
}

section_keys() { # file section-name key-name -> values, one per line
    awk -v sec="$2" -v key="$3" '
        BEGIN { k = tolower(key) }
        /^[ \t]*\[/ {
            s = tolower($0); gsub(/[][]/, "", s); gsub(/[ \t]/, "", s)
            cur = (s == sec); next
        }
        cur {
            line = $0
            sub(/^[ \t]+/, "", line)
            gsub(/[ \t]*=[ \t]*/, "=", line)
            l = tolower(line)
            if (index(l, k "=") == 1) {
                v = substr(line, length(k) + 2)
                sub(/[ \t\r]+$/, "", v)
                print v
            }
        }
    ' "$1"
}

iface_glob_match() { # glob-list (space/comma separated) -> 0 if any matches $IFACE
    # set -f: without it the split pattern words undergo pathname expansion
    # (a bare '*' would become the CWD file list) before case can glob-match
    set -f
    for _g in $(printf '%s\n' "$1" | tr ',' ' '); do
        case $IFACE in
            $_g) set +f; return 0 ;;
        esac
    done
    set +f
    return 1
}

add_conflict() { # kind path
    _tab=$(printf '\t')
    CONFLICTS="$CONFLICTS$1$_tab$2
"
}

# This is deliberately a small matcher, not a systemd parser. Refuse
# syntax whose meaning it cannot prove, before any target mutation. Drop-ins
# can change both selection and policy, including our own generated file.
# --retire-network-conflicts does not bypass these ambiguity guards.
validate_network_config_subset() {
    for _dir in $(netd_dirs); do
        for _dd in "$_dir"/*.network.d "$_dir"/*.link.d "$_dir"/*.netdev.d; do
            [ -d "$_dd" ] || continue
            for _cf in "$_dd"/*.conf; do
                [ -e "$_cf" ] || [ -L "$_cf" ] || continue
                die "unsupported networkd drop-in $_cf: review and remove it from the image before installation"
            done
        done
        for _cf in "$_dir"/*.network "$_dir"/*.link "$_dir"/*.netdev; do
            [ -f "$_cf" ] || continue
            # Reject continuations anywhere: they can obscure section/key
            # boundaries. Match value quoting, escapes, negation and resets
            # require systemd semantics that this scanner does not implement.
            if ! awk '
                /^[ \t]*[#;]/ { next }
                /\\[ \t]*$/ { exit 1 }
                /^[ \t]*(Name|OriginalName)[ \t]*=/ {
                    sub(/^[^=]*=[ \t]*/, "")
                    sub(/[ \t\r]+$/, "")
                    if ($0 == "" || $0 ~ /[!"\047\\]/) exit 1
                }
            ' "$_cf"; then
                die "unsupported networkd name/reset/continuation syntax in $_cf: review and simplify it before installation"
            fi
        done
    done
}

validate_network_config_subset

scan_network_conflicts() {
    for _dir in $(netd_dirs); do
        for _f in "$_dir"/*.network "$_dir"/*.netdev "$_dir"/*.link; do
            [ -f "$_f" ] || continue
            _base=${_f##*/}
            [ "$_base" != "$NETWORK_BASENAME" ] || continue
            case $_base in
            *.network)
                # later-sorting files never win: first lexical match wins
                if [ "$_base" \< "$NETWORK_BASENAME" ]; then
                    _names=$(section_keys "$_f" match Name | tr '\n' ' ')
                    _any=$(printf '%s' "$_names" | tr -d ' \t\n')
                    if [ -z "$_any" ] || iface_glob_match "$_names"; then
                        add_conflict network "$_f"
                    fi
                fi
                ;;
            *.link)
                _on=$( { section_keys "$_f" match OriginalName; section_keys "$_f" match Name; } | tr '\n' ' ')
                _any=$(printf '%s' "$_on" | tr -d ' \t\n')
                if [ -z "$_any" ] || iface_glob_match "$_on"; then
                    _newname=$(section_keys "$_f" link Name | sed -n '1p')
                    _policy=$(section_keys "$_f" link NamePolicy | sed -n '1p')
                    _firstpol=$(printf '%s' "$_policy" | awk '{ print $1 }')
                    _risk=0
                    if [ -n "$_newname" ] && [ "$_newname" != "$IFACE" ]; then _risk=1; fi
                    if [ -n "$_policy" ] && [ "$_firstpol" != keep ]; then _risk=1; fi
                    if [ "$_risk" = 1 ]; then
                        add_conflict link "$_f"
                    fi
                fi
                ;;
            *.netdev)
                _n=$(section_keys "$_f" netdev Name | sed -n '1p')
                if [ "$_n" = "$IFACE" ]; then
                    add_conflict netdev "$_f"
                fi
                ;;
            esac
        done
    done
}

scan_network_conflicts
if [ -n "$CONFLICTS" ]; then
    TAB=$(printf '\t')
    info 'conflicting networkd configuration found (can win or rename the uplink):'
    printf '%s\n' "$CONFLICTS" | while IFS="$TAB" read -r _kind _path; do
        [ -n "$_kind" ] || continue
        case $_kind in
            network) info "  .network matching $IFACE, sorts before ours: $_path" ;;
            link) info "  .link that can rename $IFACE: $_path" ;;
            netdev) info "  .netdev declaring $IFACE: $_path" ;;
        esac
    done
    if [ "$RETIRE_CONFLICTS" != 1 ]; then
        die "refusing: existing networkd config in the target can win the uplink over $NETWORK_BASENAME. Review the files above and either fix the image or pass --retire-network-conflicts to MOVE them to /var/lib/tor-guest/retired-network/ (recorded in /etc/tor-guest/retired-network.txt)"
    fi
    info '--retire-network-conflicts given: the files above will be retired (moved, never deleted) when the new config is written'
fi

# --- migration/gating: NetworkManager image -> systemd-networkd ------------
# Mask (and, live, stop first) everything that competes for the uplink or
# would flush/regenerate: NetworkManager (PiOS Legacy Lite Bookworm image),
# dhcpcd, stock tor (we ship tor-guest.service), and nftables.service, whose
# stock ExecStop would `nft flush ruleset` and delete our tables. Only units
# actually present in the target are touched.
for u in NetworkManager.service NetworkManager-wait-online.service \
         NetworkManager-dispatcher.service dhcpcd.service dhcpcd5.service \
         dhcpcd6.service networking.service tor.service tor@.service \
         nftables.service; do
    if find_unit "$u" >/dev/null; then
        if [ "$LIVE" = 1 ] && [ "$u" != nftables.service ] && \
           systemctl is-active --quiet "$u" 2>/dev/null; then
            systemctl stop "$u" || die "cannot stop active $u in live target"
        fi
        systemctl_do disable "$u" >/dev/null 2>&1 || true
        systemctl_do mask "$u" >/dev/null 2>&1 ||
            die "cannot mask $u (already replaced by a local unit file?)"
        info "disabled+masked $u"
    fi
done

if [ -d "$ROOT/etc/cloud" ]; then
    mkdir -p "$ROOT/etc/cloud/cloud.cfg.d"
    printf '%s\n' \
        '# tor-guest: cloud-init must not regenerate network configuration' \
        'network: {config: disabled}' \
        > "$ROOT/etc/cloud/cloud.cfg.d/99-tor-guest-disable-network-config.cfg"
    info 'wrote /etc/cloud/cloud.cfg.d/99-tor-guest-disable-network-config.cfg (cloud-init present)'
fi

# --- generate root-owned nft/torrc/hash at INSTALL time (no Node anywhere) -
CONF_DIR="$ROOT/etc/tor-guest"
mkdir -p "$CONF_DIR" "$ROOT/usr/local/sbin" "$ROOT/etc/systemd/network"

nft_template() {
cat <<'NFT_TEMPLATE_EOF'
# tor-guest.nft — generated for tor uid __TOR_UID__ / dhcp uid __DHCP_UID__.
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
		meta skuid __TOR_UID__ return
		# Loopback destinations stay local (Tor listeners, guest services).
		ip daddr 127.0.0.0/8 return
		# All non-Tor IPv4 DNS -> Tor DNSPort on loopback.
		udp dport 53 redirect to :5353
		# All remaining non-Tor IPv4 TCP -> Tor TransPort on loopback.
		meta l4proto tcp redirect to :9040
	}
}

table inet tor_guest_filter {
	chain input {
		type filter hook input priority filter; policy drop;
		iifname "lo" accept
		# DHCP replies (IPv4, server 67 -> client 68) only.
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
		# DHCP client requests (IPv4, 68 -> 67), DHCP user only.
		meta skuid __DHCP_UID__ meta nfproto ipv4 udp sport 68 udp dport 67 accept
		# Tor relay egress: IPv4 TCP only, never to loopback.
		meta skuid __TOR_UID__ ip daddr != 127.0.0.0/8 meta l4proto tcp accept
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
NFT_TEMPLATE_EOF
}

torrc_template() {
cat <<'TORRC_TEMPLATE_EOF'
# torrc — generated for a disposable Debian guest.
# Run Tor as the dedicated user that owns uid __TOR_UID__; ports match tor-guest.nft.
SocksPort 127.0.0.1:9050
TransPort 127.0.0.1:9040
DNSPort 127.0.0.1:5353
# Map .onion and resolved hostnames into a private, non-loopback IPv4 range
# so non-Tor TCP toward those addresses is transparently proxied, not leaked.
AutomapHostsOnResolve 1
VirtualAddrNetworkIPv4 10.192.0.0/10
# This node must never be used as an exit relay.
ExitPolicy reject *:*
TORRC_TEMPLATE_EOF
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

nft_template | sed -e "s/__TOR_UID__/$tor_uid/g" -e "s/__DHCP_UID__/$dhcp_uid/g" \
    > "$WORK/tor-guest.nft"
torrc_template | sed -e "s/__TOR_UID__/$tor_uid/g" -e "s/__DHCP_UID__/$dhcp_uid/g" \
    > "$WORK/torrc"
cat >> "$WORK/torrc" <<'EOF'
# Appended by guest-install.sh at install time. Nothing here overrides or
# weakens the generated policy above (no listeners, ports, addresses or
# exit rules are repeated): only the dedicated state directory and logging.
DataDirectory /var/lib/tor-guest
Log notice stdout
EOF

printf '%s\n' \
    '# tor-guest resolved identities (install-time; re-verified by the' \
    '# loader on every boot; mismatch refuses to load)' \
    "tor_account=$TOR_ACCOUNT" \
    "tor_uid=$tor_uid" \
    "dhcp_account=$DHCP_ACCOUNT" \
    "dhcp_uid=$dhcp_uid" \
    "iface=$IFACE" \
    "iface_type=$IFACE_TYPE" \
    > "$WORK/uids"

install_file() { # src dst mode
    if [ "$(id -u)" = 0 ]; then
        install -m "$3" -o 0 -g 0 "$1" "$2"
    else
        # offline/test tree as non-root: mode only, ownership is the tree
        # owner's; a real guest install runs as root
        install -m "$3" "$1" "$2"
    fi
}

install_file "$WORK/tor-guest.nft" "$CONF_DIR/tor-guest.nft" 0644
install_file "$WORK/torrc" "$CONF_DIR/torrc" 0644
install_file "$WORK/uids" "$CONF_DIR/uids" 0644
(cd "$WORK" && sha256sum tor-guest.nft > tor-guest.nft.sha256 && sha256sum torrc > torrc.sha256)
install_file "$WORK/tor-guest.nft.sha256" "$CONF_DIR/tor-guest.nft.sha256" 0644
install_file "$WORK/torrc.sha256" "$CONF_DIR/torrc.sha256" 0644
if [ "$(id -u)" = 0 ]; then
    chown 0:0 "$CONF_DIR" "$CONF_DIR"/* 2>/dev/null || true
fi
info "wrote $CONF_DIR/{tor-guest.nft,torrc,uids,*.sha256} (root-owned at install time)"

# --- loader and units --------------------------------------------------------
install_file "$SRC_DIR/tor-guest-load-nft.sh" "$ROOT/usr/local/sbin/tor-guest-load-nft" 0755
install_file "$SRC_DIR/units/tor-guest-firewall.service" \
    "$ROOT/etc/systemd/system/tor-guest-firewall.service" 0644
sed -e "s/__TOR_USER__/$TOR_ACCOUNT/g" "$SRC_DIR/units/tor-guest.service" > "$WORK/tor-guest.service"
install_file "$WORK/tor-guest.service" "$ROOT/etc/systemd/system/tor-guest.service" 0644
info 'installed loader /usr/local/sbin/tor-guest-load-nft and units tor-guest-firewall.service tor-guest.service'

# --- explicit Requires/After= firewall on the dependents ---------------------
# Before= alone only orders; it does not propagate failure. Every unit that
# must not run without the firewall gets Requires=+After= via a drop-in (the
# two shipped units carry it inline). The workspace unit is NOT given any
# network-online or Tor-bootstrap wait.
write_gating_dropin() { # unit  (caller checked existence)
    _u=$1
    _d="$ROOT/etc/systemd/system/$_u.d"
    mkdir -p "$_d"
    printf '%s\n' \
        '# tor-guest: fail closed with the firewall unit. Requires= (not just' \
        '# Before=) so a failed firewall load prevents this unit from starting.' \
        '[Unit]' \
        'Requires=tor-guest-firewall.service' \
        'After=tor-guest-firewall.service' \
        > "$_d/20-tor-guest-firewall.conf"
    info "wrote gating drop-in for $_u"
}

write_gating_dropin systemd-networkd.service
RESOLVED_PRESENT=0
if find_unit systemd-resolved.service >/dev/null; then
    RESOLVED_PRESENT=1
    write_gating_dropin systemd-resolved.service
else
    info 'systemd-resolved.service not present in target — resolver gating skipped; a fail-closed sentinel resolv.conf is written instead (below)'
fi
if [ -n "$WORKSPACE_UNIT" ]; then
    if find_unit "$WORKSPACE_UNIT" >/dev/null; then
        write_gating_dropin "$WORKSPACE_UNIT"
    else
        die "workspace unit $WORKSPACE_UNIT not found in target — the drop-in is only written for a unit that exists (agent accounts/units are owned by the storage slice)"
    fi
fi

# --- deterministic networkd config for the verified interface ----------------
# Retirement machinery first: conflicts detected pre-mutation are MOVED
# (never deleted) into /var/lib/tor-guest/retired-network/, preserving their
# path, with sha256 and reason recorded in /etc/tor-guest/retired-network.txt.
RETIRE_DIR="$ROOT/var/lib/tor-guest/retired-network"
MANIFEST="$CONF_DIR/retired-network.txt"
manifest_add() { # line
    if [ ! -f "$MANIFEST" ]; then
        printf '%s\n' \
            '# tor-guest retired configuration: files MOVED aside by' \
            '# guest-install.sh (never deleted). One record per line:' \
            '# sha256-or-symlink-target  reason  original-path (relative to /).' \
            '# Restore = move the file back and remove the replacement.' \
            > "$MANIFEST"
    fi
    printf '%s\n' "$1" >> "$MANIFEST"
}
retire_file() { # path reason   (no-op for a missing path)
    _p=$1
    _why=$2
    [ -e "$_p" ] || [ -L "$_p" ] || return 0
    _rel=${_p#"$ROOT"/}
    _dst="$RETIRE_DIR/$_rel"
    mkdir -p "${_dst%/*}"
    if [ -L "$_p" ]; then
        _rec="symlink->$(readlink "$_p" 2>/dev/null || printf '?')"
    else
        _rec=$(sha256sum "$_p" | awk '{ print $1 }')
    fi
    mv "$_p" "$_dst"
    manifest_add "$_rec  $_why  $_rel"
    info "retired ($_why): $_rel -> ${_dst#"$ROOT"/}"
}

if [ -n "$CONFLICTS" ] && [ "$RETIRE_CONFLICTS" = 1 ]; then
    _tab=$(printf '\t')
    printf '%s\n' "$CONFLICTS" | while IFS="$_tab" read -r _kind _path; do
        [ -n "$_kind" ] || continue
        retire_file "$_path" "network-conflict"
    done
fi

NETWORK_FILE="$ROOT/etc/systemd/network/10-tor-guest-uplink.network"
cat > "$NETWORK_FILE" <<EOF
# tor-guest uplink: deterministic single-interface config. Precedence is
# enforced, not hoped for: the installer REFUSED (or retired) every target
# .network matching $IFACE that sorts before this name, in every search
# dir (/etc, /run, /usr/lib, /lib), so per systemd.network(5) this first
# lexical match owns the interface.
[Match]
Name=$IFACE

[Network]
DHCP=ipv4
# No IPv6 anywhere on the uplink (the nft policy drops it regardless);
# no link-local autoconfiguration, no RA acceptance.
IPv6AcceptRA=no
LinkLocalAddressing=no
# Disable unrelated L2 listeners/emitters: networkd's AF_PACKET sockets
# (LLDP) beyond the DHCP client itself must not exist.
LLDP=no
LLMNR=no
MulticastDNS=no
EOF
[ "$(id -u)" = 0 ] && chown 0:0 "$NETWORK_FILE" 2>/dev/null || true
if [ -f "$MANIFEST" ]; then
    [ "$(id -u)" = 0 ] && chown -R 0:0 "$RETIRE_DIR" "$MANIFEST" 2>/dev/null || true
fi
info "wrote $NETWORK_FILE (Name=$IFACE, DHCP=ipv4, no RA/link-local/LLDP/LLMNR/mDNS)"

# --- resolver: an explicit, working path once NM/dhcpcd are masked ------------
# Masking NetworkManager/dhcpcd leaves /etc/resolv.conf pointing at their
# dead runtime files (or at nothing). Exactly one reviewed path is established:
#  - systemd-resolved in the image: it is enabled and firewall-gated (drop-in
#    above) and /etc/resolv.conf points at the 127.0.0.53 stub. Applications
#    reach the stub over loopback; resolved's own upstream queries are
#    non-Tor, non-loopback udp/53 and are redirected by the nat output chain
#    to Tor's DNSPort, so resolution still goes through Tor.
#  - no resolved in the image (an offline installer cannot add packages): a
#    static fail-closed sentinel `nameserver 192.0.2.1` (RFC 5737, unroutable).
#    It only resolves BECAUSE the firewall redirects udp/53 and tcp/53 to
#    Tor's DNSPort/TransPort; without the policy loaded it resolves nothing.
RESOLV="$ROOT/etc/resolv.conf"
if [ "$RESOLVED_PRESENT" = 1 ]; then
    if [ -L "$RESOLV" ] && [ "$(readlink "$RESOLV")" = /run/systemd/resolve/stub-resolv.conf ]; then
        info '/etc/resolv.conf already points at the resolved stub'
    else
        retire_file "$RESOLV" resolver-replacement
        ln -s /run/systemd/resolve/stub-resolv.conf "$RESOLV"
        info '/etc/resolv.conf -> /run/systemd/resolve/stub-resolv.conf (systemd-resolved enabled + firewall-gated; upstream DNS redirected to Tor DNSPort)'
    fi
else
    retire_file "$RESOLV" resolver-replacement
    printf '%s\n' \
        '# Written by guest-install.sh: this image has no systemd-resolved.' \
        '# Sentinel resolver (RFC 5737, unroutable): the tor-guest firewall' \
        '# redirects all non-Tor, non-loopback udp/53 and tcp/53 to Tor DNSPort' \
        '# /TransPort, so name resolution goes through Tor. WITHOUT the' \
        '# firewall this file resolves nothing (fail closed). Do not replace' \
        '# it with a real resolver address.' \
        'nameserver 192.0.2.1' \
        > "$RESOLV"
    chmod 0644 "$RESOLV"
    [ "$(id -u)" = 0 ] && chown 0:0 "$RESOLV" 2>/dev/null || true
    info 'no systemd-resolved in image: wrote fail-closed sentinel /etc/resolv.conf (resolution goes through the Tor DNSPort redirect)'
fi

# --- enable (enable only; nothing is started by this installer) ---------------
ENABLE_UNITS='systemd-networkd.service tor-guest-firewall.service tor-guest.service'
if [ "$RESOLVED_PRESENT" = 1 ]; then
    ENABLE_UNITS="$ENABLE_UNITS systemd-resolved.service"
fi
systemctl_do enable $ENABLE_UNITS ||
    die "cannot enable $ENABLE_UNITS"

info 'install complete. Summary of what the next boot will do:'
info ' - tor-guest-firewall.service loads the owned tables in one atomic transaction'
info '   (hash/uid/syntax verified; any failure keeps old tables and holds the'
info '   Required dependents down, so the guest stays offline, not egress-bare)'
info ' - the loader re-validates on every guarded boot, before any networking:'
info '   the recorded uplink exists in /sys/class/net with type 1, and the'
info '   effective networkd User= still matches the recorded DHCP account'
info ' - systemd-networkd configures only '"$IFACE"' (IPv4 DHCP; no RA/LLDP/LLMNR/mDNS);'
info '   conflicting target config was refused (or retired, never deleted)'
if [ "$RESOLVED_PRESENT" = 1 ]; then
    info ' - resolver: systemd-resolved (enabled, firewall-gated) with /etc/resolv.conf'
    info '   -> the 127.0.0.53 stub; its upstream DNS is redirected to Tor DNSPort'
else
    info ' - resolver: fail-closed sentinel /etc/resolv.conf (no resolved in image);'
    info '   resolution goes through the Tor DNSPort redirect'
fi
info ' - tor-guest.service runs Tor as '"$TOR_ACCOUNT"' with loopback listeners only'
info ' - evidence collection: private serial console or offline disk only (no SSH;'
info '   the policy drops root SSH replies once loaded). See README.md for the'
info '   clone-boot harness and acceptance scenarios.'
