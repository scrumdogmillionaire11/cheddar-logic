# Cheddar-Logic Roadmap

## Milestone 1: Production-Ready Ingest & Inference Pipeline

### Status: In Progress (Pre-Ship Hardening)

All 4 migration phases complete. System is in final hardening before production deployment.

### Phases Completed
- Phase 1: DB + Odds Ingestion ✅
- Phase 2: Model Runner + Card Generation + Web API ✅
- Phase 3: Multi-Sport Runners + Web UI ✅
- Phase 4: Scheduled Runner + Production Cutover ✅
- Step C: API Read Path + Payload Safety Hardening ✅
- Step D: Real Odds Ingest via @cheddar-logic/odds Package ✅

### Current Phase: Pre-Ship Hardening
Tighten operational guarantees before first production deploy:
- Contract checks for normalization failures
- Stable game ID regression tests
- Job key audit across all jobs
- Adapter API clarity
- T-120 documentation
- Ingest proof runbook

### Architecture
```
apps/worker/     → scheduler + ingest + model execution
web/             → Next.js UI + API routes
packages/data/   → DB layer (sql.js + migrations)
packages/odds/   → provider fetch + normalization (NO DB writes)
```

---

## Milestone 2: Play of the Day — Web Feature

### Status: Planning

A product-facing feature on cheddarlogic.com: one best play per day, signal-scored from live odds, published to the site and Discord, with a running $10 bankroll tracker.

### Architecture
```
web/app/play-of-the-day/    → Next.js page route
web/app/api/play-of-day/    → API routes (signal engine, publish, outcomes)
apps/worker/                → Daily cron trigger (12–4PM window)
packages/odds/              → The Odds API fetch (reused)
```

### Phase: potd-01 — Play of the Day: Signal Engine + Page + Discord
**Goal**: Ship a fully working /play-of-the-day page on cheddarlogic.com. The system fetches live game lines from The Odds API daily, scores each game using the 4-dimension signal engine, selects the single best ELITE/HIGH-confidence play, sizes the wager with Quarter-Kelly (20% cap, $10 starting bankroll), publishes to the Cheddar UI page and Discord simultaneously, enforces a one-play-per-day gate, and maintains a persistent bankroll + play history ledger.

**Sports in scope**: NBA, MLB, NHL (game lines only). NFL deferred.
**Posting window**: 12–4PM daily, dynamically timed 90min before first game lock.

**Plans**: TBD

Plans:

- [ ] TBD — planning in progress

---

### Phase: mlb-k-harden — MLB Pitcher-K Pipeline Hardening

**Goal**: Eliminate silent proxy substitution in the MLB pitcher-K model. Install an explicit
input contract, a deterministic quality classifier, per-pitcher pre-model completeness logging,
and card-level flag deduplication. Cards using proxies for core metrics must emit FALLBACK,
not quietly claim DEGRADED_MODEL status.

**Plans**: 4 plans

Plans:
- [ ] mlb-k-harden-01-PLAN.md — Classifier module: classifyMlbPitcherKQuality + 5 unit tests (Wave 1)
- [ ] mlb-k-harden-02-PLAN.md — Spec doc (mlb_projection_input_contract.md) + WI-0742 FALLBACK addendum (Wave 1)
- [ ] mlb-k-harden-03-PLAN.md — Wire classifier into run_mlb_model.js + pre-model audit block + flag dedup (Wave 2)
- [ ] mlb-k-harden-04-PLAN.md — INV-007 audit invariant + update/create MLB_PITCHER_K fixtures (Wave 3)


---

### Phase: di-01-decision-integrity — Decision Source-of-Truth Hardening

**Goal**: Eliminate all multiple-truth-layer decision mutations. Enforce a single canonical decision object per card, fix web reclassification, kill ghost bets from execution gate contradiction, make NHL NO_BET explicit, unify tier vocabularies, complete projection path consolidation, and lock all behavior with regression tests.

**Audit source**: `.planning/codebase/HARDENING_AUDIT.md` — CF-001 through CF-010

**Plans**: 8 plans in 3 waves

Plans:
- [ ] di-01-01-PLAN.md — Kill web-layer reclassification; add NON_CANONICAL_RENDER_FALLBACK guard (Wave 1)
- [ ] di-01-02-PLAN.md — NHL NO_BET explicit skip state; blockingReasonCodes in pipeline state (Wave 1)
- [ ] di-01-03-PLAN.md — Tier vocabulary unification: GOOD/OK/BAD in deriveAction + TIER_SCORE (Wave 1)
- [ ] di-01-04-PLAN.md — applyDecisionVeto helper; execution gate mutation fix; settlement contradiction guard (Wave 2)
- [ ] di-01-05-PLAN.md — Deprecated projectNBA migration in computeNBADriverCards (Wave 2)
- [ ] di-01-06-PLAN.md — Threshold registry completeness: NHL SPREAD/PUCKLINE + exhaustive coverage test (Wave 2)
- [ ] di-01-07-PLAN.md — Stale threshold to env var; EDGE_UPGRADE_MIN recalibrated to 0.04; assertNoDecisionMutation hardened (Wave 3)
- [ ] di-01-08-PLAN.md — Playoff sigma explicit contract + 5-case test suite (Wave 3)

