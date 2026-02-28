#!/bin/bash
# Manage the scheduler (stop, restart, logs, status)
# Usage: ./scripts/manage-scheduler.sh [start|stop|restart|logs|status]

COMMAND="${1:-status}"
LOG_FILE="./apps/worker/logs/scheduler.log"

# Color output
BLUE='\033[0;34m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

function show_help() {
    echo "Usage: ./scripts/manage-scheduler.sh [COMMAND]"
    echo ""
    echo "Commands:"
    echo "  start      - Start the background scheduler"
    echo "  stop       - Stop the running scheduler"
    echo "  restart    - Restart the scheduler"
    echo "  logs       - Tail the scheduler logs (Ctrl+C to exit)"
    echo "  status     - Show scheduler status"
    echo ""
}

function scheduler_running() {
    pgrep -f "node.*schedulers/main.js" > /dev/null
}

function get_scheduler_pid() {
    pgrep -f "node.*schedulers/main.js" | head -1
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
            echo ""
            echo "Recent logs:"
            tail -5 "$LOG_FILE"
            echo ""
            echo "View full logs: ./scripts/manage-scheduler.sh logs"
        else
            echo -e "${RED}✗ Scheduler is not running${NC}"
            echo ""
            echo "Start it with: ./scripts/manage-scheduler.sh start"
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
