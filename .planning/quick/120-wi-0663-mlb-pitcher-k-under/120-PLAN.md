---
phase: quick-120
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/models/mlb-model.js
  - apps/worker/src/jobs/run_mlb_model.js
  - apps/worker/src/jobs/__tests__/run_mlb_model.test.js
  - web/src/lib/games/route-handler.ts
  - web/src/lib/game-card/transform/index.ts
  - web/src/__tests__/api-games-market-smoke.test.js
  - web/src/__tests__/api-games-prop-decision-contract.test.js
  - web/src/__tests__/game-card-transform-market-contract.test.js
  - web/src/__tests__/prop-game-card-contract.test.js
  - packages/data/src/validators/card-payload.js
  - packages/data/src/__tests__/validators/card-payload.mlb-pitcher-k.test.js
autonomous: false
requirements: [WI-0663]

must_haves:
  truths:
    - "PITCHER_KS_MODEL_MODE=ODDS_BACKED triggers the under-scoring path and emits WATCH/PLAY cards"
    - "Market selection picks highest line first, then best under_price, then bookmaker priority"
    - "PROJECTION_ONLY rows (no market) still emit with lean_side=null and prop_display_state=PROJECTION_ONLY"
    - "Odds-backed cards carry prop_decision.lean_side='UNDER' and expanded pitcher_k_result metrics"
    - "mlb-pitcher-k rows flow through /api/games as market_type=PROP with normalized prop_decision"
    - "All targeted tests in WI-0663 pass"
  artifacts:
    - path: "apps/worker/src/models/mlb-model.js"
      provides: "computePitcherKDriverCards ODDS_BACKED branch calling scorePitcherKUnder + selectPitcherKUnderMarket"
    - path: "apps/worker/src/jobs/run_mlb_model.js"
      provides: "resolvePitcherKsMode reads PITCHER_KS_MODEL_MODE; execution envelope handles ODDS_BACKED"
    - path: "apps/worker/src/jobs/__tests__/run_mlb_model.test.js"
      provides: "Tests for market selection, lookback, scoring thresholds, payload shape"
  key_links:
    - from: "run_mlb_model.js:resolvePitcherKsMode"
      to: "computePitcherKDriverCards(mode)"
      via: "PITCHER_KS_MODEL_MODE env var"
    - from: "computePitcherKDriverCards ODDS_BACKED branch"
      to: "scorePitcherKUnder"
      via: "selectPitcherKUnderMarket -> marketInput"
    - from: "prop_decision.verdict (WATCH/PLAY)"
      to: "prop_display_state"
      via: "computePitcherKPropDisplayState"
---

<objective>
Extend the MLB pitcher-K pipeline to rank and emit strong UNDER watch/play cards when PITCHER_KS_MODEL_MODE=ODDS_BACKED. The under-scoring function (scorePitcherKUnder) and scoring logic are already implemented; this work wires the ODDS_BACKED execution path end-to-end: market selection, computePitcherKDriverCards branching, runner mode resolution, card emission, and payload shape.

