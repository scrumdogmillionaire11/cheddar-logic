#!/bin/bash
# Manage the scheduler (stop, restart, logs, status)
# Usage: ./scripts/manage-scheduler.sh [start|stop|restart|logs|status]

COMMAND="${1:-status}"
LOG_FILE="./apps/worker/logs/scheduler.log"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load environment from repo .env (dev) or .env.production (prod)
ENV_FILE="${CHEDDAR_ENV_FILE:-$ROOT_DIR/.env}"
if [ ! -f "$ENV_FILE" ] && [ -f "$ROOT_DIR/.env.production" ]; then
    ENV_FILE="$ROOT_DIR/.env.production"
fi
if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
fi

EXPECTED_DB_PATH="${CHEDDAR_DB_PATH:-/tmp/cheddar-logic/cheddar.db}"

EXPECTED_MODE="local"
if [[ "$EXPECTED_DB_PATH" == *"snapshot"* ]] || [[ "$EXPECTED_DB_PATH" == *"/.cheddar/"* ]]; then
    EXPECTED_MODE="snapshot"
fi

# Color output
BLUE='\033[0;34m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ -n "${DATABASE_PATH:-}" ] || [ -n "${RECORD_DATABASE_PATH:-}" ] || [ -n "${DATABASE_URL:-}" ]; then
    echo -e "${YELLOW}⚠️  Legacy DB env vars detected. This script expects CHEDDAR_DB_PATH as canonical source.${NC}" >&2
fi

function show_help() {
    echo "Usage: ./scripts/manage-scheduler.sh [COMMAND]"
    echo ""
    echo "Commands:"
    echo "  start      - Start the background scheduler"
    echo "  stop       - Stop the running scheduler"
    echo "  restart    - Restart the scheduler"
    echo "  logs       - Tail the scheduler logs (Ctrl+C to exit)"
    echo "  status     - Show scheduler status"
    echo "  db         - Show expected DB path and scheduler-open DB file"
    echo ""
}

function scheduler_running() {
    pgrep -f "node.*schedulers/main.js" > /dev/null
}

function get_scheduler_pid() {
    pgrep -f "node.*schedulers/main.js" | head -1
}

function get_scheduler_open_db() {
    local pid
    pid=$(get_scheduler_pid)
    if [ -z "$pid" ]; then
        echo ""
        return
    fi
    lsof -p "$pid" 2>/dev/null | awk '/cheddar\.db$/ {print $9; exit}'
}

function infer_active_db_from_job_runs() {
    local candidates=(
        "$EXPECTED_DB_PATH"
        "$ROOT_DIR/packages/data/cheddar.db"
        "/opt/data/cheddar-prod.db"
        "/opt/data/cheddar.db"
        "/tmp/cheddar-logic/cheddar.db"
        "$ROOT_DIR/data/cheddar.db"
    )
    local best_db=""
    local best_ts=""
    local seen=""

    for db in "${candidates[@]}"; do
        [ -n "$db" ] || continue
        if [[ " $seen " == *" $db "* ]]; then
            continue
        fi
        seen="$seen $db"
        [ -f "$db" ] || continue

        local ts
        ts=$(sqlite3 "$db" "SELECT COALESCE(MAX(started_at), '') FROM job_runs WHERE job_name = 'pull_odds_hourly';" 2>/dev/null)
        [ -n "$ts" ] || continue

        if [ -z "$best_ts" ] || [[ "$ts" > "$best_ts" ]]; then
            best_ts="$ts"
            best_db="$db"
        fi
    done

    if [ -n "$best_db" ]; then
        echo "$best_db|$best_ts"
    fi
}

