#!/bin/bash
# April 1 P0 Fix: Push updated .env.production to Pi and restart worker
# Run from Mac: bash scripts/april1-push-env.sh
# Requires: Pi on local network, SSH password ready

set -e
PI_HOST="babycheeeses11@cheddarpi.local"
PI_PATH="/opt/cheddar-logic"

echo "=== Step 1: Copy .env.production to Pi ==="
scp .env.production "$PI_HOST:$PI_PATH/.env.production"
echo "✓ .env.production copied"

echo ""
echo "=== Step 2: Restart worker with new env ==="
ssh "$PI_HOST" "
  cd $PI_PATH
  export PATH=\"\$PATH:\$(npm prefix -g)/bin\"
  pm2 restart worker --update-env
  sleep 3
  pm2 logs worker --lines 30 --nostream
"
echo "✓ Worker restarted"

echo ""
echo "=== Step 3: Verify key flags are active ==="
ssh "$PI_HOST" "
  grep -E 'ENABLE_DISCORD|ENABLE_ODDS|WITHOUT_ODDS|ENABLE_SETTLEMENT' $PI_PATH/.env.production
"

echo ""
echo "=== Done. Watch logs for: ==="
echo "  [SCHEDULER] Tick — check_odds_health firing every 30 min"
echo "  pull_odds_hourly succeeding (during game hours, 10am ET+)"
echo "  post_discord_cards posting at 09:00 / 12:00 / 18:00 ET"
