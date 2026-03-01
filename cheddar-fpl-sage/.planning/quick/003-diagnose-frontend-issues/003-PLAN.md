---
phase: quick-003
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: []
autonomous: true

must_haves:
  truths:
    - "We know whether the frontend dev server starts without errors"
    - "We know whether the frontend build succeeds"
    - "We know whether the backend starts and serves its API"
    - "We know whether the frontend can reach the backend API"
    - "We have a written diagnosis with specific error messages and root causes"
  artifacts:
    - path: ".planning/quick/003-diagnose-frontend-issues/003-DIAGNOSIS.md"
      provides: "Documented findings with error messages, what works, what is broken, and recommended fix path"
  key_links:
    - from: "frontend/src"
      to: "backend API on :8000"
      via: "Vite dev proxy at /api"
      pattern: "proxy.*localhost:8000"
---

<objective>
Diagnose whether the frontend web UI is functional or broken. Run the frontend dev server and backend, test the end-to-end flow, capture all errors, and document what is working vs broken.

Purpose: The CLI engine is confirmed working but there is suspicion the web UI (React frontend + FastAPI backend) has issues. Before any fixes, we need a clear picture of what exactly fails.

Output: 003-DIAGNOSIS.md with specific findings - error messages, failed commands, broken connections.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/STATE.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Test frontend build and dependency health</name>
  <files>No files modified - read-only diagnosis</files>
  <action>
Run the following checks from the frontend directory (/Users/ajcolubiale/projects/cheddar-fpl-sage/frontend) and capture all output:

1. Check node_modules exists and is not corrupted:
   `ls node_modules | head -5` and `cat package.json`

2. Attempt TypeScript compile check (no emit):
   `npx tsc --noEmit`

3. Attempt a production build:
   `npm run build`

4. Check for ESLint errors:
   `npm run lint`

Record ALL error messages verbatim. Note which commands succeed vs fail. If build succeeds, confirm dist/ directory exists and has index.html.
  </action>
  <verify>All four commands above have been run and their full output recorded (success or failure).</verify>
  <done>We know: does TypeScript compile? Does the build succeed? Are there lint errors?</done>
</task>

<task type="auto">
  <name>Task 2: Test backend startup and API health</name>
  <files>No files modified - read-only diagnosis</files>
  <action>
From the project root (/Users/ajcolubiale/projects/cheddar-fpl-sage), test backend startup:

1. Check Python environment and backend dependencies are installed:
   `cd /Users/ajcolubiale/projects/cheddar-fpl-sage && python -c "from backend.main import app; print('Backend imports OK')" 2>&1`

2. Start the backend for 5 seconds and capture startup logs:
   `cd /Users/ajcolubiale/projects/cheddar-fpl-sage && timeout 5 python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 2>&1 || true`

3. Start backend in background, test health endpoint, then kill it:
   ```
   cd /Users/ajcolubiale/projects/cheddar-fpl-sage && \
   python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 &
   BACKEND_PID=$!
   sleep 3
   curl -s http://localhost:8000/health
   curl -s http://localhost:8000/
   kill $BACKEND_PID 2>/dev/null
   ```

Record: Does backend start without errors? Does Redis connection fail (expected without Redis)? Does /health return JSON?
  </action>
  <verify>Backend start attempt and health check results are captured.</verify>
  <done>We know: does backend start? What warnings/errors appear? Is the API reachable at :8000?</done>
</task>

<task type="auto">
  <name>Task 3: Document diagnosis findings</name>
  <files>.planning/quick/003-diagnose-frontend-issues/003-DIAGNOSIS.md</files>
  <action>
Based on findings from Tasks 1 and 2, write 003-DIAGNOSIS.md with:

## Status Summary
- Frontend build: [PASS/FAIL + one-line description]
- Backend startup: [PASS/FAIL + one-line description]
- End-to-end connectivity: [PASS/FAIL/UNKNOWN]

## What Works
[List confirmed working items]

## What is Broken
[List each broken item with exact error message]

## Root Causes
[For each broken item, identify root cause: missing dependency, config error, import error, etc.]

## Recommended Fix Path
[Ordered list of fixes needed, simplest first]

Be specific - include exact error text, file names, line numbers where available.
  </action>
  <verify>`cat .planning/quick/003-diagnose-frontend-issues/003-DIAGNOSIS.md` shows a complete diagnosis document.</verify>
  <done>003-DIAGNOSIS.md exists with findings from Tasks 1 and 2, specific error messages, and a recommended fix path.</done>
</task>

</tasks>

<verification>
After all tasks complete:
1. 003-DIAGNOSIS.md exists in .planning/quick/003-diagnose-frontend-issues/
2. Document contains specific error messages (not just "it failed")
3. Document identifies whether this is a frontend build issue, backend issue, or integration issue
4. Document has a recommended fix path
</verification>

<success_criteria>
- We know exactly what is broken in the web UI (specific errors, not vague impressions)
- We know whether the frontend can build at all
- We know whether the backend starts and serves its API
- We have a written diagnosis to guide any fixes
</success_criteria>

<output>
After completion, create `.planning/quick/003-diagnose-frontend-issues/003-SUMMARY.md` following the standard summary template.
</output>