case "$COMMAND" in
    start)
        ./scripts/start-scheduler.sh
        ;;
    
    stop)
        if scheduler_running; then
            echo -e "${BLUE}Stopping scheduler...${NC}"
            pkill -f "node.*schedulers/main.js"
            sleep 1
            if ! scheduler_running; then
                echo -e "${GREEN}✓ Scheduler stopped${NC}"
            else
                echo -e "${RED}✗ Failed to stop scheduler${NC}"
                exit 1
            fi
        else
            echo -e "${YELLOW}Scheduler is not running${NC}"
        fi
        ;;
    
    restart)
        if scheduler_running; then
            echo -e "${BLUE}Restarting scheduler...${NC}"
            pkill -f "node.*schedulers/main.js"
            sleep 2
        fi
        ./scripts/start-scheduler.sh
        ;;
    
    logs)
        if [ ! -f "$LOG_FILE" ]; then
            echo -e "${YELLOW}Log file not created yet. Scheduler may not have started.${NC}"
            echo ""
            echo "Try: ./scripts/manage-scheduler.sh status"
            echo "Or: ./scripts/manage-scheduler.sh start"
            exit 1
        fi
        tail -f "$LOG_FILE"
        ;;
    
    status)
        if scheduler_running; then
            PID=$(get_scheduler_pid)
            echo -e "${GREEN}✓ Scheduler is running (PID: $PID)${NC}"
            echo "Mode: $EXPECTED_MODE"
            echo "Expected DB: $EXPECTED_DB_PATH"
            OPEN_DB=$(get_scheduler_open_db)
            if [ -n "$OPEN_DB" ]; then
                echo "Scheduler DB: $OPEN_DB"
                if [ "$OPEN_DB" != "$EXPECTED_DB_PATH" ]; then
                    echo -e "${YELLOW}⚠️  Scheduler DB path differs from CHEDDAR_DB_PATH${NC}"
                fi
            else
                INFERRED=$(infer_active_db_from_job_runs)
                if [ -n "$INFERRED" ]; then
                    INFERRED_DB="${INFERRED%%|*}"
                    INFERRED_TS="${INFERRED#*|}"
                    echo "Scheduler DB: (inferred) $INFERRED_DB"
                    echo "Last odds run: $INFERRED_TS"
                else
                    echo "Scheduler DB: (unable to detect open .db file)"
                fi
            fi
            echo ""
            echo "Recent logs:"
            tail -5 "$LOG_FILE"
            echo ""
            echo "View full logs: ./scripts/manage-scheduler.sh logs"
        else
            echo -e "${RED}✗ Scheduler is not running${NC}"
            echo "Mode: $EXPECTED_MODE"
            echo "Expected DB: $EXPECTED_DB_PATH"
            echo ""
            echo "Start it with: ./scripts/manage-scheduler.sh start"
        fi
        ;;

    db)
        echo "Mode: $EXPECTED_MODE"
        echo "Expected DB: $EXPECTED_DB_PATH"
        if scheduler_running; then
            PID=$(get_scheduler_pid)
            OPEN_DB=$(get_scheduler_open_db)
            echo "Scheduler PID: $PID"
            if [ -n "$OPEN_DB" ]; then
                echo "Scheduler DB: $OPEN_DB"
                if [ "$OPEN_DB" != "$EXPECTED_DB_PATH" ]; then
                    echo -e "${YELLOW}⚠️  Scheduler DB path differs from CHEDDAR_DB_PATH${NC}"
                fi
            else
                INFERRED=$(infer_active_db_from_job_runs)
                if [ -n "$INFERRED" ]; then
                    INFERRED_DB="${INFERRED%%|*}"
                    INFERRED_TS="${INFERRED#*|}"
                    echo "Scheduler DB: (inferred) $INFERRED_DB"
                    echo "Last odds run: $INFERRED_TS"
                else
                    echo "Scheduler DB: (unable to detect open .db file)"
                fi
            fi
        else
            echo "Scheduler PID: not running"
        fi
        ;;
    
    help|--help|-h)
        show_help
        ;;
    
    *)
        echo -e "${RED}Unknown command: $COMMAND${NC}"
        echo ""
        show_help
        exit 1
        ;;
esac
