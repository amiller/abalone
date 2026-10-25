#!/bin/bash
# deploy.sh — deploy the accounts and the root-owned /opt/portable tree for
# the accounts+vault milestone. This is the ONLY script in this slice that
# creates accounts, and it deliberately does NOT enable, start, mask or edit
# any systemd unit, boot configuration, fstab, crypttab or package: applying
# units is the supervisor's reviewed step (see portable/raspberry-pi/storage/README.md).
#
# Accounts created (system accounts, nologin shells, no sudo anywhere):
#   portable-agent    agent session account — member of NO privileged group
#   portable-ui       unprivileged workspace UI — NO lifecycle authority
#   portable-credit   journal owner — member of portable-operators
# plus portable-operators and the unprivileged portable-ipc group. The root-side lifecycle helper (the
# broker and these scripts) has no account: it runs as root.
#
# Usage:
#   deploy.sh                 # install to /opt/portable (requires root)
#   deploy.sh --stage DIR     # write the tree under DIR only (review/staging;
#                             # no accounts, no chown — for packaging and tests)
set -euo pipefail
umask 077
LC_ALL=C
export LC_ALL
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

PREFIX=/opt/portable
STAGE=
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) [ $# -ge 2 ] || usage_error '--stage requires a directory'; STAGE="$2"; shift 2 ;;
    --stage=*) STAGE="${1#*=}"; shift ;;
    --prefix) [ $# -ge 2 ] || usage_error '--prefix requires a directory'; PREFIX="$2"; shift 2 ;;
    --prefix=*) PREFIX="${1#*=}"; shift ;;
    --state-lib-dir) [ $# -ge 2 ] || usage_error '--state-lib-dir requires a directory'; STATE_LIB_DIR="$2"; shift 2 ;;
    --state-lib-dir=*) STATE_LIB_DIR="${1#*=}"; shift ;;
    -h|--help) sed -n '3,18p' "$0"; exit 0 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done
: "${STATE_LIB_DIR:=/var/lib/portable}"

SRCDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$SRCDIR/common.sh" ] || die "$EX_PRECOND" "cannot locate script sources next to $0"
[ -d "$SRCDIR/../units" ] || die "$EX_PRECOND" "cannot locate units directory next to $SRCDIR (expected $SRCDIR/../units)"
[ -f "$SRCDIR/vault.conf.example" ] || die "$EX_PRECOND" "cannot locate vault.conf.example next to $0"

if [ -n "$STAGE" ]; then
  DEST="$STAGE"
  log "staging mode: writing tree under $DEST (accounts NOT created; install as root:root 0755/0644 when deploying)"
else
  require_root
  DEST="$PREFIX"
  for tool in useradd groupadd getent id; do require_command "$tool"; done
fi
# --- accounts (deploy mode only) ---------------------------------------------
if [ -z "$STAGE" ]; then
  # Fixed image identities, not arbitrary reuse of same-named host accounts.
  # Check the WHOLE requested account graph before the first account mutation.
  account_id() {
    case "$1" in
      portable-agent) printf 970 ;;
      portable-ui) printf 971 ;;
      portable-credit) printf 972 ;;
      portable-operators) printf 973 ;;
      portable-ipc) printf 974 ;;
    esac
  }
  lookup() {
    local rc
    if LOOKUP="$(getent "$1" "$2")"; then return 0; else rc=$?; fi
    [ "$rc" = 2 ] || die "$EX_PRECOND" "account database probe failed for $1 $2 (exit $rc)"
    LOOKUP=
    return 1
  }
  check_group() {
    local name="$1" want row gn pw gid members extra byid
    want="$(account_id "$name")"
    if lookup group "$name"; then
      row="$LOOKUP"
      IFS=: read -r gn pw gid members extra <<< "$row"
      [ "$gn" = "$name" ] && [ "$gid" = "$want" ] && [ -z "$extra" ] \
        || die "$EX_PRECOND" "unexpected identity for group $name (expected gid $want)"
      case "$name:$members" in
        portable-operators:|portable-operators:portable-credit|portable-agent:|portable-ui:|portable-credit:|portable-ipc:|portable-ipc:portable-agent|portable-ipc:portable-ui|portable-ipc:portable-agent,portable-ui|portable-ipc:portable-ui,portable-agent) ;;
        *) die "$EX_PRECOND" "unexpected members of $name; workspace UI and agent must have no vault authority" ;;
      esac
    fi
    if lookup group "$want"; then
      IFS=: read -r byid _ <<< "$LOOKUP"
      [ "$byid" = "$name" ] || die "$EX_PRECOND" "reserved gid $want belongs to $byid, not $name"
    fi
  }
  check_account() {
    local name="$1" want row un pw uid gid comment home shell extra byid groups expected
    want="$(account_id "$name")"
    if lookup passwd "$name"; then
      row="$LOOKUP"
      IFS=: read -r un pw uid gid comment home shell extra <<< "$row"
      [ "$un" = "$name" ] && [ "$uid" = "$want" ] && [ "$gid" = "$want" ] \
        && [ "$home" = "/var/lib/portable/$name" ] && [ "$shell" = /usr/sbin/nologin ] && [ -z "$extra" ] \
        || die "$EX_PRECOND" "unexpected uid/gid/home/shell for $name; refusing existing account reuse"
      groups="$(id -nG "$name")" || die "$EX_PRECOND" "cannot inspect groups for $name"
      groups="$(printf '%s\n' "$groups" | tr ' ' '\n' | sort -u | tr '\n' ' ')"
      case "$name" in
        portable-agent) expected='portable-agent portable-ipc ' ;;
        portable-ui) expected='portable-ipc portable-ui ' ;;
        portable-credit) expected='portable-credit portable-operators ' ;;
      esac
      [ "$groups" = "$expected" ] \
        || die "$EX_PRECOND" "unexpected groups for $name ($groups); fix the account explicitly before deployment"
    fi
    if lookup passwd "$want"; then
      IFS=: read -r byid _ <<< "$LOOKUP"
      [ "$byid" = "$name" ] || die "$EX_PRECOND" "reserved uid $want belongs to $byid, not $name"
    fi
  }
  for name in portable-agent portable-ui portable-credit portable-operators portable-ipc; do check_group "$name"; done
  for name in portable-agent portable-ui portable-credit; do check_account "$name"; done
  # An old privileged config must not survive an otherwise safe redeployment.
  if [ -e "$DEST/etc/vault.conf" ]; then
    load_trusted_config "$DEST/etc/vault.conf"
  fi
  for name in portable-agent portable-ui portable-credit portable-operators portable-ipc; do
    if ! lookup group "$name"; then
      groupadd --system --gid "$(account_id "$name")" "$name"
    fi
  done
  for name in portable-agent portable-ui portable-credit; do
    if ! lookup passwd "$name"; then
      extra=(--groups portable-ipc)
      [ "$name" != portable-credit ] || extra=(--groups portable-operators)
      useradd --system --uid "$(account_id "$name")" --gid "$name" --no-create-home \
        --shell /usr/sbin/nologin --home-dir "/var/lib/portable/$name" "${extra[@]}" "$name"
    fi
  done
  # Verify actual postconditions before installing privileged helpers.
  for name in portable-agent portable-ui portable-credit portable-operators portable-ipc; do check_group "$name"; done
  for name in portable-agent portable-ui portable-credit; do check_account "$name"; done
  log 'account identities verified; only portable-credit has vault lifecycle authority'

  # /var/lib/portable/<account> state directories (systemd StateDirectory
  # counterparts for the unit templates).
  for account in portable-agent portable-ui portable-credit; do
    mkdir -p "$STATE_LIB_DIR/$account"
    chown "$account:$account" "$STATE_LIB_DIR/$account"
    chmod 0700 "$STATE_LIB_DIR/$account"
  done
