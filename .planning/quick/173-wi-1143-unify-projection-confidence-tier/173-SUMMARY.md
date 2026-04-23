---
phase: 173-wi-1143-unify-projection-confidence-tier
plan: "01"
subsystem: web/api/results
tags: [confidence-tier, normalization, projection-settled, type-safety, WI-1143]
dependency_graph:
  requires: []
  provides: [ConfidenceTier, normalizeToConfidenceTier, ProjectionProxyRow.confidenceTier]
  affects: [web/src/app/api/results/projection-settled/route.ts]
tech_stack:
  added: []
  patterns: [read-boundary normalization, canonical type export, TDD]
key_files:
  created:
    - web/src/__tests__/wi-1143-confidence-tier-contract.test.js
  modified:
    - web/src/lib/types/projection-accuracy.ts
    - web/src/app/api/results/projection-settled/route.ts
decisions:
  - "Appended ConfidenceTier and normalizeToConfidenceTier to existing projection-accuracy.ts rather than creating a new file — keeps confidence concerns co-located with existing accuracy types"
  - "confidenceTier is a required (non-optional) field on ProjectionProxyRow to enforce compile-time guarantee that every row carries the canonical tier"
  - "normalizeToConfidenceTier uses 5-level priority cascade matching existing resolveF5MlConfidenceBand / resolveF5MlConfidenceBandFromWinProb logic in route.ts"
metrics:
  duration_seconds: 132
  completed_date: "2026-04-23"
  tasks_completed: 2
  files_modified: 3
---

# Phase 173 Plan 01: WI-1143 Unify Projection Confidence Tier Summary

**One-liner:** Canonical `confidenceTier: 'LOW' | 'MED' | 'HIGH'` field emitted on every `ProjectionProxyRow` by normalizing all legacy vocabulary (WATCH/TRUST/STRONG/null/MISSING_SIGNAL) at the API read boundary.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | Add failing contract test | 0e9b63f5 | web/src/__tests__/wi-1143-confidence-tier-contract.test.js |
| 1 (GREEN) | Implement ConfidenceTier type + normalizer | cadfab34 | web/src/lib/types/projection-accuracy.ts |
| 2 | Emit confidenceTier on ProjectionProxyRow | 55b3f9c0 | web/src/app/api/results/projection-settled/route.ts |

## What Was Built

### `ConfidenceTier` type and `normalizeToConfidenceTier()` function

Added to `web/src/lib/types/projection-accuracy.ts`:

- `export type ConfidenceTier = 'LOW' | 'MED' | 'HIGH'`
- `export function normalizeToConfidenceTier(band, confidenceScore?, winProbability?): ConfidenceTier`

Normalization cascade (5 levels):
1. Canonical value already in `{HIGH, MED, LOW}` — return directly
2. Legacy vocabulary: `STRONG→HIGH`, `TRUST→MED`, `WATCH→LOW`
3. Confidence score fallback (0–100): `>=70→HIGH`, `>=55→MED`, else `LOW`
4. Win-probability distance fallback: `|p−0.5|>=0.20→HIGH`, `>=0.05→MED`, else `LOW`
5. Final default → `LOW`

### `confidenceTier` field on `ProjectionProxyRow`

Added to `web/src/app/api/results/projection-settled/route.ts`:

- `confidenceTier: ConfidenceTier` added as required field on the type
- Proxy eval path: `normalizeToConfidenceTier(row.accuracy_confidence_band ?? row.confidence_bucket, row.confidence_score, row.win_probability)`
- F5 moneyline path: `normalizeToConfidenceTier(confidenceBand, resolvedConfidenceScore, projValue)`
- Raw source fields (`confidenceBand`, `confidenceBucket`, `confidenceScore`) preserved unchanged

## Verification Results

- `node --import tsx/esm ...wi-1143-confidence-tier-contract.test.js` — **13/13 passed**
- `npx tsc --noEmit` — **no errors**
- `npm run test:api:results:flags` — **passed**
- `npm run test:api:validation-registry` — **passed**

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

Files verified present:
- web/src/__tests__/wi-1143-confidence-tier-contract.test.js — FOUND
- web/src/lib/types/projection-accuracy.ts — FOUND (ConfidenceTier, normalizeToConfidenceTier exported)
- web/src/app/api/results/projection-settled/route.ts — FOUND (confidenceTier field present)

Commits verified:
- 0e9b63f5 — FOUND
- cadfab34 — FOUND
- 55b3f9c0 — FOUND
