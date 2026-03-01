# 🚨 DEV SERVER CONFIGURATION - STRICT RULE 🚨

**Date Established:** January 29, 2026  
**Status:** IMMUTABLE

## HARD RULE: Port 5173 ONLY

### Frontend Dev Server
```
http://localhost:5173/
```

**NEVER CHANGE THIS PORT. EVER.**

### Why This Rule Exists

- **Consistency:** All development assumes this URL
- **Documentation:** All docs reference port 5173
- **Team Coordination:** Everyone uses the same port
- **No Confusion:** One port to rule them all

### Enforcement

If port 5173 is in use, **KILL THE EXISTING PROCESS** rather than using a different port.

```bash
# Kill anything on port 5173
lsof -ti :5173 | xargs kill -9

# Then start dev server
cd frontend && npm run dev
```

### Vite Configuration

**File:** `frontend/vite.config.ts`

Vite is configured to ONLY use port 5173. If it's busy, Vite will try other ports - **WE DON'T WANT THIS**.

Always ensure port 5173 is available before starting.

### Quick Commands

```bash
# Check if port 5173 is in use
lsof -i :5173

# Kill port 5173
lsof -ti :5173 | xargs kill -9

# Start dev server (should always be on 5173)
cd frontend && npm run dev
```

### Backend Configuration

**Backend runs on:** `http://localhost:8000`

Frontend expects backend at this URL in development.

**File:** `frontend/src/lib/api.ts`
```typescript
const host = import.meta.env.DEV 
  ? 'localhost:8000'  // ← Backend port
  : window.location.host;
```

## URL Reference Card

| Service | URL | Port | Notes |
|---------|-----|------|-------|
| **Frontend Dev** | http://localhost:5173 | 5173 | STRICT - Never change |
| **Backend API** | http://localhost:8000 | 8000 | Standard |
| **WebSocket** | ws://localhost:8000 | 8000 | Same as API |

## Emergency Protocol

If you see Vite trying to use port 5174, 5175, etc:

1. **STOP** - Don't proceed
2. **Kill all Vite processes:** `pkill -f vite`
3. **Clear port 5173:** `lsof -ti :5173 | xargs kill -9`
4. **Restart on 5173:** `cd frontend && npm run dev`
5. **Verify:** Should show `Local: http://localhost:5173/`

## Documentation References

All documentation MUST reference `http://localhost:5173/` for frontend dev server.

Files updated:
- ✅ DEV_SERVER_CONFIG.md (this file)
- ✅ WEBSOCKET_FIX_SUMMARY.md
- ✅ docs/WEBSOCKET_RECONNECTION_FIX.md
- ✅ docs/COMPLETE_CLI_FLOW.md

---

**REMEMBER: PORT 5173 IS LAW** ⚖️
