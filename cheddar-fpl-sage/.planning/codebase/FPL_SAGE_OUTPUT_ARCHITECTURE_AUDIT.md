# FPL Sage Output Architecture Audit

**Date:** 2026-04-17
**Scope:** Output contracts, transformation layers, view-model ownership, weekly UX flow
**Status:** Actionable engineering plan — not a design wish list

---

# 1. Executive Verdict

**Top 3 structural problems:**

**Problem 1 — No retrospective contract exists.**
The system has zero representation of what happened last gameweek. No previous GW score, no comparison of recommendation vs outcome, no decision quality verdict. The engine is entirely forward-only. The user lands on `Results.tsx` and is immediately told what to do next, with no context about how they got here or whether last week's advice was good.

**Problem 2 — Transfer, chip, and XI are each represented in 3-5 parallel forms that are never reconciled into a single canonical object.**
- Transfers: `transfer_recommendations` (raw list) + `forced_transfers` + `optional_transfers` + `transfer_plans` (primary/secondary/additional) + `strategy_paths` (safe/balanced/aggressive). Five forms. Frontend combines them in `decisionViewModel.ts` with ad-hoc dedup logic.
- Chip: `chip_strategy`, `chip_recommendation`, `chip_verdict`, `chip_explanation` — four fields. `toChipVerdict()` cascades through all four.
- XI: `starting_xi`, `bench`, `projected_xi`, `projected_bench`, `lineup_decision.starters`, `lineup_decision.bench` — six fields. `Results.tsx` resolves with inline fallback logic.

**Problem 3 — Presentation concerns are embedded in the analytical engine, and business logic is re-derived on the frontend.**
`output_formatter.py` inside `src/cheddar_fpl_sage/analysis/decision_framework/` generates markdown, emoji characters, and human-readable UX copy. That is a presentation artifact sitting inside the engine. In the opposite direction, `decisionViewModel.ts` re-derives `primaryAction`, `chipStatus`, `chipVerdict`, `riskStatement` from raw backend fields instead of consuming pre-computed canonical values.

**Classification:** Primarily a **contract problem** with secondary **ownership problems**. The logic is mostly correct. The contracts between layers are broken, duplicated, or missing.

---

# 2. Current-State Architecture Audit

## Layers and files

**Analytical engine (Python):**
- `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py` (3,681 lines) — Core engine. Produces `DecisionOutput` dataclass. Also generates CLI text output via `output_formatter.py`. **Owns too much.** Decision logic + presentation formatting coexist here.
- `src/cheddar_fpl_sage/analysis/decision_framework/output_formatter.py` — Formats markdown + emoji output for CLI. **Should not exist inside the analytical layer.** This is presentation code in the engine.
- `src/cheddar_fpl_sage/analysis/decision_framework/transfer_advisor.py` — Transfer scoring and ranking.
- `src/cheddar_fpl_sage/analysis/decision_framework/captain_selector.py` — Captaincy scoring.
- `src/cheddar_fpl_sage/analysis/decision_framework/chip_analyzer.py` + `chip_engine/` — Chip timing logic.
- `src/cheddar_fpl_sage/analysis/decision_framework/fixture_horizon.py` — Fixture window planning.
- `src/cheddar_fpl_sage/models/canonical_projections.py` — `CanonicalPlayerProjection`, `CanonicalProjectionSet`, `OptimizedXI`. **Correctly scoped.** Clean contracts for the engine.
- `src/cheddar_fpl_sage/analysis/decision_framework/models.py` — `DecisionSummary`, `TransferRecommendation`, `CaptainPick`, `ChipRecommendation`, `LineupPlayer`, etc. **Forward-only.** No retrospective fields.

**Backend API (Python/FastAPI):**
- `backend/services/result_transformer.py` (1,809 lines) — Converts `raw_results` → frontend dict. This is the closest thing to a canonical view-model layer. **The correct intent exists here but the scope has grown too large.** 36 top-level functions, some duplicating normalization already done upstream.
- `backend/services/contract_transformer.py` — Converts `result_transformer.py` output → "Cheddar integration contracts." This is a **third parallel representation** of transfers, chip, and captaincy. It independently rebuilds these from the already-transformed results.
- `backend/routers/dashboard.py` — A **fourth parallel representation**. Extracts weaknesses, transfer targets, chip advice, and captain advice from job results independently, using different field names than `result_transformer.py`.
- `backend/models/api_models.py` — `AnalyzeRequest`, `AnalyzeResponse`, `AnalysisStatus`. `AnalysisStatus.results` is typed as `Optional[Dict[str, Any]]` — effectively untyped.
- `backend/models/product_models.py` — `DecisionReceipt`, `DraftSession`, `DraftCandidate`. Has `process_verdict`, `outcome`, `drift_flags` — retrospective concepts that exist here but are **never surfaced to the weekly output or UI flow**.

