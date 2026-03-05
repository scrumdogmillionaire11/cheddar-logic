#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-.}"
FAIL=0

while IFS=: read -r file ref; do
  [[ -z "${file:-}" || -z "${ref:-}" ]] && continue
  target="$ROOT/${ref#@./}"
  if [[ ! -e "$target" ]]; then
    echo "[FAIL] Missing reference target"
    echo "       source: $file"
    echo "       ref:    $ref"
    FAIL=1
  fi
done < <(grep -RHEo '@\./\.claude/[A-Za-z0-9_./-]+' "$ROOT/.claude" 2>/dev/null)

while IFS=: read -r file cmd; do
  [[ -z "${file:-}" || -z "${cmd:-}" ]] && continue
  name="${cmd#/pax:}"
  cmd_file="$ROOT/.claude/commands/pax/$name.md"
  if [[ ! -f "$cmd_file" ]]; then
    echo "[WARN] Referenced slash command has no direct command file: $cmd (source: $file)"
  fi
done < <(grep -RHEo '/pax:[a-z0-9-]+' "$ROOT/.claude" 2>/dev/null)

if [[ $FAIL -ne 0 ]]; then
  echo "Link integrity: FAIL"
  exit 1
fi

echo "Link integrity: PASS"
