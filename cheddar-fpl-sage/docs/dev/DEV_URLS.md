# 🚨 DEVELOPMENT URLS - QUICK REFERENCE 🚨

**Updated:** January 29, 2026

## STRICT RULES ⚖️

### Frontend Dev Server
```
http://localhost:5173/
```
**PORT 5173 ONLY. NEVER CHANGE. EVER.**

### Backend API
```
http://localhost:8000/api/v1
```

### WebSocket
```
ws://localhost:8000/api/v1/analyze/{id}/stream
```

## Start Commands

```bash
# Backend (Terminal 1)
cd backend && uvicorn backend.main:app --reload

# Frontend (Terminal 2)  
cd frontend && npm run dev

# ✅ Should show: Local: http://localhost:5173/
```

## Troubleshooting

### Port 5173 is busy?

```bash
# Kill whatever is on 5173
lsof -ti :5173 | xargs kill -9

# Then restart
cd frontend && npm run dev
```

### Vite tries port 5174, 5175, etc?

**DON'T USE IT.** Kill everything and restart on 5173.

```bash
pkill -f vite
lsof -ti :5173 | xargs kill -9
cd frontend && npm run dev
```

## Configuration Files

- `frontend/vite.config.ts` - Has `strictPort: true` to enforce 5173
- `DEV_SERVER_CONFIG.md` - Full enforcement documentation

---

**REMEMBER: These URLs are law. Don't deviate.**
