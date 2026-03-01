#!/bin/bash
# Test script for interactive FPL Sage API flow

BASE_URL="http://localhost:8000/api/v1"

echo "=== FPL Sage Interactive API Test ==="
echo ""

# Step 1: Trigger analysis with manual overrides
echo "1️⃣ Triggering interactive analysis with overrides..."
RESPONSE=$(curl -s -X POST "$BASE_URL/analyze/interactive" \
  -H "Content-Type: application/json" \
  -d '{
    "team_id": 123456,
    "free_transfers": 2,
    "available_chips": ["bench_boost", "triple_captain"],
    "injury_overrides": [
      {"player_name": "Haaland", "status": "DOUBTFUL", "chance": 50},
      {"player_name": "Salah", "status": "FIT", "chance": 100}
    ],
    "force_refresh": false
  }')

ANALYSIS_ID=$(echo $RESPONSE | python -c "import sys, json; print(json.load(sys.stdin)['analysis_id'])" 2>/dev/null)

if [ -z "$ANALYSIS_ID" ]; then
  echo "❌ Failed to trigger analysis"
  echo $RESPONSE | python -m json.tool
  exit 1
fi

echo "✅ Analysis triggered: $ANALYSIS_ID"
echo ""

# Step 2: Poll for status
echo "2️⃣ Polling analysis status..."
for i in {1..10}; do
  STATUS=$(curl -s "$BASE_URL/analyze/$ANALYSIS_ID" | python -c "import sys, json; print(json.load(sys.stdin)['status'])" 2>/dev/null)
  echo "   Status: $STATUS"
  
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    break
  fi
  
  sleep 2
done
echo ""

# Step 3: Get detailed projections
echo "3️⃣ Fetching detailed player projections..."
curl -s "$BASE_URL/analyze/$ANALYSIS_ID/projections" | python -m json.tool | head -n 40
echo ""

# Step 4: Test WebSocket connection
echo "4️⃣ WebSocket stream available at:"
echo "   ws://localhost:8000/api/v1/analyze/$ANALYSIS_ID/stream"
echo ""

echo "=== Test Complete ==="
