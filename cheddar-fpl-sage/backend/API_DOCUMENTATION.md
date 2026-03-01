# FPL Sage Interactive API

## Overview

The FPL Sage backend provides a FastAPI-based REST API with WebSocket support for real-time analysis streaming.

## Base URL

```
http://localhost:8000/api/v1
```

## Endpoints

### 1. Standard Analysis (Basic)

**POST /analyze**

Trigger a basic FPL analysis without overrides.

**Request:**
```json
{
  "team_id": 123456,
  "gameweek": 23
}
```

**Response (202 Accepted):**
```json
{
  "analysis_id": "a1b2c3d4",
  "status": "queued",
  "created_at": "2026-01-30T00:00:00Z"
}
```

**Response (200 OK - Cached):**
```json
{
  "status": "completed",
  "results": { ... },
  "cached": true
}
```

---

### 2. Interactive Analysis (With Overrides) ✨

**POST /analyze/interactive**

Trigger analysis with manual overrides for chips, transfers, and injuries.

**Request:**
```json
{
  "team_id": 123456,
  "available_chips": ["bench_boost", "triple_captain"],
  "free_transfers": 2,
  "injury_overrides": [
    {
      "player_name": "Haaland",
      "status": "DOUBTFUL",
      "chance": 50
    },
    {
      "player_name": "Salah", 
      "status": "FIT",
      "chance": 100
    }
  ],
  "force_refresh": false
}
```

**Fields:**
- `team_id` (required): FPL team ID (1-20,000,000)
- `available_chips` (optional): Override chip availability
  - Valid: `bench_boost`, `triple_captain`, `free_hit`, `wildcard`
- `free_transfers` (optional): Override free transfer count (0-5)
- `injury_overrides` (optional): Manual player injury status
  - `status`: `FIT`, `DOUBTFUL`, `OUT`
  - `chance`: Playing chance (0-100)
- `force_refresh` (optional): Bypass cache (default: false)

**Response (202 Accepted):**
```json
{
  "analysis_id": "c1288d2b",
  "status": "queued",
  "created_at": "2026-01-30T00:27:59Z"
}
```

---

### 3. Analysis Status (Polling)

**GET /analyze/{analysis_id}**

Get current status and results when complete.

**Response (Running):**
```json
{
  "status": "running",
  "progress": 65.0,
  "phase": "analyzing_squad",
  "results": null,
  "error": null
}
```

**Response (Completed):**
```json
{
  "status": "completed",
  "progress": 100.0,
  "phase": "completed",
  "results": {
    "team_name": "My Team",
    "primary_recommendation": "HOLD",
    "transfers": [],
    "captain": {...}
  },
  "error": null
}
```

**Response (Failed):**
```json
{
  "status": "failed",
  "progress": 25.0,
  "phase": "collecting_data",
  "results": null,
  "error": "FPL API timeout"
}
```

---

### 4. Detailed Projections ✨

**GET /analyze/{analysis_id}/projections**

Get detailed player projections after analysis completes.

**Response (200 OK):**
```json
{
  "team_name": "Fantasy Masters",
  "manager_name": "John Doe",
  "current_gw": 23,
  "overall_rank": 123456,
  "overall_points": 1500,
  
  "primary_decision": "TRANSFER",
  "confidence": "High",
  "reasoning": "Strong transfer opportunity identified",
  
  "transfer_recommendations": [
    {
      "out": {
        "name": "Player A",
        "team": "ARS",
        "expected_pts": 4.2,
        "reason": "Injured"
      },
      "in": {
        "name": "Player B",
        "team": "LIV",
        "expected_pts": 8.5,
        "reason": "Excellent fixtures"
      },
      "gain": 4.3,
      "priority": 1
    }
  ],
  
  "captain": {
    "name": "Salah",
    "team": "LIV",
    "expected_pts": 9.2,
    "ownership": 45.3
  },
  
  "vice_captain": {
    "name": "Haaland",
    "team": "MCI",
    "expected_pts": 8.8,
    "ownership": 67.1
  },
  
  "starting_xi_projections": [
    {
      "name": "Alisson",
      "team": "LIV",
      "position": "GK",
      "price": 5.5,
      "expected_pts": 5.2,
      "ownership": 12.4,
      "form": 4.8,
      "fixture_difficulty": 2,
      "injury_status": "FIT",
      "playing_chance": 100
    }
  ],
  
  "bench_projections": [...],
  
  "transfer_targets": [
    {
      "name": "De Bruyne",
      "team": "MCI",
      "position": "MID",
      "price": 12.5,
      "expected_pts": 8.9,
      "reasoning": "Great form, easy fixtures"
    }
  ],
  
  "risk_scenarios": [
    {
      "type": "injury",
      "player": "Haaland",
      "likelihood": "medium",
      "impact": "Lose 8.5 expected points"
    }
  ],
  
  "chip_recommendation": {
    "chip": "bench_boost",
    "gameweek": 25,
    "expected_gain": 12.3,
    "reasoning": "Strong bench + easy fixtures"
  },
  
  "available_chips": ["bench_boost", "triple_captain"]
}
```

