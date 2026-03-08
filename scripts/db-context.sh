#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

EXISTING_CHEDDAR_DB_PATH="${CHEDDAR_DB_PATH:-}"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

if [ -n "$EXISTING_CHEDDAR_DB_PATH" ]; then
  export CHEDDAR_DB_PATH="$EXISTING_CHEDDAR_DB_PATH"
fi

unset DATABASE_PATH
unset RECORD_DATABASE_PATH
unset DATABASE_URL

# Production should set CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db in .env.production.
export CHEDDAR_DB_PATH="${CHEDDAR_DB_PATH:-/tmp/cheddar-logic/cheddar.db}"

MODE="local"
if [[ "$CHEDDAR_DB_PATH" == *"snapshot"* ]] || [[ "$CHEDDAR_DB_PATH" == *"/.cheddar/"* ]]; then
  MODE="snapshot"
fi

echo "[DB-CONTEXT] root: $ROOT_DIR"
echo "[DB-CONTEXT] mode: $MODE"
echo "[DB-CONTEXT] CHEDDAR_DB_PATH: $CHEDDAR_DB_PATH"

node - <<'NODE'
const fs = require('fs');
const { resolveDatabasePath } = require('./packages/data/src/db-path');

const resolved = resolveDatabasePath();
console.log(`[DB-CONTEXT] resolver source: ${resolved.source}`);
console.log(`[DB-CONTEXT] resolver path: ${resolved.dbPath}`);
console.log(`[DB-CONTEXT] file exists: ${fs.existsSync(resolved.dbPath)}`);
NODE

if command -v sqlite3 >/dev/null 2>&1 && [ -f "$CHEDDAR_DB_PATH" ]; then
  echo "[DB-CONTEXT] table counts:"
  sqlite3 "$CHEDDAR_DB_PATH" <<'SQL'
SELECT 'games' AS table_name, COUNT(*) AS row_count FROM games
UNION ALL
SELECT 'odds_snapshots', COUNT(*) FROM odds_snapshots
UNION ALL
SELECT 'card_payloads', COUNT(*) FROM card_payloads
UNION ALL
SELECT 'run_state', COUNT(*) FROM run_state
UNION ALL
SELECT 'card_results', COUNT(*) FROM card_results
UNION ALL
SELECT 'game_results', COUNT(*) FROM game_results;
SQL
else
  echo "[DB-CONTEXT] sqlite3 not available or DB file missing; skipping table counts"
fi
