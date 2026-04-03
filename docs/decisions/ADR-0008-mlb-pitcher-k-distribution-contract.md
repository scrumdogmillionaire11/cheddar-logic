# ADR-0008: MLB Pitcher-K Projection-Only Distribution Contract

## Status
Accepted

## Context
MLB pitcher strikeout cards were previously shaped like an odds-backed over/under market, but live prop pulls from The Odds API were removed to stop event-level token burn. That left the model contract ambiguous: some code/docs still implied a live line comparison path, while runtime cards were already mostly projection-only.

The implementation also used a K/9-style projection path, which hides the actual interaction that matters most for strikeout props: expected batters faced multiplied by pitcher strikeout skill and opponent strikeout tendency against pitcher handedness.

## Decision
MLB pitcher-K runtime output is `PROJECTION_ONLY` only until a separate free-line sourcing work item ships.

The active projection contract is:

```text
bf_exp = projected_ip * batters_per_inning
k_interaction = starter_k_pct * opp_k_pct_vs_hand / league_avg_k_pct
k_mean = bf_exp * k_interaction * k_leash_mult
```

Runtime cards must also emit a Poisson tail ladder from `k_mean`:

- `P(5+)`
- `P(6+)`
- `P(7+)`

Each ladder point must have a fair American price, and the card should expose playability thresholds derived from those fair prices.

Because there is no live line in the current runtime contract, pitcher-K cards are non-actionable market rows:

- `basis = 'PROJECTION_ONLY'`
- `tags` includes `no_odds_mode`
- `prediction = 'PASS'`
- `status = 'PASS'`
- `action = 'PASS'`
- `classification = 'PASS'`
- `status_cap = 'PASS'`
- `ev_passed = false`
- `line`, `line_source`, `over_price`, `under_price`, `best_line_bookmaker`, and `margin` are null or omitted

Missing or degraded inputs do not produce synthetic plays. They produce PASS rows with diagnostics:

- `projection_source = FULL_MODEL | DEGRADED_MODEL | SYNTHETIC_FALLBACK`
- `missing_inputs = string[]`
- `reason_codes` includes `PASS_PROJECTION_ONLY_NO_MARKET` and any `MISSING_INPUT:*` or `DEGRADED_INPUT:*` tags

Legacy `ODDS_BACKED` payloads remain validator-compatible for historical rows, but active worker runtime must not emit them.

## Consequences
- MLB pitcher-K rows remain visible in the Props tab as a research/projection lane, but they cannot be treated as executable betting recommendations.
- Fair-price and Poisson ladder metadata are now available for future line-shopping/scraping work without changing the core projection math again.
- Any attempt to restore live MLB pitcher-K line comparison must go through a separate WI + ADR and must not rely on paid Odds API prop pulls by default.
