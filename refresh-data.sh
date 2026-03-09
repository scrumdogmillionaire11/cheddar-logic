#!/bin/bash
set -e

echo "=== Starting Fresh Data Pull ==="
echo ""

# Load environment
set -a
source .env
set +a

echo "=== Step 1: Pull Fresh Odds ==="
npm --prefix apps/worker run job:pull-odds 2>&1 | grep -E "(PullOdds|complete|errors)"
echo ""

echo "=== Step 2: Run NBA Model ==="
npm --prefix apps/worker run job:run-nba-model 2>&1 | grep -E "(NBAModel|complete|cards generated)"
echo ""

echo "=== Step 3: Run NHL Model ==="
npm --prefix apps/worker run job:run-nhl-model 2>&1 | grep -E "(NHLModel|complete|cards generated)"
echo ""

echo "=== Step 4: Run NCAAM Model ==="
npm --prefix apps/worker run job:run-ncaam-model 2>&1 | grep -E "(NCAAMModel|complete|cards generated)"
echo ""

echo "=== All Jobs Complete ==="
echo ""
echo "Checking results:"
sqlite3 packages/data/cheddar.db "SELECT sport, COUNT(*) as active_cards FROM card_payloads WHERE datetime(expires_at) > datetime('now') GROUP BY sport ORDER BY sport;"
