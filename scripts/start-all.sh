#!/bin/bash
# Quick Start for Cheddar Logic + FPL Dashboard
#
# This script starts both:
# - Web app (Next.js) on port 3000
# - FPL backend (FastAPI) on port 8000

set -e

echo "🧀 Cheddar Logic Startup"
echo "========================"
echo ""

START_FPL=false
SKIP_DB_SETUP=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --with-fpl)
      START_FPL=true
      shift
      ;;
    --skip-db)
      SKIP_DB_SETUP=true
      shift
      ;;
    --help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --with-fpl     Also start FPL Sage backend on port 8000"
      echo "  --skip-db      Skip database setup (faster restart)"
      echo "  --help         Show this help message"
      echo ""
      echo "Examples:"
      echo "  $0                    # Start web only"
      echo "  $0 --with-fpl         # Start web + FPL backend"
      echo "  $0 --with-fpl --skip-db  # Quick restart"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Use --help for usage information"
      exit 1
      ;;
  esac
done

# Check if port 3000 is in use
if lsof -ti:3000 >/dev/null 2>&1; then
    echo "⚠️  Port 3000 is in use. Killing existing process..."
    lsof -ti:3000 | xargs kill -9 2>/dev/null || true
    sleep 1
fi

# Database setup (unless skipped)
if [ "$SKIP_DB_SETUP" = false ]; then
    echo "📦 [1/3] Setting up database..."
    cd packages/data
    npm install
    npm run migrate
  echo "   Skipping seed:test-odds (disabled for shared DB safety)"
    cd ../..
else
    echo "⏭️  Skipping database setup"
fi

# Web app
echo ""
echo "🌐 [2/3] Starting web app..."
cd web
npm install
cd ..

# Start web app in background
echo "   Starting Next.js on port 3000..."
cd web && npm run dev &
WEB_PID=$!
cd ..

# Start FPL backend if requested
if [ "$START_FPL" = true ]; then
    echo ""
    echo "🤖 [3/3] Starting FPL Sage backend..."
    
    # Check if port 8000 is in use
    if lsof -ti:8000 >/dev/null 2>&1; then
        echo "⚠️  Port 8000 is in use. Killing existing process..."
        lsof -ti:8000 | xargs kill -9 2>/dev/null || true
        sleep 1
    fi
    
    ./scripts/start-fpl-backend.sh &
    FPL_PID=$!
    
    echo ""
    echo "✅ Both services starting..."
    echo ""
    echo "   Web:         http://localhost:3000"
    echo "   FPL Backend: http://localhost:8000"
    echo "   FPL Docs:    http://localhost:8000/docs"
    echo ""
    echo "Press Ctrl+C to stop all services"
    
    # Wait for both processes
    wait $WEB_PID $FPL_PID
else
    echo ""
    echo "✅ Web app starting on http://localhost:3000"
    echo ""
    echo "   To also start FPL backend, run:"
    echo "   ./scripts/start-fpl-backend.sh"
    echo ""
    echo "   Or restart with: $0 --with-fpl"
    echo ""
    echo "Press Ctrl+C to stop"
    
    # Wait for web process
    wait $WEB_PID
fi
