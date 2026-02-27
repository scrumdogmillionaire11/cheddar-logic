---
phase: quick-3
plan: 01
subsystem: web-frontend
tags: [fpl, proxy, nextjs, api-client]
tech-stack:
  added: []
  patterns: ["Next.js rewrites proxy", "relative API URL pattern"]
key-files:
  modified:
    - web/next.config.ts
    - web/src/lib/fpl-api.ts
decisions:
  - "Use Next.js rewrites proxy (server-side) instead of direct cross-origin calls to eliminate CORS entirely"
  - "Use relative /api/v1 base URL in fpl-api.ts so NEXT_PUBLIC_FPL_API_URL can override for production"
metrics:
  duration: "5 minutes"
  completed: "2026-02-27"
  tasks_completed: 2
  files_modified: 2
---

# Quick Task 3: Wire cheddar-fpl-sage Frontend to localhost:8001 Summary

**One-liner:** Added Next.js rewrites proxy for /api/v1/* to localhost:8001 and fixed fpl-api.ts to use a relative base URL, eliminating browser CORS issues.

---

## What Was Done

### Task 1 — Add Next.js rewrites proxy (commit: 0d50656)

**File:** `web/next.config.ts`

Added an `async rewrites()` function to the empty `nextConfig` object. All requests matching `/api/v1/:path*` are now proxied server-side from the Next.js Node process to `http://localhost:8001/api/v1/:path*`.

```ts
async rewrites() {
  return [
    {
      source: '/api/v1/:path*',
      destination: 'http://localhost:8001/api/v1/:path*',
    },
  ];
},
```

Because the proxy runs in the Next.js Node process (not the browser), the browser never makes a cross-origin request — CORS is irrelevant for this traffic path.

### Task 2 — Fix FPL API base URL (commit: 932cbff)

**File:** `web/src/lib/fpl-api.ts`

Changed line 6 from:
```ts
const FPL_API_BASE_URL = process.env.NEXT_PUBLIC_FPL_API_URL || 'http://localhost:8000/api/v1';
```
To:
```ts
const FPL_API_BASE_URL = process.env.NEXT_PUBLIC_FPL_API_URL || '/api/v1';
```

This single-character change routes all `triggerAnalysis`, `getAnalysisStatus`, `getDashboardData`, and `pollForDashboard` calls through the proxy rather than directly to a hardcoded port. The `NEXT_PUBLIC_FPL_API_URL` env var override remains available for production deployments.

---

## Verification

**Proxy active confirmation:** With Next.js dev server running at localhost:3000, a `curl` POST to `http://localhost:3000/api/v1/analyze` returns HTTP 500 (connection refused from Next.js to the backend at 8001) instead of 404 (which would indicate the rewrite rule was not matched). This confirms the rewrite is registered and the proxy is live. When the cheddar-fpl-sage FastAPI backend is started (`uvicorn backend.main:app --port 8001`), the full analyze → poll → dashboard flow will work without any CORS errors.

**Full flow when backend is running:**
1. Browser submits team ID at localhost:3000/fpl
2. `triggerAnalysis` calls POST `/api/v1/analyze` (relative URL → same origin)
3. Next.js Node proxy forwards to `http://localhost:8001/api/v1/analyze`
4. FastAPI returns `{ analysis_id, status, estimated_duration }`
5. `pollForDashboard` calls GET `/api/v1/dashboard/{id}` (same proxy path)
6. FastAPI returns dashboard data when analysis complete
7. Zero CORS headers needed — all API traffic is same-origin from browser's perspective

---

## Deviations from Plan

None — plan executed exactly as written.

---

## Self-Check

- [x] `web/next.config.ts` exists and contains `rewrites` block proxying to localhost:8001
- [x] `web/src/lib/fpl-api.ts` line 6 uses `/api/v1` relative path
- [x] Task 1 commit 0d50656 exists
- [x] Task 2 commit 932cbff exists
- [x] Proxy confirmed active (500 not 404 from localhost:3000/api/v1/analyze)
