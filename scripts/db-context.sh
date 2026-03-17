#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

EXISTING_CHEDDAR_DB_PATH="${CHEDDAR_DB_PATH:-}"
CANONICAL_PROD_DB_PATH="/opt/data/cheddar-prod.db"

is_production_host=false
if [[ "$ROOT_DIR" == "/opt/cheddar-logic" ]] || [[ "${NODE_ENV:-}" == "production" ]]; then
  is_production_host=true
fi
if [[ "${CHEDDAR_ENV_FILE:-}" == *".env.production" ]]; then
  is_production_host=true
fi

ENV_FILE="${CHEDDAR_ENV_FILE:-$ROOT_DIR/.env}"
if [ -z "${CHEDDAR_ENV_FILE:-}" ] && [ "$is_production_host" = true ] && [ -f "$ROOT_DIR/.env.production" ]; then
  ENV_FILE="$ROOT_DIR/.env.production"
fi

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [ -n "$EXISTING_CHEDDAR_DB_PATH" ]; then
  if [ "$is_production_host" = true ] && [ "$EXISTING_CHEDDAR_DB_PATH" != "$CANONICAL_PROD_DB_PATH" ]; then
    echo "[DB-CONTEXT][ERROR] Refusing shell override CHEDDAR_DB_PATH=$EXISTING_CHEDDAR_DB_PATH on production host. Expected $CANONICAL_PROD_DB_PATH" >&2
    exit 1
  fi
  export CHEDDAR_DB_PATH="$EXISTING_CHEDDAR_DB_PATH"
fi

unset DATABASE_PATH
unset RECORD_DATABASE_PATH
unset DATABASE_URL

# Production should set CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db in .env.production.
if [ "$is_production_host" = true ]; then
  if [ -z "${CHEDDAR_DB_PATH:-}" ]; then
    echo "[DB-CONTEXT][ERROR] CHEDDAR_DB_PATH is unset on production host. Set CHEDDAR_DB_PATH=$CANONICAL_PROD_DB_PATH in .env.production" >&2
    exit 1
  fi
  if [ "$CHEDDAR_DB_PATH" != "$CANONICAL_PROD_DB_PATH" ]; then
    echo "[DB-CONTEXT][ERROR] Non-canonical CHEDDAR_DB_PATH on production host: $CHEDDAR_DB_PATH (expected $CANONICAL_PROD_DB_PATH)" >&2
    exit 1
  fi
else
  export CHEDDAR_DB_PATH="${CHEDDAR_DB_PATH:-/tmp/cheddar-logic/cheddar.db}"
fi

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
