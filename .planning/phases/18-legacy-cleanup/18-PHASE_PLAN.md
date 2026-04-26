---
phase: 18-legacy-cleanup
name: "Legacy Code Debt & Tech Debt Hardening"
status: planning
created: "2026-04-13T16:00Z"
---

# Phase 18: Legacy Code Debt & Tech Debt Hardening

**Goal**: Eliminate high-risk legacy code patterns, dead imports, and fragile architecture decisions identified in 2026-04-13 concerns audit. Stabilize before full production deployment.

**Milestone**: v1.1 → v1.2 (Post-Ship Quality)

**Scope**: 10 distinct concerns grouped into 5 executable work items (WI-2780 through WI-2784)

**Rationale**: 
- NFL stub disabled indefinitely; archive prevents accidental low-quality card emit
- Deprecated packages create security gaps and memory leaks
- Feature flags scattered across schedulers; standardization reduces configuration complexity
- Pass reason code fallback chain silent-fails in UI rendering
- Goalie state dual-contract (bool + enum) causes ambiguity in model execution

---

## Work Items

### WI-2780: Archive NFL Model Stub & Define Decision Record

| Field | Value |
|-------|-------|
| **Goal** | Formally decide NFL feature status: archive stub with reintroduction path or remove entirely. Update ADR-NFL. Eliminate confusion. |
| **Scope** | `apps/worker/src/jobs/run_nfl_model.js`, `apps/worker/src/schedulers/main.js#L126-129`, `docs/decisions/ADR-0011-nfl-model-decision.md` |
| **Out of Scope** | Building NFL data layer; scheduling NFL model enabling |
| **Acceptance** | (A) Scheduled registration removed; job archived to `_archive/` with internal @deprecated marker; ADR-0011 written with reintroduction checklist. OR (B) Job + scheduler entry deleted entirely with ADR-0011 documenting sunset decision. |
| **Owner** | Unassigned |
| **Priority** | **CRITICAL** — prevents accidental enable without data layer |
| **Effort** | 1–2 hours |
| **Created** | 2026-04-13 |

---

### WI-2781: Remove Dead `projectNBA` Import from models/index.js

| Field | Value |
|-------|-------|
| **Goal** | Remove unused `projectNBA` import from `models/index.js`. Function lives in `projections.js` with @deprecated marker but index.js incorrectly re-exports it, blocking import cleanup. |
| **Scope** | `apps/worker/src/models/index.js` only (leave `projections.js` untouched) |
| **Out of Scope** | Removing `projectNBA` function body; changes to other imports |
| **Acceptance** | 1. Remove `projectNBA,` from destructured require. 2. `grep -n 'projectNBA\b' apps/worker/src/models/index.js` returns 0 results. 3. `npm --prefix apps/worker run test -- --no-coverage` passes. 4. Verify `projectNBACanonical` still imported/exported. |
| **Owner** | Unassigned |
| **Priority** | Medium (cleanup, low risk) |
| **Effort** | 15–30 minutes |
| **Created** | 2026-04-13 |

---

### WI-2782: Standardize Feature Flags Across Schedulers

| Field | Value |
|-------|-------|
| **Goal** | Consolidate scattered feature flag checks (`ENABLE_X=false`, `ENABLE_X=true`, inline string checks) into a single centralized feature object. Standardize all schedulers to call `isFeatureEnabled(sportId, 'model')` pattern. |
| **Scope** | `apps/worker/src/schedulers/*.js` (NFL, FPL, NBA, Player Props, etc.), create `packages/data/src/feature-flags.js` |
| **Out of Scope** | Changing scheduler logic or model behavior; env var schema changes |
| **Acceptance** | 1. `packages/data/src/feature-flags.js` created with `isFeatureEnabled(sport, feature)` function. 2. All schedulers rewritten to call `isFeatureEnabled()` instead of inline flag checks. 3. Unit tests for edge cases (missing env, mis-spelled sport). 4. No `ENABLE_*` strings exist in scheduler source files. 5. CI green. |
| **Owner** | Unassigned |
| **Priority** | High (reduces confusion; centralizes on/off logic) |
| **Effort** | 2–3 hours |
| **Created** | 2026-04-13 |

---

### WI-2783: Unify NHL Goalie State (Remove Deprecated Bool Contract)