---

### Phase: WI-0914 — Multi-Sport Playoff Overlay Layer

**Goal**: Implement a deterministic playoff overlay layer across NHL/NBA/NFL/MLB that adjusts volatility bands, eligibility strictness, and execution thresholds in the existing single-model paths.

**Requirements:** [PO-OVERLAY-01, PO-OVERLAY-02, PO-OVERLAY-03, PO-NHL-01, PO-NHL-02, PO-NBA-01, PO-NFL-01, PO-MLB-01, PO-THRESH-01]

**Plans:** 3 plans in 2 waves

Plans:
- [ ] WI-0914-01-PLAN.md — Shared playoff overlay contract + scheduler/watchdog + payload validation (Wave 1)
- [ ] WI-0914-02-PLAN.md — NHL + NBA playoff runner/model overlays (Wave 2)
- [ ] WI-0914-03-PLAN.md — NFL + MLB playoff overlays + stricter playoff thresholds (Wave 2)


---

### Phase: ime-01-independent-market-eval — Independent Market Evaluation

**Goal**: Replace winner-take-all market selection with independent evaluation + explicit rejection accounting for MLB and NHL moneyline markets. Every generated market candidate must end in exactly one terminal status with reason codes. No market may disappear without accounting. MLB full_game_ml and NHL ML are first-class markets, not fallback artifacts.

**Audit source**: `.planning/MONEYLINE_AUDIT_FULL_SYSTEM.md`

**Requirements:** [IME-CONTRACT-01, IME-CONTRACT-02, IME-MLB-01, IME-MLB-02, IME-MLB-03, IME-MLB-04, IME-NHL-01, IME-NHL-02, IME-NHL-03]

**Plans:** 5 plans in 3 waves

Plans:
- [ ] ime-01-01-PLAN.md — Shared evaluation contract: evaluateSingleMarket, finalizeGameMarketEvaluation, assertNoSilentMarketDrop, REASON_CODES (Wave 1)
- [ ] ime-01-02-PLAN.md — Kill MLB hardcoded selector: replace selectMlbGameMarket with evaluateMlbGameMarkets (Wave 1)
- [ ] ime-01-03-PLAN.md — Wire evaluateMlbGameMarkets into run_mlb_model.js; multi-market insertion (Wave 2)
- [ ] ime-01-04-PLAN.md — NHL independent evaluation: evaluateNHLGameMarkets + choosePrimaryDisplayMarket; wire into run_nhl_model.js (Wave 2)
- [ ] ime-01-05-PLAN.md — Spec doc docs/market_evaluation_contract.md + VALID_STATUSES export (Wave 3)

---

### Phase: WI-0911 — NHL Player Blocks Projection Settlement Policy

**Goal**: Enforce an explicit, deterministic settlement policy for `nhl-player-blk` so this market cannot silently flow through unsupported grading paths.

**Requirements:** [BLK-SETTLE-01, BLK-SETTLE-02, BLK-SETTLE-03]

**Plans:** 1 plan in 1 wave

Plans:
- [ ] WI-0911-01-PLAN.md — Lock `nhl-player-blk` as projection-audit-only, add market-specific closeout reason metadata, and harden settlement tests (Wave 1)

---

### Phase: discord-3layer — 3-Layer Discord Architecture

**Goal**: Collapse the Discord webhook pipeline from 9 inference layers to 3. Every card payload is stamped with canonical `webhook_bucket`, `webhook_eligible`, `webhook_display_side`, `webhook_lean_eligible`, and `webhook_reason_code` fields at publish time (Layer A). The Discord formatter reads these fields directly with no threshold math, no sport-specific bucket logic, and no model imports (Layer B). Transport handles chunking and routing only (Layer C — already clean).

**Requirements:** [DISCORD-LAYER-01, DISCORD-LAYER-02, DISCORD-LAYER-03, DISCORD-LAYER-04, DISCORD-LAYER-05]

- `DISCORD-LAYER-01`: `computeWebhookFields(payload)` exported from `decision-publisher.js`; called in `publishDecisionForCard()` for all card kinds
- `DISCORD-LAYER-02`: NHL total bucket derived from `payload.nhl_totals_status.status` (already stamped by model runner) — no re-computation in Discord
- `DISCORD-LAYER-03`: NHL 1P bucket derived from `payload.nhl_1p_decision.surfaced_status` — no re-computation in Discord
- `DISCORD-LAYER-04`: `classifyNhlTotalsBucketStatus()` deleted from `post_discord_cards.js`; `classifyNhlTotalsStatus` import removed
- `DISCORD-LAYER-05`: Four Discord functions (`classifyDecisionBucket`, `isDisplayableWebhookCard`, `selectionSummary`, `passesLeanThreshold`) read canonical `webhook_*` fields first; legacy fallbacks preserved for pre-deploy payloads

