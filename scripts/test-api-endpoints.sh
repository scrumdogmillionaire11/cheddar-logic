#!/bin/bash
# Test Next.js API endpoints locally
# Run this script while the Next.js dev server is running

set -e

BASE_URL="${1:-http://localhost:3000}"

echo "🧪 Testing Next.js API Endpoints"
echo "Base URL: $BASE_URL"
echo ""

echo "1. Testing /api/games..."
GAMES_RESPONSE=$(curl -s "${BASE_URL}/api/games")
GAMES_COUNT=$(echo "$GAMES_RESPONSE" | grep -o '"data":\[' | wc -l)

if [ "$GAMES_COUNT" -gt 0 ]; then
  GAMES_LENGTH=$(echo "$GAMES_RESPONSE" | node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(0, 'utf-8'));
    console.log(data.success ? data.data.length : 0);
  ")
  echo "   ✅ /api/games returned $GAMES_LENGTH games"
else
  echo "   ❌ /api/games returned no data"
  echo "   Response: $GAMES_RESPONSE"
  exit 1
fi

echo ""
echo "2. Testing /api/results..."
RESULTS_RESPONSE=$(curl -s "${BASE_URL}/api/results")
RESULTS_SUCCESS=$(echo "$RESULTS_RESPONSE" | node -e "
  const fs = require('fs');
  const data = JSON.parse(fs.readFileSync(0, 'utf-8'));
  console.log(data.success ? 'true' : 'false');
")

if [ "$RESULTS_SUCCESS" = "true" ]; then
  echo "   ✅ /api/results returned successfully"
else
  echo "   ❌ /api/results failed"
  echo "   Response: $RESULTS_RESPONSE"
  exit 1
fi

echo ""
echo "3. Testing /api/cards..."
CARDS_RESPONSE=$(curl -s "${BASE_URL}/api/cards")
CARDS_SUCCESS=$(echo "$CARDS_RESPONSE" | node -e "
  const fs = require('fs');
  const data = JSON.parse(fs.readFileSync(0, 'utf-8'));
  console.log(data.success ? 'true' : 'false');
")

if [ "$CARDS_SUCCESS" = "true" ]; then
  echo "   ✅ /api/cards returned successfully"
else
  echo "   ❌ /api/cards failed"
  echo "   Response: $CARDS_RESPONSE"
  exit 1
fi

echo ""
echo "✅ All API endpoints are working!"
