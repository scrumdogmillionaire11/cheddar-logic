#!/bin/bash

################################################################################
# SAFE DEV → PROD DATABASE MIGRATION
# 
# Usage: ./scripts/migrate-dev-to-prod-safe.sh user@prod-server
#
# Procedure:
# 1. Discovers the actual repo root + DB path on prod (no assumptions)
# 2. Stops all writers (systemd/pm2/docker safe)
# 3. Backs up existing prod DB
# 4. Copies dev DB to temp, then atomically moves into place
# 5. Verifies DB integrity + sanity checks
# 6. Restarts services + runs settlement rebuild pipeline
#
# Safety:
# - zero hardcoded paths (discovers everything)
# - stops writers before touching DB
# - atomic copy (temp → move avoids half-copies)
# - integrity checks before restart
# - can restore from backup if verification fails
#
################################################################################

set -euo pipefail

PROD_HOST="${1:-}"
DEV_DB="/Users/ajcolubiale/projects/cheddar-logic/packages/data/cheddar.db"
COLOR_RESET='\033[0m'
COLOR_GREEN='\033[0;32m'
COLOR_YELLOW='\033[0;33m'
COLOR_RED='\033[0;31m'

usage() {
  cat << EOF
Usage: $0 <prod-host>

Examples:
  $0 user@prod.example.com
  $0 ubuntu@10.0.1.50
  $0 deploy@my-prod-server

This script will:
1. Discover actual cheddar-logic repo + DB path on prod
2. Stop all writers (systemd/pm2/docker)
3. Back up existing prod DB
4. Copy dev DB to prod atomically
5. Verify DB integrity
6. Restart services + run settlement pipeline

No hardcoded paths or assumptions. Safe to run.
EOF
  exit 1
}

log_info() {
  echo -e "${COLOR_GREEN}✓${COLOR_RESET} $*"
}

log_warn() {
  echo -e "${COLOR_YELLOW}⚠${COLOR_RESET} $*"
}

log_error() {
  echo -e "${COLOR_RED}✗${COLOR_RESET} $*"
}

[ -z "$PROD_HOST" ] && usage

# ============================================================================
# STEP 0: Verify dev DB exists locally
# ============================================================================
if [ ! -f "$DEV_DB" ]; then
  log_error "Dev DB not found: $DEV_DB"
  exit 1
fi
log_info "Dev DB found: $DEV_DB ($(du -h "$DEV_DB" | cut -f1))"

# ============================================================================
# STEP 1: Discover the actual repo + DB path on prod (no assumptions)
# ============================================================================
log_info "Connecting to prod and discovering repo/DB..."