**Frontend (TypeScript/React):**
- `frontend/src/lib/api.ts` — `AnalysisResults` interface. Uses `[key: string]: unknown` as catch-all. The typed fields are correct but the interface is open-ended, allowing silent contract drift.
- `frontend/src/lib/decisionViewModel.ts` — `buildDecisionViewModel()`. This is the frontend view-model layer. It should be consuming pre-computed values. Instead it re-derives `primaryAction` (with 5 fallback branches), `chipVerdict` (4 fallback lookups), `chipStatus`, `riskStatement` (computed inline), `strategyMode` (two fallback paths). **Business logic in a frontend module.**
- `frontend/src/pages/Results.tsx` — Does additional resolution inline: falls back between `lineup_decision.starters` and `decision.startingXI`. Resolution logic inside a page component.
- `frontend/src/components/DecisionBrief.tsx` — Clean. Consumes view-model props only.
- `frontend/src/components/TransferSection.tsx`, `CaptaincySection.tsx`, `ChipDecision.tsx` — Generally presentational but receive partially raw data.

## Ambiguous / leaky ownership

| Concern | Current Owner | Should Own |
|---|---|---|
| Transfer dedup | `decisionViewModel.ts` | `result_transformer.py` |
| Chip verdict resolution | `decisionViewModel.ts` (4 fallbacks) | `result_transformer.py` (single canonical field) |
| XI/bench resolution | `Results.tsx` inline | `result_transformer.py` |
| Primary action normalization | `decisionViewModel.ts` | `result_transformer.py` |
| Risk statement text | `decisionViewModel.ts` | Backend (or removed entirely — this is copy) |
| UX copy / emoji formatting | `output_formatter.py` (engine layer) | Presentation layer only |
| Retrospective verdict | `product_models.py` (`DecisionReceipt`) — exists but not surfaced | Weekly output contract |
| Dashboard weaknesses | `dashboard.py` independently | `result_transformer.py` canonical field |
| Chip strategy display | `contract_transformer.py` independently | `result_transformer.py` canonical field |

---

# 3. Output/UX Failure Analysis

## Why weekly presentation feels awkward

The current output is a **single flat dict** trying to serve three different user questions simultaneously:
1. What happened last week and was the advice good?
2. What is the state of my squad right now?
3. What should I do this week and next?

None of these are cleanly separated. The user gets dumped into a results page showing a `DecisionBrief` ("TRANSFER — High confidence") with no prior context. There is no section that says "GW34 result: 68 points, rank moved from 84,000 to 91,000, the Salah captaincy advice cost you 8 points vs the field." Without that, the user cannot evaluate whether to trust the forward-looking advice.

## Specific missing separations

**Retrospective review (Section A) — entirely absent.**
There is no `previous_gw_score`, `previous_gw_rank_delta`, `previous_captain_result`, `did_follow_recommendation`, or `recommendation_outcome` anywhere in the live output path. `DecisionReceipt.outcome` and `DecisionReceipt.process_verdict` exist in `product_models.py` but are never computed or surfaced to the UI for weekly use.

**Current-state diagnosis (Section B) — partially present but scattered.**
`squad_health`, `squad_issues`, `risk_scenarios` are present. However, squad health is computed in `_calculate_squad_health()` inside `result_transformer.py` using three separate fallback paths (canonical payload → FPL picks → risk scenarios). The user-facing representation (`RiskNote`) only shows a one-line status string generated in `decisionViewModel.ts`. The actual diagnostic data (positions at risk, injury severity, transfer implications) is not cleanly separated from the recommendation output.

**Action recommendation (Section C) — present but duplicated across 5 shapes.**
Transfer data is available but fragmented. `strategy_paths` (safe/balanced/aggressive) and `transfer_plans` (primary/secondary/additional) are combined in `decisionViewModel.ts` with dedup logic that can drop valid alternatives. The user cannot tell which alternatives are engine-ranked vs threshold-ranked vs horizon-opportunistic.

**Future planning (Section D) — present but buried and unreachable on its own.**
`fixture_planner` with `gw_timeline`, `squad_windows`, `target_windows`, `key_planning_notes` exists in the backend output. It is surfaced in `gwTimeline` in the view model but never rendered as a standalone planning surface. It bleeds into the transfer section as `strategy_paths` which is confusing.

## Data that exists but is not surfaced cleanly

