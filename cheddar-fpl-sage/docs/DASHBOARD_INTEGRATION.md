# Dashboard Data Export Integration

**Status:** ✅ **SHIPPED** (Built by Flash/GSD Builder - 2.5 hours)

## What It Does

The `/dashboard` endpoint transforms FPL Sage analysis output into a format compatible with external FPL dashboards (like the Node.js example you showed).

## Quick Start

### 1. Run Analysis (Web UI or API)

```bash
# Option A: Use Web UI
http://localhost:5173

# Option B: Direct API call
curl -X POST http://localhost:8001/api/v1/analyze/interactive \
  -H "Content-Type: application/json" \
  -d '{
    "team_id": 1930561,
    "free_transfers": 1,
    "available_chips": [],
    "risk_posture": "balanced"
  }'

# Returns: {"analysis_id": "abc123def", "status": "queued"}
```

### 2. Get Dashboard Data

**Full Structured Format:**
```bash
curl http://localhost:8001/api/v1/dashboard/abc123def
```

**Simple Minimal Format:**
```bash
curl http://localhost:8001/api/v1/dashboard/abc123def/simple
```

## API Endpoints

### `GET /api/v1/dashboard/{analysis_id}`

Returns fully structured dashboard data with type validation.

**Response Structure:**
```json
{
  "gameweek": {
    "current": 22,
    "season": "2025-26",
    "deadline": null
  },
  "my_team": {
    "starting_11": [],
    "bench": [],
    "value": null,
    "bank": null,
    "transfers_available": null
  },
  "weaknesses": [
    {
      "type": "squad_rule",
      "severity": "high",
      "player": "Guéhi",
      "detail": "Squad rule violation - 4 MCI players (max 3)",
      "action": "Transfer out (replace with Thiaw)"
    }
  ],
  "transfer_targets": [
    {
      "name": "Thiaw",
      "team": "NEW",
      "position": "DEF",
      "cost": 5.1,
      "expected_points": 6.44,
      "priority": "URGENT",
      "reason": "Replace Guéhi to resolve squad violation",
      "injury_status": "Available"
    }
  ],
  "chip_advice": [],
  "captain_advice": {
    "captain": {
      "name": "Wirtz",
      "team": "LIV",
      "position": "MID",
      "ownership_pct": 13.1,
      "expected_points": "7.8",
      "rationale": "Top projected points in XI (7.8pts)"
    },
    "vice_captain": {
      "name": "Thiago",
      "team": "BRE",
      "position": "FWD",
      "ownership_pct": 37.5,
      "rationale": "Second-best option (7.6pts)"
    },
    "alternatives": [...]
  },
  "decision_summary": {
    "decision": "URGENT_TRANSFER",
    "reasoning": "Squad rule violation detected...",
    "status": "URGENT",
    "confidence": "1.0"
  },
  "metadata": {
    "analysis_id": "abc123def",
    "generated_at": "2026-02-15T...",
    "run_id": "2026-01-24T03-35-58Z"
  }
}
```

### `GET /api/v1/dashboard/{analysis_id}/simple`

Returns minimal JSON structure for quick integration.

**Response Structure:**
```json
{
  "status": "completed",
  "gameweek": 22,
  "decision": "URGENT_TRANSFER",
  "reasoning": "Squad rule violation detected...",
  "transfers": [
    {
      "action": "OUT",
      "player_name": "Guéhi",
      "position": "DEF",
      "team": "MCI",
      "priority": "URGENT",
      "reason": "Squad rule violation - 4 MCI players (max 3)"
    },
    {
      "action": "IN",
      "player_name": "Thiaw",
      "position": "DEF",
      "team": "NEW",
      "priority": "URGENT",
      "expected_points": 6.44
    }
  ],
  "captain": {
    "name": "Wirtz",
    "team": "LIV",
    "position": "MID",
    "ownership_pct": 13.1,
    "rationale": "Top projected points in XI (7.8pts)"
  },
  "analysis_id": "abc123def",
  "timestamp": "2026-02-15T..."
}
```

## Integration Guide for Your Dashboard

### What You Need to Change in Your Dashboard

Your Node.js dashboard currently calls:
```javascript
const data = await analyzer.getDashboardData(teamId);
```

