#!/bin/bash
# Start the background scheduler with automatic log management
# Usage: ./scripts/start-scheduler.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
WORKER_DIR="$ROOT_DIR/apps/worker"
LOG_DIR="$WORKER_DIR/logs"

# Create log directory
mkdir -p "$LOG_DIR"

# Color output
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}════════════════════════════════════════════${NC}"
echo -e "${BLUE}  CHEDDAR-LOGIC SCHEDULER STARTUP${NC}"
echo -e "${BLUE}════════════════════════════════════════════${NC}"

# Check if scheduler is already running
if pgrep -f "node.*schedulers/main.js" > /dev/null; then
    echo -e "${YELLOW}⚠️  Scheduler is already running${NC}"
    echo "To view logs: tail -f $LOG_DIR/scheduler.log"
    echo "To stop: pkill -f 'node.*schedulers/main.js'"
    exit 0
fi

# Check database exists
if [ ! -f "$ROOT_DIR/packages/data/cheddar.db" ]; then
    echo -e "${YELLOW}⚠️  Database not found. Initializing...${NC}"
    cd "$ROOT_DIR"
    npm --prefix packages/data run migrate
    echo -e "${YELLOW}⚠️  Database initialized. First odds pull will populate games/odds.${NC}"
fi

# Check web app is running
if ! curl -s http://localhost:3000 > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Web app not running. Start it with:${NC}"
    echo "   npm --prefix $ROOT_DIR/web run dev"
    echo ""
fi

# Start scheduler in background
echo -e "${GREEN}✓ Starting scheduler...${NC}"
cd "$WORKER_DIR"

# Run with nohup so it survives SSH disconnect
nohup npm run scheduler > "$LOG_DIR/scheduler.log" 2>&1 &

SCHEDULER_PID=$!
sleep 2

# Verify it started
if ps -p $SCHEDULER_PID > /dev/null; then
    echo -e "${GREEN}✓ Scheduler started (PID: $SCHEDULER_PID)${NC}"
    echo ""
    echo "Logs: tail -f $LOG_DIR/scheduler.log"
    echo "Stop: pkill -f 'node.*schedulers/main.js'"
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
