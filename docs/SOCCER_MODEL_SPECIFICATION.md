# Cheddar Board: Soccer Model — Target Specification

**Version 1.0  |  March 2026**  
Cheddar Logic LLC  |  [cheddarlogic.com](http://cheddarlogic.com)

## Executive Summary

The current soccer implementation is a functional scaffold, not a calibrated model. It generates cards and routes them correctly through the pipeline, but the edge signals driving those cards are either synthetic (no real market line) or purely structural (implied probability math on the moneyline). There is no xG-based model, no calibration tracking, no league-aware variance adjustment, and no measurement of whether projection-only cards win at a rate that justifies their display.

This specification defines what the soccer model needs to become: a three-tier system where (1) odds-backed markets compute real edge using market-aware probability math, (2) projection markets use an xG foundation with matchup adjustments, and (3) all recommendations are tracked against outcomes with explicit win-rate guardrails. The build is sequenced so each phase delivers working, measurable improvements without breaking the existing pipeline.

| Dimension | Current State | Target State |
|-----------|---------------|--------------|
| Edge signal | Market implied prob math only | xG Poisson model + matchup adj |
| Projection basis | Synthetic placeholders / heuristics | Calibrated xG rolling model per league |
| League handling | EPL / MLS / UCL identical | League-specific sigma and pace adj |
| Performance tracking | None | CLV ledger + projection win-rate per market |
| Execution eligibility | Not differentiated | Formally gated — odds-backed only |
| Calibration guard | None | Recalibration flag at <48% rolling 20 |

---

## 1. Current State — What Exists

### 1.1 Architecture

The system runs a two-track job (`run_soccer_model.js`) that processes live odds snapshots on Track 1 and generates synthetic projections on Track 2. Cards are routed through the decision pipeline and stored in `card_payloads`. A companion pull job (`pull_soccer_player_props.js`) fetches Tier 1 player props from 5 bookmakers within a 36-hour window.

### 1.2 What the current model actually does

**Track 1 (Odds-backed):** Reads `h2h_home` / `h2h_away` from the Odds API snapshot, normalizes implied probabilities by removing vig, and derives a `win_prob_home`. No model is applied — the "projection" is just the vig-removed market price.

**Track 2 (Projection-only):** Builds placeholder cards for `player_shots`, `to_score_or_assist`, and `team_totals` with synthetic basis. These cards are informational and explicitly marked `execution_eligible: false` via the `decision_basis` contract.

**Edge calculation:** `edge_ev = fair_prob - implied_prob`. Since `fair_prob` is derived from the same market (vig removal), this is circular — it measures vig only, not true model edge.

**Card priority:** Scored by a heuristic formula, not by historical win rate or projected edge. Top 12 cards per game are kept.

**Performance:** No outcome tracking. No win rate. No CLV. No recalibration trigger.

### 1.3 Gaps — Honest Assessment

| Gap | Impact | Severity |
|-----|--------|----------|
| No xG model | Projection cards have no predictive basis. Market edge is circular. | **Critical** |
| No calibration tracking | Cannot know if any soccer card type is profitable. No feedback loop. | **Critical** |
| Circular edge math | `edge_ev = vig`. Always positive. Always misleading. | **Critical** |
| Identical league handling | EPL and MLS have different pace, variance, and line quality. Treating them identically inflates false confidence. | **High** |
| Heuristic card priority | Top cards selected by scoring formula, not win rate. Best card may be worst predictor. | **High** |
| No market efficiency use | Research shows home-side xG edges exist but model does not exploit them. | **Medium** |
| No multi-league harmonization | EPL lines are sharper than MLS. No sigma difference applied. | **Medium** |

---

## 2. Target State — The Model It Needs to Become

### 2.1 Core Architectural Principle

The target soccer model operates in three tiers. Tier 1 is the only tier that produces execution-eligible cards — it requires a real market line from the Odds API and computes edge against a model-derived fair probability. Tier 2 produces projection-informed cards that are informational but tracked for win rate. Tier 3 is research and signal-building that feeds Tier 1 over time.

| Tier | Name | Definition | Execution Eligible |
|------|------|-----------|-------------------|
| 1 | Odds-backed edge | Real Odds API line + xG model fair prob → true edge calculation | **YES** — CLV tracked |
| 2 | Projection-informed | xG projection exists, no market line yet — synthetic floor used | **NO** — win rate tracked |
| 3 | Signal research | New features under development — not surfaced to users | **NO** — not displayed |

### 2.2 The xG Foundation

Expected goals (xG) is the statistical backbone of the target model. It replaces the circular vig-removal math with a true prior probability derived from team attacking and defensive quality.

#### 2.2.1 xG Data Source

- **Primary:** FBref via `soccerdata` Python library (already in your stat API stack) — provides rolling xG per 90 min for each team across EPL, MLS, UCL.
- **Rolling window:** Last 6 home games for home xG, last 6 away games for away xG. Weighted recency (most recent game = 2x weight).
- **Fallback when FBref unavailable:** Use season-average xG from the Odds API implied probability as a prior, but flag as LOW confidence.

#### 2.2.2 xG → Win Probability (Poisson Model)

The Poisson model converts team xG values into home/draw/away win probabilities. This is the same approach that produced +10–15% ROI in backtested Bundesliga data across 11 seasons.

**Formula:**

```
P(home goals = k) = Poisson(k, λ_home)  
  where λ_home = home_team_xg_rolling × home_advantage_adj × opponent_def_adj

P(away goals = k) = Poisson(k, λ_away)  
  where λ_away = away_team_xg_rolling × opponent_def_adj

P(home_win) = Σ P(home=i) × Σ P(away=j) for all i > j (i, j = 0..7)
```

#### 2.2.3 Home Advantage Adjustment

| League | Home advantage | Notes |
|--------|---|---|
| EPL | +0.12 xG per game | Historically documented |
| MLS | +0.09 xG per game | Lower due to travel patterns |
| UCL | +0.10 xG per game | Neutral venue finals excluded |

These are **additive adjustments** to λ_home, not multipliers.

### 2.3 League-Specific Model Parameters

The single most important improvement over current state. EPL and MLS are different markets with different line sharpness, different variance profiles, and different edge opportunities.

| League | Line sharpness | Sigma (goals) | Home edge | Away bias | Best market |
|--------|---|---|---|---|---|
| EPL | Highest | 1.18 goals | +12% vs away | Loss-making | Home ML / AH |
| MLS | Medium | 1.24 goals | +9% vs away | Loss-making | Home ML / Total |
| UCL | High | 1.15 goals | +10% vs away | Loss-making | AH / Home ML |

**Key research finding:** Away wins are systematically loss-making across all three leagues in 11-season Bundesliga backtest and confirmed in EPL xG modeling. The model must **NOT** generate execution-eligible away-win recommendations unless `edge_pct` exceeds a league-specific high threshold:
- **EPL:** >8%
- **MLS:** >6%
- **UCL:** >7%

### 2.4 Market Coverage — Target vs Current

| Market | Current | Target tier | Edge method | Profitability basis |
|--------|---------|---|---|---|
| Home ML (soccer_ml) | Track 1 ✓ | Tier 1 | xG Poisson | Backtested +10-15% ROI (xG) |
| Game total (soccer_game_total) | Track 1 ✓ | Tier 1 | λ_home + λ_away | xG total vs market total |
| Double chance | Track 1 ✓ | Tier 1 | P(home)+P(draw) | Reduces variance vs ML |
| Player shots on target | Track 2 synthetic | Tier 1 (w/ line) | xG → shot volume | Volume stat — least volatile prop |
| Goalkeeper saves | Not built | Tier 1 (new) | Opp xG → save vol | Low variance — opponent xG driven |
| Away ML | Track 1 ✓ | Tier 2 only | xG Poisson | Systematically loss-making — informational only |
| BTTS (both teams score) | Banned (Ohio) | Track 1 ✓ | N/A | Ohio scope restriction maintained |
| Asian handicap | Banned (Ohio) | Track 1 ✓ | N/A | Ohio scope restriction maintained |
| To score or assist | Track 2 synthetic | Tier 2 (tracked) | Role-tag model | High variance — track before promoting |
| Anytime goalscorer | Track 2 synthetic | Tier 2 (tracked) | xG per player | High variance — track only |

### 2.5 Edge Calculation — Fixing the Circular Math

**Current problem:** `edge_ev = fair_prob - implied_prob`, where `fair_prob` is derived from the market price. This is measuring vig, not model edge. It is always positive and always misleading.

**Target edge calculation:**

1. Run xG Poisson model → `model_prob` (independent of market)
2. Fetch Odds API line → `implied_prob` (vig-removed)
3. `edge_pct = model_prob - implied_prob`
4. Apply league sigma normalization (EPL sigma lower → higher bar for HOT tier)
5. Gate execution eligibility: only ODDS_BACKED plays with `edge_pct > threshold` surface as actionable

**League-specific edge thresholds (target):**

| League | Market | HOT threshold | WATCH threshold | Away win hard cap |
|--------|--------|---|---|---|
| EPL | Home ML | >5.5% | >3.0% | >8.0% only |
| EPL | Game total | >4.5% | >2.5% | N/A |
| MLS | Home ML | >5.0% | >2.5% | >6.0% only |
| UCL | Asian-handicap equiv | >5.5% | >3.0% | >7.0% only |

### 2.6 Performance Tracking — The Calibration Loop

The target model is only as good as its feedback loop. Without outcome tracking, there is no way to know if the xG model is working, if the league adjustments are correct, or if any market is worth continuing to show users.

#### Track A: CLV Ledger (Odds-backed plays)

- **Capture:** American odds at time of card display
- **Settle:** American odds at market close (pre-game)
- **Compute:** CLV = displayed_odds vs closing_odds in implied probability terms
- **Signal:** Consistently positive CLV = model is finding value before the market. Negative CLV = model is wrong direction.
- **Minimum sample before reporting:** 30 plays per market type per league

#### Track B: Projection Win Rate (Tier 2 plays)

- **Capture:** `pick_side` (HOME/OVER/etc.), projection value, synthetic line
- **Settle:** actual result vs pick_side
- **Compute:** `win_rate = wins / settled plays`
- **Guard:** Rolling 20-play win rate < 48% → recalibration flag raised, cards demoted to PASS tier
- **Promote to Tier 1 condition:** `win_rate >= 54%` over 50+ plays with real market line available

---

## 3. Build Roadmap — Prioritized Phases

### 3.1 Phase Overview

Each phase delivers working, measurable improvements without breaking the existing pipeline. All phases use feature flags from the `flags.js` contract established in Phase 0.

| Phase | Name | Deliverable | Unlocks |
|-------|------|-------------|---------|
| 0 | Contract (DONE) | flags.js, decision-basis.types.js, db-telemetry.js — decision_basis contract applied to NHL + Soccer | Formal separation of ODDS_BACKED vs PROJECTION_ONLY |
| 1 | xG Foundation | FBref data pull, Poisson model, rolling xG per team per league | First real model_prob independent of market price |
| 2 | Edge Repair | Replace circular edge_ev with xG model_prob - implied_prob for Tier 1 markets | Execution-eligible cards have real edge signal for the first time |
| 3 | League Differentiation | EPL/MLS/UCL sigma values, home advantage adj, away-win hard cap | Markets treated correctly by risk profile and efficiency |
| 4 | Calibration Loop | CLV ledger populated for Tier 1, projection_perf_ledger for Tier 2, recalibration trigger | First measurable feedback on model performance |
| 5 | Prop Model | xG → shot volume projection for player_shots_on_target, goalkeeper_saves | New Tier 1 prop markets with genuine edge basis |

### 3.2 Phase 1 — xG Foundation (Build First)

**New file:** `pull_soccer_xg_stats.js`
- Pull FBref rolling xG data via `soccerdata` Python wrapper for EPL, MLS, UCL
- Store in new table: `soccer_team_xg_cache` (sport, team_name, league, home_xg_l6, away_xg_l6, fetched_at)
- Run on same schedule as `pull_soccer_player_props.js` — before every model run
- Fail open: if FBref unavailable, use NULL and model falls back to implied_prob with LOW confidence tag

**New file:** `xg-model.js` (packages/models/src/)
- `poissonPmf(k, lambda)` — pure function, tested independently
- `computeXgWinProbs({ homeXg, awayXg, league })` → `{ homeWin, draw, awayWin }`
- `computeXgTotalProb({ homeXg, awayXg, totalLine, direction })` → probability over/under line
- `applyLeagueHomeAdj(xg, league)` → adjusted xG with league-specific home advantage
- `getLeagueSigma(league)` → sigma value for edge normalization

### 3.3 Phase 2 — Edge Repair

**Changes to `run_soccer_model.js`**

- Track 1 `soccer_ml`: Replace `edge_ev` computation. Pull `home_xg` / `away_xg` from cache → run Poisson → get `model_prob` → `edge_pct = model_prob - implied_prob`
- Track 1 `soccer_game_total`: `λ_total = home_xg + away_xg` → compute `P(total > line)` → edge against Odds API total price
- Add `model_confidence` flag to `payloadData`: `FULL` (xG cache hit), `PARTIAL` (one team missing), `LOW` (no xG — implied prob fallback used)
- Keep existing `payloadData` shape — just fix the `edge_ev` field and add `model_confidence`. No breaking changes.

### 3.4 Phase 3 — League Differentiation

- Apply SPORT_MARKET_THRESHOLDS map (already built in `decision-pipeline-v2.patch.js`) but extend it with SOCCER sub-league keys:
- Add `'EPL:MONEYLINE'`, `'MLS:MONEYLINE'`, `'UCL:MONEYLINE'` to SPORT_MARKET_THRESHOLDS with differentiated thresholds
- Add `away_win_blocked` flag: when model selects away team and league threshold not met, downgrade to PASS and log reason `AWAY_WIN_CAPPED`
- Add `league_tag` to every soccer card `payloadData` (already pulled from `raw_data` in deriveLeagueTag but not used in edge calculation)

### 3.5 Phase 4 — Calibration Loop

The `db-telemetry.js` foundation is built. Phase 4 wires it into the soccer job:

- On every Tier 1 card insert: call `recordClvEntry()` with `odds_at_pick`
- **New job:** `settle_soccer_clv.js` — runs post-game, fetches closing odds from Odds API, calls `settleClvEntry()`
- On every Tier 2 card insert: call `recordProjectionEntry()` with `projection + pick_side`
- **New job:** `settle_soccer_projections.js` — runs post-game, fetches actual scores from Odds API results endpoint, calls `settleProjectionEntry()`
- **New dashboard endpoint:** `GET /api/soccer/model-health` → returns `getProjectionWinRates()` + CLV summary

### 3.6 Phase 5 — Shot + Saves Prop Model

- **Player shots on target:** xG → expected shot volume using league-average conversion rates. Adjust for opponent defensive strength (`shots_against_pg / league_avg`).
- **Goalkeeper saves:** opponent xG → expected shots faced → expected saves (using starter save percentage from NHL shots model pattern).
- Both markets use the same `BaseProjector` pattern from `projection_engine.py` — rolling average + matchup adjustment + confidence scoring.
- Promote to Tier 1 when a real Odds API line exists AND `win_rate` from `projection_perf_ledger >= 54%` over 30+ settled plays.

---

## 4. Implementation Checklist

### 4.1 New Files Required

| File | Purpose | Phase |
|------|---------|-------|
| `apps/worker/src/jobs/pull_soccer_xg_stats.js` | Pull FBref xG data, populate soccer_team_xg_cache | PHASE1 |
| `packages/models/src/xg-model.js` | Poisson model, win prob computation, league params | PHASE1 |
| `apps/worker/src/jobs/settle_soccer_clv.js` | Post-game closing line capture for Tier 1 cards | PHASE2 |
| `apps/worker/src/jobs/settle_soccer_projections.js` | Post-game result settlement for Tier 2 cards | PHASE2 |

### 4.2 Modified Files

| File | Change | Phase |
|------|--------|-------|
| `run_soccer_model.js` | Replace circular `edge_ev` with xG `model_prob` diff. Add `league_tag` to payloadData. Add `model_confidence` field. | PHASE2 |
| `run_soccer_model.js` | Apply league-specific thresholds. Add away-win hard cap. Route through SPORT_MARKET_THRESHOLDS_V2. | PHASE3 |
| `run_soccer_model.js` | Add CLV and projection telemetry calls on card insert. | PHASE2 |
| `decision-pipeline-v2.js` | Add EPL/MLS/UCL sub-keys to SPORT_MARKET_THRESHOLDS. Already patched via flags. | PHASE3 |
| `db.js` | Add `soccer_team_xg_cache` table schema + CRUD functions. | PHASE1 |
| `pull_soccer_player_props.js` | Add `goalkeeper_saves` prop type fetch from Odds API `player_goalie_saves` market. | PHASE3 |

### 4.3 New DB Tables

| Table | Key columns | Phase |
|-------|-------------|-------|
| `soccer_team_xg_cache` | sport, league, team_name, home_xg_l6, away_xg_l6, fetched_at, cache_date | PHASE1 |
| `clv_ledger` | Already built in `db-telemetry.js` — needs `ENABLE_CLV_LEDGER=true` | NOW |
| `projection_perf_ledger` | Already built in `db-telemetry.js` — needs `ENABLE_PROJECTION_PERF_LEDGER=true` | NOW |

### 4.4 Feature Flag Rollout

| Flag | Enable when | Effect |
|------|-------------|--------|
| `ENABLE_DECISION_BASIS_TAGS` | Phase 0 (now) | Soccer Track 2 cards marked `execution_eligible: false` |
| `ENABLE_PROJECTION_PERF_LEDGER` | Phase 0 (now) | Track 2 cards written to `projection_perf_ledger` |
| `ENABLE_SOCCER_XG_MODEL` | Phase 1 | Run xG Poisson model instead of vig removal for `edge_ev` |
| `ENABLE_MARKET_THRESHOLDS_V2` | Phase 3 | League-specific edge thresholds applied |
| `ENABLE_CLV_LEDGER` | Phase 2 | Tier 1 soccer cards tracked in CLV ledger |
| `ENABLE_SOCCER_AWAY_WIN_CAP` | Phase 3 | Away wins blocked unless edge > league threshold |

---

## 5. Success Metrics — How to Know It's Working

### 5.1 Phase 1 Complete When

- ✅ `soccer_team_xg_cache` populated for all EPL, MLS, UCL teams before each model run
- ✅ `xg-model.js` unit tests pass: Poisson PMF accurate to 4 decimal places, win prob sums to 1.0, league adjustments applied correctly
- ✅ `model_confidence` field present in all Tier 1 soccer `payloadData`: FULL for >80% of EPL games

### 5.2 Phase 2 Complete When

- ✅ `edge_ev` in `soccer_ml` cards reflects `model_prob - implied_prob` (not vig removal)
- ✅ Edge distribution is no longer always-positive — approximately 40-60% of cards should have negative edge (those are correctly filtered to PASS)
- ✅ CLV ledger receiving entries for all Tier 1 soccer cards
- ✅ AWAY side cards appear at much lower rate than HOME side cards

### 5.3 Phase 3 Complete When

- ✅ EPL, MLS, UCL cards have different `edge_pct` thresholds visible in `decision_v2`
- ✅ Away-win cards appear only when edge > league threshold — validated by checking `card_payloads` for away `soccer_ml` over a 2-week window
- ✅ `model_health` API endpoint returns win rates by league and market type

### 5.4 Phase 4 Complete When

- ✅ CLV summary shows average CLV > 0 for home ML picks over 50+ settled games (this is the fundamental proof that xG finds value)
- ✅ `projection_perf_ledger` win rate for Track 2 player shots >= 50% over 30+ plays
- ✅ Recalibration flag not triggered on any market for 4+ consecutive weeks

### 5.5 Long-Term North Star Metrics

| Metric | Minimum acceptable | Target | Elite |
|--------|---|---|---|
| Home ML CLV (avg) | +0.5% | +1.5% | +3.0% |
| Game total win rate | 53% | 55% | 57% |
| Player shots win rate | 52% | 54% | 56% |
| Away ML card rate | <15% of all ML cards | <10% | <8% |
| Model confidence FULL rate | >70% of cards | >85% | >90% |
