# Dead Code & Pipeline Cleanup Audit

**Audit Date:** 2026-04-27  
**Method:** grep-verified imports, scheduler registration, runtime flag inspection, explicit call-site tracing. No deletions recommended without proof.
****
**Scheduling note:** NFL cleanup and parity work is intentionally deferred until the June/July summer window unless NFL enablement moves earlier.

---

## Executive Verdict

| Dimension | Rating | Evidence |
|-----------|--------|----------|
| Overall cleanup grade | **C+** | Multiple active legacy paths, 4+ dead/unscheduled jobs, 3 remaining `normalizeMarketType` implementations, no degraded-state persistence |
| Highest-risk live ghost path | **MLB game-line fallback in web** | `web/src/lib/games/route-handler.ts:950` — reads v1 payload topology, injects older cards when current model rows are missing; can serve stale PLAY cards on a fresh model run gap |
| Highest-risk broken pipeline | **Pipeline health watchdog default-off** | `apps/worker/src/jobs/check_pipeline_health.js` watchdog alerting remains disabled unless `ENABLE_PIPELINE_HEALTH_WATCHDOG=true`, so repeated failures can degrade quietly |
| Highest-risk unsafe fallback | **MLB game-line fallback injection path** | `web/src/lib/games/route-handler.ts:1058` can inject older rows when current-run MLB game-line cards are missing |

---

## Cleanup Inventory

### A. Safe Delete Candidates

| File/Path | Why Dead | Evidence | Risk If Deleted | Test Needed |
|-----------|----------|----------|-----------------|-------------|
| `apps/worker/src/jobs/execution-gate.js` — `VIG_COST_STANDARD`, `SLIPPAGE_ESTIMATE` constants | Marked `DEPRECATED (ADR-0017)`, exported but zero import sites outside the file | `grep -rn "VIG_COST_STANDARD\|SLIPPAGE_ESTIMATE" apps/worker/src --include="*.js"` returns only execution-gate.js | None — they are exported no-ops | Test that removal does not break `evaluateExecution` exports |
| `packages/adapters/src/f5-line-fetcher.js` | Header said "Spike scope", "Production use is deferred pending legal/ToS review." Not imported anywhere in worker | `grep -rn "f5LineFetcher\|f5-line-fetcher" apps/worker/src` = no runtime results; stale test mocks removed | ✅ Completed — file removed from adapters package and dead test mocks deleted (`run-mlb-model.dual-run.test.js`, `run_mlb_model.test.js`) | `npm --prefix apps/worker test -- src/__tests__/run-mlb-model.dual-run.test.js` and `npm --prefix apps/worker test -- src/jobs/__tests__/run_mlb_model.test.js` |
| `apps/worker/src/utils/nhl-shots-patch.js` | Name implies temporary patch. Only imported by `run_nhl_player_shots_model.js` for `applyNhlDecisionBasisMeta` — needs audit to determine if it is a shim or permanent | One call site: `run_nhl_player_shots_model.js:35` | Medium — if it applies required basis meta, removing silently breaks NHL shots cards | Inspect function, verify behavior is captured elsewhere |
| `apps/worker/src/jobs/repair_mlb_full_game_display_log.js` | One-shot repair script — no scheduler registration, not in `package.json` scripts, had local `normalizeMarketType` copy | No schedule entry; file no longer present in worker jobs path | ✅ Completed — script removed from active jobs tree | None |
| `apps/worker/src/models/mlb-model.js` — deprecated WI-0763 traceability fields at lines 2751–2805 | Marked deprecated, documented as no longer driving projection. Owner: WI-1173. | `grep "deprecated WI-0763" apps/worker/src/models/mlb-model.js` | Low — audit/test fixtures may reference these fields | Add assertion that removal does not change projection output |

---

### B. Archive Candidates

