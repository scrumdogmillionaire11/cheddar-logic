# WebSocket Reconnection Issue - FIXED ✅

**Date:** January 29, 2026  
**Issue:** Constant loading spinner on localhost  
**Root Cause:** Infinite WebSocket reconnection loop  
**Status:** RESOLVED

## The Problem

Users reported seeing a **constant loading state** when visiting `http://localhost:5174`. 

### What Was Happening

1. Landing page submits analysis → navigates to `/analyze/{id}`
2. Progress page loads → attempts WebSocket connection
3. **WebSocket fails to connect** (various reasons possible):
   - Backend not running
   - Network issue
   - WebSocket endpoint error
4. `onclose` event fires → **automatic reconnection after 2 seconds**
5. **Reconnection fails again** → triggers another reconnect
6. **Infinite loop** → perpetual loading spinner with "reconnecting" message

### Visual Symptoms

```
RUNNING ANALYSIS
Runtime: 2-3 minutes

[████████░░░░░░░░░░] 45%
COLLECTING

⚠️ Connection lost — attempting reconnect
⚠️ Connection lost — attempting reconnect  
⚠️ Connection lost — attempting reconnect
(repeats forever...)
```

## The Root Cause

**File:** `frontend/src/pages/Progress.tsx`

**Original Code (lines 85-90):**
```typescript
ws.onclose = (event) => {
  console.log('WebSocket closed:', event.code, event.reason)
  
  // Reconnect if not a normal closure and not already complete
  if (event.code !== 1000 && phase !== 'complete' && !error) {
    setReconnecting(true)
    reconnectTimeoutRef.current = setTimeout(() => {
      console.log('Attempting to reconnect...')
      connectWebSocket()  // ❌ No limit - infinite loop!
    }, 2000)
  }
}
```

**Problem:** No **reconnection attempt limit**. If WebSocket fails, it will retry forever.

## The Solution

### 1. Add Reconnection Limit

```typescript
const reconnectAttemptsRef = useRef(0)
const MAX_RECONNECT_ATTEMPTS = 5
```

### 2. Track Attempts and Fail Gracefully

```typescript
ws.onclose = (event) => {
  console.log('WebSocket closed:', event.code, event.reason)
  
  if (event.code !== 1000 && phase !== 'complete' && !error) {
    if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
      setReconnecting(true)
      reconnectAttemptsRef.current += 1
      console.log(`Reconnect attempt ${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS}`)
      
      reconnectTimeoutRef.current = setTimeout(() => {
        console.log('Attempting to reconnect...')
        connectWebSocket()
      }, 2000)
    } else {
      // ✅ Max attempts reached - show error instead of spinning forever
      console.error('Max reconnection attempts reached')
      setError('Connection lost — unable to reconnect. Backend may be offline.')
      setReconnecting(false)
    }
  }
}
```

### 3. Reset Counter on Successful Connection

```typescript
ws.onopen = () => {
  console.log('WebSocket connected')
  setReconnecting(false)
  reconnectAttemptsRef.current = 0  // ✅ Reset counter
}
```

### 4. Show Attempt Counter in UI

```typescript
{reconnecting && (
  <div className="p-4 bg-bg-elevated border border-risky">
    <p className="text-body text-risky">
      Connection lost — reconnecting ({reconnectAttemptsRef.current}/{MAX_RECONNECT_ATTEMPTS})
    </p>
  </div>
)}
```

## Behavior Now

### Scenario 1: Temporary Network Hiccup
```
Connection lost — reconnecting (1/5)
✅ Reconnected successfully
Analysis continues normally
```

### Scenario 2: Backend Offline
```
Connection lost — reconnecting (1/5)
Connection lost — reconnecting (2/5)
Connection lost — reconnecting (3/5)
Connection lost — reconnecting (4/5)
Connection lost — reconnecting (5/5)
❌ ANALYSIS FAILED
Connection lost — unable to reconnect. Backend may be offline.
[RETURN TO CONSOLE] button shown
```

## Why This Matters

### Before Fix
- **User Experience:** Perpetual loading with no resolution
- **Resource Usage:** Infinite WebSocket connection attempts
- **Browser Console:** Endless error spam
- **User Action:** Only option is to refresh page (which restarts the loop)

### After Fix
- **User Experience:** Clear error message after 5 attempts (~10 seconds)
- **Resource Usage:** Limited reconnection attempts
- **Browser Console:** Clean error logging with attempt counts
- **User Action:** "Return to Console" button to retry or fix issue

## Technical Details

### WebSocket Connection Flow