**Error Responses:**

- **404**: Analysis not found
- **425 Too Early**: Analysis not completed yet

---

### 5. Real-Time Stream (WebSocket)

**WS /analyze/{analysis_id}/stream**

Stream live progress updates via WebSocket.

**Connection:**
```javascript
const ws = new WebSocket('ws://localhost:8000/api/v1/analyze/a1b2c3d4/stream');
```

**Message Types:**

**Progress Update:**
```json
{
  "type": "progress",
  "progress": 45.0,
  "phase": "analyzing_squad"
}
```

**Heartbeat (every 2 seconds):**
```json
{
  "type": "heartbeat",
  "status": "running",
  "progress": 50.0
}
```

**Completion:**
```json
{
  "type": "complete",
  "results": { ... }
}
```

**Error:**
```json
{
  "type": "error",
  "error": "Analysis failed: FPL API timeout"
}
```

---

## Complete Workflow Example

### JavaScript/TypeScript

```typescript
// 1. Trigger analysis with overrides
const response = await fetch('http://localhost:8000/api/v1/analyze/interactive', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    team_id: 123456,
    free_transfers: 2,
    available_chips: ['bench_boost'],
    injury_overrides: [
      { player_name: 'Haaland', status: 'DOUBTFUL', chance: 50 }
    ]
  })
});

const { analysis_id } = await response.json();

// 2. Connect WebSocket for real-time updates
const ws = new WebSocket(`ws://localhost:8000/api/v1/analyze/${analysis_id}/stream`);

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  switch (data.type) {
    case 'progress':
      console.log(`Progress: ${data.progress}% - ${data.phase}`);
      break;
    case 'complete':
      console.log('Analysis complete!', data.results);
      ws.close();
      break;
    case 'error':
      console.error('Analysis failed:', data.error);
      ws.close();
      break;
  }
};

// 3. When complete, fetch detailed projections
async function getProjections() {
  const projections = await fetch(
    `http://localhost:8000/api/v1/analyze/${analysis_id}/projections`
  );
  return await projections.json();
}
```

### Python

```python
import requests
import json

# 1. Trigger analysis
response = requests.post(
    'http://localhost:8000/api/v1/analyze/interactive',
    json={
        'team_id': 123456,
        'free_transfers': 2,
        'available_chips': ['bench_boost'],
        'injury_overrides': [
            {'player_name': 'Haaland', 'status': 'DOUBTFUL', 'chance': 50}
        ]
    }
)

analysis_id = response.json()['analysis_id']

# 2. Poll for completion
import time

while True:
    status = requests.get(f'http://localhost:8000/api/v1/analyze/{analysis_id}')
    data = status.json()
    
    print(f"Status: {data['status']} - Progress: {data['progress']}%")
    
    if data['status'] in ['completed', 'failed']:
        break
    
    time.sleep(2)

# 3. Get detailed projections
if data['status'] == 'completed':
    projections = requests.get(
        f'http://localhost:8000/api/v1/analyze/{analysis_id}/projections'
    )
    print(json.dumps(projections.json(), indent=2))
```

---

## Error Codes

| Code | Description |
|------|-------------|
| `INVALID_TEAM_ID` | Team ID outside valid range (1-20M) |
| `INVALID_GAMEWEEK` | Gameweek outside valid range (1-38) |
| `ANALYSIS_NOT_FOUND` | No analysis found with given ID |
| `ANALYSIS_NOT_READY` | Analysis not completed yet |
| `RATE_LIMITED` | Too many requests (not implemented yet) |

---

## Rate Limiting

Currently not implemented. MVP allows unlimited requests.

**Planned limits:**
- 10 analyses per team_id per hour
- 100 status checks per analysis_id per hour

---

## Caching

- **Standard analysis**: Cached for 5 minutes per team_id + gameweek
- **Interactive analysis**: Currently not cached (planned for future)
- Cache header: `X-Cache: HIT` when cached result returned

---

## Performance

**Expected response times:**
- Analysis trigger: < 50ms
- Status check: < 10ms
- Projections: < 10ms
- Full analysis: 2-10 seconds (depends on FPL API)

---

## Next Steps

✅ Implemented:
- Interactive analysis with manual overrides
- Detailed player projections endpoint
- WebSocket streaming
- Basic error handling

🚧 Planned:
- Rate limiting
- Redis caching for interactive requests
- Advanced injury data integration
- Batch analysis for multiple teams