Purpose: Enable actionable UNDER monitoring for MLB pitcher strikeouts without any new external feeds. All inputs come from existing odds snapshots (strikeout_lines in raw_data.mlb).
Output: WATCH/PLAY under cards with prop_decision.lean_side='UNDER', passing all WI-0663 acceptance tests.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@WORK_QUEUE/WI-0663.md
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Wire ODDS_BACKED under-scoring path in mlb-model.js and resolvePitcherKsMode</name>
  <files>
    apps/worker/src/models/mlb-model.js
    apps/worker/src/jobs/run_mlb_model.js
    apps/worker/src/jobs/__tests__/run_mlb_model.test.js
  </files>
  <behavior>
    - selectPitcherKUnderMarket(strikeoutLines, role): given raw_data.mlb.strikeout_lines object and a role ('home'|'away'), returns the entry with highest line, tiebreak by best under_price (closest to 0 from negative side), then MLB_PROP_BOOKMAKER_PRIORITY. Returns null if no qualifying entries. Uses normalizePitcherLookupKey on pitcher name to match entries.
    - computePitcherKDriverCards ODDS_BACKED branch: when mode='ODDS_BACKED' AND selectPitcherKUnderMarket returns a non-null market, call normalizePitcherKMarketInput on the selected entry and pass to scorePitcherKUnder; emit basis='ODDS_BACKED', direction='UNDER', prop_decision.lean_side='UNDER'. When mode='ODDS_BACKED' but no market line available (selectPitcherKUnderMarket returns null), fall back to existing PROJECTION_ONLY path (adds MODE_FORCED:ODDS_BACKED->PROJECTION_ONLY to reason_codes).
    - resolvePitcherKsMode: reads process.env.PITCHER_KS_MODEL_MODE; if set to 'ODDS_BACKED' returns 'ODDS_BACKED', otherwise returns 'PROJECTION_ONLY' (preserving current default).
    - ODDS_BACKED card shape: prediction=verdict (WATCH|PLAY|NO_PLAY), action=verdict, card_verdict=verdict, basis='ODDS_BACKED', line=marketInput.line, under_price=marketInput.under_price, prop_decision.lean_side='UNDER', prop_decision.verdict=verdict, prop_decision.line=marketInput.line, prop_decision.display_price=marketInput.under_price, pitcher_k_result=scorePitcherKUnder result.
    - emit_card=true for WATCH and PLAY verdicts; emit_card=false for NO_PLAY.
    - prop_display_state: computePitcherKPropDisplayState(verdict) — already handles WATCH/PLAY/PROJECTION_ONLY.
    - Tests to add/update in run_mlb_model.test.js:
      * Update existing test 'resolvePitcherKsMode is hard-pinned to PROJECTION_ONLY' — it must now assert that when PITCHER_KS_MODEL_MODE='ODDS_BACKED' the return value is 'ODDS_BACKED', and when unset or set to other values it returns 'PROJECTION_ONLY'.
      * 'selectPitcherKUnderMarket selects highest-line entry': given two strikeout_lines entries (lines 6.5 and 7.0), selects 7.0.
      * 'selectPitcherKUnderMarket tiebreaks by best under_price': given two entries with same line, selects the one with under_price closer to 0 (e.g., -105 over -115).
      * 'selectPitcherKUnderMarket tiebreaks by bookmaker priority': given same line and same under_price, uses MLB_PROP_BOOKMAKER_PRIORITY.
      * 'selectPitcherKUnderMarket returns null when strikeout_lines is empty': returns null.
      * 'computePitcherKDriverCards emits PLAY card in ODDS_BACKED mode with strong under profile': use fullPitcher + strongUnderHistory + strikeout_lines entry {line:6.5, under_price:-105}. Assert cards[0].basis='ODDS_BACKED', cards[0].prop_decision.lean_side='UNDER', cards[0].prop_decision.verdict='PLAY', cards[0].emit_card=true.
      * 'computePitcherKDriverCards emits WATCH card in ODDS_BACKED mode with moderate under profile': use fullPitcher + watchUnderHistory + strikeout_lines entry. Assert verdict='WATCH', emit_card=true.
      * 'computePitcherKDriverCards falls back to PROJECTION_ONLY when ODDS_BACKED but no strikeout_lines': Assert reason_codes contains 'MODE_FORCED:ODDS_BACKED->PROJECTION_ONLY', basis='PROJECTION_ONLY'.
      * 'computePitcherKDriverCards emits NO_PLAY card in ODDS_BACKED mode on hard gate': use line 4.5 and under_price -170. Assert emit_card=false, verdict='NO_PLAY'.
  </behavior>
  <action>
    1. In apps/worker/src/models/mlb-model.js, add `selectPitcherKUnderMarket(strikeoutLines, pitcherName, bookmakerPriority)` function before `computePitcherKDriverCards`. strikeoutLines is the raw_data.mlb.strikeout_lines object (keys are normalized pitcher names or team+role keys). The function:
       - Iterates entries, normalizing keys with normalizePitcherLookupKey
       - Filters entries where line >= 5.0 (minimum playable line)
       - Sorts by: (1) line descending, (2) under_price descending (-105 > -115), (3) bookmaker priority ascending
       - Returns the first entry as a normalized market object {line, under_price, over_price, bookmaker, line_source, fetched_at}, or null if no entries.
       - Note: bookmakerPriority map is MLB_PROP_BOOKMAKER_PRIORITY which is defined in run_mlb_model.js, not mlb-model.js. Pass it in as a parameter (or inline a local copy if calling from mlb-model.js). Prefer passing in as an option from computePitcherKDriverCards' callers.

    2. In `computePitcherKDriverCards`, update the per-pitcher loop:
       - If requestedMode === 'ODDS_BACKED', attempt to extract strikeout_lines from oddsSnapshot: `const strikeoutLinesMap = mlb.strikeout_lines ?? {}`.
       - Call selectPitcherKUnderMarket to pick a market for this pitcher (match by pitcher name or role key: e.g. 'home_pitcher' or pitcher full_name normalized).
       - If market found: call scorePitcherKUnder(pitcherInput, matchupInput, normalizedMarket, weatherInput). Build card with:
         - prediction/action/card_verdict/status = result.verdict
         - emit_card = (result.verdict === 'PLAY' || result.verdict === 'WATCH')
         - basis = 'ODDS_BACKED'
         - direction = 'UNDER'
         - line = normalizedMarket.line
         - under_price = normalizedMarket.under_price
         - prop_decision = { verdict: result.verdict, lean_side: 'UNDER', line: normalizedMarket.line, display_price: normalizedMarket.under_price, projection: result.projection, k_mean: null, line_delta: result.line_delta, under_score: result.under_score, score_components: result.score_components, history_metrics: result.history_metrics, current_form_metrics: result.current_form_metrics, selected_market: result.selected_market, flags: result.flags, why: result.why, probability_ladder: null, fair_prices: null, playability: null, projection_source: 'ODDS_BACKED', status_cap: result.verdict, missing_inputs: [], fair_prob: null, implied_prob: null, prob_edge_pp: null, ev: null }
         - pitcher_k_result = result (full scorePitcherKUnder output)
         - prop_display_state: inline logic mirroring computePitcherKPropDisplayState: PLAY->'PLAY', WATCH->'WATCH', else->'PROJECTION_ONLY'
         - reason_codes = uniqueReasonCodes(['ODDS_BACKED_UNDER', ...(result.flags || [])])
       - If no market found: fall through to existing PROJECTION_ONLY card construction but push 'MODE_FORCED:ODDS_BACKED->PROJECTION_ONLY' into reasonCodes.
       - If requestedMode !== 'ODDS_BACKED': use existing PROJECTION_ONLY path unchanged.

    3. In apps/worker/src/jobs/run_mlb_model.js, update `resolvePitcherKsMode()`:
       - Read process.env.PITCHER_KS_MODEL_MODE
       - If value is 'ODDS_BACKED' return 'ODDS_BACKED'
       - Otherwise return 'PROJECTION_ONLY'

    4. In apps/worker/src/jobs/__tests__/run_mlb_model.test.js, update and add tests per the behavior block above. Export `selectPitcherKUnderMarket` from mlb-model.js so it can be imported in the test.
  </action>
  <verify>
    <automated>npm --prefix apps/worker test -- --runInBand --testPathPattern=run_mlb_model.test.js</automated>
  </verify>
  <done>
    All existing run_mlb_model.test.js tests pass plus new tests: ODDS_BACKED market selection (highest line, under_price tiebreak, bookmaker tiebreak, null on empty), PLAY/WATCH/NO_PLAY card emission, and PROJECTION_ONLY fallback when no strikeout_lines.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Update web route, transform, and validator for ODDS_BACKED mlb-pitcher-k cards</name>
  <files>
    web/src/lib/games/route-handler.ts
    web/src/lib/game-card/transform/index.ts
    web/src/__tests__/api-games-market-smoke.test.js
    web/src/__tests__/api-games-prop-decision-contract.test.js
    web/src/__tests__/game-card-transform-market-contract.test.js
    web/src/__tests__/prop-game-card-contract.test.js
    packages/data/src/validators/card-payload.js
    packages/data/src/__tests__/validators/card-payload.mlb-pitcher-k.test.js
  </files>
  <behavior>
    - /api/games: mlb-pitcher-k cards with basis='ODDS_BACKED' and verdict='WATCH'|'PLAY' should flow through with prop_decision.lean_side='UNDER' preserved; they are already market_type='PROP' via inferMarketFromCardType — no change needed there. Verify the ODDS_BACKED verdict does not get clobbered to 'PROJECTION' by the PASS-to-PROJECTION mapping (only PASS maps to PROJECTION).
    - transform/index.ts (Player Props tab): ODDS_BACKED pitcher-K rows with WATCH/PLAY verdict should sort ahead of NO_PLAY rows; propVerdict='WATCH'|'PLAY' must not be downgraded. Existing PROJECTION_ONLY rows remain non-actionable (propVerdict='PROJECTION').
    - card-payload.js validator: accept basis='ODDS_BACKED' for mlb-pitcher-k cards; currently may only allow 'PROJECTION_ONLY'. Add 'ODDS_BACKED' to allowed basis values for the pitcher-k card family.
    - Existing contract tests must still pass; add assertions:
      * api-games-prop-decision-contract: assert route preserves lean_side='UNDER' for ODDS_BACKED pitcher-K cards (source code pattern check).
      * game-card-transform-market-contract: assert transform respects propVerdict='WATCH' for ODDS_BACKED mlb-pitcher-k.
      * card-payload.mlb-pitcher-k.test.js: add test that a card with basis='ODDS_BACKED', prop_decision.lean_side='UNDER', verdict='WATCH' passes validation.
      * prop-game-card-contract: assert Player Props tab renders ODDS_BACKED pitcher-K rows as actionable (non-PROJECTION) when verdict is WATCH or PLAY.
  </behavior>
  <action>
    1. In web/src/lib/games/route-handler.ts: verify the PASS->PROJECTION mapping (e.g. `=== 'PASS' ? 'PROJECTION'`) does not apply to WATCH or PLAY verdicts from ODDS_BACKED cards. The existing mapping should already only target PASS; confirm and add a comment noting ODDS_BACKED WATCH/PLAY verdicts must not be remapped. No code change expected here, but confirm.

    2. In web/src/lib/game-card/transform/index.ts: confirm the sort that places NO_PLAY rows last also handles WATCH and PLAY from ODDS_BACKED pitcher-K cards correctly. The existing comparator should handle this if propVerdict is set from prop_decision.verdict (not overridden). Add lean_side='UNDER' to the props that flow through to the card output when present.

    3. In packages/data/src/validators/card-payload.js: find the mlb-pitcher-k validator or the general pitcher-K basis check. Add 'ODDS_BACKED' as an allowed basis value alongside 'PROJECTION_ONLY'. Ensure prop_decision.lean_side='UNDER' is accepted (it should already be, since lean_side is an optional string field).

    4. Update/add tests:
       - packages/data/src/__tests__/validators/card-payload.mlb-pitcher-k.test.js: add test validating an ODDS_BACKED WATCH card with lean_side='UNDER', line=6.5, under_price=-108.
       - web/src/__tests__/api-games-prop-decision-contract.test.js: add assertion that route source does NOT remap 'WATCH' or 'PLAY' to 'PROJECTION' (i.e., the PASS mapping is conditional on verdict === 'PASS').
       - web/src/__tests__/game-card-transform-market-contract.test.js: add assertion that transform source includes lean_side passthrough for prop cards.
       - web/src/__tests__/prop-game-card-contract.test.js: add assertion that Player Props ODDS_BACKED pitcher-K rows with verdict='WATCH' are not downgraded to PROJECTION.
  </action>
  <verify>
    <automated>node web/src/__tests__/api-games-market-smoke.test.js && node web/src/__tests__/api-games-prop-decision-contract.test.js && node web/src/__tests__/game-card-transform-market-contract.test.js && node web/src/__tests__/prop-game-card-contract.test.js</automated>
  </verify>
  <done>
    All four web contract tests pass. Validator accepts basis='ODDS_BACKED' for pitcher-K. WATCH/PLAY verdicts from ODDS_BACKED cards are not remapped to PROJECTION. lean_side='UNDER' flows through route and transform.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 3: Verify full ODDS_BACKED under pipeline end-to-end</name>
  <what-built>
    End-to-end MLB pitcher-K UNDER pipeline in ODDS_BACKED mode:
    - selectPitcherKUnderMarket: highest-line, best-price, bookmaker-priority selection
    - computePitcherKDriverCards ODDS_BACKED branch: calls scorePitcherKUnder, emits WATCH/PLAY cards
    - resolvePitcherKsMode: reads PITCHER_KS_MODEL_MODE env var
    - Web route and transform: ODDS_BACKED WATCH/PLAY verdicts flow through correctly
    - Validator: accepts basis='ODDS_BACKED'
    - All WI-0663 targeted tests passing
  </what-built>
  <how-to-verify>
    1. Run all targeted tests from WI-0663:
       npm --prefix apps/worker test -- --runInBand --testPathPattern=run_mlb_model.test.js
       node web/src/__tests__/api-games-market-smoke.test.js
       node web/src/__tests__/api-games-prop-decision-contract.test.js
       node web/src/__tests__/game-card-transform-market-contract.test.js
    2. Run manual validation (from WI-0663):
       Set PITCHER_KS_MODEL_MODE=ODDS_BACKED and seed pitcher-K lines in a test snapshot with strikeout_lines containing a line >= 5.0 and under_price in range [-155, 0].
       Confirm only UNDER WATCH/PLAY cards are emitted for pitchers with qualifying history.
       Confirm prop_decision.lean_side='UNDER' is present in emitted payloads.
       Confirm PROJECTION_ONLY rows (no strikeout_lines entry) still emit with lean_side=null.
    3. Check Player Props tab: MLB pitcher-K projection rows render as Strikeouts alongside NHL shots/blocks; WATCH/PLAY rows show as actionable.
  </how-to-verify>
  <action>Human verifies automated test output and manually confirms ODDS_BACKED card emission.</action>
  <verify>
    <automated>npm --prefix apps/worker test -- --runInBand --testPathPattern=run_mlb_model.test.js && node web/src/__tests__/api-games-market-smoke.test.js && node web/src/__tests__/api-games-prop-decision-contract.test.js && node web/src/__tests__/game-card-transform-market-contract.test.js</automated>
  </verify>
  <done>All WI-0663 targeted tests pass and manual validation confirms ODDS_BACKED under cards emit correctly.</done>
  <resume-signal>Type "approved" or describe issues found</resume-signal>