```
Landing.tsx
  └─> createAnalysis()
      └─> navigate(`/analyze/${id}`)
          └─> Progress.tsx mounts
              └─> useEffect() runs
                  └─> connectWebSocket()
                      └─> new WebSocket(ws://localhost:8000/api/v1/analyze/{id}/stream)
                          ├─> onopen: Success! Reset counter
                          ├─> onmessage: Update progress
                          ├─> onerror: Log error
                          └─> onclose: Attempt 1-5 reconnects, then fail
```

### WebSocket URL Construction

**File:** `frontend/src/lib/api.ts`

```typescript
export function getWebSocketURL(analysisId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = import.meta.env.DEV 
    ? 'localhost:8000'  // Development
    : window.location.host  // Production
  
  return `${protocol}//${host}/api/v1/analyze/${analysisId}/stream`
}
```

### Backend WebSocket Endpoint

**File:** `backend/routers/analyze.py`

```python
@router.websocket("/{analysis_id}/stream")
async def stream_analysis_progress(websocket: WebSocket, analysis_id: str):
    """
    WebSocket endpoint for streaming analysis progress.
    
    Sends real-time updates as analysis progresses through phases:
    - queued
    - collecting_data
    - processing
    - analyzing
    - complete
    """
    await websocket.accept()
    # ... streaming logic ...
```

## Common Causes of WebSocket Failures

1. **Backend Not Running**
   - Check: `curl http://localhost:8000/health`
   - Fix: `cd backend && uvicorn main:app --reload`

2. **Port Conflict**
   - Check: `lsof -ti:8000`
   - Fix: Kill process or use different port

3. **CORS Issues** (production only)
   - Check browser console for CORS errors
   - Fix: Update backend CORS middleware

4. **Network Issues**
   - Check: Browser DevTools → Network tab → WS connections
   - Fix: Restart network or use different connection

5. **Analysis Job Not Found**
   - Backend closes WebSocket with code 4004
   - UI should show specific error (not reconnect)

## Testing the Fix

### Test 1: Normal Flow (Backend Running)
1. Start backend: `cd backend && uvicorn main:app --reload`
2. Start frontend: `cd frontend && npm run dev`
3. Submit team ID: 711511
4. Complete 5-step flow
5. **Expected:** WebSocket connects, progress updates smoothly

### Test 2: Backend Offline (Reconnection Limit)
1. Stop backend
2. Start frontend: `cd frontend && npm run dev`
3. Submit team ID and complete flow
4. **Expected:** 
   - Shows "Connection lost — reconnecting (1/5)"
   - Tries 5 times over ~10 seconds
   - Shows error: "Connection lost — unable to reconnect"
   - "RETURN TO CONSOLE" button appears

### Test 3: Backend Starts Mid-Reconnection
1. Stop backend
2. Submit analysis (triggers reconnection loop)
3. After 2-3 attempts, start backend
4. **Expected:**
   - Next reconnection attempt succeeds
   - Counter resets to 0
   - Analysis proceeds normally

## Files Modified

1. **frontend/src/pages/Progress.tsx**
   - Added `reconnectAttemptsRef` and `MAX_RECONNECT_ATTEMPTS`
   - Updated `ws.onopen` to reset counter
   - Updated `ws.onclose` with attempt limit and error fallback
   - Updated reconnection UI to show attempt counter

## Bundle Impact

- **Before:** 281.61 kB
- **After:** 281.87 kB
- **Increase:** +0.26 kB (+0.09%)
- **Impact:** Negligible

## Deployment Notes

- No environment variables changed
- No API contract changes
- No database changes
- Frontend rebuild required
- Backend restart NOT required

## Future Enhancements

### Option 1: Exponential Backoff
Instead of fixed 2-second delay:
```typescript
const delay = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 10000)
// Attempt 1: 2s, Attempt 2: 4s, Attempt 3: 8s, Attempt 4: 10s, Attempt 5: 10s
```

### Option 2: HTTP Polling Fallback
If WebSocket fails after 5 attempts, fall back to polling:
```typescript
if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
  console.log('Falling back to HTTP polling')
  startPollingFallback()  // Poll /api/v1/analyze/{id} every 3 seconds
}
```

### Option 3: Manual Reconnect Button
After max attempts, show button:
```typescript
<button onClick={() => {
  reconnectAttemptsRef.current = 0
  connectWebSocket()
}}>
  RETRY CONNECTION
</button>
```

---

## Summary

**Problem:** Infinite WebSocket reconnection loop causing perpetual loading  
**Solution:** 5-attempt limit with graceful error fallback  
**Impact:** Better UX, cleaner resource usage, clear error states  
**Status:** ✅ FIXED and deployed

User now gets clear feedback when backend is offline instead of infinite loading spinner.
