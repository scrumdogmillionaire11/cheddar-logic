#!/usr/bin/env bash
# Safe dev server restart script
# Kills any existing Next.js processes before starting new one

set -e

cd "$(dirname "$0")/.."

echo "🔍 Checking for existing Next.js processes..."

# Kill any existing next dev servers
pkill -f "next dev" 2>/dev/null && echo "✅ Killed existing 'next dev' process" || echo "ℹ️  No 'next dev' process found"
pkill -f "next-server" 2>/dev/null && echo "✅ Killed existing 'next-server' process" || echo "ℹ️  No 'next-server' process found"

# Wait for processes to fully terminate
sleep 2

# Clean lock file if it exists
LOCK_FILE="web/.next/dev/lock"
if [ -f "$LOCK_FILE" ]; then
    echo "🧹 Removing stale lock file: $LOCK_FILE"
    rm -f "$LOCK_FILE"
fi

echo ""
echo "🚀 Starting Next.js dev server..."
echo ""

cd web && npm run dev
