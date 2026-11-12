#!/bin/sh
# apply.sh — (re-)apply this package's patches to the installed
# @juicesharp/rpiv-ask-user-question package:
#   0001-partial-answer-registration.patch
#     `partial?: boolean` on the answer channel: partial sets register into
#     the MOUNTED TUI dialog (entries + clears + tab advance) for DISPLAY
#     without resolving the wait. Consumed by pi-matrix-integration's
#     ask-user mirror (per-reply display sync while the authoritative
#     complete set ships on confirm).
#   0002-terminal-answers-sync.patch
#     Outbound `rpiv:ask-user:answers-state`: every answer-map change in the
#     mounted dialog (terminal keystroke OR a 0001 partial registration)
#     broadcasts the full answer map, so a mirroring host sees terminal-side
#     answers and can arm its own review surface. 0002's context assumes
#     0001 is in place — the order matters.
#
# Without these two hunks the room question flow still works (a complete
# answer set on confirm settles the wait), but the terminal dialog does not
# follow room replies and terminal keystrokes do not reach the room.
#
# Usage:
#   sh apply.sh            # apply (or confirm already applied) the patches
#   sh apply.sh --check    # exit 0 when applied, 1 when missing
#
# Idempotent. Run it after every install or update of
# @juicesharp/rpiv-ask-user-question — an update replaces the package on
# disk and drops the patches. Dry-run first: never half-patches — if upstream
# moved a hunk, the script stops and says so. A refusal therefore left nothing
# half-applied: fix the cause it names (a missing `patch` binary is the common
# one) and re-run.

set -eu

PATCH_HOME="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PKG="${PI_MATRIX_AUQ_PKG:-$HOME/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question}"
GENERATED_AGAINST="0001: 2.13.9 · 0002: 2.13.9 + 0001 (both verified to apply on 2.15.0)"

[ -d "$PKG" ] || {
  echo "package not found at $PKG"
  echo "install it first:  pi install npm:@juicesharp/rpiv-ask-user-question"
  exit 1
}

# Without `patch` every dry-run below "fails" with the misleading diagnosis
# that upstream changed the context — the real reason (`patch: not found`) is
# swallowed by the dry-run's own redirect. Say what is missing instead.
command -v patch > /dev/null 2>&1 || {
  echo "'patch' is not installed — this script cannot patch anything."
  echo "install it (debian/ubuntu: apt-get install patch · alpine: apk add patch), then re-run."
  exit 1
}

installed_version="$(node -e "console.log(require('$PKG/package.json').version)" 2>/dev/null || echo unknown)"
echo "package: $PKG (version $installed_version, patches generated against $GENERATED_AGAINST)"
MODE="${1:-}"

apply_one() { # $1=patch-file $2=marker $3=marker-file $4=label
  patch_file="$1"; marker="$2"; marker_file="$3"; label="$4"
  [ -f "$patch_file" ] || { echo "patch file missing: $patch_file"; exit 1; }
  if grep -q "$marker" "$PKG/$marker_file" 2>/dev/null; then
    echo "$label already applied — nothing to do."
    return 0
  fi
  if [ "$MODE" = "--check" ]; then
    echo "$label not applied."
    exit 1
  fi
  if ! patch -p1 --dry-run -d "$PKG" < "$patch_file" > /dev/null 2> /tmp/pi-matrix-ask-user-dryrun.err; then
    echo "DRY-RUN FAILED for $label — patch does not apply cleanly (upstream likely changed the context)."
    cat /tmp/pi-matrix-ask-user-dryrun.err
    echo ""
    echo "The terminal-sync behaviour needs these hunks; the room question flow works without them."
    exit 1
  fi
  patch -p1 -d "$PKG" < "$patch_file"
  if ! grep -q "$marker" "$PKG/$marker_file"; then
    echo "ERROR: $label applied but marker not found — undo with:"
    echo "  patch -p1 -d '$PKG' -R < '$patch_file'"
    exit 1
  fi
  echo "$label applied OK."
}

apply_one "$PATCH_HOME/0001-partial-answer-registration.patch" "Patch A2.13-0001" "answer-channel.ts" "0001 (partial answer registration)"
apply_one "$PATCH_HOME/0002-terminal-answers-sync.patch" "Patch A2.13-0002" "answer-channel.ts" "0002 (terminal answers sync)"

if [ "$MODE" = "--check" ]; then
  echo "applied OK."
  exit 0
fi

echo "applied OK."
echo "restart Pi (or /reload) to load the patched extension."
