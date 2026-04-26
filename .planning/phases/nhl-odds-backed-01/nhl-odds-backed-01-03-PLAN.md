---
phase: nhl-odds-backed-01
plan: "03"
type: execute
wave: 2
depends_on: ["nhl-odds-backed-01-01", "nhl-odds-backed-01-02"]
files_modified:
  - web/src/lib/games/route-handler.ts
  - web/src/__tests__/cards-projection-exclusion.test.js
  - apps/worker/src/jobs/check_pipeline_health.js
  - apps/worker/src/__tests__/check-pipeline-health.nhl.test.js
  - docs/MARKET_REGISTRY.md
autonomous: true
requirements: [NHR-API-01, NHR-OBS-01, NHR-DOCS-01]

must_haves:
  truths:
    - "A nhl-moneyline-call with execution_status EXECUTABLE and decision_v2 survives gamelines filtering"
    - "A nhl-totals-call with LEAN/EXECUTABLE survives projection-only filtering"
    - "Pipeline health reports NHL moneyline card coverage and alerts when games with h2h odds have zero NHL ML cards"
    - "Registry docs explicitly state NHL totals and moneyline are active odds-backed lanes"
  artifacts:
    - path: "web/src/__tests__/cards-projection-exclusion.test.js"
      provides: "route-handler regression coverage for NHL ML/totals pass-through"
    - path: "apps/worker/src/jobs/check_pipeline_health.js"
      provides: "NHL ML observability counters"
    - path: "apps/worker/src/__tests__/check-pipeline-health.nhl.test.js"
      provides: "health-check assertions for NHL ML counter behavior"
    - path: "docs/MARKET_REGISTRY.md"
      provides: "updated market status documentation"
  key_links:
    - from: "web/src/lib/games/route-handler.ts"
      to: "isProjectionOnlyPlayPayload"
      via: "drop gate for PROJECTION_ONLY rows"
      pattern: "isProjectionOnlyPlayPayload"
    - from: "apps/worker/src/jobs/check_pipeline_health.js"
      to: "NHL ML card coverage"
      via: "counter + alert condition"
      pattern: "nhl-moneyline-call|NHL_ML"
---

<objective>
Lock surfacing behavior and observability for NHL moneyline + totals now that worker-side execution status and decision-v2 correctness are fixed.

Purpose: prevent regressions where cards are generated but silently filtered in gamelines, and make missing NHL moneyline cards diagnosable in health checks.

Output:
- route-handler regression tests proving executable NHL ML/totals cards pass through
- pipeline health counter for NHL moneyline card presence vs available h2h games
- MARKET_REGISTRY updated to reflect fully active odds-backed NHL ML/totals contract
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@web/src/lib/games/route-handler.ts
@web/src/__tests__/cards-projection-exclusion.test.js
@apps/worker/src/jobs/check_pipeline_health.js
@apps/worker/src/__tests__/check-pipeline-health.nhl.test.js
@docs/MARKET_REGISTRY.md
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add gamelines regression tests for NHL executable ML/totals pass-through</name>
  <files>web/src/__tests__/cards-projection-exclusion.test.js</files>
  <behavior>
    - Executable NHL ML card is retained in route output
    - Executable NHL totals card (LEAN) is retained in route output
    - PROJECTION_ONLY NHL ML card is still dropped (guard remains valid)
  </behavior>
  <action>
    Add fixture-driven tests in cards-projection-exclusion suite:
    1. `nhl-moneyline-call` payload with `execution_status: 'EXECUTABLE'`, valid `decision_v2`, `market_type: 'MONEYLINE'`, `kind: 'PLAY'` -> assert included.
    2. `nhl-totals-call` payload with `execution_status: 'EXECUTABLE'`, `classification: 'LEAN'`, valid `decision_v2` -> assert included.
    3. Control case: same NHL ML payload with `execution_status: 'PROJECTION_ONLY'` -> assert excluded.

    Do not expand projection-surface allowlist. This plan verifies fixed worker outputs pass current route logic.
  </action>
  <verify>
    <automated>node --import tsx/esm web/src/__tests__/cards-projection-exclusion.test.js 2>&1 | tail -30</automated>
  </verify>
  <done>
    Test suite proves executable NHL ML/totals cards survive the projection-only gate and projection-only controls are still dropped.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Add NHL moneyline coverage counter in pipeline health + tests + registry updates</name>
  <files>apps/worker/src/jobs/check_pipeline_health.js, apps/worker/src/__tests__/check-pipeline-health.nhl.test.js, docs/MARKET_REGISTRY.md</files>
  <behavior>
    - Health script reports count of NHL games with h2h odds
    - Health script reports count of emitted nhl-moneyline-call cards
    - Health script warns/fails when h2h-capable games exist but NHL ML cards are zero
    - Registry docs mark NHL moneyline + totals as active odds-backed lanes with dependency notes
  </behavior>
  <action>
    In `check_pipeline_health.js`:
    - Add NHL-specific aggregation:
      - `nhl_games_with_h2h_odds`
      - `nhl_moneyline_cards_count`
    - Add health check condition:
      - If `nhl_games_with_h2h_odds > 0 && nhl_moneyline_cards_count === 0`, emit explicit warning/error code (e.g. `NHL_ML_SURFACING_GAP`).

    In `check-pipeline-health.nhl.test.js`:
    - Add tests for both pass and fail scenarios above.

    In `docs/MARKET_REGISTRY.md`:
    - Ensure NHL totals + moneyline entries explicitly declare:
      - odds-backed dependency (totals/h2h required)
      - expected execution statuses (EXECUTABLE/BLOCKED, not PROJECTION_ONLY in live-odds mode)
      - known degraded mode behavior (`withoutOddsMode`)
  </action>
  <verify>
    <automated>npm --prefix apps/worker run test -- --runInBand src/__tests__/check-pipeline-health.nhl.test.js 2>&1 | tail -30</automated>
  </verify>
  <done>
    Pipeline health detects NHL ML surfacing gaps and tests validate both healthy and unhealthy states. MARKET_REGISTRY reflects current contract.
  </done>
</task>

</tasks>

<verification>
```bash
node --import tsx/esm web/src/__tests__/cards-projection-exclusion.test.js
npm --prefix apps/worker run test -- --runInBand src/__tests__/check-pipeline-health.nhl.test.js
```

Expected:
- Route-handler regression tests pass
- Health-check NHL tests pass
- Documentation update is aligned with implemented behavior
</verification>

<success_criteria>
1. Executable NHL ML/totals cards are proven to pass route filtering by test.
2. Pipeline health emits actionable NHL ML surfacing signal.
3. MARKET_REGISTRY documents NHL odds-backed contract and degraded-mode semantics.
4. No route-handler production logic change is required for this fix path.
</success_criteria>

<output>
After completion, create `.planning/phases/nhl-odds-backed-01/nhl-odds-backed-01-03-SUMMARY.md`
</output>
