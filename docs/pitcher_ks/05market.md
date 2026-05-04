# 05 — Projection-only posture contract

## Rule

Current runtime does not publish a verified pitcher-K line/price contract, so pitcher-K output is strictly projection intelligence. The model converts `k_mean` into fair ladder probabilities and then assigns a non-executable posture from three deterministic inputs:

- pitcher K baseline
- opponent K factor versus handedness
- projected innings / leash bucket

No live odds dependency exists in this step.

---

## Hard rule

Until a separate work item introduces a verified user-provided line/price path, every `mlb-pitcher-k` row must remain:

- `basis: 'PROJECTION_ONLY'`
- `prediction/status/action/classification: 'PASS'`
- `status_cap: 'PASS'` or stricter
- `pass_reason_code: 'PASS_PROJECTION_ONLY_NO_MARKET'`
- `line`, `line_source`, `over_price`, `under_price`, `best_line_bookmaker`, `margin`: null/omitted

The engine must never emit `PLAY` for pitcher-K from model-only output.

---

## Allowed posture labels

Every row must carry exactly one posture label:

- `OVER_CANDIDATE`
- `UNDER_CANDIDATE`
- `UNDER_LEAN_ONLY`
- `NO_EDGE_ZONE`
- `TRAP_FLAGGED`
- `DATA_UNTRUSTED`

Posture is descriptive only. It is not an execution instruction.

---

## Deterministic posture logic

Each of the three projection inputs is bucketed as `OVER_SUPPORT`, `UNDER_SUPPORT`, or `NEUTRAL`.

### Pitcher K baseline

- `OVER_SUPPORT` when starter K% is at or above 27.0%
- `UNDER_SUPPORT` when starter K% is at or below 23.5%
- otherwise `NEUTRAL`

### Opponent K factor

`opponent_k_factor = opp_k_pct_vs_hand / league_avg_k_pct`

- `OVER_SUPPORT` when factor is at or above `1.05`
- `UNDER_SUPPORT` when factor is at or below `0.97`
- otherwise `NEUTRAL`

### Projected innings / leash bucket

- `OVER_SUPPORT` when projected IP is at or above `5.75`
- `UNDER_SUPPORT` when projected IP is at or below `5.0`
- otherwise `NEUTRAL`

### Final posture

- `DATA_UNTRUSTED` if the row is synthetic fallback or the leash context is structurally untrusted (`IL_RETURN`, `EXTENDED_REST`, opener/bulk role)
- `TRAP_FLAGGED` if two or more trap flags are active
- `UNDER_CANDIDATE` if at least 2 inputs support under and 0 support over
- `UNDER_LEAN_ONLY` if at least 2 inputs support under and exactly 1 supports over
- `OVER_CANDIDATE` if at least 2 inputs support over and 0 support under
- otherwise `NO_EDGE_ZONE`

No posture may be assigned from a single input alone.

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

These fair prices remain research output only until a verified line/price input exists.
