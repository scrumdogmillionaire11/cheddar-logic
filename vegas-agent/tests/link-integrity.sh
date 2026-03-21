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
done < <(grep -RHEo '@\./[A-Za-z0-9_./-]+' "$ROOT/.claude" 2>/dev/null)

if [[ $FAIL -ne 0 ]]; then
  echo "Link integrity: FAIL"
  exit 1
fi

echo "Link integrity: PASS"
