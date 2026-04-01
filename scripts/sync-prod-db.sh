#!/bin/bash
# Pull a snapshot of the production DB from CheddarPi for local dev.
#
# Usage:
#   ./scripts/sync-prod-db.sh [user@host]
#
# The snapshot is copied to ~/.cheddar/prod-snapshot.db.
# .env.local points CHEDDAR_DB_PATH at that path — web and worker
# both read from it without hitting the odds API or double-spending tokens.
# Writes from local model runs stay in the local copy — prod is never touched.
#
# Add to cron for automatic refresh, e.g. every 15 min:
#   */15 * * * * /path/to/cheddar-logic/scripts/sync-prod-db.sh

set -e

PROD_HOST="${1:-babycheeses11@cheddarpi.local}"
PROD_DB="/opt/data/cheddar-prod.db"
LOCAL_DIR="$HOME/.cheddar"
LOCAL_SNAPSHOT="$LOCAL_DIR/prod-snapshot.db"

mkdir -p "$LOCAL_DIR"

echo "[sync-prod-db] Pulling $PROD_HOST:$PROD_DB → $LOCAL_SNAPSHOT"
rsync -az --progress "$PROD_HOST:$PROD_DB" "$LOCAL_SNAPSHOT"
echo "[sync-prod-db] Done. $(ls -lh "$LOCAL_SNAPSHOT" | awk '{print $5}') on disk."
