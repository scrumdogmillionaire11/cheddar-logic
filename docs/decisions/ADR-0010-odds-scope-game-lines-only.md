# ADR-0010: Odds Usage Scope — Game Lines Only

- Status: Accepted
- Date: 2026-04-05
- Decision Makers: lane/data-platform, lane/worker-models

## Context

Cheddar Logic operates under a constrained Odds API token budget (20,000 tokens/
month normal; emergency-restricted to 2,000 in April 2026). The platform surfaces
two categories of betting analysis:

1. **Game Lines** — full-game totals, spreads, moneylines (e.g., NHL puck line,
   NBA spread, MLB full-game total, NFL spread)
2. **Player Props / Game Props** — per-player or per-period markets (e.g., NHL
   shots on goal, NHL blocked shots, MLB pitcher strikeouts, NBA player points)

The Odds API bulk endpoint (`/v4/sports/{sport}/odds`) returns game-level markets
efficiently at 1 token per sport per call. Per-event endpoints
(`/v4/sports/{sport}/events/{id}/odds?markets=...`) are required for prop markets
and cost 1 token **per game per market type**, making full odds coverage for all
player props prohibitively expensive at current budget levels.

Additionally, player prop market efficiency is lower and line availability is
inconsistent across bookmakers and game slates. Running a projection-only model
for props produces cards with known accuracy that can be evaluated against
settlement results without depending on real-time line movement.

## Decision

**Odds data (live bookmaker lines and pricing) is used exclusively for Game Lines.**

Player props and game props across all sports (NHL, MLB, NBA, NFL, Soccer, FPL,
or any future sport) are **projection-only**. No live odds are fetched, stored,
or used as inputs for player prop or game prop card decisions.

### Scope by card type

| Card Type | Sport | Odds Used | Mode |
| --------- | ----- | --------- | ---- |
| Full-game total | NHL, NBA, MLB, NFL | ✅ Yes | `ODDS_BACKED` |
| Spread / puck line | NHL, NBA, NFL | ✅ Yes | `ODDS_BACKED` |
| Moneyline | MLB (F5), NBA | ✅ Yes | `ODDS_BACKED` |
| 1st-period total | NHL | ✅ Yes (when `NHL_1P_ODDS_ENABLED=true`) | `ODDS_BACKED` |
| Shots on goal (SOG) | NHL | ❌ No | `PROJECTION_ONLY` |
| Blocked shots (BLK) | NHL | ❌ No | `PROJECTION_ONLY` |
| Pitcher strikeouts (K) | MLB | ❌ No | `PROJECTION_ONLY` |
| Player points / rebounds | NBA | ❌ No | `PROJECTION_ONLY` |
| xG / player goals | Soccer | ❌ No | `PROJECTION_ONLY` |
| FPL expected points | FPL | ❌ No | `PROJECTION_ONLY` |
| Any future player prop | Any | ❌ No | `PROJECTION_ONLY` |

### Where this surfaces in the UI

- **`/cards` → Game Lines tab**: odds-backed cards. Live prices displayed.
- **`/cards` → Player Props tab** (NHL SOG/BLK, MLB pitcher K): projection-only
  cards. No odds displayed. Confidence expressed via model projection spread, not
  price.
- **`/results` → Projections section**: settlement accuracy metrics for
  projection-only models. No P&L in expected-value terms — accuracy % only.

### Implementation rules

1. **Worker models**: `PITCHER_KS_MODEL_MODE` is hard-locked to `PROJECTION_ONLY`
   in `resolvePitcherKsMode()`. Setting the env var has no effect (by design).
   This ADR formalizes why.

2. **Per-event odds endpoints** (`pull_nhl_1p_odds.js`, any future prop odds job):
   these are gated behind explicit opt-in env vars (e.g., `NHL_1P_ODDS_ENABLED`)
   and apply **only to game-level period markets**, not to player prop markets.

3. **Player prop schedulers** (`schedulers/player-props.js`): must never add an
   odds-fetch step for a prop market. If a prop model is upgraded to use live
   odds in the future, a new ADR is required first.

4. **Card payloads for projection-only cards**: must carry `model_mode:
   'PROJECTION_ONLY'` and must not include `odds_snapshot_id`,
   `bookmaker_price_over`, or `bookmaker_price_under` fields. Settlement uses
   actual result vs projection line — not odds-implied probability.

5. **Token budget**: odds fetches are budgeted only for game-line markets. Adding
   any per-event prop odds pull requires explicit budget analysis and ADR update.

## Consequences

**Positive:**

- Token budget is predictable and controlled. Game-line coverage is always
  funded; prop coverage never competes for that budget.
- Player prop model development is independent of odds availability. Models can
  be built, tested, and deployed without waiting for prop market liquidity.
- Settlement for props is clean: projection vs actual result, no price-to-
  probability conversion required.

**Negative:**

- Player prop cards cannot be presented with live market odds or edge %. The UI
  must clearly communicate "projection" framing rather than "value bet" framing.
- If a bookmaker consistently offers mispriced prop lines, this system will not
  detect or surface it.
- Future extension to odds-backed props requires a dedicated per-event token
  budget, scheduler changes, and a new ADR.

## References

- `apps/worker/src/jobs/run_mlb_model.js` — `resolvePitcherKsMode()`
- `apps/worker/src/schedulers/player-props.js` — player prop scheduler (no odds
  fetch)
- `apps/worker/src/jobs/pull_nhl_1p_odds.js` — 1P period markets (game-level,
  not player props)
- `packages/models/src/market-contract.js` — card type registry
- ADR-0007: MLB F5 Full Model Projection Contract
- ADR-0008: MLB Pitcher K Distribution Contract
