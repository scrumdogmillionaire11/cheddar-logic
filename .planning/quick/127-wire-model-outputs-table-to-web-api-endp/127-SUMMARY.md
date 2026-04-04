---
phase: quick-127
plan: 01
subsystem: web-api, worker, data
tags: [model-outputs, api-route, dr-claire, comment-correction]
dependency_graph:
  requires: []
  provides: [GET /api/model-outputs]
  affects: [web/src/app/api, packages/data/src/db/models.js, apps/worker/src/jobs/run_nhl_model.js]
tech_stack:
  added: []
  patterns: [NextRequest/NextResponse, getDatabaseReadOnly + closeReadOnlyInstance, performSecurityChecks + addRateLimitHeaders]
key_files:
  created:
    - web/src/app/api/model-outputs/route.ts
  modified:
    - apps/worker/src/jobs/run_nhl_model.js
    - packages/data/src/db/models.js
decisions:
  - "Used raw db.prepare SELECT for no-sport case (returns up to 200 rows) rather than adding a new getModelOutputsAll helper — avoids package churn for a single call site"
  - "NBA model header already accurate (card_payloads only); no change needed there"
metrics:
  duration: 7m
  completed: "2026-04-04"
  tasks_completed: 2
  files_changed: 3
---

# Phase quick-127 Plan 01: Wire model_outputs to GET /api/model-outputs Summary

**One-liner:** GET /api/model-outputs route reading from model_outputs table via getModelOutputsBySport with optional ?sport= filter, plus NHL model header correction removing false model_outputs write claim.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Create GET /api/model-outputs route | b767700 | web/src/app/api/model-outputs/route.ts |
| 2 | Fix NHL header + add models.js inline comment | a5b3bd1 | apps/worker/src/jobs/run_nhl_model.js, packages/data/src/db/models.js |

## What Was Built

**Task 1 — GET /api/model-outputs route**

Created `web/src/app/api/model-outputs/route.ts` following the exact pattern of `/api/cards/route.ts`:

- Calls `performSecurityChecks` + `addRateLimitHeaders`
- Calls `ensureDbReady()` before DB access
- Optional `?sport=` param (case-insensitive, trimmed): routes to `getModelOutputsBySport(sport, sinceUtc)` with a 24h window
- No param: raw `SELECT * FROM model_outputs ORDER BY predicted_at DESC LIMIT 200`
- Parses `output_data` JSON string per row before returning
- `closeReadOnlyInstance()` in finally block
- Returns `{ success: true, data: [...] }` or `{ success: false, error: "..." }` on exception

The endpoint is structured for clean agent polling (Dr. Claire model health monitoring): flat JSON array with all columns present, output_data already parsed.

**Task 2 — Comment corrections**

- `run_nhl_model.js` header: removed false claim that the job writes `model_outputs`; added explicit NOTE clarifying only MLB and NFL runners call `insertModelOutput()`
- `packages/data/src/db/models.js`: added inline comment directly above `getModelOutputsBySport` pointing to the new route as the canonical read surface
- `run_nba_model.js` header: already accurate (only mentions `card_payloads`), no change required

## Verification

- `npm --prefix web run lint` — passes, no errors
- `grep model_outputs run_nhl_model.js` — only appears in the corrective NOTE, no write claims
- `ls web/src/app/api/model-outputs/route.ts` — file exists
- `grep "getModelOutputsBySport|GET /api/model-outputs" route.ts` — both present

## Deviations from Plan

None — plan executed exactly as written. NBA model header check (from additional context) confirmed accurate; no change needed.

## Self-Check: PASSED

- web/src/app/api/model-outputs/route.ts — FOUND
- apps/worker/src/jobs/run_nhl_model.js — FOUND (header corrected)
- packages/data/src/db/models.js — FOUND (inline comment added)
- Commit b767700 — FOUND
- Commit a5b3bd1 — FOUND