</task>

</tasks>

<verification>
- npm --prefix apps/worker test -- --runInBand --testPathPattern=run_mlb_model.test.js passes all existing + new tests
- node web/src/__tests__/api-games-market-smoke.test.js passes
- node web/src/__tests__/api-games-prop-decision-contract.test.js passes
- node web/src/__tests__/game-card-transform-market-contract.test.js passes
- Validator test for ODDS_BACKED basis passes
</verification>

<success_criteria>
- PITCHER_KS_MODEL_MODE=ODDS_BACKED causes computePitcherKDriverCards to invoke scorePitcherKUnder when strikeout_lines present, emitting cards with basis='ODDS_BACKED', prop_decision.lean_side='UNDER', verdict=WATCH|PLAY
- Market selection: highest line wins, tiebreak by best under_price, then MLB_PROP_BOOKMAKER_PRIORITY
- PROJECTION_ONLY rows (no strikeout_lines) persist with lean_side=null, prop_display_state='PROJECTION_ONLY'
- All 4 targeted test commands in WI-0663 pass
- Validator accepts basis='ODDS_BACKED' for mlb-pitcher-k cards
</success_criteria>

<output>
After completion, create `.planning/quick/120-wi-0663-mlb-pitcher-k-under/120-SUMMARY.md`
</output>