fi

# --- root-owned tree -----------------------------------------------------------
install -d -m 0755 "$DEST" "$DEST/bin" "$DEST/etc" "$DEST/systemd"
install -m 0755 \
  "$SRCDIR/common.sh" "$SRCDIR/check-prereqs.sh" "$SRCDIR/deploy.sh" \
  "$SRCDIR/provision-vault.sh" "$SRCDIR/unlock-vault.sh" "$SRCDIR/lock-vault.sh" \
  "$SRCDIR/vault-status.sh" "$SRCDIR/verify-fs-boundary.sh" "$SRCDIR/volatile-root.sh" \
  "$DEST/bin/"
install -m 0755 "$SRCDIR/vault-broker.py" "$DEST/bin/"
if [ -f "$SRCDIR/../README.md" ]; then
  install -m 0644 "$SRCDIR/../README.md" "$DEST/README.md"
fi
install -m 0644 "$SRCDIR/vault.conf.example" "$DEST/etc/vault.conf.example"
# Every file in units/ (broker units and hardened app-unit templates for the
# other slices) is copied verbatim; nothing here enables anything.
for unit in "$SRCDIR"/../units/*; do
  [ -f "$unit" ] || continue
  install -m 0644 "$unit" "$DEST/systemd/"
done

# vault.conf: create from the example ONLY when absent; never overwrite a
# pinned configuration (the UUID is supervisor-owned state).
if [ ! -e "$DEST/etc/vault.conf" ]; then
  install -m 0600 "$SRCDIR/vault.conf.example" "$DEST/etc/vault.conf"
  log "created $DEST/etc/vault.conf from example (mode 0600; VAULT_LUKS_UUID still empty)"
else
  log "$DEST/etc/vault.conf already exists; left untouched (idempotent redeploy)"
fi

if [ -z "$STAGE" ]; then
  # Ownership: everything under /opt/portable belongs to root.
  chown -R root:root "$PREFIX"
  chmod 0755 "$PREFIX" "$PREFIX/bin" "$PREFIX/etc" "$PREFIX/systemd"
  chmod 0600 "$PREFIX/etc/vault.conf"
  out "deployed: $PREFIX (root:root)"
  out "next (supervisor, reviewed steps — units are NEVER enabled here):"
  out "  1. check-prereqs.sh"
  out "  2. provision-vault.sh --device <declared fresh disk> --confirm ERASE-NEW-VAULT-DISK"
  out "  3. pin the printed VAULT_LUKS_UUID into $PREFIX/etc/vault.conf"
  out "  4. systemd-analyze verify $PREFIX/systemd/portable-vault-broker.service"
  out "  5. cp $PREFIX/systemd/*.service /etc/systemd/system/ (if wanted) and: systemctl daemon-reload"
  out "  6. systemctl enable --now portable-vault-broker.service   # root broker in the HOST mount namespace; see $PREFIX/README.md"
  out "  7. verify-fs-boundary.sh after the first unlock"
else
  out "staged tree: $DEST"
  out "accounts were NOT created (staging mode); verify-fs-boundary.sh --staged for text-level checks"
fi
exit "$EX_OK"
