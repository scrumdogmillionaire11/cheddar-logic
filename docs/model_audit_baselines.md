# Model Audit Baselines

## Purpose

These baseline traces are synthetic examples for deterministic audit review. Each example uses a single `GAME_ID` across all five stages so a reviewer can trace exactly where drift appears or does not appear.

## NBA Baseline

`GAME_ID: nba-20260401-bos-nyk`

### INPUT

```json
{
  "game_id": "nba-20260401-bos-nyk",
  "sport": "NBA",
  "market_type": "TOTAL",
  "line": 224.5,
  "price_over": -110,
  "price_under": -110,
  "book": "consensus",
  "captured_at": "2026-04-01T14:00:00Z"
}
```

### ENRICHED_INPUT

```json
{
  "game_id": "nba-20260401-bos-nyk",
  "sport": "NBA",
  "market_type": "TOTAL",
  "line": 224.5,
  "price_over": -110,
  "price_under": -110,
  "book": "consensus",
  "captured_at": "2026-04-01T14:00:00Z",
  "normalized_market_type": "TOTAL",
  "team_mapping_ok": true,
  "watchdog_inputs_ready": true,
  "consistency": {
    "pace_tier": "HIGH",
    "event_env": "INDOOR",
    "event_direction_tag": "FAVOR_OVER",
    "vol_env": "STABLE",
    "total_bias": "OK"
  }
}
```

### MODEL_OUTPUT

```json
{
  "game_id": "nba-20260401-bos-nyk",
  "sport": "NBA",
  "market_type": "TOTAL",
  "projection_total": 226.0,
  "fair_prob_over": 0.54,
  "implied_prob_over": 0.52,
  "fair_price_over": -117,
  "drivers": ["PACE_EDGE", "REST_EDGE"],
  "support_score": 0.63,
  "conflict_score": 0.18
}
```

### DECISION_OUTPUT

```json
{
  "game_id": "nba-20260401-bos-nyk",
  "card_type": "nba-total-call",
  "market_type": "TOTAL",
  "classification": "PLAY",
  "official_status": "PLAY",
  "execution_status": "EXECUTABLE",
  "reason_codes": ["EDGE_CLEAR"],
  "decision_v2": {
    "official_status": "PLAY",
    "play_tier": "GOOD",
    "primary_reason_code": "EDGE_CLEAR",
    "watchdog_status": "OK",
    "watchdog_reason_codes": [],
    "fair_prob": 0.54,
    "implied_prob": 0.52
  }
}
```

### PUBLISH_OUTPUT

```json
{
  "game_id": "nba-20260401-bos-nyk",
  "card_type": "nba-total-call",
  "market_type": "TOTAL",
  "classification": "PLAY",
  "official_status": "PLAY",
  "execution_status": "EXECUTABLE",
  "reason_codes": ["EDGE_CLEAR"],
  "decision_v2": {
    "official_status": "PLAY",
    "play_tier": "GOOD",
    "primary_reason_code": "EDGE_CLEAR",
    "watchdog_status": "OK",
    "watchdog_reason_codes": [],
    "fair_prob": 0.54,
    "implied_prob": 0.52
  },
  "generated_at": "2026-04-01T14:01:02Z",
  "run_id": "run-wi0718-demo-001"
}
```

Audit read:

- Raw values were preserved from `INPUT` to `ENRICHED_INPUT`.
- `MODEL_OUTPUT` stayed math-only.
- Strict decision fields did not change between decision and publish.
- Covered tolerant fields: NBA `projection_total`, probabilities, fair price.

## NHL Baseline

`GAME_ID: nhl-20260401-nyr-bos`

### INPUT

```json
{
  "game_id": "nhl-20260401-nyr-bos",
  "sport": "NHL",
  "market_type": "TOTAL",
  "line": 5.5,
  "price_over": -105,
  "price_under": -115,
  "book": "consensus",
  "captured_at": "2026-04-01T16:00:00Z"
}
```

### ENRICHED_INPUT

```json
{
  "game_id": "nhl-20260401-nyr-bos",
  "sport": "NHL",
  "market_type": "TOTAL",
  "line": 5.5,
  "price_over": -105,
  "price_under": -115,
  "book": "consensus",
  "captured_at": "2026-04-01T16:00:00Z",
  "normalized_market_type": "TOTAL",
  "team_mapping_ok": true,
  "consistency": {
    "pace_tier": "LOW",
    "event_env": "INDOOR",
    "event_direction_tag": "FAVOR_OVER",
    "vol_env": "STABLE",
    "total_bias": "OK"
  },
  "tags": ["GOALIE_CONFIRMED"]
}
```