| File/Path | Why Legacy | Still Referenced By | Recommended Destination | Guard Needed |
|-----------|------------|---------------------|------------------------|--------------|
| `web/src/lib/game-card/transform/adapters/v1-legacy-repair.ts` | Entire file is a V1 payload shape adapter. The V1 topology (pre-canonical-envelope) is still probed live at `route-handler.ts:969-976` and `transform/index.ts:61` | `route-handler.ts`, `transform/index.ts` | Keep in place but add `@v1-only` flag; archive when MLB historical card cutover is complete | Must add test: no v1 code path fires for any card created after a V2 cutover date |
| `apps/worker/src/jobs/resettle_historical_cards.js` | "Resettle historical" — ad-hoc backfill. Manual-only via `package.json:job:resettle-history`. Not in any scheduler. | `apps/worker/package.json` npm script only | `.archive/one-shot-scripts/` | Dry-run before any use; verify schema compat |
| `apps/worker/src/jobs/import_historical_settled_results.js` | Historical import — manual-only (`package.json:job:import-historical-settled`). Not scheduled. | `apps/worker/package.json` npm script only | `.archive/one-shot-scripts/` | Same as above |
| `apps/worker/src/jobs/backfill_period_token.js` | Backfills `market_period_token` into already-settled rows. Manual-only (npm script, no scheduler). Comment says it's for already-settled rows. | `apps/worker/package.json` only | `.archive/one-shot-scripts/` | Dry-run mode exists — safe |
| `web/src/lib/game-card/transform/legacy-repair.ts` | Contains `normalizeCardType`, `getSourcePlayAction`, `resolveSourceModelProb` for old payload shapes. Still re-exported via `v1-legacy-repair.ts`. | `v1-legacy-repair.ts` re-exports, `transform/index.ts` imports `isPlayItem`, `isEvidenceItem`, `isWelcomeHomePlay` | Archive when v1 cutover complete | Test that no current card fails the non-v1 path |

---

### C. Live Legacy Paths That Must Be Expired

