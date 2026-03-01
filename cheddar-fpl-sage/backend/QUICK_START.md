## 🎯 Quick Start: Interactive FPL Sage API

### 0️⃣ Start Backend Server

**From project root:**
```bash
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8001
```

**Options:**
- `--reload` - Auto-reload on code changes (development)
- `--host 0.0.0.0` - Accept connections from network (required for frontend)
- `--port 8001` - Server port (default: 8001)

**Production mode (no reload):**
```bash
uvicorn backend.main:app --host 0.0.0.0 --port 8001
```

Server will be available at:
- Local: `http://localhost:8001`
- Network: `http://192.168.x.x:8001`
- API Docs: `http://localhost:8001/docs`

---

### 1️⃣ Trigger Analysis with Overrides
```bash
curl -X POST http://localhost:8001/api/v1/analyze/interactive \
  -H "Content-Type: application/json" \
  -d '{
    "team_id": 123456,
    "free_transfers": 2,
    "available_chips": ["bench_boost"],
    "injury_overrides": [
      {"player_name": "Haaland", "status": "DOUBTFUL", "chance": 50}
    ]
  }'
```

**Response:**
```json
{"analysis_id": "a1b2c3d4", "status": "queued"}
```

---

### 2️⃣ Check Status
```bash
curl http://localhost:8001/api/v1/analyze/a1b2c3d4
```

**Response:**
```json
{"status": "completed", "progress": 100, "phase": "completed"}
```

---

### 3️⃣ Get Detailed Projections
```bash
curl http://localhost:8001/api/v1/analyze/a1b2c3d4/projections
```

**Response:** Full player projections with expected points, transfers, captaincy, chips

---

### 4️⃣ Stream Real-Time Updates
```javascript
const ws = new WebSocket('ws://localhost:8001/api/v1/analyze/a1b2c3d4/stream');
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

---

## 📚 Full Documentation
- **API Reference:** `backend/API_DOCUMENTATION.md`
- **Test Script:** `bash backend/test_interactive_api.sh`

## ✅ All Endpoints Working
- POST `/analyze/interactive` - Analysis with overrides
- GET `/analyze/{id}/projections` - Detailed player data
- GET `/analyze/{id}` - Status polling
- WS `/analyze/{id}/stream` - Real-time updates