### MODEL_OUTPUT

```json
{
  "game_id": "nhl-20260401-nyr-bos",
  "sport": "NHL",
  "market_type": "TOTAL",
  "projection_total": 5.75,
  "fair_prob_over": 0.53,
  "implied_prob_over": 0.51,
  "fair_price_over": -113,
  "drivers": ["PACE_EDGE", "GOALIE_FORM"],
  "support_score": 0.61,
  "conflict_score": 0.12
}
```

### DECISION_OUTPUT

```json
{
  "game_id": "nhl-20260401-nyr-bos",
  "card_type": "nhl-total-call",
  "market_type": "TOTAL",
  "classification": "LEAN",
  "official_status": "LEAN",
  "execution_status": "EXECUTABLE",
  "reason_codes": ["PLAY_REQUIRES_FRESH_MARKET"],
  "decision_v2": {
    "official_status": "LEAN",
    "play_tier": "OK",
    "primary_reason_code": "PLAY_REQUIRES_FRESH_MARKET",
    "watchdog_status": "CAUTION",
    "watchdog_reason_codes": ["WATCHDOG_STALE_SNAPSHOT"],
    "fair_prob": 0.53,
    "implied_prob": 0.51
  }
}
```

### PUBLISH_OUTPUT

```json
{
  "game_id": "nhl-20260401-nyr-bos",
  "card_type": "nhl-total-call",
  "market_type": "TOTAL",
  "classification": "LEAN",
  "official_status": "LEAN",
  "execution_status": "EXECUTABLE",
  "reason_codes": ["PLAY_REQUIRES_FRESH_MARKET"],
  "decision_v2": {
    "official_status": "LEAN",
    "play_tier": "OK",
    "primary_reason_code": "PLAY_REQUIRES_FRESH_MARKET",
    "watchdog_status": "CAUTION",
    "watchdog_reason_codes": ["WATCHDOG_STALE_SNAPSHOT"],
    "fair_prob": 0.53,
    "implied_prob": 0.51
  },
  "generated_at": "2026-04-01T16:01:05Z",
  "run_id": "run-wi0718-demo-002"
}
```

Audit read:

- `projection_total` uses the NHL totals tolerance of `±0.25`.
- `watchdog_status=CAUTION` is valid and remains unchanged through publish.
- No post-decision mutation occurred.

## MLB Baseline

`GAME_ID: mlb-20260401-lad-sd`

### INPUT

```json
{
  "game_id": "mlb-20260401-lad-sd",
  "sport": "MLB",
  "market_type": "MONEYLINE",
  "price_home": -128,
  "price_away": 114,
  "book": "consensus",
  "captured_at": "2026-04-01T18:00:00Z"
}
```

### ENRICHED_INPUT

```json
{
  "game_id": "mlb-20260401-lad-sd",
  "sport": "MLB",
  "market_type": "MONEYLINE",
  "price_home": -128,
  "price_away": 114,
  "book": "consensus",
  "captured_at": "2026-04-01T18:00:00Z",
  "normalized_market_type": "MONEYLINE",
  "team_mapping_ok": true,
  "consistency": {
    "pace_tier": "UNKNOWN",
    "event_env": "UNKNOWN",
    "event_direction_tag": "FAVOR_HOME",
    "vol_env": "STABLE",
    "total_bias": "UNKNOWN"
  },
  "tags": ["MLB_LOWER_ENFORCEMENT_MATURITY"]
}
```

### MODEL_OUTPUT

```json
{
  "game_id": "mlb-20260401-lad-sd",
  "sport": "MLB",
  "market_type": "MONEYLINE",
  "fair_prob_home": 0.58,
  "implied_prob_home": 0.56,
  "fair_price_home": -138,
  "drivers": ["STARTER_EDGE", "BULLPEN_EDGE"],
  "support_score": 0.59,
  "conflict_score": 0.16
}
```

### DECISION_OUTPUT

```json
{
  "game_id": "mlb-20260401-lad-sd",
  "card_type": "mlb-moneyline-call",
  "market_type": "MONEYLINE",
  "classification": "LEAN",
  "official_status": "LEAN",
  "execution_status": "EXECUTABLE",
  "reason_codes": ["EDGE_CLEAR"],
  "decision_v2": {
    "official_status": "LEAN",
    "play_tier": "OK",
    "primary_reason_code": "EDGE_CLEAR",
    "watchdog_status": "OK",
    "watchdog_reason_codes": [],
    "fair_prob": 0.58,
    "implied_prob": 0.56
  }
}
```

