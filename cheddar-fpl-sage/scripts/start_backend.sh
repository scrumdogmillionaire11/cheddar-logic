#!/bin/bash
# Quick backend starter script

cd "$(dirname "$0")/.."

echo "🚀 Starting FPL Sage Backend..."
echo ""

# Check if port 8001 is already in use
if lsof -Pi :8001 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "⚠️  Port 8001 is already in use. Killing existing process..."
    kill -9 $(lsof -Pi :8001 -sTCP:LISTEN -t) 2>/dev/null
    sleep 1
fi

# Start backend
echo "Starting uvicorn on port 8001..."
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8001
