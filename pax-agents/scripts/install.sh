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

mkdir -p "$TARGET/.claude" "$TARGET/.claude/agents" "$TARGET/.claude/commands/pax" "$TARGET/.claude/process-acceleration-executors" "$TARGET/.claude/hooks"

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$TARGET/.claude/.pax-backup-$STAMP"
mkdir -p "$BACKUP_DIR"

backup_if_exists() {
  local path="$1"
  if [[ -e "$path" ]]; then
    local rel
    rel="${path#$TARGET/}"
    mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
    cp -R "$path" "$BACKUP_DIR/$rel"
  fi
}

backup_if_exists "$TARGET/.claude/agents"
backup_if_exists "$TARGET/.claude/commands/pax"
backup_if_exists "$TARGET/.claude/process-acceleration-executors"
backup_if_exists "$TARGET/.claude/hooks/pax-check-update.js"
backup_if_exists "$TARGET/.claude/hooks/pax-statusline.js"

find "$TARGET/.claude/agents" -maxdepth 1 -type f -name 'pax-*.md' -delete
rm -rf "$TARGET/.claude/commands/pax"
mkdir -p "$TARGET/.claude/commands/pax"
rm -rf "$TARGET/.claude/process-acceleration-executors"
mkdir -p "$TARGET/.claude/process-acceleration-executors"

cp "$PKG_ROOT/.claude/agents/"pax-*.md "$TARGET/.claude/agents/"
cp -R "$PKG_ROOT/.claude/commands/pax/." "$TARGET/.claude/commands/pax/"
cp -R "$PKG_ROOT/.claude/process-acceleration-executors/." "$TARGET/.claude/process-acceleration-executors/"
cp "$PKG_ROOT/.claude/hooks/pax-check-update.js" "$TARGET/.claude/hooks/"
cp "$PKG_ROOT/.claude/hooks/pax-statusline.js" "$TARGET/.claude/hooks/"
chmod +x "$TARGET/.claude/hooks/pax-check-update.js" "$TARGET/.claude/hooks/pax-statusline.js"

if [[ ! -f "$TARGET/.claude/settings.json" ]]; then
  cp "$PKG_ROOT/.claude/settings.template.json" "$TARGET/.claude/settings.json"
  echo "Created .claude/settings.json from template"
fi

echo "Installed PAX package into: $TARGET"
echo "Backup created at: $BACKUP_DIR"
echo "Next: $PKG_ROOT/scripts/doctor.sh $TARGET"