### PUBLISH_OUTPUT

```json
{
  "game_id": "mlb-20260401-lad-sd",
  "card_type": "mlb-moneyline-call",
  "market_type": "MONEYLINE",
  "classification": "LEAN",
  "official_status": "LEAN",
  "execution_status": "EXECUTABLE",
  "reason_codes": ["EDGE_CLEAR"],
  "decision_v2": {
    "official_status": "LEAN",
    "play_tier": "OK",
    "primary_reason_code": "EDGE_CLEAR",
    "watchdog_status": "OK",
    "watchdog_reason_codes": [],
    "fair_prob": 0.58,
    "implied_prob": 0.56
  },
  "generated_at": "2026-04-01T18:01:08Z",
  "run_id": "run-wi0718-demo-003"
}
```

Audit read:

- MLB uses the same five stages and strict-field rules.
- This example intentionally avoids claiming NBA/NHL hard-cut parity; it demonstrates audit vocabulary and comparison shape only.
- Covered tolerant fields here are probabilities and fair price, not sport-specific projection tolerance.

## Negative Example: Illegal Post-Decision Rewrite

`GAME_ID: nhl-20260401-bad-publish-rewrite`

### INPUT

```json
{
  "game_id": "nhl-20260401-bad-publish-rewrite",
  "sport": "NHL",
  "market_type": "TOTAL",
  "line": 5.5,
  "price_over": -120,
  "price_under": 100,
  "captured_at": "2026-04-01T19:00:00Z"
}
```

### ENRICHED_INPUT

```json
{
  "game_id": "nhl-20260401-bad-publish-rewrite",
  "sport": "NHL",
  "market_type": "TOTAL",
  "line": 5.5,
  "price_over": -120,
  "price_under": 100,
  "captured_at": "2026-04-01T19:00:00Z",
  "normalized_market_type": "TOTAL",
  "consistency": {
    "pace_tier": "LOW",
    "event_env": "INDOOR",
    "event_direction_tag": "FAVOR_UNDER",
    "vol_env": "STABLE",
    "total_bias": "OK"
  }
}
```

### MODEL_OUTPUT

```json
{
  "game_id": "nhl-20260401-bad-publish-rewrite",
  "sport": "NHL",
  "market_type": "TOTAL",
  "projection_total": 5.1,
  "fair_prob_under": 0.49,
  "implied_prob_under": 0.52,
  "fair_price_under": 104,
  "drivers": ["NO_EDGE"],
  "support_score": 0.39,
  "conflict_score": 0.22
}
```

### DECISION_OUTPUT

```json
{
  "game_id": "nhl-20260401-bad-publish-rewrite",
  "card_type": "nhl-total-call",
  "market_type": "TOTAL",
  "classification": "PASS",
  "official_status": "PASS",
  "execution_status": "PROJECTION_ONLY",
  "reason_codes": ["NO_VALUE_AT_PRICE"],
  "decision_v2": {
    "official_status": "PASS",
    "play_tier": "BAD",
    "primary_reason_code": "NO_VALUE_AT_PRICE",
    "watchdog_status": "OK",
    "watchdog_reason_codes": []
  }
}
```

### PUBLISH_OUTPUT

```json
{
  "game_id": "nhl-20260401-bad-publish-rewrite",
  "card_type": "nhl-total-call",
  "market_type": "TOTAL",
  "classification": "PLAY",
  "official_status": "PLAY",
  "execution_status": "EXECUTABLE",
  "reason_codes": ["EDGE_CLEAR"],
  "decision_v2": {
    "official_status": "PLAY",
    "play_tier": "GOOD",
    "primary_reason_code": "EDGE_CLEAR",
    "watchdog_status": "OK",
    "watchdog_reason_codes": []
  },
  "generated_at": "2026-04-01T19:01:10Z",
  "publish_override_reason": "ui-repair-heuristic"
}
```

Audit classification:

- `PUBLISH_DRIFT`: strict decision fields changed between `DECISION_OUTPUT` and `PUBLISH_OUTPUT`.
- `SPEC_DRIFT`: `publish_override_reason` introduced an undocumented decision-mutating field on the publish boundary.

Why this fails:

- `classification` changed from `PASS` to `PLAY`.
- `official_status` changed from `PASS` to `PLAY`.
- `execution_status` changed from `PROJECTION_ONLY` to `EXECUTABLE`.
- `reason_codes` changed from `NO_VALUE_AT_PRICE` to `EDGE_CLEAR`.
- Publish performed an illegal post-decision rewrite after `publishDecisionForCard`.
