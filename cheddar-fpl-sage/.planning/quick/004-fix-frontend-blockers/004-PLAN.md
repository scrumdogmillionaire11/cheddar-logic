---
phase: quick-004
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - frontend/src/lib/api.ts
  - frontend/vite.config.ts
  - frontend/src/lib/api.ts
autonomous: true

must_haves:
  truths:
    - "Frontend builds without TypeScript errors"
    - "Vite dev server proxies /api to the FPL Sage backend on port 8001"
    - "WebSocket direct connection targets port 8001"
  artifacts:
    - path: "frontend/src/lib/api.ts"
      provides: "AnalysisResults interface with projected_xi and projected_bench fields"
      contains: "projected_xi"
    - path: "frontend/vite.config.ts"
      provides: "Proxy config pointing to port 8001"
      contains: "8001"
  key_links:
    - from: "frontend/src/pages/Results.tsx"
      to: "AnalysisResults interface"
      via: "results.projected_xi / results.projected_bench"
      pattern: "projected_xi\\?"
    - from: "frontend/src/lib/api.ts"
      to: "vite.config.ts"
      via: "getWebSocketURL uses same port as proxy target"
      pattern: "localhost:8001"
---

<objective>
Fix both frontend blockers so the dev server starts and the build compiles cleanly.

Purpose: Unblock frontend development and allow end-to-end testing of the full FPL Sage web flow.
Output: Clean TypeScript build, working Vite dev proxy on port 8001.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@frontend/src/lib/api.ts
@frontend/vite.config.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add projected_xi and projected_bench to AnalysisResults interface</name>
  <files>frontend/src/lib/api.ts</files>
  <action>
    In the `AnalysisResults` interface (lines 40-98), add two optional fields after the `bench` array field:

    ```typescript
    projected_xi?: Array<{
      name: string;
      expected_pts?: number;
      position?: string;
      team?: string;
    }>;
    projected_bench?: Array<{
      name: string;
      expected_pts?: number;
      position?: string;
      team?: string;
    }>;
    ```

    These fields represent the post-transfer starting XI and bench that Results.tsx already references at lines 486 and 496. The shape mirrors `starting_xi` and `bench` exactly since the same `SquadSection` component renders all four arrays.
  </action>
  <verify>Run `cd /Users/ajcolubiale/projects/cheddar-fpl-sage/frontend && npx tsc --noEmit` and confirm zero errors referencing projected_xi or projected_bench.</verify>
  <done>TypeScript reports 0 errors for projected_xi and projected_bench in Results.tsx.</done>
</task>

<task type="auto">
  <name>Task 2: Move backend proxy and WebSocket to port 8001</name>
  <files>frontend/vite.config.ts, frontend/src/lib/api.ts</files>
  <action>
    **In `frontend/vite.config.ts`:** Change the proxy target from `http://localhost:8000` to `http://localhost:8001`.

    **In `frontend/src/lib/api.ts`:** Change the WebSocket direct-connection host from `localhost:8000` to `localhost:8001` (line 233 in the `getWebSocketURL` function).

    Do NOT change the Vite server port (5173 is fixed by strictPort). Do NOT add WebSocket proxy — the comment already explains Vite proxy does not support WebSocket, so the direct connection pattern stays, just on 8001.
  </action>
  <verify>
    1. Run `cd /Users/ajcolubiale/projects/cheddar-fpl-sage/frontend && grep -n "8000" vite.config.ts src/lib/api.ts` — should return no results.
    2. Run `grep -n "8001" frontend/vite.config.ts frontend/src/lib/api.ts` — should show both files updated.
  </verify>
  <done>No references to port 8000 remain in vite.config.ts or api.ts; both now target port 8001.</done>
</task>

<task type="auto">
  <name>Task 3: Verify full build passes</name>
  <files></files>
  <action>
    Run the full TypeScript build to confirm no remaining errors:

    ```bash
    cd /Users/ajcolubiale/projects/cheddar-fpl-sage/frontend && npm run build
    ```

    If the build fails with errors unrelated to these two blockers, document them but do not fix them in this plan — scope is strictly the two diagnosed blockers.
  </action>
  <verify>`npm run build` exits with code 0 and produces output in `frontend/dist/`.</verify>
  <done>Build succeeds cleanly. Frontend is unblocked for development and end-to-end testing.</done>
</task>

</tasks>

<verification>
- `npx tsc --noEmit` in frontend/ reports 0 errors
- `grep "8000" frontend/vite.config.ts frontend/src/lib/api.ts` returns nothing
- `npm run build` succeeds (exit code 0)
</verification>

<success_criteria>
Both blockers resolved:
1. TypeScript compiles Results.tsx without errors about projected_xi / projected_bench
2. Vite dev server and WebSocket both target port 8001 (no longer conflicts with NBA Pipeline on 8000)
</success_criteria>

<output>
After completion, create `.planning/quick/004-fix-frontend-blockers/004-SUMMARY.md`
</output>