**Plans:** 2 plans in 2 waves

Plans:
- [ ] discord-3layer-01-PLAN.md — Layer A: Publisher stamps webhook_bucket/eligible/display_side/lean_eligible/reason_code on every card (Wave 1)
- [ ] discord-3layer-02-PLAN.md — Layer B: Discord reads canonical webhook fields; deletes classifyNhlTotalsBucketStatus (Wave 2)

---

### Phase: ui-decision-contract — Public Decision Surface Contract

**Goal**: Enforce a single, coherent public card decision surface so surfaced status, verification/certainty gating, and optional model context cannot contradict each other. PASS cards must not publicly expose BEST/raw-edge/fair signals in the primary body unless explicitly internal-labeled.

**Requirements:** [UI-CONTRACT-01, UI-CONTRACT-02, UI-CONTRACT-03, UI-CONTRACT-04]

- `UI-CONTRACT-01`: Introduce canonical `final_market_decision` payload contract in web transform with surfaced_status, surfaced_reason, verification_state, certainty_state, and model-context visibility flags
- `UI-CONTRACT-02`: Encode precedence rule in one helper: integrity/verification gate -> certainty gate -> market-stability gate -> surfaced status -> optional model context
- `UI-CONTRACT-03`: `GameCardItem` primary body must render from surfaced decision only; PASS suppresses public BEST/edge/fair fields
- `UI-CONTRACT-04`: Add regression guards preventing PASS + BEST + large edge + verification-required contradictions in public output

**Plans:** 2 plans in 2 waves

Plans:
- [ ] ui-decision-contract-01-PLAN.md — Canonical `final_market_decision` transform contract + precedence helper + contract tests (Wave 1)
- [ ] ui-decision-contract-02-PLAN.md — GameCardItem surfaced-status-first rendering + legacy contradictory path removal + regression tests (Wave 2)

---

### Phase: market-board - The Wedge + Cheddar Board

**Goal**: Split picks and market intelligence into sibling surfaces: The Wedge (/wedge) for model-driven picks and Cheddar Board (/board) for market-state intelligence.

**Requirements:** [WEDGE-01, BOARD-01, BOARD-02, BOARD-03, BOARD-04]

**Plans:** 2 plans in 2 waves

Plans:
- [ ] market-board-01-PLAN.md - The Wedge route rename and /cards redirect (Wave 1)
- [ ] market-board-02-PLAN.md - Cheddar Board API + 4-tab UI + nav integration (Wave 2)

### Phase: WI-0944 — MLB Full-Game Market De-Suppression (Totals + Moneyline)

**Goal**: Reduce over-suppression in MLB full-game totals and moneyline so legitimate odds-backed full-game plays can surface, while preserving explicit edge discipline, deterministic reason codes, and runner-level observability.

**Requirements:** [WI-0944-OBS-01, WI-0944-OBS-02, WI-0944-TOTAL-01, WI-0944-ML-01, WI-0944-GATE-01]

**Plans:** 3 plans in 3 waves

Plans:
- [ ] WI-0944-01-PLAN.md — Full-game funnel instrumentation + suppressor report + runner coverage (Wave 1)
- [ ] WI-0944-02-PLAN.md — Full-game total de-suppression retune + capped volatility threshold + gate regression tests (Wave 2)
- [ ] WI-0944-03-PLAN.md — Full-game moneyline adjustment layer + fresh-odds surfacing regression coverage (Wave 3)


---

### Phase: nhl-odds-backed-01 — NHL ML + Totals Odds-Backed Surfacing Recovery

**Goal**: Surface NHL moneyline and totals market-call cards as fully odds-backed plays in gamelines/cards by removing PROJECTION_ONLY contamination in totals, ensuring moneyline decision_v2 pricing completeness, and adding regression/health coverage to prevent silent drops.

**Requirements:** [NHR-TOTALS-01, NHR-TOTALS-02, NHR-ML-01, NHR-ML-02, NHR-API-01, NHR-OBS-01, NHR-DOCS-01]

**Plans:** 3 plans in 2 waves

Plans:
- [ ] nhl-odds-backed-01-01-PLAN.md — Totals execution status contamination fix (goalie guard + canonical status sync) (Wave 1)
- [ ] nhl-odds-backed-01-02-PLAN.md — Moneyline decision_v2 pricing completeness + model_prob fallback hardening (Wave 1)
- [ ] nhl-odds-backed-01-03-PLAN.md — Gamelines regression coverage + pipeline health NHL ML counters + registry updates (Wave 2)
