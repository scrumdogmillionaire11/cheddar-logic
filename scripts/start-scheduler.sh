#!/bin/bash
# Start the background scheduler with automatic log management
# Usage: ./scripts/start-scheduler.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
WORKER_DIR="$ROOT_DIR/apps/worker"
LOG_DIR="$WORKER_DIR/logs"
CANONICAL_PROD_DB_PATH="/opt/data/cheddar-prod.db"

IS_PRODUCTION_HOST=false
if [[ "$ROOT_DIR" == "/opt/cheddar-logic" ]] || [[ "${NODE_ENV:-}" == "production" ]]; then
    IS_PRODUCTION_HOST=true
fi
if [[ "${CHEDDAR_ENV_FILE:-}" == *".env.production" ]]; then
    IS_PRODUCTION_HOST=true
fi

# Load environment from repo .env (dev) or .env.production (prod)
ENV_FILE="${CHEDDAR_ENV_FILE:-$ROOT_DIR/.env}"
if [ -z "${CHEDDAR_ENV_FILE:-}" ] && [ "$IS_PRODUCTION_HOST" = true ] && [ -f "$ROOT_DIR/.env.production" ]; then
    ENV_FILE="$ROOT_DIR/.env.production"
fi
if [ ! -f "$ENV_FILE" ] && [ -f "$ROOT_DIR/.env.production" ]; then
    ENV_FILE="$ROOT_DIR/.env.production"
fi

load_env_file() {
        local file="$1"
        [ -f "$file" ] || return 0
        if ! command -v node >/dev/null 2>&1; then
                echo "[ERROR] node is required to parse env file: $file" >&2
                return 1
        fi

        local export_script
        export_script=$(mktemp)

        if ! node -e '
            const fs = require("fs");
            const dotenv = require("dotenv");
            const file = process.argv[1];
            const parsed = dotenv.parse(fs.readFileSync(file));
            for (const [key, raw] of Object.entries(parsed)) {
                const value = String(raw)
                    .replace(/\\/g, "\\\\")
                    .replace(/"/g, "\\\"")
                    .replace(/\$/g, "\\$")
                    .replace(/`/g, "\\`");
                process.stdout.write(`export ${key}="${value}"\n`);
            }
        ' "$file" > "$export_script"; then
                rm -f "$export_script"
                echo "[ERROR] Failed to parse env file: $file" >&2
                return 1
        fi

        # shellcheck disable=SC1090
        source "$export_script"
        rm -f "$export_script"
}

load_env_file "$ENV_FILE"

# Clear legacy DB vars to enforce CHEDDAR_DB_PATH as the single source of truth
unset DATABASE_PATH
unset RECORD_DATABASE_PATH
unset DATABASE_URL

# Canonical DB settings (all worker processes should use CHEDDAR_DB_PATH only)
# CRITICAL: Only set CHEDDAR_DB_PATH to avoid path conflicts
# Production should set CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db in .env.production.
DEFAULT_DB_PATH="/tmp/cheddar-logic/cheddar.db"
if [ "$IS_PRODUCTION_HOST" = true ]; then
    if [ -z "${CHEDDAR_DB_PATH:-}" ]; then
        echo "[ERROR] CHEDDAR_DB_PATH is unset on production host. Set CHEDDAR_DB_PATH=$CANONICAL_PROD_DB_PATH in .env.production." >&2
        exit 1
    fi
    if [ "$CHEDDAR_DB_PATH" != "$CANONICAL_PROD_DB_PATH" ]; then
        echo "[ERROR] Non-canonical CHEDDAR_DB_PATH on production host: $CHEDDAR_DB_PATH (expected $CANONICAL_PROD_DB_PATH)." >&2
        exit 1
    fi
else
    export CHEDDAR_DB_PATH="${CHEDDAR_DB_PATH:-$DEFAULT_DB_PATH}"
fi
export CHEDDAR_DATA_DIR="${CHEDDAR_DATA_DIR:-$(dirname "$CHEDDAR_DB_PATH")}"

MODE="local"
if [[ "$CHEDDAR_DB_PATH" == *"snapshot"* ]] || [[ "$CHEDDAR_DB_PATH" == *"/.cheddar/"* ]]; then
    MODE="snapshot"
fi

# Create log directory
mkdir -p "$LOG_DIR"
mkdir -p "$CHEDDAR_DATA_DIR"

# Color output
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}════════════════════════════════════════════${NC}"
echo -e "${BLUE}  CHEDDAR-LOGIC SCHEDULER STARTUP${NC}"
echo -e "${BLUE}════════════════════════════════════════════${NC}"
echo "Mode: $MODE"
echo "DB: $CHEDDAR_DB_PATH"

if [ "$MODE" = "snapshot" ]; then
    echo -e "${YELLOW}⚠️  Snapshot mode detected. Scheduler should not run against snapshot DBs.${NC}"
fi

# Check if scheduler is already running
if pgrep -f "node.*schedulers/main.js" > /dev/null; then
    echo -e "${YELLOW}⚠️  Scheduler is already running${NC}"
    echo "To view logs: tail -f $LOG_DIR/scheduler.log"
    echo "To stop: pkill -f 'node.*schedulers/main.js'"
    exit 0
fi

# Check database exists
if [ ! -f "$CHEDDAR_DB_PATH" ]; then
    echo -e "${YELLOW}⚠️  Database not found. Initializing...${NC}"
    cd "$ROOT_DIR"
    npm --prefix packages/data run migrate
    echo -e "${YELLOW}⚠️  Database initialized at $CHEDDAR_DB_PATH. First odds pull will populate games/odds.${NC}"
fi

# Check web app is running
if ! curl -s http://localhost:3000 > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Web app not running. Start it with:${NC}"
    echo "   npm --prefix $ROOT_DIR/web run dev"
    echo ""
fi

# Start scheduler in background
echo -e "${GREEN}✓ Starting scheduler...${NC}"
cd "$ROOT_DIR"

# Run with nohup so it survives SSH disconnect
nohup npm --prefix "$WORKER_DIR" run scheduler > "$LOG_DIR/scheduler.log" 2>&1 &

SCHEDULER_PID=$!
sleep 2

# Verify it started
if ps -p $SCHEDULER_PID > /dev/null; then
    echo -e "${GREEN}✓ Scheduler started (PID: $SCHEDULER_PID)${NC}"
    echo ""
    echo "Logs: tail -f $LOG_DIR/scheduler.log"
    echo "Stop: pkill -f 'node.*schedulers/main.js'"
    echo "DB: $CHEDDAR_DB_PATH"
    echo ""
    echo "The scheduler is running in the background."
    echo "It will:"
    echo "  • Pull odds every hour"
    echo "  • Run models every 2 hours"
    echo "  • Keep your cheddar board updated automatically"
else
    echo -e "${RED}✗ Failed to start scheduler${NC}"
    tail -20 "$LOG_DIR/scheduler.log"
    exit 1
fi
