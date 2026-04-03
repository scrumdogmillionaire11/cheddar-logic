# 05 — Fair thresholds and no-line PASS policy

## Rule

Current runtime does not ingest a live pitcher-K line, so there is no executable margin calculation. Instead, the engine converts `k_mean` into Poisson tail probabilities and fair American prices, then derives a pair of research thresholds that indicate where an over or under would become playable if a verified line source is added later.

---

## Hard rule

Until a separate free-line sourcing WI restores verified standard + alt lines, every `mlb-pitcher-k` row must remain:

- `basis: 'PROJECTION_ONLY'`
- `prediction/status/action/classification: 'PASS'`
- `status_cap: 'PASS'`
- `pass_reason_code: 'PASS_PROJECTION_ONLY_NO_MARKET'`
- `line`, `line_source`, `over_price`, `under_price`, `best_line_bookmaker`, `margin`: null/omitted

---

## Probability ladder

Poisson tails are computed from `k_mean`:

```text
P(5+) = 1 - CDF_poisson(4; k_mean)
P(6+) = 1 - CDF_poisson(5; k_mean)
P(7+) = 1 - CDF_poisson(6; k_mean)
```

---

## Fair-price conversion

Each probability is converted to a fair American price:

```python
def implied_probability_to_american(p):
    if p >= 0.5:
        return round(-100 * p / (1 - p))
    return round(100 * (1 - p) / p)
```

---

## Playability thresholds

```
over_playable_at_or_below  ≈ floor(k_mean - 0.5)
under_playable_at_or_above ≈ ceil(k_mean + 0.5)
```

These thresholds are not current recommendations. They only define where the projection would start to deserve an odds-backed check once a real line appears.

## Free line sourcing status

There is no clean free structured MLB pitcher-K odds API. A separate WI must evaluate DraftKings/FanDuel direct scraping first, with OddsTrader/OddsJam as secondary fallback candidates, and must define rate limits, parser health checks, and TOS risk before any runtime odds-backed mode is re-enabled.