- `captaincy_rate`, `effective_ownership` on `CanonicalPlayerProjection` — computed but never rendered in UI
- `ceiling`, `floor`, `volatility_score` on projections — computed, not shown
- `chip_recommendation.opportunity_cost` — present in API response, partially shown in `ChipDecision` component but only for current vs best-future window, not per-chip
- `lineup_decision.formation_reason`, `risk_profile_effect`, `notes` — passed to `CurrentSquad` but rendered as a list, not structured UI
- `DecisionReceipt.process_verdict`, `drift_flags` — never surfaced from product store to UI
- `near_threshold_moves` — present in transform output, not rendered in UI

---

# 4. Required Target Architecture

## Canonical output objects

---

### `WeeklyReviewCard`
**Purpose:** Answer "what happened last GW — and was the advice right?"

**Required fields:**
```
gameweek_reviewed: int
points_scored: int
rank_before: int | null
rank_after: int | null
rank_delta: int | null  # positive = improved
captain_name: str
captain_actual_pts: int | null
captain_advice_was: str  # name of player Sage recommended
recommendation_followed: bool | null
process_verdict: 'good_process' | 'bad_process' | null
advice_summary: str  # one sentence: "Salah (C) returned 16pts. Rank improved 6,400 places."
drift_flags: list[str]  # if any
```

**Source of truth:** `product_models.DecisionReceipt` (populated on receipt issuance) + FPL API previous GW picks.

**Ownership:** Backend — `backend/services/weekly_review_service.py` (new file).

**Show/hide:** Hidden when no previous GW receipt exists for this manager or if it's GW1.

---

### `CurrentSquadStateCard`
**Purpose:** Answer "what is the actual state of my squad entering this GW?"

**Required fields:**
```
gameweek: int
squad_health: {
    total: int, available: int, injured: int, doubtful: int, health_pct: float
}
critical_issues: list[SquadIssue]  # severity HIGH only
available_chips: list[str]
active_chip: str | null
free_transfers: int
team_value: float | null
bank: float | null
```

`SquadIssue`:
```
category: str  # 'injury', 'suspension', 'form', 'structural'
severity: 'HIGH' | 'MEDIUM' | 'LOW'
title: str
detail: str
players: list[str]
```

**Source of truth:** `result_transformer.py` → `squad_health` + `squad_issues`. **Consolidate the three separate fallback paths into one function.**

**Ownership:** Backend — single derivation in `result_transformer.py`.

**Show/hide:** Always shown.

---

### `GameweekPlanCard`
**Purpose:** Answer "what are my decisions this GW — in priority order?"

**Required fields:**
```
gameweek: int
primary_action: 'TRANSFER' | 'CHIP' | 'ROLL' | 'HOLD'
confidence: 'HIGH' | 'MED' | 'LOW'
confidence_label: str  # backend-derived one-liner
free_transfers: int
decision_brief: str  # one sentence
urgency_flags: list[str]  # e.g., 'DEADLINE_TODAY', 'INJURY_REPLACEMENT_NEEDED'
```

**Source of truth:** `result_transformer.py`. `primary_action` must be a single canonical field — not inferred in the frontend.

**Ownership:** Backend.

**Show/hide:** Always shown.

---

### `TransferRecommendationCard`
**Purpose:** Answer "which transfer should I make and exactly why?"

**Required fields:**
```
transfers: list[TransferItem]
no_transfer_reason: str | null
transfer_budget: float | null
```

`TransferItem`:
```
rank: int  # 1 = primary, 2 = secondary, etc.
out: {name, position, team, expected_pts_next_gw, price}
in: {name, position, team, expected_pts_next_gw, price}
hit_cost: int  # 0 or 4
net_cost: float
delta_pts_4gw: float | null
delta_pts_6gw: float | null
rationale: str
confidence: 'HIGH' | 'MED' | 'LOW'
urgency: 'injury' | 'suspension' | 'standard' | null
profile: str  # 'FIXTURE_UPGRADE', 'INJURY_REPLACEMENT', etc.
alternatives: list[{name, team, delta_pts_4gw}]
is_marginal: bool
```

**Source of truth:** `result_transformer.py` → `_build_transfer_plans()`. **This function already exists but produces an incomplete shape.** Eliminate `transfer_recommendations`, `forced_transfers`, `optional_transfers`, `strategy_paths` as separate top-level fields. Fold strategy_paths into `alternatives` on each `TransferItem`.

**Ownership:** Backend exclusively. Frontend must not recombine or deduplicate.

**Show/hide:** Hidden when `free_transfers == 0` and no URGENT transfer.

---

### `CaptaincyCard`
**Purpose:** Answer "who should I captain?"

