#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /path/to/target-project"
  exit 1
fi

TARGET="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ ! -d "$TARGET" ]]; then
  echo "Target directory does not exist: $TARGET"
  exit 1
fi

TARGET_ABS="$(cd "$TARGET" && pwd)"
DEST_PKG="$TARGET_ABS/vegas-agent"

mkdir -p "$TARGET_ABS/.claude/agents"

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$TARGET_ABS/.claude/.vegas-backup-$STAMP"
mkdir -p "$BACKUP_DIR"

backup_if_exists() {
  local path="$1"
  if [[ -e "$path" ]]; then
    local rel
    rel="${path#$TARGET_ABS/}"
    mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
    cp -R "$path" "$BACKUP_DIR/$rel"
  fi
}

backup_if_exists "$DEST_PKG"
backup_if_exists "$TARGET_ABS/.claude/agents/vegas-auditor.md"

if [[ -d "$DEST_PKG" ]]; then
  CURRENT_DEST="$(cd "$DEST_PKG" && pwd)"
  if [[ "$CURRENT_DEST" != "$PKG_ROOT" ]]; then
    rm -rf "$DEST_PKG"
    cp -R "$PKG_ROOT" "$DEST_PKG"
  fi
else
  cp -R "$PKG_ROOT" "$DEST_PKG"
fi

cp "$PKG_ROOT/.claude/agents/vegas-auditor.md" "$TARGET_ABS/.claude/agents/vegas-auditor.md"

echo "Installed VEGAS package into: $DEST_PKG"
echo "Installed agent definition: $TARGET_ABS/.claude/agents/vegas-auditor.md"
echo "Backup created at: $BACKUP_DIR"
echo "Next: $PKG_ROOT/scripts/doctor.sh $DEST_PKG"
