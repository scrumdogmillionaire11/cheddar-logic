---
phase: quick-3
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - web/next.config.ts
  - web/src/lib/fpl-api.ts
autonomous: true
requirements: []

must_haves:
  truths:
    - "Visiting localhost:3000/fpl and submitting a team ID sends the POST request to the cheddar-fpl-sage backend at localhost:8001/api/v1/analyze"
    - "Polling for dashboard data hits localhost:8001/api/v1/dashboard/{id} and returns results"
    - "No CORS errors appear in the browser console during the full analyze → poll → dashboard flow"
  artifacts:
    - path: "web/next.config.ts"
      provides: "Next.js rewrites rule proxying /api/v1/* to localhost:8001"
      contains: "rewrites"
    - path: "web/src/lib/fpl-api.ts"
      provides: "Correct API base URL (relative path, no hardcoded port)"
      contains: "FPL_API_BASE_URL"
  key_links:
    - from: "web/src/app/fpl/page.tsx"
      to: "web/src/lib/fpl-api.ts"
      via: "triggerAnalysis / pollForDashboard imports"
      pattern: "fpl-api"
    - from: "web/src/lib/fpl-api.ts"
      to: "http://localhost:8001/api/v1"
      via: "Next.js rewrites proxy"
      pattern: "/api/v1"
---

<objective>
Wire the Next.js web app's /fpl page to the cheddar-fpl-sage FastAPI backend running at localhost:8001.

Purpose: The /fpl page at localhost:3000/fpl currently calls `http://localhost:8000/api/v1` directly (wrong port, no proxy). The cheddar-fpl-sage backend runs on port 8001 and already allows CORS from localhost:3000. Adding a Next.js rewrites rule proxies /api/v1/* server-side, eliminating browser CORS issues entirely.

Output: Two file edits — next.config.ts gets a rewrites block, fpl-api.ts uses a relative /api/v1 base URL.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md

Key facts discovered:
- cheddar-fpl-sage FastAPI backend runs on port 8001 (uvicorn backend.main:app --port 8001)
- Backend CORS_ALLOWED_ORIGINS already includes http://localhost:3000
- web/src/lib/fpl-api.ts line 6: `const FPL_API_BASE_URL = process.env.NEXT_PUBLIC_FPL_API_URL || 'http://localhost:8000/api/v1'` — port 8000 is wrong, should be 8001
- web/next.config.ts has no rewrites, just empty nextConfig object
- web/src/app/fpl/page.tsx imports from @/lib/fpl-api: triggerAnalysis, pollForDashboard, DashboardData
- pollForDashboard calls getDashboardData which hits /dashboard/{id} — this endpoint exists in cheddar-fpl-sage backend (backend/routers/dashboard.py, prefix="/dashboard")
- The backend's analyze router is at /api/v1/analyze and dashboard at /api/v1/dashboard/{id}
- Vite frontend (cheddar-fpl-sage/frontend/) is a separate app that already proxies /api to :8001 — it is NOT the Next.js app
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add Next.js rewrites proxy for FPL Sage backend</name>
  <files>web/next.config.ts</files>
  <action>
    Add an async rewrites() function to the nextConfig object in web/next.config.ts.

    The rewrite must proxy all /api/v1/* requests to the cheddar-fpl-sage FastAPI backend at http://localhost:8001:

    ```ts
    import type { NextConfig } from "next";

    const nextConfig: NextConfig = {
      async rewrites() {
        return [
          {
            source: '/api/v1/:path*',
            destination: 'http://localhost:8001/api/v1/:path*',
          },
        ];
      },
    };

    export default nextConfig;
    ```

    This proxy runs server-side (Next.js Node process), so browser CORS headers are irrelevant for these requests. The existing backend CORS config remains untouched.
  </action>
  <verify>
    With the Next.js dev server running (`cd web && npm run dev`), confirm:
    `curl -X POST http://localhost:3000/api/v1/analyze -H "Content-Type: application/json" -d '{"team_id": 1}' -v`
    Response should come from the FastAPI backend (status 200 or 422), NOT a Next.js 404.
  </verify>
  <done>curl to localhost:3000/api/v1/analyze returns a response from the FastAPI backend (not a Next.js 404 page)</done>
</task>

<task type="auto">
  <name>Task 2: Fix FPL API base URL to use relative path</name>
  <files>web/src/lib/fpl-api.ts</files>
  <action>
    Update line 6 in web/src/lib/fpl-api.ts. Change the hardcoded localhost:8000 fallback to a relative path so all API calls go through the Next.js proxy added in Task 1:

    Change FROM:
    ```ts
    const FPL_API_BASE_URL = process.env.NEXT_PUBLIC_FPL_API_URL || 'http://localhost:8000/api/v1';
    ```

    Change TO:
    ```ts
    const FPL_API_BASE_URL = process.env.NEXT_PUBLIC_FPL_API_URL || '/api/v1';
    ```

    Using a relative path means:
    - In dev: browser calls localhost:3000/api/v1/... → Next.js proxy forwards to localhost:8001/api/v1/...
    - In prod: NEXT_PUBLIC_FPL_API_URL env var can be set to the production FPL Sage URL
    - No hardcoded port in client-side code

    Do NOT change any other lines in this file. The fetch calls, interface definitions, and polling logic are correct as-is.
  </action>
  <verify>
    1. Open browser to http://localhost:3000/fpl
    2. Enter a valid FPL team ID (e.g., 123456) and click "Analyze Team"
    3. Open browser DevTools → Network tab
    4. Confirm POST to /api/v1/analyze goes to localhost:3000 (not localhost:8001 or localhost:8000 directly)
    5. Confirm subsequent GET to /api/v1/dashboard/{id} also goes to localhost:3000
    6. No CORS errors in console
  </verify>
  <done>The /fpl page successfully initiates an analysis and the network tab shows all API calls going to localhost:3000/api/v1/* (proxied server-side to the FastAPI backend)</done>
</task>

</tasks>

<verification>
With both changes in place and `npm run dev` running in web/:

1. `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/v1/analyze -H "Content-Type: application/json" -d '{"team_id":1}'` returns 200 or 422 (not 404)
2. Browser DevTools shows no CORS errors on the /fpl page
3. The full flow (submit team ID → loading spinner → results or error from backend) completes without network failures
</verification>

<success_criteria>
- next.config.ts has a rewrites() block proxying /api/v1/:path* to http://localhost:8001/api/v1/:path*
- fpl-api.ts FPL_API_BASE_URL fallback is '/api/v1' (relative, no port)
- Visiting localhost:3000/fpl and submitting a team ID reaches the cheddar-fpl-sage FastAPI backend
</success_criteria>

<output>
After completion, create `.planning/quick/3-wire-cheddar-fpl-sage-frontend-to-localh/3-SUMMARY.md` with what was changed and confirmed working.
</output>