**Required fields:**
```
captain: {
    name, team, position,
    expected_pts: float,
    ownership_pct: float,
    effective_ownership: float | null,
    rationale: str,
    fixture: str,
    fixture_difficulty: int,
    confidence: 'HIGH' | 'MED' | 'LOW'
}
vice_captain: { same shape }
delta_pts_vs_vice: float | null
alternatives: list[{name, expected_pts, rationale}]
captaincy_insight: str  # e.g., "Haaland vs Bournemouth (H) at 74% ownership is safe floor"
```

**Source of truth:** `result_transformer.py` → `_transform_captain()`. **Add `effective_ownership` and `alternatives` to this function.**

**Ownership:** Backend.

**Show/hide:** Always shown.

---

### `ChipStrategyCard`
**Purpose:** Answer "should I use a chip this GW, and if so which one?"

**Required fields:**
```
decision: 'USE' | 'WATCH' | 'SAVE'
chip: 'BB' | 'TC' | 'FH' | 'WC' | null
status: 'FIRE' | 'WATCH' | 'PASS'
rationale: str
current_window_score: float | null
best_future_window: { gw: int, score: float, name: str } | null
opportunity_cost_delta: float | null
watch_until_gw: int | null
available_chips: list[str]
reason_codes: list[str]
```

**Source of truth:** `result_transformer.py` chip normalization block (currently lines ~1350–1500). **Consolidate `chip_strategy`, `chip_recommendation`, `chip_verdict`, `chip_explanation` into this single object.**

**Ownership:** Backend. One canonical field named `chip_strategy_card`.

**Show/hide:** Hidden when all chips used. Always shown when `decision == 'USE'`.

---

### `HorizonWatchCard`
**Purpose:** Answer "what should I be building toward over the next 6–8 GWs?"

**Required fields:**
```
horizon_gws: int
start_gw: int
gw_timeline: list[{gw, dgw_teams, bgw_teams, fixture_count_total}]
squad_windows: list[PlayerWindow]
target_windows: list[PlayerWindow]
key_planning_notes: list[str]
chip_path_hint: str | null  # e.g., "DGW37 is optimal WC window"
```

`PlayerWindow`:
```
player_id: int | null
name: str
team: str
summary: { dgw_count, bgw_count, next_dgw_gw, weighted_fixture_score, next6_pts }
upcoming: list[{gw, fixture_count, is_blank, is_double, opponents, avg_difficulty}]
```

**Source of truth:** `result_transformer.py` → `_normalize_fixture_planner()`. **Already mostly correct. Extract into standalone `HorizonWatchCard` object instead of flat `fixture_planner` field.**

**Ownership:** Backend.

**Show/hide:** Hidden when `gw_timeline` is empty. Shown whenever fixture planning context is available.

---

### `DecisionConfidenceCard`
**Purpose:** Answer "how confident is this recommendation and on what basis?"

**Required fields:**
```
overall_confidence: 'HIGH' | 'MED' | 'LOW'
confidence_label: str
confidence_summary: str
strategy_mode: 'DEFEND' | 'CONTROLLED' | 'BALANCED' | 'RECOVERY'
risk_posture: 'conservative' | 'balanced' | 'aggressive'
rank_bucket: 'elite' | 'strong' | 'mid' | 'recovery' | 'unknown'
decision_status: str  # 'PASS', 'HOLD', 'BLOCKED', etc.
data_quality_flags: list[str]  # missing fixtures, stale data, etc.
near_threshold_moves: list[{out, in, delta_gap}]
near_threshold_reason: str | null
```

**Source of truth:** `result_transformer.py` `manager_state` + `decision_status` + `near_threshold_moves`. **Consolidate into one card object.**

**Ownership:** Backend.

**Show/hide:** Always shown. This is the explainability layer.

---

# 5. Canonical View Model Plan

## Current state

