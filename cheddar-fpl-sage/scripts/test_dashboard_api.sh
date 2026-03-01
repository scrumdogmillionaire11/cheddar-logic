#!/bin/bash
# Quick test script for dashboard integration
# Run this after starting the backend server

set -e

API_BASE="http://localhost:8001/api/v1"

echo "🧪 Testing FPL Sage Dashboard Integration"
echo "========================================="
echo ""

# Step 1: Trigger analysis
echo "Step 1: Triggering analysis for team 1930561..."
RESPONSE=$(curl -s -X POST "$API_BASE/analyze/interactive" \
  -H "Content-Type: application/json" \
  -d '{
    "team_id": 1930561,
    "free_transfers": 1,
    "available_chips": [],
    "risk_posture": "balanced"
  }')

ANALYSIS_ID=$(echo $RESPONSE | python -c "import sys, json; print(json.load(sys.stdin).get('analysis_id', 'FAILED'))")

if [ "$ANALYSIS_ID" = "FAILED" ]; then
  echo "❌ Failed to trigger analysis"
  echo "Response: $RESPONSE"
  exit 1
fi

echo "✅ Analysis triggered: $ANALYSIS_ID"
echo ""

# Step 2: Wait for completion
echo "Step 2: Waiting for analysis to complete..."
MAX_ATTEMPTS=30
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  sleep 2
  
  STATUS=$(curl -s "$API_BASE/dashboard/$ANALYSIS_ID/simple" | \
    python -c "import sys, json; print(json.load(sys.stdin).get('status', 'error'))" 2>/dev/null || echo "error")
  
  if [ "$STATUS" = "completed" ]; then
    echo "✅ Analysis completed!"
    break
  fi
  
  ATTEMPT=$((ATTEMPT + 1))
  echo "  ⏳ Still running... ($ATTEMPT/$MAX_ATTEMPTS)"
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
  echo "❌ Analysis timed out"
  exit 1
fi

echo ""

# Step 3: Get dashboard data
echo "Step 3: Fetching dashboard data..."
echo ""
echo "=== SIMPLE FORMAT ==="
curl -s "$API_BASE/dashboard/$ANALYSIS_ID/simple" | python -m json.tool

echo ""
echo ""
echo "=== FULL FORMAT (First 50 lines) ==="
curl -s "$API_BASE/dashboard/$ANALYSIS_ID" | python -m json.tool | head -50

echo ""
echo ""
echo "✅ Integration test complete!"
echo "📖 See docs/DASHBOARD_INTEGRATION.md for integration guide"