| Field | Value |
|-------|-------|
| **Goal** | Eliminate dual-contract goalie state (deprecated `homeGoalieConfirmed` boolean + new `homeGoalieState` enum). Audit all model callers; migrate to state enum exclusively. Remove fallback logic. |
| **Scope** | `apps/worker/src/models/nhl-pace-model.js`, `apps/worker/src/jobs/sync_nhl_goalie_starters.js`, `packages/data/src/db/players.js` (goalie fetch), integration test suite |
| **Out of Scope** | NHL goalie starter sync itself (keep that job); other model parameters |
| **Acceptance** | 1. Lines 255–297 of nhl-pace-model.js rewritten to accept only state enum. 2. No fallback to `homeGoalieConfirmed` boolean. 3. Unit test: pass state enum, assert correct goalie context. 4. Grep for 'homeGoalieConfirmed' returns 0 callers (only definition in `@deprecated` comments in projections.js if it exists). 5. Integration test for NHL model output: confirm goalie state propagates to card payload. |
| **Owner** | Unassigned |
| **Priority** | High (eliminates ambiguity; prevents silent model errors) |
| **Effort** | 2–4 hours |
| **Created** | 2026-04-13 |

---

### WI-2784: Fix Pass Reason Code Fallback Chain (UI + Settlement)

| Field | Value |
|-------|-------|
| **Goal** | Eliminate silent data loss in pass_reason fallback. Canonical `pass_reason_code` (enum string) should be checked first; legacy `pass_reason` (freeform string) only used for historical rows (NOT new rows). Add test to confirm no new rows use legacy field. |
| **Scope** | `web/src/lib/game-card/transform/index.ts#L2436-2443`, `web/src/lib/game-card/market-signals.ts#L59-62`, `apps/worker/src/jobs/post_discord_cards.js#L73-74`, test suite addition |
| **Out of Scope** | Backfilling old rows; changing card payload schema |
| **Acceptance** | 1. Modify transform fallback: ALWAYS check `pass_reason_code` first; use `pass_reason` only if code is null AND row is historical (via created_at or flag). 2. Add unit test: pass card with both fields populated; assert code wins. 3. Add integration test: fetch game API response; scan N recent cards; confirm all non-historical have code, not reason. 4. Discord post function: log warning if `pass_reason` used for new card. 5. Post-launch audit script: identifies any new cards using legacy reason field. |
| **Owner** | Unassigned |
| **Priority** | High (prevents UI render mismatches and settlement inference errors) |
| **Effort** | 3–5 hours |
| **Created** | 2026-04-13 |

---

### WI-2785: Replace Deprecated npm Packages (glob + async)

| Field | Value |
|-------|-------|
| **Goal** | Replace `glob@5.x` (security risk, unmaintained) and `async@1.x` (memory leaks, unmaintained) with modern equivalents. Audit callers in build and worker scripts. |
| **Scope** | `package-lock.json`, `apps/worker/package-lock.json`, build scripts, any direct usage in source |
| **Out of Scope** | Other transitive deprecations; major version upgrades unrelated to these two packages |
| **Acceptance** | 1. `package.json` updated: `glob` → modern version (e.g., glob@10+), `async` → native Promise or small alternative. 2. All `require('glob')` calls in build scripts updated to use new API. 3. All `async.map()` / `async.waterfall()` replaced with Promise-based equivalents. 4. Lock files regenerated. 5. `npm audit` shows no vulns for these packages. 6. Build + tests pass. |
| **Owner** | Unassigned |
| **Priority** | High (security + stability) |
| **Effort** | 2–3 hours |
| **Created** | 2026-04-13 |

---

### WI-2786: Partition model_outputs Table for Scaling (Medium Priority)

| Field | Value |
|-------|-------|
| **Goal** | Add schema partitioning to `model_outputs` table by (sport, model_version_hash) to prevent unbounded growth scans during settlement. Add retention policy (90-day rolling window). Add indices for settlement queries. |
| **Scope** | `packages/data/db/migrations/` (new migration), `packages/data/src/db/connection.js` (partition logic), settlement query optimization |
| **Out of Scope** | Archive/cold storage implementation; retention on other tables |
| **Acceptance** | 1. New migration: partition `model_outputs` by (sport, created_date). 2. Settlement queries updated to use partition elimination. 3. Query plan diff: before/after shows scanned rows reduced by 80%+. 4. Data integrity test: verify rows still found after partitioning. |
| **Owner** | Unassigned |
| **Priority** | Medium (scaling: prevents settling query bloat as models run 4x/day) |
| **Effort** | 4–6 hours |
| **Created** | 2026-04-13 |

---

### WI-2787: Graceful Database Lock Recovery

