#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SNAPSHOT_DB="${HOME}/.cheddar/prod-snapshot.db"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

unset DATABASE_PATH
unset RECORD_DATABASE_PATH
unset DATABASE_URL

export CHEDDAR_DB_PATH="${CHEDDAR_SNAPSHOT_DB_PATH:-$SNAPSHOT_DB}"
export CHEDDAR_DATA_DIR="${CHEDDAR_DATA_DIR:-$(dirname "$CHEDDAR_DB_PATH")}"

if [[ "${1:-}" == "--sync" ]]; then
  "$ROOT_DIR/scripts/sync-prod-db.sh"
fi

if [[ "${1:-}" == "--check" ]] || [[ "${1:-}" == "--sync" ]]; then
  echo "[DEV-MODE:snapshot] CHEDDAR_DB_PATH=$CHEDDAR_DB_PATH"
  bash "$ROOT_DIR/scripts/db-context.sh"
  exit 0
fi

echo "[DEV-MODE:snapshot] Using DB: $CHEDDAR_DB_PATH"
echo "[DEV-MODE:snapshot] Start web: CHEDDAR_DB_PATH=$CHEDDAR_DB_PATH npm --prefix web run dev"
echo "[DEV-MODE:snapshot] Do NOT run local model jobs against this mode unless intentional"
