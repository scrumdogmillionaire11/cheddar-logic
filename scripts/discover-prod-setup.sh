#!/bin/bash

################################################################################
# DISCOVERY ONLY: Inspect prod repo + DB (no changes, safe to run)
#
# Usage: ./scripts/discover-prod-setup.sh user@prod-server
#
# Shows you exactly what the full migration will work with:
# - Where the repo actually lives
# - Where the DB is
# - What services are running
# - Current DB state
#
# Run this first if you want to verify before doing the actual migration.
#
################################################################################

set -euo pipefail

PROD_HOST="${1:-}"
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

This script shows you the actual paths + configuration on prod
WITHOUT making any changes. Safe to run anytime.
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

DISCOVERY_SCRIPT=$(cat << 'DISCOVERYEND'
#!/bin/bash
set -euo pipefail

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║           PROD DISCOVERY (read-only, safe)                     ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

echo "📍 SYSTEM INFO"
echo "  pwd: $(pwd)"
echo "  user: $(whoami)"
echo "  hostname: $(hostname)"
echo "  uname: $(uname -s)"
echo ""

echo "🔍 DISCOVERING CHEDDAR-LOGIC REPO"
REPO_ROOT=""
if [ -d "./cheddar-logic" ]; then
  REPO_ROOT="./cheddar-logic"
  echo "  Found in current dir: ./cheddar-logic"
elif [ -d "cheddar-logic" ]; then
  REPO_ROOT="./cheddar-logic"
  echo "  Found in current dir: ./cheddar-logic"
elif [ -d ".git" ] && git rev-parse --show-toplevel 2>/dev/null | grep -q cheddar-logic; then
  REPO_ROOT="$(git rev-parse --show-toplevel)"
  echo "  Found via git: $REPO_ROOT"
else
  CANDIDATES=$(find /opt /home /var -maxdepth 4 -type d -name "cheddar-logic" 2>/dev/null | head -5)
  if [ -n "$CANDIDATES" ]; then
    REPO_ROOT="$(echo "$CANDIDATES" | head -1)"
    echo "  Found via filesystem search: $REPO_ROOT"
  fi
fi

if [ -z "$REPO_ROOT" ]; then
  echo "  ✗ NOT FOUND! Searched: ./, /opt, /home, /var"
  exit 1
fi

echo "  ✓ Repo root: $REPO_ROOT"
echo ""

echo "🗄️  DISCOVERING DATABASE FILE"
DB_CANDIDATES=$(find "$REPO_ROOT" -maxdepth 6 -type f \( -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3" \) 2>/dev/null || true)

if [ -z "$DB_CANDIDATES" ]; then
  echo "  No DBs in repo; searching /opt /home /var..."
  DB_CANDIDATES=$(find /opt /home /var -maxdepth 6 -type f \( -name "*.db" -o -name "*.sqlite" -o -name "*.sqlite3" \) 2>/dev/null | head -30 || true)
fi

PROD_DB=""
for f in $DB_CANDIDATES; do
  if echo "$f" | grep -q "packages/data/cheddar"; then
    PROD_DB="$f"
    echo "  Found (pattern match): $f"
    break
  fi
done

if [ -z "$PROD_DB" ] && [ -n "$DB_CANDIDATES" ]; then
  for f in $DB_CANDIDATES; do
    if file "$f" 2>/dev/null | grep -q SQLite; then
      TABLE_COUNT=$(sqlite3 "$f" "SELECT count(*) FROM sqlite_master WHERE type='table';" 2>/dev/null || echo "0")
      if [ "$TABLE_COUNT" -gt 0 ]; then
        PROD_DB="$f"
        echo "  Found (has tables): $f"
        break
      fi
    fi
  done
fi

if [ -z "$PROD_DB" ]; then
  echo "  All candidates:"
  echo "$DB_CANDIDATES" | sed 's/^/    - /'
  echo "  ✗ Could not identify the prod DB"
  exit 1
fi

echo "  ✓ DB path: $PROD_DB"
ls -lh "$PROD_DB" 2>/dev/null || echo "  (file size query failed)"
echo ""

echo "📊 DATABASE STATE"
echo -n "  Table count: "
sqlite3 "$PROD_DB" "SELECT count(*) FROM sqlite_master WHERE type='table';" 2>/dev/null || echo "?"

echo "  Tables:"
sqlite3 "$PROD_DB" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY 1;" 2>/dev/null | sed 's/^/    - /'

echo ""
echo "  Sample row counts (if tables exist):"
sqlite3 "$PROD_DB" << SQLEND 2>/dev/null || true
.mode list
.separator ": "
SELECT 'games' AS table_name, COUNT(*) FROM games UNION ALL
SELECT 'cards', COUNT(*) FROM cards UNION ALL
SELECT 'card_payloads', COUNT(*) FROM card_payloads UNION ALL
SELECT 'card_results', COUNT(*) FROM card_results UNION ALL
SELECT 'game_results', COUNT(*) FROM game_results UNION ALL
SELECT 'settlements', COUNT(*) FROM settlements UNION ALL
SELECT 'odds_snapshots', COUNT(*) FROM odds_snapshots;
SQLEND

echo ""
echo "🔧 SERVICE MANAGERS"
if command -v systemctl >/dev/null 2>&1; then
  echo "  systemctl: ✓ available"
  systemctl list-units --type=service 2>/dev/null | grep -i cheddar && echo "    (cheddar units found)" || echo "    (no cheddar units)"
else
  echo "  systemctl: ✗ not available"
fi

if command -v pm2 >/dev/null 2>&1; then
  echo "  pm2: ✓ available"
  pm2 ls 2>/dev/null | head -10 || echo "    (pm2 list failed)"
else
  echo "  pm2: ✗ not available"
fi

if command -v docker >/dev/null 2>&1; then
  echo "  docker: ✓ available"
  docker ps --format '{{.Names}}' 2>/dev/null | head -10 && echo "    (containers running)" || echo "    (no containers)"
else
  echo "  docker: ✗ not available"
fi

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                      PARSED RESULTS                            ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo "REPO_ROOT=$REPO_ROOT"
echo "PROD_DB=$PROD_DB"
DISCOVERYEND
)

log_info "Discovering prod setup on $PROD_HOST..."
echo ""

ssh -q "$PROD_HOST" bash << EOF
$DISCOVERY_SCRIPT
EOF