| Path | Current Behavior | Why Unsafe | Expiry Rule | Replacement |
|------|-----------------|------------|-------------|-------------|
| `apps/worker/src/utils/decision-publisher.js:214` — `fallbackToLegacy: true` | When publishing a decision via `readDecisionAuthority` in the main publish path, if `decision_v2` is missing or malformed, it reads `action/classification/status` from legacy top-level fields to derive `official_status` | A card missing `decision_v2` should fail closed. With this flag, legacy fields can produce a PLAY status on a card that never passed the canonical pipeline. The legacy fields are set by older job runs and may not be current. | Expire: any card created after V2 stabilization date (worker >= decision-pipeline-v2 release). For historical cards, the flag is acceptable. Implement a cutover epoch check. | `fallbackToLegacy: false` + explicit fail-closed `official_status: 'PASS'` for any card without `decision_v2.canonical_envelope_v2` |
| `web/src/lib/games/route-handler.ts:950-990` — `isEligibleMlbGameLineFallbackRow` + `mergeMlbGameLineFallbackRows` | When current-run MLB full-game or ML cards are missing for a game, the API injects older card rows (up to `API_GAMES_MLB_FALLBACK_MAX_AGE_MINUTES`) that passed a multi-condition eligibility check including v1 payload probes | The fallback deliberately reads v1 payload topology (`resolveMlbFallbackOfficialStatus`, `hasMlbFallbackDropReason`, etc.) to infer decision. If the worker ran and wrote a PASS for the same game (but it didn't persist the row properly), the fallback can serve an older PLAY to the user. | Expire: once the worker's `run_mlb_model` consistently writes canonical v2 rows without gaps; add check that current run exists before enabling fallback | ✅ **COMPLETED (2026-04-27):** Disabled fallback merge in route-handler.ts:2474; empty/PASS now served when current-run MLB full-game/ML cards missing |
| `apps/worker/src/jobs/settle_pending_cards.js` legacy acceptance surfaces | Live settlement now fails closed when `decision_v2.official_status` is missing, and historical-only display-log backfill is hard-disabled by ADR-0003. Backfill helper resolution also now requires canonical `decision_v2.official_status` instead of accepting legacy `status/action/classification`. | Remaining risk is limited to any future re-enable of display-log backfill without canonical decision data. The prior warning-only live settlement path is no longer active. | Keep backfill disabled unless a historical-only use case is explicitly re-approved. If re-enabled, maintain canonical-only status resolution. | ✅ **COMPLETED (2026-04-27):** Replaced resolveNormalizedDecisionStatus with resolveExplicitOfficialDecisionStatus in backfill helper; enforces canonical-only authority |
| `web/src/lib/game-card/decision.ts:167` — `isMlbFullGameLegacyDisplayPlay` | For MLB full-game cards without `decision_v2`, falls back to `action/classification/status` to derive display decision | Active display bypass of canonical read — MLB full-game users can see PLAY on cards that have no `decision_v2` envelope | Expire: when all MLB full-game cards in DB have `decision_v2` | ✅ **COMPLETED (2026-04-27):** Added V2_STABILIZATION_CUTOVER_EPOCH constant (2026-04-25); legacy fallback now enforces fail-closed for cards created after cutover |
| `apps/worker/src/schedulers/nfl.js:38-39` — `ENABLE_NFL_MODEL=false` guard | NFL model is frozen behind `ENABLE_NFL_MODEL=false`. Scheduler still runs, just logs "frozen". | NFL model job (`run_nfl_model.js`) has no `decision_basis_meta`, no `freshness_tier`, no `execution_gate` integration — it writes cards without these required fields. If flag is flipped on, it would write under-specified cards live. | Expire: don't flip flag until `run_nfl_model.js` is brought to parity with MLB/NBA/NHL | Deferred to June/July summer window; add pre-flight validation before enabling that asserts `decision_basis_meta` is set |

---

### D. Half-Wired Pipelines

| Pipeline/Job | Produces | Consumed By | Missing Link | User-Facing Symptom | Fix |
|-------------|----------|-------------|--------------|---------------------|-----|
| `apps/worker/src/jobs/pull_nhl_1p_odds.js` | Writes `total_1p`, `total_1p_price_over`, `total_1p_price_under` to `odds_snapshots` | `run_nhl_model.js` reads these columns via `oddsSnapshot.total_1p` | **Not registered in any scheduler**. Not in `schedulers/nhl.js`, `schedulers/player-props.js`, or `schedulers/main.js`. Only callable manually. | NHL 1P cards always use projection-floor synthetic line (`floorFull * 0.32`) instead of real market line | Register in `schedulers/nhl.js` before `run_nhl_model` window; gate on `NHL_1P_ODDS_ENABLED=true` |
| `apps/worker/src/jobs/pull_public_splits.js` + `pull_vsin_splits.js` | Writes `splits_*` (public) and `dk_bets_pct_*`, `dk_handle_pct_*` (DK/VSIN) to `odds_snapshots` | `run_nba_model.js` reads `splits_divergence` from `dk_bets_pct_home`. `run_nhl_model.js` reads `dk_bets_pct_home`. `run_mlb_model.js` does NOT read splits. NFL does NOT read splits. | MLB model has no splits input path | For MLB: splits data is fetched but ignored in decision logic | Wire `splits_divergence` into MLB market intel reads |
| `apps/worker/src/jobs/run_nfl_model.js` | Writes card payloads with `model_version: 'nfl-model-v1'` | `check_pipeline_health.js`, web `/api/cards`, web `/api/games` | No `decision_basis_meta`, no `freshness_tier`, no `execution_gate` call, no `pipeline_health` write by job itself | If NFL is enabled: cards appear without freshness, basis, or execution-gate status; web transform will not find `freshnessTier` | Deferred to June/July summer window; bring `run_nfl_model.js` to v2 parity before enabling |
| `apps/worker/src/jobs/check_pipeline_health.js` | Writes `pipeline_health` table (phase/check_name/status/reason) | Web `/api/admin/pipeline-health` endpoint | `ENABLE_PIPELINE_HEALTH_WATCHDOG` defaults to `false` — Discord alerts never fire unless explicitly set | Pipeline can degrade silently without operator alerts | Set `ENABLE_PIPELINE_HEALTH_WATCHDOG=true` in production; add degraded-state row persistence so it survives a restart |
| `apps/worker/src/jobs/potd/settle-shadow-candidates.js` + `settlement-mirror.js` | POTD shadow settlement | POTD engine reporting | Shadow candidates settlement does not write to `pipeline_health`. No failure persistence. | POTD settlement errors are logged but not surfaced | Add `pipeline_health` write on error; add test for mirror failure path |

---

### E. Duplicate Authority Hotspots

| Concern | Implementations | Current Risk | Canonical Owner | Required Deletion/Import Change |
|---------|----------------|-------------|-----------------|--------------------------------|
| `normalizeMarketType` | 2 primary implementations remain: `packages/data/src/normalize.js:116` and `packages/data/src/market-contract.js:22`. `packages/models/src/decision-gate.js` now delegates core market normalization to canonical market-contract and only keeps local policy mapping (`first_period`, `team_total`, `prop`) for gate semantics. Plus `normalizeMarketTypeForTracking` at `packages/data/src/db/cards.js:293`. | Residual divergence risk remains between `data/src/normalize.js` and canonical contract, but worker-local one-off copies are removed and models gate now anchors to canonical outputs for MONEYLINE/SPREAD/TOTAL. | `packages/data/src/market-contract.js::normalizeMarketType` (canonical, most complete) | Completed: removed local copies in `repair_mlb` and `performance_drift_report`; audited and consolidated `decision-gate.js` to canonical delegation |
| `normalizeMarketTag` | Local tag resolver in `apps/worker/src/jobs/post_discord_cards.js` now delegates core market mapping to canonical `normalizeMarketType` (market-contract) while preserving Discord-only tags (`POTD`, `1P`, prop tags). | Residual risk is now limited to Discord-specific display tags; core ML/SPREAD/TOTAL classification is canonicalized. | `packages/data/src/market-contract.js` | Completed canonical delegation for core market types; regression tests added for `h2h`, `ou`, and MLB token false-positive guard |
| Reason code registries | `packages/data/src/reason-codes.js` (canonical, with ALL_REASON_CODES) + `web/src/lib/game-card/transform/reason-codes.ts` (web-side alias map + set of codes) + inline reason code strings across `mlb-model.js`, `execution-gate.js`, `nhl-totals-status.js` | Web alias map `PASS_REASON_ALIAS_MAP` normalizes codes that may not exist in canonical registry; unregistered codes will pass through silently | `packages/data/src/reason-codes.js` | Validate web alias map against canonical registry in a test; add test that all inline reason codes exist in canonical set |
| Staleness calculations | `apps/worker/src/jobs/check_pipeline_health.js:243` (odds freshness: `ageMinutes > ODDS_FRESHNESS_MAX_AGE_MINUTES`), `packages/data/src/teamrankings-ft.js:329` (feature staleness), `web/src/app/admin/page.tsx:169` (UI staleness), `apps/worker/src/jobs/execution-gate-freshness-contract.js` (gate contract), `apps/worker/src/models/feature-time-guard.js` (feature timestamp guard) | Each uses different thresholds and different field names (`isStale`, `freshness_tier`, `stale`). A card can be "fresh" per gate but "stale" per pipeline health. | `apps/worker/src/jobs/execution-gate-freshness-contract.js` | Unify freshness tier into `freshness_tier: 'FRESH' | 'STALE_VALID' | 'EXPIRED' | 'UNKNOWN'` propagated from gate; consume in all sites |
| Decision readers | `packages/models/src/decision-authority.js` (canonical), `web/src/lib/runtime-decision-authority.ts` (web read), `web/src/lib/game-card/decision.ts` (display resolver with MLB legacy bypass), `apps/worker/src/utils/decision-publisher.js` (publish path) | Four separate sites reading/writing decision fields. Publisher uses `fallbackToLegacy: false`; web reader uses `false`; display resolver has own MLB legacy path with cutover epoch enforcement. | `packages/models/src/decision-authority.js` | ✅ **COMPLETED (2026-04-27):** Publisher mirror web with `fallbackToLegacy: false`; display resolver enforces V2 cutover epoch for MLB legacy bypass |

---

### F. Unsafe Fallbacks

| Fallback | File | Trigger | Bad Outcome | Correct Fail-Closed Behavior |
|----------|------|---------|-------------|------------------------------|
| `fallbackToLegacy: true` in publish path | `apps/worker/src/utils/decision-publisher.js:214` | Any card during publish where `decision_v2` is missing or has no `canonical_envelope_v2` | Legacy `action/classification/status` fields (written by older job runs) used to derive `official_status`, potentially PLAY | ✅ **COMPLETED (prior):** Already set to `fallbackToLegacy: false` with synthetic PASS at line 220 for fail-closed behavior |
| MLB game-line fallback injection | `web/src/lib/games/route-handler.ts:1058` | Current-run MLB full/ML card is missing for a game (model gap) | Injects an older PLAY card from a previous run. The row passed all v1 eligibility probes but may not reflect the latest model run's opinion. | Return empty / PASS for missing game. Log the gap. Do not inject older rows. |
| `isMlbFullGameLegacyDisplayPlay` display bypass | `web/src/lib/game-card/decision.ts:167` | MLB full-game card has no `decision_v2` | Display shows PLAY/LEAN based on legacy `action`/`classification` fields | Return PASS for missing `decision_v2` |
| `canonicalDecision` synthetic PASS at `decision-publisher.js:220` | `apps/worker/src/utils/decision-publisher.js:220` | `authorityDecision` is null (no canonical data resolvable) | Defaults to `{ official_status: 'PASS', is_actionable: false }` — this is correct fail-closed | ✅ This fallback is safe. No change needed. |
| NHL shots 1P synthetic line | `apps/worker/src/jobs/run_nhl_player_shots_model.js:2852` | No real Odds API prop line for 1P | Uses `Math.round(floorFull * 0.32 * 2) / 2` projection floor as market line | `market_line_source: 'synthetic_fallback'` is set. BUT: `blockedNoRealLine = !usingRealLine \|\| !isOddsBacked` — this blocks BREAKOUT path. Standard full-game path can still produce cards with synthetic line. Needs explicit PROJECTION_ONLY basis assertion. |
| Settlement display-log backfill legacy status acceptance | `apps/worker/src/jobs/settle_pending_cards.js` backfill helpers | Historical backfill candidate has no canonical `decision_v2.official_status` | Legacy `status/action/classification` could otherwise resurrect a PLAY/LEAN candidate during backfill ranking | Fail closed unless canonical `decision_v2.official_status` is present; keep display-log backfill disabled by default |

---

### G. Observability Gaps

| Missing Signal | Where It Should Be Written | Where It Should Surface | Test |
|---------------|---------------------------|------------------------|------|
| `freshness_tier` in NFL model cards | `apps/worker/src/jobs/run_nfl_model.js` — not set at all | Web `/api/games` `freshnessTier` field; admin panel | Deferred to June/July summer window; add test: NFL card payload has `freshness_tier` set to `'FRESH'` or `'UNKNOWN'` |
| `decision_basis_meta` in NFL model cards | `apps/worker/src/jobs/run_nfl_model.js` — not set | Web decision authority reads; `/api/cards` `basis` field | Deferred to June/July summer window; add test: NFL card has `decision_basis_meta.decision_basis` |
| Degraded-state persistence | `apps/worker/src/jobs/check_pipeline_health.js` — no `DEGRADED` row written; only `OK`/`WARN`/`FAIL` states | Persistent degraded state in `pipeline_health` table that survives scheduler restart | Test: degraded state after restart is visible in `/api/admin/pipeline-health` |
| `ENABLE_PIPELINE_HEALTH_WATCHDOG` disabled by default | `apps/worker/src/schedulers/main.js:425` — guard prevents watchdog from running unless env var is true | Discord alert when cards degrade | Integration test: watchdog fires Discord alert when N consecutive WARN checks occur |
| `missing_inputs` not surfaced in `/api/games` or `/api/results` | Written by `packages/models/src/mlb-model.js` into projection output | Only rendered in CardsHeader UI at `web/src/components/cards/CardsHeader.tsx:144`; not in games API response | Test: `/api/games` response includes `projection_missing_inputs` array |
| `pipeline_health` write by individual job runs | Only `check_pipeline_health.js` writes health rows. Individual jobs like `run_nfl_model`, `run_nba_model`, `settle_pending_cards` do not write health markers. | Admin panel shows gaps after job failures | Add `pipeline_health` write at end of critical jobs (model runs, settlement) |
| NHL 1P odds gap | `pull_nhl_1p_odds` never runs (unscheduled) | `check_pipeline_health` should detect `total_1p IS NULL` for live games | Test: health check fails when `total_1p` is missing within game window |

---

## Priority Cleanup Plan

### Phase 1 — Stop Live Misclassification

**Goal:** Prevent ghost PLAY cards from reaching users. No broad refactors.

**Status:** ✅ COMPLETE (2026-04-27)

1. **`decision-publisher.js:214` — `fallbackToLegacy: true`**
   - ✅ Already set to `fallbackToLegacy: false`
   - The synthetic PASS at line 220 provides the correct fail-closed outcome
   - Files: `apps/worker/src/utils/decision-publisher.js`

2. **`settle_pending_cards.js` canonical-only settlement/backfill authority**
   - ✅ Completed: live settlement already fails closed for missing canonical `decision_v2.official_status`
   - ✅ Completed: display-log backfill helper now also requires canonical `decision_v2.official_status` and fails closed for legacy-only statuses
   - Files: `apps/worker/src/jobs/settle_pending_cards.js`

3. **`decision.ts:167` — `isMlbFullGameLegacyDisplayPlay`**
   - ✅ Completed: Added cutover epoch (2026-04-25); cards created after this date fail-closed
   - Files: `web/src/lib/game-card/decision.ts`

4. **`route-handler.ts:950-1090` — MLB game-line fallback injection disabled**
   - ✅ Completed: Disabled mergeMlbGameLineFallbackRows call; API now serves empty/PASS for missing games
   - Files: `web/src/lib/games/route-handler.ts`

5. **NFL model gate — prevent premature enable**
   - Deferred to June/July summer window unless NFL enablement is pulled forward
   - Add pre-flight assertion in `run_nfl_model.js` that `decision_basis_meta` and `freshness_tier` fields are set before writing cards
   - Files: `apps/worker/src/jobs/run_nfl_model.js`

### Phase 2 — Remove Dead Runtime Paths

After Phase 1 is green:

1. Delete `VIG_COST_STANDARD` / `SLIPPAGE_ESTIMATE` from `execution-gate.js` (confirmed zero consumers)
2. Archive `repair_mlb_full_game_display_log.js` (manual one-shot, no schedule entry, no package.json script)
3. Archive `resettle_historical_cards.js`, `import_historical_settled_results.js`, `backfill_period_token.js` to `.archive/one-shot-scripts/`
4. Archive/tombstone `packages/adapters/src/f5-line-fetcher.js` (spike, ToS deferred, no consumer)
5. Delete deprecated WI-0763 traceability fields in `mlb-model.js:2751-2805` (owner: WI-1173)

### Phase 3 — Consolidate Authority

One normalizer, one registry, one staleness authority, one decision reader.

1. **`normalizeMarketType` consolidation:**
   - Canonical: `packages/data/src/market-contract.js`
   - Completed: deleted local copies in `repair_mlb_full_game_display_log.js` and `performance_drift_report.js` (both now import canonical normalizer)
   - Completed: `decision-gate.js` audited and updated to delegate core market normalization to canonical contract (retains local semantic mapping for `first_period`, `team_total`, `prop`)

2. **Reason code registry:**
   - Completed: added sync test assertion validating `web/src/lib/game-card/transform/reason-codes.ts::PASS_REASON_ALIAS_MAP` targets only codes in `packages/data/src/reason-codes.js::ALL_REASON_CODES`
   - Completed: registered legacy PASS aliases (`PASS_MISSING_EDGE`, `PASS_MISSING_SELECTION`, `PASS_MISSING_LINE`, `PASS_MISSING_PRICE`, `PASS_NO_MARKET_PRICE`) in canonical reason-code registry and regenerated web reason-label map
   - Inline codes in `mlb-model.js`, `execution-gate.js`, `nhl-totals-status.js` must all appear in canonical registry

3. **Staleness/freshness consolidation:**
   - All staleness decisions must flow from `execution-gate-freshness-contract.js`
   - `freshness_tier` payload field must be the single surface read by all consumers
   - Remove redundant `isStale` computation in `check_pipeline_health.js:243` in favor of reading `freshness_tier` from card payload

4. **Decision reader consolidation:**
   - Publisher (`decision-publisher.js`) must use identical `readDecisionAuthority` options as web read (`runtime-decision-authority.ts`)
   - Both: `fallbackToLegacy: false`, `strictSource: true`

### Phase 4 — Pipeline Health Hardening

1. **Schedule `pull_nhl_1p_odds`:**
   - Register in `schedulers/nhl.js` before `run_nhl_model` window
   - Enable with `NHL_1P_ODDS_ENABLED=true` in production

2. **Enable watchdog:**
   - Set `ENABLE_PIPELINE_HEALTH_WATCHDOG=true` in production environment
   - Add degraded-state row with `status='DEGRADED'` in `pipeline_health` when check fails N consecutive times

3. **NFL model pipeline_health:**
   - Deferred to June/July summer window
   - `run_nfl_model.js` should write a `pipeline_health` row on completion (success/failure)

4. **MLB splits wiring:**
   - Wire `splits_divergence` into MLB model market intel reads (currently absent despite splits being fetched)

---

## Required Tests

### Phase 1 Tests

| Cleanup Target | Unit Test | Integration/Smoke Test | Negative/Fail-Closed Test |
|---------------|-----------|----------------------|--------------------------|
| `fallbackToLegacy: false` in publisher | `decision-publisher.v2.test.js` — assert no legacy status derived when `decision_v2` missing | Publish a card missing `decision_v2` — assert `official_status === 'PASS'` | Publish a pre-v2 card — assert PLAY does NOT appear |
| Settlement legacy fallback → error | `settle_pending_cards.test.js` — assert non-historical card with `legacyFallback` rejects | Settlement pipeline smoke — historical card with `legacyFallback` still settles | Non-historical card must not settle with legacy fallback |
| MLB full-game display cutover | `decision.test.ts` — card after V2 epoch with no `decision_v2` renders PASS | Cards API smoke — no PLAY cards missing `decision_v2` | Card with `decision_v2: null` created after cutover renders PASS |
| NFL pre-flight gate | Deferred to June/July summer window: `run_nfl_model.test.js` should assert card without `decision_basis_meta` fails validation | NFL model dry-run with incomplete payload | Card written without `decision_basis_meta` is rejected at `validateCardPayload` |

### Phase 2 Tests

| Cleanup Target | Unit Test | Integration/Smoke Test | Negative/Fail-Closed Test |
|---------------|-----------|----------------------|--------------------------|
| Delete `VIG_COST_STANDARD`/`SLIPPAGE_ESTIMATE` | `execution-gate.test.js` — assert exports still work | All existing execution-gate tests pass | No consumer fails to import |
| Archive `repair_mlb_full_game_display_log.js` | N/A — delete | Confirm no scheduler references | Grep for imports returns empty |

### Phase 3 Tests

| Cleanup Target | Unit Test | Integration/Smoke Test | Negative/Fail-Closed Test |
|---------------|-----------|----------------------|--------------------------|
| `normalizeMarketType` consolidation | Unit test each removed local copy matches canonical output | All market-contract tests pass | Unknown market type → `undefined` not crash |
| Reason code registry alignment | `reason-codes.test.js` — assert all alias map targets exist in canonical | N/A | Unregistered code throws at module init |

### Phase 4 Tests

| Cleanup Target | Unit Test | Integration/Smoke Test | Negative/Fail-Closed Test |
|---------------|-----------|----------------------|--------------------------|
| `pull_nhl_1p_odds` scheduling | `scheduler-windows.test.js` — assert job appears in NHL window | NHL model smoke with real `total_1p` column | `total_1p` NULL → model uses projection floor, not synthetic fallback without warning |
| Watchdog enable | `check_pipeline_health.watchdog.test.js` | Discord alert fires on N consecutive failures | Watchdog does not fire on single transient failure |

---

## Do Not Touch

| File/Path | Reason |
|-----------|--------|
| `apps/worker/src/jobs/potd/run_potd_engine.js` | Complex POTD shadow/signal engine with active scheduling. `fallbackToLegacy: false` already set at line 902. Do not change. |
| `apps/worker/src/jobs/check_pipeline_health.js` | Central health aggregator. Very large file with many interlocking checks. All changes must be targeted (watchdog enable only). |
| `packages/models/src/decision-pipeline-v2.js` | Core decision pipeline. Do not touch edge math, devig, or sigma fallback gate logic. |
| `packages/models/src/edge-thresholds-config.js` | Threshold registry. No modifications to numeric thresholds as part of cleanup. |
| `apps/worker/src/jobs/execution-gate.js` — `evaluateExecution` / `evaluateMlbExecution` | Active gate logic. Only the deprecated constants may be removed; do not change any policy blocks. |
| `web/src/lib/games/route-handler.ts` | ~3000+ line production route handler. The MLB fallback section (`isEligibleMlbGameLineFallbackRow`) has many guards. Audit carefully before removing; do not refactor in same pass. |
| `apps/worker/src/jobs/run_nhl_player_shots_model.js` | NHL shots model is highly active and complex. The synthetic fallback 1P path correctly sets `market_line_source: 'synthetic_fallback'` and `blockedNoRealLine` blocks BREAKOUT. Do not change the gating logic. |
| `packages/data/src/reason-codes.js` | Canonical reason code registry. Adding codes is safe; removing requires full audit of all callers. |
| `packages/models/src/decision-authority.js` | Canonical decision authority. `normalizeLifecycle` and `fallbackToLegacy` parameter are used correctly here (with `false` defaults). Do not change the canonical module — change callers. |

---

## Top 10 Cleanup Targets

| # | Target | Type | Priority |
|---|--------|------|----------|
| 1 | `decision-publisher.js` legacy fallback path (fixed on branch: `fallbackToLegacy: false`) | Live unsafe fallback | DONE |
| 2 | `pull_nhl_1p_odds` scheduling gap (fixed on branch in NHL scheduler windows) | Broken pipeline | DONE |
| 3 | MLB game-line fallback injection in `/api/games` | Live legacy fallback | DONE |
| 4 | `run_nfl_model.js` — no `decision_basis_meta`, no `freshness_tier` | Missing observability + pre-parity gate | DEFERRED (June/July) |
| 5 | `isMlbFullGameLegacyDisplayPlay` — display bypass for no-decision_v2 MLB cards | Live legacy display path | DONE |
| 6 | `normalizeMarketType` — 2 primary implementations + tracking helper remain | Duplicate authority | MEDIUM |
| 7 | `VIG_COST_STANDARD`/`SLIPPAGE_ESTIMATE` deprecated constants in exports (removed on branch) | Safe delete | DONE |
| 8 | `packages/adapters/src/f5-line-fetcher.js` — spike, ToS deferred, no consumer | Safe archive | DONE |
| 9 | `repair_mlb_full_game_display_log.js` — unscheduled one-shot script (normalizer copy removed) | Safe archive | DONE |
| 10 | `ENABLE_PIPELINE_HEALTH_WATCHDOG=false` default — watchdog never fires | Observability gap | MEDIUM |

---

## Top 5 Dangerous Ghost Paths

| # | Ghost Path | File | Mechanism | Impact |
|---|-----------|------|-----------|--------|
| 1 | `fallbackToLegacy: true` in worker publish | `apps/worker/src/utils/decision-publisher.js:214` | Legacy `action/classification/status` fields become `official_status` when `decision_v2` is missing | ✅ Completed: now `fallbackToLegacy: false`; fail-closed synthetic PASS remains |
| 2 | MLB game-line fallback injection | `web/src/lib/games/route-handler.ts:1058` | Older PLAY cards injected into API response when current-run cards are absent | User sees stale PLAY recommendation that the current model run may not support |
| 3 | MLB full-game legacy display | `web/src/lib/game-card/decision.ts:167` | Cards without `decision_v2` derive display action from legacy fields | ✅ Completed: post-cutover cards now fail closed |
| 4 | Settlement legacy fallback as warn | `apps/worker/src/jobs/settle_pending_cards.js:80` | Non-historical cards settled using legacy-derived decision; only a console.warn | ✅ Completed: canonical-only status resolution enforced for live and backfill helper paths |
| 5 | NHL 1P synthetic line production | `apps/worker/src/jobs/run_nhl_player_shots_model.js:2852` | Uses synthetic projection-floor line when no real line is present | Active behavior; monitor with explicit PROJECTION_ONLY/line-source assertions |

---

## Top 5 Missing Pipeline Connections

| # | Missing Connection | Input Job | Output Job | Gap | Impact |
|---|-------------------|-----------|------------|-----|--------|
| 1 | `pull_nhl_1p_odds` → `run_nhl_model` | `pull_nhl_1p_odds` | `run_nhl_model` reads `total_1p` | ✅ Scheduler registration landed; remaining risk is operational enablement/config | Reduced synthetic-floor fallback usage when 1P odds ingest runs |
| 2 | Splits data → MLB model | `pull_public_splits`, `pull_vsin_splits` | `run_mlb_model` | MLB model does not read `splits_divergence`; NBA and NHL do | MLB model cannot detect sharp vs public divergence |
| 3 | Job health → `pipeline_health` table | `run_nfl_model`, `run_nba_model`, `run_nhl_model`, `settle_pending_cards` | `check_pipeline_health` reads from table | Individual jobs do not write `pipeline_health` on success/failure | Pipeline health dashboard shows only `check_pipeline_health` output, not job-level failures |
| 4 | Degraded-state persistence | `check_pipeline_health` | Admin panel + watchdog | No `DEGRADED` state row survives scheduler restart | Degraded periods are invisible after restart |
| 5 | `missing_inputs` → `/api/games` response | `packages/models/src/mlb-model.js` | `web/src/lib/games/route-handler.ts` | `projection_missing_inputs` is partially wired at `route-handler.ts:1103` but not fully propagated to all card types | Consumers cannot distinguish model degradation from no-play |

---

## Exact Next WI Recommendation

### WI-NEXT: Pipeline Connection Hardening (non-deferred)

Scope:

1. Wire MLB splits signal consumption (`splits_divergence`) into `run_mlb_model.js` market intel path.
2. Add job-level `pipeline_health` write hooks for critical model/settlement jobs (`run_nba_model`, `run_nhl_model`, `settle_pending_cards`).
3. Add degraded-state persistence behavior for `check_pipeline_health` so WARN/DEGRADED periods survive restarts.
4. Add focused tests from Phase 4 table for watchdog behavior and pipeline connection visibility.

**Do NOT include in this WI:**

- NFL model parity work (`run_nfl_model.js` decision_basis_meta/freshness_tier) — deferred to June/July
- threshold math/edge policy changes
- broad route-handler refactors

This keeps the next slice scoped to operational visibility and missing data-flow links.

****

Audit: 2026-04-27 | Method: import-trace + scheduler-registration + grep-verified | Source edits since audit are documented above.