| Field | Value |
|-------|-------|
| **Goal** | Implement auto-detect of stale lock file (>30min old); emit health warning to Discord; do NOT auto-unlock (prevents corruption). Add recovery runbook + scripts/unlock-db-safe.sh with user confirmation gate. |
| **Scope** | `packages/data/src/db/connection.js` (health check), `scripts/unlock-db-safe.sh` (new), health-check job alerting |
| **Out of Scope** | CHEDDAR_DB_ALLOW_MULTI_PROCESS workaround; allowing concurrent writers |
| **Acceptance** | 1. Health check job runs every 5 min; detects lock >30min old. 2. Discord alert sent with lock age + operator runbook link. 3. `scripts/unlock-db-safe.sh` created: confirms age, stops worker, removes lock, restarts worker. 4. Test: simulate stale lock, verify alert + script works. |
| **Owner** | Unassigned |
| **Priority** | Medium (reduces manual intervention; increases uptime) |
| **Effort** | 2–3 hours |
| **Created** | 2026-04-13 |

---

### WI-2788: Add Market Type Validation at API Boundary

| Field | Value |
|-------|-------|
| **Goal** | Add strict schema validation for `market_type` at API routes to reject canonical names not in enum. Prevents silent settlement failures due to market mismatch. |
| **Scope** | `web/src/app/api/games/route.ts` (input validation), `packages/data/src/validators/market-type.js` (new validator), test suite |
| **Out of Scope** | Backfilling invalid rows; settlement logic changes |
| **Acceptance** | 1. New validator: `validateMarketType(type)` returns valid enum or throws typed error. 2. API route calls validator before passing to transform/settlement. 3. Test: unknown market type returns 400 + error message. 4. Test: canonical types pass through. 5. Integration test: confirm settlement skips invalid types (non-actionable). |
| **Owner** | Unassigned |
| **Priority** | Medium (prevents silent settlement failures) |
| **Effort** | 2–3 hours |
| **Created** | 2026-04-13 |

---

### WI-2789: Centralize Scheduler Window Calculation Logic

| Field | Value |
|-------|-------|
| **Goal** | Extract scattered window checks (windows.js#L118–153, main.js#L150–176) into single `ScheduleWindow` type with named bounds. Audit all schedulers for off-by-one errors. Simplify window reasoning. |
| **Scope** | `apps/worker/src/schedulers/windows.js` (create export), `apps/worker/src/schedulers/*.js` (refactor all checks), test suite |
| **Out of Scope** | Changing game schedule fetch logic; changing fetch frequency |
| **Acceptance** | 1. `ScheduleWindow` type created: `{ minsBefore, minsAfter, alignmentMins, gameStartUtc }`. 2. All schedulers rewritten to call `getExecutionWindow(game, sport)`. 3. Unit tests: verify -30m pass start, +90m, 5m alignment for NHL + NBA + MLB. 4. No more ad-hoc max/min checks in scheduler bodies. 5. Code review: window logic simple enough to reason about in <5 min. |
| **Owner** | Unassigned |
| **Priority** | Medium (reduces edge-case bugs; improves code clarity) |
| **Effort** | 3–4 hours |
| **Created** | 2026-04-13 |

---

## Execution Plan (Proposed)

### Wave 1 (Critical; start immediately)
- **WI-2780**: Archive NFL stub (1–2h)
- **WI-2781**: Remove projectNBA import (0.5h)

### Wave 2 (High; start after Wave 1)
- **WI-2782**: Standardize feature flags (2–3h)
- **WI-2783**: Unify goalie state (2–4h)

### Wave 3 (High; can overlap with Wave 2)
- **WI-2784**: Fix pass_reason chain (3–5h)
- **WI-2785**: Replace deprecated npm packages (2–3h)

### Wave 4 (Medium; after Wave 3)
- **WI-2786**: Partition model_outputs (4–6h)
- **WI-2787**: Graceful lock recovery (2–3h)
- **WI-2788**: Market type validation (2–3h)
- **WI-2789**: Centralize window logic (3–4h)

---

## Risks & Dependencies

| Risk | Mitigation |
|------|-----------|
| Goalie state refactor breaks model tests | Add comprehensive NHL model integration test; run against historical payloads. |
| Pass reason fallback change affects UI rendering | Add UI snapshot tests; verify all legacy cards still render correctly. |
| npm package upgrade introduces transitive issues | Run full integration test suite after upgrade. |
| Scheduler window centralization misses edge cases | Code review + unit test coverage >90% for boundary conditions. |

---

## Success Criteria

- [ ] All 9 work items claimed, executed, and closed by assigned agents
- [ ] No regressions in model output (NHL, NBA, MLB, FPL)
- [ ] No new security alerts in `npm audit`
- [ ] Settlement query performance ≥ baseline (partition validation)
- [ ] Feature flags centralized + documented
- [ ] Zero instances of `ENABLE_*` string literals in scheduler code
- [ ] Pass reason code fallback test added + passing
- [ ] Goalie state contract simplified + unified

---

*Phase plan created: 2026-04-13 | Orchestrator summary generated from 10-item legacy concerns audit.*
