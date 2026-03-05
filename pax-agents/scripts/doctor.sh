#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-.}"
FAIL=0

check_file() {
  local p="$1"
  if [[ ! -f "$TARGET/$p" ]]; then
    echo "[FAIL] Missing file: $p"
    FAIL=1
  else
    echo "[OK]   $p"
  fi
}

check_dir() {
  local p="$1"
  if [[ ! -d "$TARGET/$p" ]]; then
    echo "[FAIL] Missing dir: $p"
    FAIL=1
  else
    echo "[OK]   $p"
  fi
}

echo "Running doctor for: $TARGET"

check_dir ".claude/agents"
check_dir ".claude/commands/pax"
check_dir ".claude/process-acceleration-executors"
check_dir ".claude/hooks"

check_file ".claude/process-acceleration-executors/VERSION"
check_file ".claude/hooks/pax-check-update.js"
check_file ".claude/hooks/pax-statusline.js"

AGENTS_COUNT=$(find "$TARGET/.claude/agents" -maxdepth 1 -type f -name 'pax-*.md' 2>/dev/null | wc -l | tr -d ' ')
CMDS_COUNT=$(find "$TARGET/.claude/commands/pax" -maxdepth 1 -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')

if [[ "$AGENTS_COUNT" -lt 1 ]]; then
  echo "[FAIL] No pax agents found in .claude/agents"
  FAIL=1
else
  echo "[OK]   Found $AGENTS_COUNT pax agent files"
fi

if [[ "$CMDS_COUNT" -lt 1 ]]; then
  echo "[FAIL] No pax commands found in .claude/commands/pax"
  FAIL=1
else
  echo "[OK]   Found $CMDS_COUNT command files"
fi

if [[ $FAIL -ne 0 ]]; then
  echo "Doctor result: FAIL"
  exit 1
fi

echo "Doctor result: PASS"
