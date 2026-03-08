#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

unset DATABASE_PATH
unset RECORD_DATABASE_PATH
unset DATABASE_URL

DEFAULT_LOCAL_DB="/tmp/cheddar-logic/cheddar.db"
export CHEDDAR_DB_PATH="${CHEDDAR_DB_PATH:-$DEFAULT_LOCAL_DB}"
export CHEDDAR_DATA_DIR="${CHEDDAR_DATA_DIR:-$(dirname "$CHEDDAR_DB_PATH")}"

if [[ "${1:-}" == "--check" ]]; then
  echo "[DEV-MODE:local] Mode: local (web + worker + scheduler share one DB)"
  echo "[DEV-MODE:local] CHEDDAR_DB_PATH=$CHEDDAR_DB_PATH"
  bash "$ROOT_DIR/scripts/db-context.sh"
  exit 0
fi

echo "[DEV-MODE:local] Mode: local (write-enabled via worker)"
echo "[DEV-MODE:local] Using DB: $CHEDDAR_DB_PATH"
echo "[DEV-MODE:local] Start web: CHEDDAR_DB_PATH=$CHEDDAR_DB_PATH npm --prefix web run dev"
echo "[DEV-MODE:local] Run worker jobs: set -a; source .env; set +a; npm --prefix apps/worker run job:pull-odds"
