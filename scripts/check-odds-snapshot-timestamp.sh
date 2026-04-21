#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PATTERN='odds_snapshots[^\n]*created_at|created_at[^\n]*odds_snapshots|MAX\(created_at\).*FROM odds_snapshots|FROM odds_snapshots.*MAX\(created_at\)'

# We intentionally enforce captured_at for odds_snapshots. created_at remains valid
# for many other tables and should not be globally removed.
if rg -n "$PATTERN" --glob '**/*.{js,ts,sql,sh}' --glob '!scripts/check-odds-snapshot-timestamp.sh' > /tmp/odds_ts_violations.txt; then
  echo "[FAIL] Found odds_snapshots timestamp violations (use captured_at, not created_at):"
  cat /tmp/odds_ts_violations.txt
  exit 1
fi

echo "[OK] odds_snapshots uses captured_at consistently."
