# FPL Dashboard Integration

The FPL dashboard experience integrates the **cheddar-fpl-sage** backend with the main **cheddar-logic** web app.

## Architecture

```
┌─────────────────────────┐
│  Next.js Web App        │
│  (web/)                 │
│  - /fpl page            │
│  - Dashboard UI         │
└────────┬────────────────┘
         │ HTTP API calls
         ▼
┌─────────────────────────┐
│  FastAPI Backend        │
│  (cheddar-fpl-sage/)    │
│  - Analysis engine      │
│  - Dashboard endpoints  │
└─────────────────────────┘
```

## Local Development Setup

### 1. Start the FPL Sage Backend

```bash
cd cheddar-fpl-sage

# Install dependencies
pip install -r config/requirements.txt

# Initialize database (one-time)
python scripts/data_pipeline_cli.py init-db

# Start the API server (port 8000)
cd backend
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

The backend will be available at `http://localhost:8000`
- API docs: `http://localhost:8000/docs`
- Health: `http://localhost:8000/health`

### 2. Configure Environment

Create `.env.local` in the project root (or update `.env`):

```bash
# FPL Sage API URL
NEXT_PUBLIC_FPL_API_URL=http://localhost:8000/api/v1
```

### 3. Start the Next.js Web App

```bash
cd web
npm install
npm run dev
```

The web app will be available at `http://localhost:3000`

### 4. Use the Dashboard

1. Open `http://localhost:3000`
2. Click "FPL Team Check"
3. Enter your FPL Team ID (find it in your FPL URL: `fantasy.premierleague.com/entry/123456/`)
4. Wait 30-60 seconds for analysis
5. View your personalized dashboard with:
   - Transfer recommendations
   - Chip strategy advice
   - Captain picks
   - Team weaknesses

## API Endpoints Used

### POST `/api/v1/analyze`
Trigger a new analysis for a team.

**Request:**
```json
{
  "team_id": 123456,
  "gameweek": 25  // optional
}
```

**Response:**
```json
{
  "analysis_id": "abc123",
  "status": "queued",
  "estimated_duration": 45
}
```

### GET `/api/v1/dashboard/{analysis_id}`
Get formatted dashboard data for a completed analysis.

**Response:** See `DashboardData` type in [fpl-api.ts](../web/src/lib/fpl-api.ts)

## Components

### Web App (`web/src/`)

- **`app/fpl/page.tsx`** - Main FPL page with state management
- **`components/fpl-dashboard.tsx`** - Dashboard UI components
- **`components/fpl-loading.tsx`** - Loading and error states
- **`lib/fpl-api.ts`** - API client and type definitions

### Backend (`cheddar-fpl-sage/backend/`)

- **`routers/analyze.py`** - Analysis trigger and status endpoints
- **`routers/dashboard.py`** - Dashboard data transformation
- **`services/engine_service.py`** - Core analysis engine

## Production Deployment

### Backend Deployment

The FPL Sage backend should be deployed as a separate service:

```bash
# Example using gunicorn in production
cd cheddar-fpl-sage/backend
gunicorn main:app -w 4 -k uvicorn.workers.UvicornWorker -b 0.0.0.0:8000
```

### Environment Configuration

Production environment should include:

```bash
# Backend
FPL_SAGE_REDIS_URL=redis://production-redis:6379
FPL_SAGE_CORS_ALLOWED_ORIGINS=https://cheddarlogic.com
FPL_SAGE_RATE_LIMIT_ENABLED=true

# Web App
NEXT_PUBLIC_FPL_API_URL=https://api.cheddarlogic.com/fpl/v1
```

### CORS Configuration

The backend is configured to accept requests from:
- `http://localhost:3000` (development)
- `https://cheddarlogic.com` (production)

Update `CORS_ALLOWED_ORIGINS` in `cheddar-fpl-sage/backend/config.py` for additional domains.

## Troubleshooting

### "Analysis failed to start"
- Verify backend is running: `curl http://localhost:8000/health`
- Check console for CORS errors
- Verify `.env.local` has correct `NEXT_PUBLIC_FPL_API_URL`

### "Analysis timed out"
- Backend may be processing slowly (cold start, FPL API delays)
- Check backend logs for errors
- Default timeout is 2 minutes (60 retries × 2s)

### Backend 500 errors
- Check if database is initialized: `python scripts/data_pipeline_cli.py init-db`
- Verify FPL API is accessible
- Check Redis connection if caching is enabled

## Development Notes

### State Flow

```
Input → Loading → Dashboard
  ↓        ↓
Error ← Error
```

1. **Input**: User enters Team ID
2. **Loading**: Triggers analysis, polls for completion
3. **Dashboard**: Displays results
4. **Error**: Shows error state with retry option

### Caching

The backend caches analysis results for 5 minutes by default. Repeated requests for the same team within this window return cached data immediately.

### Rate Limiting

Default: 100 requests/hour per IP. Configurable via `FPL_SAGE_RATE_LIMIT_REQUESTS_PER_HOUR`.

## Future Enhancements

- [ ] Real-time WebSocket updates during analysis
- [ ] Historical analysis comparison
- [ ] Team value tracking
- [ ] Transfer planning over multiple gameweeks
- [ ] League comparison and rank predictions
