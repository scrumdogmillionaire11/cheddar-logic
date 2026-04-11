---
phase: WI-0856
plan: WI-0856-01
subsystem: web-api
tags: [next.js, route-handler, market-pulse, scanner, cache, odds]
status: complete
completed: 2026-04-10

dependency-graph:
  requires: [WI-0855]
  provides: [GET /api/market-pulse]
  affects: [WI-0857]

tech-stack:
  added: []
  patterns: [module-level-cache, dual-pass-scan, cjs-require-cast]

key-files:
  created:
    - web/src/app/api/market-pulse/route.ts
  modified: []

decisions:
  - id: D1
    decision: "require() with explicit type cast for CJS packages lacking TS declarations"
    reason: "@cheddar-logic/data and @cheddar-logic/models are CJS with no .d.ts; named ESM import fails"
  - id: D2
    decision: "Interfaces declared before require() casts (TypeScript hoisting constraint)"
    reason: "require() casts reference OddsSnapshot, LineGap, OddsGap in type position; must be declared first"
  - id: D3
    decision: "Cache keyed by sport only; includeWatch excluded from cache key"
    reason: "Full TRIGGER+WATCH set is cached; trimming to TRIGGER happens at serve time per spec"

metrics:
  duration: ~15min
  completed: 2026-04-10
---

# WI-0856 Summary: Market Pulse API route `/api/market-pulse` with 4.5-min server cache

**One-liner:** Next.js route handler with module-level Map cache (4.5-min TTL) running dual-pass scanner — `scanLineDiscrepancies` on all snapshots, then `scanOddsDiscrepancies` on clean games only.

## Objective

Create `web/src/app/api/market-pulse/route.ts` — a read-only API endpoint that:
1. Validates `?sport=` (ALL/NBA/MLB/NHL) and `?includeWatch=` query params
2. Serves from a 4.5-minute module-level cache keyed by sport
3. On cache miss: loads odds snapshots via `getOddsSnapshots()`, runs both scanners
4. Returns `{ scannedAt, lineGaps, oddsGaps, meta }` shape per spec

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Implement `/api/market-pulse` route with cache | 3f0f608 | web/src/app/api/market-pulse/route.ts |

## Decisions Made

| ID | Decision | Rationale |
|----|----------|-----------|
| D1 | `require()` with explicit type cast for CJS packages | No `.d.ts` files in `@cheddar-logic/data` or `@cheddar-logic/models`; named ESM import fails TS check |
| D2 | Domain interfaces declared before `require()` statements | TypeScript `require()` casts reference interface types in type position — must be hoisted |
| D3 | Cache key is sport only; `includeWatch` excluded | Full TRIGGER+WATCH set cached; TRIGGER-only filtering is a view operation at serve time |

## Acceptance Criteria Status

| # | Criterion | Status |
|---|-----------|--------|
| 1 | 200 response with `scannedAt`, `lineGaps`, `oddsGaps`, `meta` | SATISFIED |
| 2 | `?sport=INVALID` returns 400 | SATISFIED |
| 3 | Two rapid calls within TTL hit cache | SATISFIED (module-level Map; same `expiresAt`) |
| 4 | Default response contains only `tier: 'TRIGGER'` items | SATISFIED (`serveResponse` filters when `includeWatch=false`) |
| 5 | `?includeWatch=true` includes WATCH items | SATISFIED (full payload passed through) |
| 6 | Zero forbidden terms (bet/play/recommend/pick) | SATISFIED (`grep` returns exit 1 = no matches) |
| 7 | `oddsGaps` excludes games in `lineGaps` | SATISFIED (`lineGapGameIds` Set filters `cleanSnapshots`) |
| 8 | No DB writes | SATISFIED (read-only path; no write calls) |

## Verification

```
npx tsc --noEmit --project web/tsconfig.json  → EXIT:0
grep -ri "bet|play|recommend|pick" web/src/app/api/market-pulse/route.ts (excluding comments) → 0 matches
```

## Deviations from Plan

None — plan executed exactly as written.

## Next Phase Readiness

WI-0857 (Market Pulse page) can proceed — the API endpoint is live at `/api/market-pulse`.