There are currently **three active transformation paths** producing overlapping output:
1. `backend/services/result_transformer.py` → main frontend dict
2. `backend/services/contract_transformer.py` → "Cheddar integration" version (independent re-derivation)
3. `frontend/src/lib/decisionViewModel.ts` → React view model (re-derives chip/transfer/action on top of #1)

Plus a fourth partial path in `backend/routers/dashboard.py`.

## Target: single backend transformation, thin frontend mapper

**Recommended transform module:** `backend/services/result_transformer.py` — **it already has the right intent.** It needs to be refactored, not replaced.

**Inputs:** Raw `analysis` dict (containing `DecisionOutput` dataclass) + `raw_data` dict + `overrides` dict.

**Outputs:** A strictly typed `WeeklyAnalysisPayload` Pydantic model containing exactly:
```
weekly_review: WeeklyReviewCard | null
squad_state: CurrentSquadStateCard
gameweek_plan: GameweekPlanCard
transfer_recommendation: TransferRecommendationCard
captaincy: CaptaincyCard
chip_strategy: ChipStrategyCard
horizon_watch: HorizonWatchCard | null
decision_confidence: DecisionConfidenceCard
```

No other top-level fields. No `[key: string]: unknown` escape hatch.

**Frontend `decisionViewModel.ts` becomes a thin adapter:**
- It maps `WeeklyAnalysisPayload` fields to component props
- It does NOT re-derive chip verdict, primary action, risk statement, or transfer dedup
- Its only logic is null-safety coercion and prop renaming for component APIs

**Pages and components that must stop doing their own inference:**
- `Results.tsx`: remove `lineupStarters`/`lineupBench` inline resolution — consume `squad_state.starting_xi` and `squad_state.bench` directly
- `decisionViewModel.ts`: remove `toPrimaryAction()`, `toChipVerdict()`, `toChipStatus()`, `toRiskStatement()` — these become backend fields
- `TransferSection`: stop receiving `strategy_paths` separately — strategy alternatives belong in `TransferRecommendationCard.transfers[n].alternatives`

**Anti-patterns to eliminate:**
- `[key: string]: unknown` on `AnalysisResults` in `api.ts`
- Multiple chip fields (`chip_strategy`, `chip_recommendation`, `chip_verdict`, `chip_explanation`) — one card, one field
- Multiple transfer list shapes (`transfer_recommendations`, `forced_transfers`, `optional_transfers`, `transfer_plans`) — one `TransferRecommendationCard`
- Inline null-cascade resolution in page components
- Markdown/emoji in `output_formatter.py` being passed through the API response

---

# 6. Retrospective vs Forward-Looking Contract

## Section A: Previous GW Review

**User questions answered:**
- How did I score last GW?
- Did my rank improve or fall?
- Was my captain the right call?
- Did I follow Sage's advice? Was it right?

**Metrics that belong here:**
- `points_scored`, `rank_before`, `rank_after`, `rank_delta`
- `captain_name`, `captain_actual_pts`
- `recommendation_followed`, `process_verdict`
- `advice_summary` (one sentence)
- `drift_flags` if any recommendations were contradicted by outcome

**Must never be mixed in:** Transfer recommendations, chip timing, fixture windows. Nothing forward-looking.

**Implementation note:** This requires `DecisionReceipt` to be populated at GW close via a background job that fetches `my_team/history` from the FPL API and compares against the stored receipt. Currently `DecisionReceipt.outcome` and `process_verdict` are defined but never computed.

---

## Section B: Current GW Adjustments

**User questions answered:**
- What is the state of my squad right now?
- Do I have any urgent moves to make before the deadline?
- What chips do I have?
- Am I healthy or compromised entering this GW?

**Metrics that belong here:**
- `squad_health`, `squad_issues`, `critical_issues`
- `free_transfers`, `available_chips`, `active_chip`
- `primary_action`, `confidence`, `decision_brief`
- `transfer_recommendation` (all transfer items with priority rank)
- `captaincy` (captain + vice captain)
- `chip_strategy` (use/watch/save verdict)

**Must never be mixed in:** Previous GW results, future horizon planning, chip window projections beyond current decision.

---

## Section C: Upcoming Horizon / Chip Planning

**User questions answered:**
- What are the DGW/BGW windows ahead?
- Which players in my squad have good fixture runs?
- What is the optimal chip deployment window?
- What should I be targeting in future transfers?

**Metrics that belong here:**
- `horizon_watch.gw_timeline` (DGW/BGW calendar)
- `horizon_watch.squad_windows` (per-player fixture quality over 8 GWs)
- `horizon_watch.target_windows` (players to target based on fixture run)
- `horizon_watch.key_planning_notes`
- `horizon_watch.chip_path_hint`
- `decision_confidence.near_threshold_moves` (players approaching transfer threshold)

**Must never be mixed in:** Current-GW transfer recommendations, captain pick, squad health status, previous GW outcomes.

---

# 7. Concrete Refactor Plan

## Phase 1: Eliminate duplicate output fields (backend)
**Objective:** Make `result_transformer.py` produce a single canonical shape per concern.

**Files impacted:**
- `backend/services/result_transformer.py`
- `backend/models/api_models.py`
- `frontend/src/lib/api.ts`

**Operations:**
1. Consolidate `chip_strategy` + `chip_recommendation` + `chip_verdict` + `chip_explanation` → single `chip_strategy_card` field with the shape defined in Section 4.
2. Consolidate `transfer_recommendations` + `forced_transfers` + `optional_transfers` + `transfer_plans` + `strategy_paths` → single `transfer_recommendation` field. Strategy paths become `alternatives` on each `TransferItem`.
3. Consolidate `starting_xi` + `bench` + `projected_xi` + `projected_bench` + `lineup_decision.starters` + `lineup_decision.bench` → a single canonical squad layout in `squad_state`. The projected version is a sub-field, not a parallel top-level array.
4. Add `WeeklyAnalysisPayload` Pydantic model to `backend/models/api_models.py` defining the complete output contract.
5. Update `frontend/src/lib/api.ts` `AnalysisResults` to match exactly. Remove `[key: string]: unknown`.

**Acceptance criteria:** Backend returns exactly the fields defined in Section 4. No extra top-level keys. Frontend tests pass.

**Regression risks:** Any component or test that reads `chip_recommendation.chip`, `chip_verdict`, `transfer_recommendations`, `starting_xi`, `projected_xi` directly will break. Requires coordinated frontend update in same phase.

**Order of operations:** Backend first. Deploy with both old and new fields present (additive). Update frontend. Remove old fields.

---

## Phase 2: Thin the frontend view model
**Objective:** `decisionViewModel.ts` becomes a prop-mapper, not a business logic module.

**Files impacted:**
- `frontend/src/lib/decisionViewModel.ts`
- `frontend/src/pages/Results.tsx`
- `frontend/src/components/ChipDecision.tsx`
- `frontend/src/components/TransferSection.tsx`

**Operations:**
1. Remove `toPrimaryAction()` — consume `gameweek_plan.primary_action` directly.
2. Remove `toChipVerdict()`, `toChipStatus()` — consume `chip_strategy_card.chip` and `chip_strategy_card.status` directly.
3. Remove `toRiskStatement()` — this is UX copy; either backend-provides it in `squad_state` or it is a static template-fill function in a dedicated `copy.ts` module, not in the view model.
4. Remove transfer dedup logic from `toTransferSectionView()` — backend guarantees no duplicates.
5. Remove inline resolution in `Results.tsx` (`lineupStarters`/`lineupBench` cascade) — consume `squad_state.starting_xi` and `squad_state.bench`.

**Acceptance criteria:** `decisionViewModel.ts` contains no if/else branching on field names. No fallback cascade logic. All functions are pure prop-mappers.

**Regression risks:** Component test snapshots will change. Verify `CaptaincySection.test.tsx`, `DecisionBrief.test.tsx`, `TransferSection.test.tsx` all pass.

---

## Phase 3: Add `WeeklyReviewCard` (retrospective)
**Objective:** Surface previous GW outcome to the user before showing recommendations.

**Files impacted:**
- `backend/services/weekly_review_service.py` (new)
- `backend/services/result_transformer.py`
- `backend/models/api_models.py`
- `backend/routers/analyze.py`
- `frontend/src/lib/api.ts`
- `frontend/src/components/WeeklyReview.tsx` (new)
- `frontend/src/pages/Results.tsx`

**Operations:**
1. Create `backend/services/weekly_review_service.py`. It fetches `my_team/history` from FPL API, looks up the stored `DecisionReceipt` for the previous GW via product store, and computes `WeeklyReviewCard`.
2. Call `weekly_review_service.build_review()` inside `result_transformer.transform_analysis_results()`. If no receipt exists for previous GW, return `null`.
3. Add `weekly_review` field to `WeeklyAnalysisPayload`.
4. Add `WeeklyReview` component. Render above `DecisionBrief` in `Results.tsx` when non-null.

**Acceptance criteria:** After running an analysis in GW35, the output shows GW34 score, rank delta, and whether captain pick was followed. When no receipt exists (GW1 or first run), section is absent with no error.

**Regression risks:** FPL API `my_team/history` must be available. If offline or stale, fallback to null gracefully.

---

## Phase 4: Extract `HorizonWatchCard` as standalone section
**Objective:** Separate fixture horizon planning from the transfer recommendation section.

**Files impacted:**
- `backend/services/result_transformer.py`
- `frontend/src/components/HorizonWatch.tsx` (new)
- `frontend/src/pages/Results.tsx`
- `frontend/src/lib/decisionViewModel.ts`

**Operations:**
1. In `result_transformer.py`, extract `_normalize_fixture_planner()` output into `horizon_watch` field of the canonical payload.
2. Remove `strategy_paths` as a standalone field — fold into `transfer_recommendation.transfers[n].alternatives`.
3. Add `chip_path_hint` to `HorizonWatchCard` — derived from `chip_timing_outlook` field.
4. Create `HorizonWatch` React component rendering the GW timeline and player fixture windows.
5. Render below `ChipDecision` in `Results.tsx`.

**Acceptance criteria:** The fixture planner renders as a standalone section. Transfer recommendations no longer include `strategy_paths` as a sibling field. Chip timing hint appears in horizon section, not in chip card.

**Regression risks:** Tests that assert on `gwTimeline` in view model need updating.

---

## Phase 5: Remove UX copy from engine layer
**Objective:** `output_formatter.py` generates clean structured output, not formatted text.

**Files impacted:**
- `src/cheddar_fpl_sage/analysis/decision_framework/output_formatter.py`
- `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py`

**Operations:**
1. Audit all uses of `output_formatter.generate_decision_summary()`. This function generates markdown+emoji text — identify every call site.
2. If this output is consumed only by the CLI (`fpl_sage.py`), it stays as-is but is clearly marked as CLI-only: it must not be passed through the API response.
3. If this text is being piped into `reasoning` or `narrative` fields in the API response (which it currently is via the `normalized_reasoning` field in the transformer), replace it with structured fields: `rationale`, `confidence_context`, `key_factors: list[str]`.
4. The `reasoning` field in the API response must be plain text only, no markdown headers, no emoji.

**Acceptance criteria:** `AnalysisResults.reasoning` in API response contains no `#`, no `**`, no emoji. CLI output is unaffected.

**Regression risks:** Any test that asserts on the content of `reasoning` will need updating.

---

## Phase 6: Eliminate `contract_transformer.py` and `dashboard.py` parallel paths
**Objective:** Stop maintaining three independent transformation paths.

**Files impacted:**
- `backend/services/contract_transformer.py`
- `backend/routers/dashboard.py`

**Operations:**
1. `contract_transformer.py` rebuilds transfers, chip, and captaincy from already-transformed results. After Phase 1, these are canonical fields on `WeeklyAnalysisPayload`. Update `contract_transformer.py` to read from canonical card objects instead of re-deriving.
2. `dashboard.py` extracts weaknesses, transfers, chip advice, captain advice from raw job results. Update to read from canonical `squad_state`, `transfer_recommendation`, `chip_strategy_card`, `captaincy` fields.
3. Mark `_extract_weaknesses()`, `_extract_transfer_targets()`, `_extract_chip_advice()`, `_extract_captain_advice()` in `dashboard.py` as deprecated and schedule for removal.

**Acceptance criteria:** Dashboard endpoint returns the same data as before. No independent re-derivation of business logic.

**Regression risks:** Low. These are downstream consumers, not producers. Verify `test_analyze_api.py` and `tests_new/test_api_endpoints.py`.

---

# 8. Contract and Type Fixes

| # | Issue | Severity | Why It Matters | Proposed Fix |
|---|---|---|---|---|
| 1 | `AnalysisResults` uses `[key: string]: unknown` catch-all in `api.ts` | Critical | Silent contract drift. Fields can disappear from backend without TypeScript catching it. | Replace with strict `WeeklyAnalysisPayload` Pydantic model surfaced as TypeScript type via codegen or hand-maintained strict interface. |
| 2 | `chip_strategy`, `chip_recommendation`, `chip_verdict`, `chip_explanation` are four separate top-level fields for the same concept | High | `toChipVerdict()` requires 4-fallback cascade. Any field change breaks the cascade silently. | Merge into `ChipStrategyCard`. One field: `chip_strategy_card`. |
| 3 | `transfer_recommendations` + `forced_transfers` + `optional_transfers` + `transfer_plans` + `strategy_paths` are five representations of transfer recommendations | High | Frontend dedup logic can drop valid alternatives. Priority signal is lost across forms. | Merge into `TransferRecommendationCard`. One field: `transfer_recommendation`. |
| 4 | `starting_xi`, `bench`, `projected_xi`, `projected_bench`, `lineup_decision.starters`, `lineup_decision.bench` are six representations of squad layout | High | `Results.tsx` resolves inline with cascade. Stale data in one source silently shadows another. | Canonical `squad_state.starting_xi`, `squad_state.bench`, `squad_state.projected_xi`, `squad_state.projected_bench`. `lineup_decision` becomes an internal engine struct only. |
| 5 | `reasoning` field contains markdown-formatted text with emoji | High | `toPlainText()` in `decisionViewModel.ts` strips formatting — but this is fragile and means the field has no stable contract. | Make `reasoning` plain text only. Separate `key_factors: list[str]` for structured display. |
| 6 | `DecisionReceipt.process_verdict` and `outcome` exist in `product_models.py` but are never computed or surfaced | High | The retrospective evaluation capability exists on paper but produces no user-facing value. | Implement `weekly_review_service.py` to populate and expose this data. |
| 7 | `AnalysisStatus.results` typed as `Optional[Dict[str, Any]]` in `api_models.py` | Medium | The entire typed contract is bypassed at the job result boundary. | Type `results` as `Optional[WeeklyAnalysisPayload]`. |
| 8 | `DecisionSummary` in `models.py` has no `previous_gw_review` or `horizon_plan` fields | Medium | Decision models are entirely forward-only. Retrospective data has no home in the analytical layer. | Add optional `previous_gw_summary` field or keep retrospective separate via `WeeklyReviewCard`. |
| 9 | `CanonicalPlayerProjection` has `effective_ownership` property but it is never surfaced to UI | Medium | Effective ownership is key to captaincy differentiation decisions (template vs differential). | Surface in `CaptaincyCard.captain.effective_ownership`. |
| 10 | `near_threshold_moves` exists in transformer output but is never rendered in UI | Low | Users cannot see which transfers are close to being recommended — blocks proactive decision-making. | Render in `DecisionConfidenceCard` as "Watching" section. |
| 11 | `_calculate_squad_health()` has three separate fallback paths (canonical payload → picks → risk_scenarios) | Low | Inconsistent health data depending on which path activates. Fragile. | Single path: canonical squad_health from `DecisionOutput.squad_health`. If absent, compute from picks. Remove risk_scenarios fallback. |
| 12 | `confidence_label` and `confidence` are two parallel confidence fields | Low | `toConfidence()` in view model tries both with a cascade. | Single `confidence` field with values `HIGH | MED | LOW`. Remove `confidence_label`. Fold `confidence_summary` into `DecisionConfidenceCard`. |

---

# 9. Non-Negotiable Rules Going Forward

**Rule 1 — Analytical modules do not format UX copy.**
`output_formatter.py` and any function inside `enhanced_decision_framework.py` must not produce markdown headers, emoji characters, or human-readable narrative text that passes through the API response. Structured fields only. CLI formatting belongs in a CLI-only presentation adapter.

**Rule 2 — Frontend components do not re-derive business logic.**
`decisionViewModel.ts` may rename fields and null-coerce. It may not compute chip verdicts, normalize primary actions, or generate risk statement copy from raw score fields. If a business rule is needed, it belongs in `result_transformer.py`.

**Rule 3 — Every recommendation object must include: `rationale`, `confidence`, `risk_note`, `source`.**
`TransferItem`, `CaptaincyCard.captain`, `ChipStrategyCard`, and `DecisionConfidenceCard` must each carry these four fields. No recommendation is surfaced without a `rationale`. No confidence is surfaced without a `source` (what drove it).

**Rule 4 — Previous GW review and upcoming GW plan are distinct contracts that must never be mixed.**
`WeeklyReviewCard` contains only retrospective data. `GameweekPlanCard` contains only current GW decisions. `HorizonWatchCard` contains only forward planning. Cross-field references between these objects are forbidden.

**Rule 5 — One canonical field per concept.**
Transfers have one canonical field. Chips have one canonical field. XI/bench have one canonical set. When a new representation is needed (e.g., for a dashboard export), it is derived from the canonical field at the consumption point — not added as a parallel top-level field.

**Rule 6 — No `[key: string]: unknown` on primary output contracts.**
`AnalysisResults` must be a closed, fully typed interface. Any field that exists on the backend must have a TypeScript counterpart. Any field that no longer exists on the backend must be removed from the frontend interface.

**Rule 7 — The weekly review capability must be tested end-to-end.**
`DecisionReceipt.outcome` and `process_verdict` must be populated at GW close. Their correctness must be tested in `tests/test_decision_receipts_api.py`. A receipt without an outcome after GW deadline is a data quality failure, not acceptable silent null.

**Rule 8 — Transformation logic is backend-owned, not duplicated across routers.**
`dashboard.py`, `contract_transformer.py`, and any future integration layer must consume canonical card objects from `result_transformer.py`. They must not re-extract raw fields and re-compute the same quantities independently.

---

# 10. Final Recommendation

The analytical engine works. The contracts between it and the user do not.

**Do this first this week:**

1. Write `WeeklyAnalysisPayload` Pydantic model in `backend/models/api_models.py` with the card objects defined in Section 4. Add it as the output type of `transform_analysis_results()`.
2. Consolidate the four chip fields into `chip_strategy_card`. This is a targeted change in `result_transformer.py` and the corresponding field in `api.ts`. No logic changes required.
3. Start populating `DecisionReceipt.outcome` at GW close by adding a background FPL API fetch in `engine_service.py`. Even if `WeeklyReviewCard` is not rendered yet, the data pipeline must be running.

**Do not touch yet:**

- `enhanced_decision_framework.py` internals — the engine logic is not the problem. Do not refactor the 3,681-line core until the contract layer above it is stabilized.
- `output_formatter.py` CLI text generation — this works and serves a real use case. Isolate it from the API path; do not rewrite it.
- Component styling or visual layout — these are cosmetic and irrelevant until the data contracts are correct.

The fastest path to a better weekly UX is not new components. It is fixing what the backend sends so the frontend stops guessing.
