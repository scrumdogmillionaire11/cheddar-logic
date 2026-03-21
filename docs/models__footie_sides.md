# Soccer Sides Engine Contract (`FOOTIE_SIDES_ENGINE`)

## Scope

- Markets: `soccer_ml`, `asian_handicap_home`, `asian_handicap_away`
- Engine: side markets only (separate from Tier-1 soccer prop ingestion)
- Goal: model-derived side probabilities from team-stat lambdas, with market input used only as a stabilizer/fallback

## Inputs

`FootieSideModelInput`

- `game_id`, `home_team`, `away_team`, `league`
- `stats_home`, `stats_away` (xG for/against, recent form, shot profile where available)
- `lineup_context`, `motivation_context`, `weather_context`
- `market_context` (`h2h`, spreads, totals)
- `lambda_home`, `lambda_away` (resolved by `computeFootieLambdas`)
- `lambda_source`, `lambda_source_quality`

## Lambda Resolution

`computeFootieLambdas()` resolves in this order:

1. `STATS_PRIMARY`
- Team-stat lambdas from structured home/away stat blocks and/or explicit non-market lambda inputs.

2. `STATS_MARKET_BLEND`
- If stats lambdas and market signals both exist:
- `lambda_final = 0.75 * stats_lambda + 0.25 * market_implied_lambda`

3. `MARKET_FALLBACK`
- Used only when stats lambdas are unavailable and market signals are available.
- Explicitly tagged and quality-capped (`LOW`).

If no viable stats and no viable market signal: side output is blocked (`BLOCKED_NO_PRIMARY_LAMBDA` / PASS path).

## ML Probability Model

- Use Poisson scoreline enumeration (`computeXgWinProbs`) from resolved lambdas.
- Output:
- `p_home_win`, `p_draw`, `p_away_win`
- `fair_ml_home`, `fair_ml_draw`, `fair_ml_away`

Selection rule:

- Choose side from model (`max(p_home_win, p_away_win)`), not market favorite.
- Compute edge against de-vigged 2-way book probabilities.

## AH Pricing

- Keep existing AH pricing/grading engine (`priceAsianHandicap`) for quarter/half/full lines.
- Feed it resolved lambdas from `computeFootieLambdas()`.
- Required transparency fields on AH cards:
- `lambda_home`, `lambda_away`, `lambda_source`, `lambda_source_quality`
- `p_full_win`, `p_half_win`, `p_push`, `p_half_loss`, `p_full_loss`
- `fair_price`, `expected_value`, `reason_codes`

## Confidence + Risk Gates

Confidence components use input quality, not market separation:

- stats completeness
- lambda source quality
- lineup certainty
- stats/market disagreement penalty

Side risk guards:

- `BLOCKED_MARKET_FALLBACK_ONLY` (moneyline hard block when lambda source is fallback-only)
- `BLOCKED_NO_PRIMARY_LAMBDA`
- `BLOCKED_UNCONFIRMED_LINEUP`
- `BLOCKED_ML_DRAW_RISK_HIGH`
- `BLOCKED_CONTRADICTORY_SIDE_SIGNAL`
- `PASS_MISSING_EDGE`

## Invariants

- ML probabilities must include draw term and sum to ~1.
- `lambda_source` must always be explicit when side pricing runs.
- Market fallback cannot masquerade as primary stats modeling.
- Side cards must carry explicit reason codes for pass/guarded outcomes.