**New Integration:**
```javascript
// 1. Trigger FPL Sage analysis
const response = await axios.post('http://localhost:8001/api/v1/analyze/interactive', {
  team_id: teamId,
  free_transfers: 1,  // Or read from FPL API
  available_chips: [],
  risk_posture: 'balanced'
});

const { analysis_id } = response.data;

// 2. Poll for completion (or use WebSocket)
let dashboardData;
while (true) {
  const result = await axios.get(`http://localhost:8001/api/v1/dashboard/${analysis_id}/simple`);
  
  if (result.data.status === 'completed') {
    dashboardData = result.data;
    break;
  }
  
  await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s
}

// 3. Use the data (same structure as before)
console.log('Decision:', dashboardData.decision);
console.log('Transfers:', dashboardData.transfers);
console.log('Captain:', dashboardData.captain);
```

### Field Mappings

| Your Dashboard Field | FPL Sage Dashboard API |
|---------------------|------------------------|
| `weaknesses` | `weaknesses[]` - Same structure |
| `transferTargets` | `transfer_targets[]` - Filtered to IN transfers only |
| `chipAdvice` | `chip_advice[]` - Basic chip guidance |
| `gameweek.current` | `gameweek.current` |
| `myTeam.starting11` | `my_team.starting_11` (currently empty - see note) |

### Current Limitations

**⚠️ Known Gaps (not blocking):**

1. **Team Data (`my_team`)** - Currently returns empty structure
   - **Why:** FPL Sage analysis doesn't expose raw team picks in API response yet
   - **Workaround:** Your dashboard can still fetch this from FPL API directly
   - **Fix:** Could add in 30 minutes if needed

2. **Fixture Analysis** - Not included in v1
   - **Why:** FPL Sage doesn't track fixture difficulty in same format
   - **Workaround:** Keep your existing fixture analyzer
   - **Fix:** Could map if you need it

3. **Chip Guidance** - Basic only
   - **Why:** FPL Sage chip logic is more conservative
   - **Your advantage:** Sage will tell you when chips are actually worth using

### What Works Better in FPL Sage

✅ **Transfer Targets** - Smarter prioritization (URGENT/HIGH/MEDIUM/LOW)  
✅ **Weaknesses** - Includes squad rule violations and projection-based risks  
✅ **Captain Advice** - Expected points-based, not just form  
✅ **Decision Confidence** - Includes confidence scores and reasoning  

## Testing the Integration

### 1. Start the Backend

```bash
# Terminal 1
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8001
```

### 2. Trigger Analysis and Get Dashboard Data

```bash
# Trigger analysis
curl -X POST http://localhost:8001/api/v1/analyze/interactive \
  -H "Content-Type: application/json" \
  -d '{"team_id": 1930561, "free_transfers": 1, "available_chips": [], "risk_posture": "balanced"}'

# Get dashboard data (replace with your analysis_id)
curl http://localhost:8001/api/v1/dashboard/abc123def/simple
```

### 3. Check API Docs

```bash
open http://localhost:8001/docs
# Look for /api/v1/dashboard endpoints
```

## Implementation Details

**Time Budget:** 2.5 hours (GSD Builder)  
**Files Created:**
- `backend/routers/dashboard.py` (390 lines)
- `docs/DASHBOARD_INTEGRATION.md` (this file)

**Files Modified:**
- `backend/main.py` - Added dashboard router

**Testing:** Manual curl tests ✅  
**Production Ready:** MVP yes, needs team data enhancement  

## Next Steps (If Needed)

### Priority 1: Add Team Picks Data (30 min)
If you need `my_team.starting_11` populated:
1. Read from `model_inputs.json` (has team state)
2. Add to dashboard response builder
3. Map to dashboard format

### Priority 2: Enhanced Chip Guidance (1 hour)
Add detailed chip timing windows:
1. Extract from FPL Sage ruleset
2. Map to your chip advice format
3. Include double gameweek detection

### Priority 3: WebSocket Integration (1 hour)
Instead of polling, use WebSocket for real-time updates:
```javascript
const ws = new WebSocket('ws://localhost:8001/api/v1/analyze/abc123def/stream');
ws.onmessage = (e) => {
  const { type, progress } = JSON.parse(e.data);
  if (type === 'complete') {
    // Fetch dashboard data
  }
};
```

## Questions?

Check:
- Full API docs: http://localhost:8001/docs
- Analysis API: [backend/API_DOCUMENTATION.md](../backend/API_DOCUMENTATION.md)
- FPL Sage architecture: [README.md](../README.md)

---

**Built by:** Flash (GSD Builder)  
**Shipped:** February 15, 2026  
**Philosophy:** Working code > perfect code. Ship it, then improve it. 🚀