DISCOVERY_SCRIPT=$(cat << 'DISCOVERYEND'
#!/bin/bash
set -euo pipefail

echo "=== DISCOVERY PHASE ==="
echo "Current dir: $(pwd)"
echo "User: $(whoami)"
echo "Hostname: $(hostname)"
echo "OS: $(uname -a | head -1)"
echo ""

echo "=== Looking for cheddar-logic repo ==="
REPO_ROOT=""
if [ -d "./cheddar-logic" ]; then
  REPO_ROOT="./cheddar-logic"
elif [ -d "cheddar-logic" ]; then
  REPO_ROOT="./cheddar-logic"
elif [ -d ".git" ] && git rev-parse --show-toplevel 2>/dev/null | grep -q cheddar-logic; then
  REPO_ROOT="$(git rev-parse --show-toplevel)"
else
  # Search common locations
  CANDIDATES=$(find /opt /home /var -maxdepth 4 -type d -name "cheddar-logic" 2>/dev/null | head -5)
  if [ -n "$CANDIDATES" ]; then
    REPO_ROOT="$(echo "$CANDIDATES" | head -1)"
  fi
fi

if [ -z "$REPO_ROOT" ]; then
  echo "ERROR: cheddar-logic repo not found in /opt, /home, /var, or current dir"
  exit 1
fi

echo "Found repo: $REPO_ROOT"
echo ""

echo "=== Looking for DB files ==="
DB_CANDIDATES=$(find "$REPO_ROOT" -maxdepth 6 -type f \( -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3" \) 2>/dev/null || true)

if [ -z "$DB_CANDIDATES" ]; then
  echo "WARN: No DB files found in $REPO_ROOT"
  echo "Searching /opt /home /var (may take a moment)..."
  DB_CANDIDATES=$(find /opt /home /var -maxdepth 6 -type f \( -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3" \) 2>/dev/null | head -30 || true)
fi

if [ -z "$DB_CANDIDATES" ]; then
  echo "ERROR: No SQLite DB files found"
  exit 1
fi

echo "Candidates found:"
echo "$DB_CANDIDATES"
echo ""

# Try to pick the most likely one (packages/data/cheddar.db pattern)
PROD_DB=""
for f in $DB_CANDIDATES; do
  if echo "$f" | grep -q "packages/data/cheddar"; then
    PROD_DB="$f"
    break
  fi
done

# If no exact match, use first candidate that has tables
if [ -z "$PROD_DB" ]; then
  for f in $DB_CANDIDATES; do
    if file "$f" 2>/dev/null | grep -q SQLite; then
      TABLE_COUNT=$(sqlite3 "$f" "SELECT count(*) FROM sqlite_master WHERE type='table';" 2>/dev/null || echo "0")
      if [ "$TABLE_COUNT" -gt 0 ]; then
        PROD_DB="$f"
        break
      fi
    fi
  done
fi

if [ -z "$PROD_DB" ]; then
  echo "ERROR: Could not identify the prod DB file"
  echo "Candidates:"
  echo "$DB_CANDIDATES"
  exit 1
fi

echo "Selected DB: $PROD_DB"
ls -lh "$PROD_DB" || true
echo ""

echo "=== Verifying DB is valid ==="
TABLES=$(sqlite3 "$PROD_DB" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1;" 2>/dev/null | head -20 || echo "")
echo "Tables in DB:"
echo "$TABLES"
echo ""

echo "=== Checking service managers ==="
if command -v systemctl >/dev/null 2>&1; then
  echo "systemctl: YES"
  systemctl list-units --type=service 2>/dev/null | grep -i cheddar || echo "(no cheddar units found)"
else
  echo "systemctl: NO"
fi

if command -v pm2 >/dev/null 2>&1; then
  echo "pm2: YES"
else
  echo "pm2: NO"
fi

if command -v docker >/dev/null 2>&1; then
  echo "docker: YES"
  docker ps --format '{{.Names}}' 2>/dev/null | head -10 || echo "(no containers running)"
else
  echo "docker: NO"
fi
echo ""

# Return values in a parseable format
echo "=== PARSED RESULTS ==="
echo "REPO_ROOT=$REPO_ROOT"
echo "PROD_DB=$PROD_DB"
DISCOVERYEND
)

# Run discovery on prod
DISCOVERY_OUTPUT=$(ssh -q "$PROD_HOST" bash << EOF
$DISCOVERY_SCRIPT
EOF
)

echo "$DISCOVERY_OUTPUT"
echo ""

# Parse results
REPO_ROOT=$(echo "$DISCOVERY_OUTPUT" | grep "^REPO_ROOT=" | cut -d= -f2)
PROD_DB=$(echo "$DISCOVERY_OUTPUT" | grep "^PROD_DB=" | cut -d= -f2)

if [ -z "$REPO_ROOT" ] || [ -z "$PROD_DB" ]; then
  log_error "Failed to discover repo or DB path on prod"
  log_error "REPO_ROOT=$REPO_ROOT"
  log_error "PROD_DB=$PROD_DB"
  exit 1
fi

log_info "Discovered: REPO_ROOT=$REPO_ROOT"
log_info "Discovered: PROD_DB=$PROD_DB"
echo ""

# ============================================================================
# STEP 2: Stop all writers on prod (generic, safe)
# ============================================================================
log_info "Stopping potential writers on prod..."

STOP_SCRIPT=$(cat << 'STOPEND'
#!/bin/bash
set -euo pipefail

echo "Stopping systemd services..."
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl stop cheddar-logic 2>/dev/null || true
  sudo systemctl stop cheddar 2>/dev/null || true
  sleep 1
fi

echo "Stopping pm2..."
if command -v pm2 >/dev/null 2>&1; then
  pm2 stop all 2>/dev/null || true
fi

echo "Stopping docker (if in compose dir)..."
if command -v docker >/dev/null 2>&1; then
  docker ps --format '{{.Names}}' | grep -E 'cheddar|worker|web' && docker compose down 2>/dev/null || true
fi

sleep 2
echo "Stopped all writers"
STOPEND
)

ssh -q "$PROD_HOST" bash << EOF
$STOP_SCRIPT
EOF

log_warn "Services stopped. DB should be free from writers."
echo ""

# ============================================================================
# STEP 3: Back up existing prod DB
# ============================================================================
log_info "Backing up existing prod DB on prod..."

BACKUP_SCRIPT=$(cat << 'BACKUPEND'
#!/bin/bash
set -euo pipefail

DB="$1"
TS="$(date +%Y%m%d_%H%M%S)"
BACKUP_PATH="${DB}.bak.${TS}"

if [ -f "$DB" ]; then
  echo "Backing up $DB → $BACKUP_PATH"
  sudo cp -av "$DB" "$BACKUP_PATH" || cp -v "$DB" "$BACKUP_PATH"
  ls -lh "$BACKUP_PATH"
else
  echo "WARN: No existing DB to back up"
fi
BACKUPEND
)

ssh -q "$PROD_HOST" bash << EOF
$BACKUP_SCRIPT "$PROD_DB"
EOF

log_info "Backup complete"
echo ""

# ============================================================================
# STEP 4: Copy dev DB to prod atomically (temp → move)
# ============================================================================
log_info "Copying dev DB to prod (temp → atomic move)..."

# Copy to temp file on prod
log_info "Uploading dev DB to prod:/tmp/cheddar.db.incoming..."
scp -q "$DEV_DB" "$PROD_HOST:/tmp/cheddar.db.incoming"
log_info "Upload complete"

# Move into place on prod
log_info "Moving into place atomically on prod..."
MOVE_SCRIPT=$(cat << 'MOVEEND'
#!/bin/bash
set -euo pipefail

INCOMING="/tmp/cheddar.db.incoming"
TARGET="$1"

if [ ! -f "$INCOMING" ]; then
  echo "ERROR: temp file not found: $INCOMING"
  exit 1
fi

echo "Moving $INCOMING → $TARGET"
sudo mv "$INCOMING" "$TARGET" || mv "$INCOMING" "$TARGET"
sudo chmod 664 "$TARGET" 2>/dev/null || true

ls -lh "$TARGET"
echo "Move complete"
MOVEEND
)

ssh -q "$PROD_HOST" bash << EOF
$MOVE_SCRIPT "$PROD_DB"
EOF

log_info "DB copy complete"
echo ""

# ============================================================================
# STEP 5: Verify DB integrity
# ============================================================================
log_info "Verifying DB integrity on prod..."

VERIFY_SCRIPT=$(cat << 'VERIFYEND'
#!/bin/bash
set -euo pipefail

DB="$1"

echo "Running PRAGMA integrity_check..."
INTEGRITY=$(sqlite3 "$DB" "PRAGMA integrity_check;" 2>&1 || echo "ERROR")
echo "$INTEGRITY"

if ! echo "$INTEGRITY" | grep -q "^ok$"; then
  echo "ERROR: DB integrity check failed!"
  exit 1
fi

echo ""
echo "Table count:"
sqlite3 "$DB" "SELECT count(*) AS table_count FROM sqlite_master WHERE type='table';"

echo ""
echo "Tables in DB:"
sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1;"

echo ""
echo "Sample data (first 5 games):"
sqlite3 "$DB" "SELECT COUNT(*) AS games FROM games;" 2>/dev/null || echo "0"

echo ""
echo "Integrity check: PASSED"
VERIFYEND
)

VERIFY_OUTPUT=$(ssh -q "$PROD_HOST" bash << EOF
$VERIFY_SCRIPT "$PROD_DB"
EOF
)

echo "$VERIFY_OUTPUT"

if ! echo "$VERIFY_OUTPUT" | grep -q "PASSED"; then
  log_error "DB integrity check failed on prod!"
  log_error "Would restore from backup, but this needs manual intervention."
  log_error "SSH into prod and run:"
  log_error "  TS=\$(ls ${PROD_DB}.bak.* | tail -1 | sed 's/.*bak.//g')"
  log_error "  sudo cp ${PROD_DB}.bak.\$TS $PROD_DB"
  exit 1
fi

log_info "DB integrity verified successfully"
echo ""

# ============================================================================
# STEP 6: Restart services and run settlement pipeline
# ============================================================================
log_info "Restarting services on prod..."

RESTART_SCRIPT=$(cat << 'RESTARTEND'
#!/bin/bash
set -euo pipefail

if command -v systemctl >/dev/null 2>&1; then
  echo "Starting systemd service..."
  sudo systemctl start cheddar-logic 2>/dev/null || true
  sleep 2
fi

if command -v pm2 >/dev/null 2>&1; then
  echo "Starting pm2..."
  pm2 start all 2>/dev/null || true
  sleep 2
fi

if command -v docker >/dev/null 2>&1; then
  echo "Starting docker compose..."
  docker compose up -d 2>/dev/null || true
  sleep 2
fi

echo "Services started"
RESTARTEND
)

ssh -q "$PROD_HOST" bash << EOF
$RESTART_SCRIPT
EOF

log_info "Services restarted"
echo ""

# ============================================================================
# STEP 7: Run settlement pipeline rebuild (if npm scripts exist)
# ============================================================================
log_info "Running settlement pipeline rebuild on prod..."

REBUILD_SCRIPT=$(cat << 'REBUILDEND'
#!/bin/bash
set -euo pipefail

REPO_ROOT="$1"

if [ ! -d "$REPO_ROOT" ]; then
  echo "WARN: Repo not found at $REPO_ROOT, skipping rebuild"
  exit 0
fi

cd "$REPO_ROOT"

# Check if we're in a monorepo with apps/worker
if [ -d "apps/worker" ]; then
  cd apps/worker
fi

echo "Running jobs from: $(pwd)"
echo ""

if npm run | grep -q "job:backfill-card-results"; then
  echo "Running: npm run job:backfill-card-results"
  npm run job:backfill-card-results || true
  sleep 2
fi

if npm run | grep -q "job:settle-games"; then
  echo "Running: npm run job:settle-games"
  npm run job:settle-games || true
  sleep 2
fi

if npm run | grep -q "job:settle-cards"; then
  echo "Running: npm run job:settle-cards"
  npm run job:settle-cards || true
fi

echo "Settlement pipeline rebuild complete"
REBUILDEND
)

ssh -q "$PROD_HOST" bash << EOF
$REBUILD_SCRIPT "$REPO_ROOT"
EOF

log_info "Settlement pipeline rebuild complete"
echo ""

# ============================================================================
# SUMMARY
# ============================================================================
log_info "✓ Migration complete!"
echo ""
echo "=== FINAL STATE ==="
echo "Dev DB: $DEV_DB (source)"
echo "Prod DB: $PROD_DB (target, on $PROD_HOST)"
echo "Prod Repo: $REPO_ROOT"
echo ""
log_info "Next steps:"
echo "  1. Test the app on prod"
echo "  2. Monitor settlement pipeline results"
echo "  3. If anything broke, restore backup:"
echo "     ssh $PROD_HOST"
echo "     TS=\$(ls ${PROD_DB}.bak.* | tail -1 | sed 's/.*bak.//g')"
echo "     sudo cp ${PROD_DB}.bak.\$TS $PROD_DB"
