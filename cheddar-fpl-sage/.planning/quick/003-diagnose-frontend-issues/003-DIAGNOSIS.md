# FPL Sage Web UI Diagnosis

**Date:** 2026-02-08
**Diagnosed by:** Automated task execution (003-PLAN.md)

---

## Status Summary

| Component | Status | Description |
|-----------|--------|-------------|
| TypeScript compile (`tsc --noEmit`) | PASS | No type errors via direct compile |
| Frontend build (`npm run build`) | FAIL | 2 TypeScript errors block production build |
| ESLint | FAIL | 11 errors, 1 warning across 5 files |
| Backend startup (FPL Sage) | PASS | Starts cleanly, Redis connects, /health returns 200 |
| Port 8000 availability | FAIL | Occupied by unrelated "Cheddar NBA Pipeline" service |
| Frontend dev server | BLOCKED | Would start on :5173 but Vite proxy targets :8000 which has wrong service |
| End-to-end connectivity | BROKEN | Proxy would hit wrong backend |

---

## What Works

1. **TypeScript compilation passes** when using `npx tsc --noEmit` directly - zero errors
2. **FPL Sage backend starts cleanly** - tested on port 8001:
   - `/health` returns `{"status":"healthy","version":"1.0.0","redis":"connected"}`
   - `/` returns `{"name":"FPL Sage API","version":"1.0.0",...}`
   - Redis connects successfully to `redis://localhost:6379`
3. **Backend startup logs** show no errors:
   - Unlimited access teams configured
   - Rate limit middleware initialized
   - Application startup complete
4. **node_modules** exists and is not corrupted
5. **dist/** exists from a previous successful build (January 30, 2026)
6. **Frontend code is mostly valid React/TypeScript** - 15 source files, no import errors

---

## What Is Broken

### 1. Frontend Build Fails - TypeScript Errors in Results.tsx

**Error:** `tsc -b` (used by `npm run build`) raises type errors that `tsc --noEmit` does not

**Exact errors from `npm run build`:**
```
src/pages/Results.tsx(486,37): error TS2339: Property 'projected_xi' does not exist on type 'AnalysisResults'.
src/pages/Results.tsx(496,37): error TS2339: Property 'projected_bench' does not exist on type 'AnalysisResults'.
```

**Context:** `AnalysisResults` in `frontend/src/lib/api.ts` defines explicit fields `starting_xi` and `bench` but not `projected_xi` or `projected_bench`. An index signature `[key: string]: any` exists on line 97 which should allow arbitrary keys, but TypeScript 5.9.3 with composite project builds (`tsc -b`) appears to enforce stricter property access than standalone `tsc --noEmit`.

**File:** `frontend/src/pages/Results.tsx` lines 486 and 496
**Type definition:** `frontend/src/lib/api.ts` lines 40-98 (AnalysisResults interface)

### 2. Port 8000 Occupied by Wrong Service

**Error:** Port 8000 is occupied by a "Cheddar NBA Pipeline" service (unrelated project)

**Evidence:**
```
lsof -i :8000 shows: python3.1 processes on *:irdmi (irdmi = port 8000)
curl http://localhost:8000/ returns: {"service":"Cheddar NBA Pipeline","status":"operational",...}
```

**Impact:** The Vite dev proxy in `frontend/vite.config.ts` proxies `/api` to `http://localhost:8000`. If the frontend dev server is started, all API calls will hit the NBA Pipeline instead of FPL Sage.

### 3. ESLint Errors (11 errors, 1 warning)

**Full output from `npm run lint`:**

- `src/components/UsageCounter.tsx:35:7` - setState called synchronously within useEffect
- `src/components/ui/button.tsx:56:18` - Fast refresh violation (constant exported from component file)
- `src/components/ui/input.tsx:4:18` - Empty interface equivalent to supertype
- `src/lib/api.ts:97:18` - `any` type used (2 instances)
- `src/pages/Landing.tsx:92:19`, `93:21` - unused variable `_`; `115:19` - `any` type
- `src/pages/Progress.tsx:16:13` - `any` type; `194:50` - ref accessed during render
- `src/pages/Results.tsx:133:18` - `projErr` defined but never used

**Severity:** ESLint is run separately from the TypeScript build. These errors do NOT block the production build (only TypeScript errors do). However, `react-hooks/refs` error in Progress.tsx (accessing `reconnectAttemptsRef.current` during render) could cause incorrect rendering.

### 4. `transfer_plans` Field Not in AnalysisResults Type

**Results.tsx line 487 and 497 reference:** `results.transfer_plans?.primary || results.transfer_plans?.secondary`
**Not declared** in `AnalysisResults` interface in api.ts (only accessible via `[key: string]: any`)

This did not trigger a TypeScript error (the index signature catches it) but is worth noting for future type safety.

---

## Root Causes

| Issue | Root Cause |
|-------|-----------|
| TypeScript build failure | `projected_xi` and `projected_bench` added to Results.tsx (likely during Phase 3 work) but not added to `AnalysisResults` interface in api.ts. TypeScript 5.9.3 composite build is stricter about property access than standalone compile. |
| Port 8000 conflict | A separate "Cheddar NBA Pipeline" project has a uvicorn server running on port 8000. This is a development environment conflict, not a code issue. |
| ESLint errors | Code quality issues accumulated during rapid development - `any` types, unused vars, ref-during-render pattern. |
| `tsc --noEmit` vs `tsc -b` discrepancy | `tsc --noEmit` compiles `src/` directly but `tsc -b` uses the composite project references and may read cached build info differently. This is surprising and warrants investigation. |

---

## Recommended Fix Path

Listed in order of impact (most critical first):

### Fix 1: Add missing fields to AnalysisResults interface (5 minutes)

**File:** `frontend/src/lib/api.ts`
**Action:** Add `projected_xi` and `projected_bench` to the `AnalysisResults` interface alongside the existing `starting_xi` and `bench` fields:

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

**Expected result:** `npm run build` succeeds, TypeScript errors resolved.

### Fix 2: Stop the conflicting NBA Pipeline service or change FPL Sage port (2 minutes)

**Option A (preferred for dev):** Kill the NBA Pipeline: `lsof -ti :8000 | xargs kill`
**Option B (config change):** Run FPL Sage on port 8001 and update `vite.config.ts` proxy target to `http://localhost:8001`
**Expected result:** Frontend dev server proxies API calls to correct backend.

### Fix 3: Fix ESLint errors (30 minutes)

**Priority order:**
1. `Progress.tsx:194` - ref accessed during render (functional bug, may cause incorrect state display)
2. `UsageCounter.tsx:35` - setState in effect body (performance issue, may cause cascading re-renders)
3. Remaining errors (`any` types, unused vars) - code quality, no functional impact

### Fix 4: Delete stale .tsbuildinfo cache (optional, 1 minute)

If `tsc --noEmit` and `tsc -b` continue to disagree after Fix 1:
```bash
rm frontend/node_modules/.tmp/tsconfig.app.tsbuildinfo
rm frontend/node_modules/.tmp/tsconfig.node.tsbuildinfo
```

---

## Additional Notes

- The **existing dist/** (built January 30) predates the `projected_xi`/`projected_bench` changes and is therefore stale
- The **backend API itself is fully functional** - all startup, health check, and routing work correctly
- The **dev workflow** requires: (1) backend running on :8000, (2) `npm run dev` on :5173 - neither of which works cleanly right now due to the port conflict and build failure
