# Model Audit Drift Reason Codes

## Purpose

This document defines the canonical drift categories for the cross-sport audit framework. Each category has a stage boundary, trigger rule, interpretation, and owning fault domain. These codes are observational in WI-0718: they classify and attribute drift, but they do not yet halt publish.

## Severity Ordering

From highest to lowest operational urgency:

1. `DECISION_DRIFT`
2. `PUBLISH_DRIFT`
3. `SPEC_DRIFT`
4. `INPUT_SHAPE_DRIFT`
5. `MODEL_DRIFT`
6. `PERFORMANCE_DRIFT`

## Canonical Drift Classes

### `SPEC_DRIFT`

**Stage boundary:** Any audited stage boundary.

**Trigger rule:**

- A required field is missing.
- A new non-ignored field appears unexpectedly.
- A field changes type.
- A field moves from a previously documented class into an undocumented shape.

**Allowed?** No.

**Owning fault domain:** The first layer that emitted the shape mismatch.

Example:

```json
{
  "before": {
    "classification": "PASS",
    "reason_codes": ["STALE_MARKET_INPUT"]
  },
  "after": {
    "classification": ["PLAY"],
    "reason_codes": "EDGE_CLEAR"
  }
}
```

This is `SPEC_DRIFT` because `classification` changed from string to array and `reason_codes` changed from array to string.

### `INPUT_SHAPE_DRIFT`

**Stage boundary:** `INPUT` -> `ENRICHED_INPUT`

**Trigger rule:**

- Any raw input field captured in `INPUT` changes value in `ENRICHED_INPUT`.
- Any required raw field disappears before the model stage.

**Allowed?** No.

**Owning fault domain:** Input normalization, enrichment, or ingestion.

Example:

```json
{
  "input": {
    "line": 224.5,
    "price_over": -110
  },
  "enriched_input": {
    "line": 223.5,
    "price_over": -110
  }
}
```

This is `INPUT_SHAPE_DRIFT` because enrichment changed a raw market line instead of adding derived context alongside it.

### `MODEL_DRIFT`

**Stage boundary:** `MODEL_OUTPUT` compared against a baseline or prior run.

**Trigger rule:**

- A tolerant field exceeds its documented numeric threshold.
- A pure model field changes enough to alter the tolerated math envelope.
- A decision field appears in `MODEL_OUTPUT`.

**Allowed?**

- Within tolerance: yes.
- Beyond tolerance: no.

**Owning fault domain:** Model, projection, or pricing logic.

Example:

```json
{
  "field": "projection_total",
  "sport": "NBA",
  "before": 226.0,
  "after": 227.4,
  "tolerance": 1.0
}
```

This is `MODEL_DRIFT` because the delta is `1.4`, which exceeds the allowed NBA totals threshold.

### `DECISION_DRIFT`

**Stage boundary:** `DECISION_OUTPUT` compared against another decision snapshot for the same candidate or run baseline.

**Trigger rule:** Any change to strict decision-authoritative fields, including:

- `classification`
- `official_status`
- `execution_status`
- `reason_codes`
- `card_type`
- `market_type`
- `decision_v2.primary_reason_code`
- `decision_v2.play_tier`

**Allowed?** No.

**Owning fault domain:** Decision layer.

Example:

```json
{
  "before": {
    "classification": "LEAN",
    "official_status": "LEAN",
    "reason_codes": ["PLAY_REQUIRES_FRESH_MARKET"]
  },
  "after": {
    "classification": "PLAY",
    "official_status": "PLAY",
    "reason_codes": ["EDGE_CLEAR"]
  }
}
```

This is `DECISION_DRIFT` because decision meaning changed after the model stage and before publish.

### `PUBLISH_DRIFT`

**Stage boundary:** `DECISION_OUTPUT` -> `PUBLISH_OUTPUT`

**Trigger rule:**

- Any strict field differs between decision and published payload.
- A downstream transform upgrades or downgrades decision meaning.
- Publish-side repair logic reclassifies a row after `publishDecisionForCard`.

**Allowed?** No.

**Owning fault domain:** Publish path, write adapter, downstream repair, or read-surface mutation.

Example:

```json
{
  "decision_output": {
    "classification": "PASS",
    "official_status": "PASS"
  },
  "publish_output": {
    "classification": "PLAY",
    "official_status": "PLAY"
  }
}
```

This is `PUBLISH_DRIFT` because publish altered decision truth after the authoritative boundary.

### `PERFORMANCE_DRIFT`

**Stage boundary:** Rolling-window outcome review after publication and settlement.

**Trigger rule:**

- Aggregate quality metrics degrade materially over a rolling window.
- Review must use a minimum sample size of **30 settled rows per sport + market + period bucket** before classifying drift.
- The comparison window and baseline window must use the same bucket definition.

**Allowed?** Investigate; not automatically a contract violation unless it correlates to one of the structural drift classes above.

**Owning fault domain:** Model by default, unless the degradation can be traced to an earlier structural drift category.

Example:

```json
{
  "bucket": "NBA|TOTAL|FULL_GAME",
  "sample_size": 42,
  "baseline_roi": 0.081,
  "current_roi": -0.034
}
```

This is `PERFORMANCE_DRIFT` because the sample size is large enough and the rolling-window quality degraded.

## Trigger Summary Table

| Drift Code | Boundary | Trigger | Allowed | Owner |
| --- | --- | --- | --- | --- |
| `SPEC_DRIFT` | Any | Missing field, new field, or type change | No | First emitting layer |
| `INPUT_SHAPE_DRIFT` | `INPUT` -> `ENRICHED_INPUT` | Raw input changed | No | Input / enrichment |
| `MODEL_DRIFT` | `MODEL_OUTPUT` vs baseline | Tolerant field outside bounds or forbidden decision field appears | No | Model |
| `DECISION_DRIFT` | `DECISION_OUTPUT` vs decision baseline | Strict decision field changed | No | Decision |
| `PUBLISH_DRIFT` | `DECISION_OUTPUT` -> `PUBLISH_OUTPUT` | Published payload diverges on strict field | No | Publish |
| `PERFORMANCE_DRIFT` | Rolling settled outcomes | Quality degraded with sample size >= 30 | Investigate | Model unless re-attributed |

## Attribution Rules

Use the following order:

1. Find the earliest stage boundary where the contract fails.
2. Apply the matching drift code.
3. Attribute ownership to that boundary's emitting layer.
4. Only apply a later drift code if earlier boundaries still hold.

This prevents downstream symptoms from hiding the real origin.

## Allowed vs Not Allowed Summary

- `SPEC_DRIFT`: never allowed
- `INPUT_SHAPE_DRIFT`: never allowed
- `MODEL_DRIFT`: allowed only within documented numeric tolerances
- `DECISION_DRIFT`: never allowed
- `PUBLISH_DRIFT`: never allowed
- `PERFORMANCE_DRIFT`: not automatically illegal, but it is operationally actionable when the minimum sample rule is met

## Notes For Later Enforcement WIs

Because this WI is observational only:

- Audits classify drift without halting writes.
- `DECISION_DRIFT` and `PUBLISH_DRIFT` should be treated as red-alert classes in dashboards and review packets.
- Blocking behavior, if added later, must reuse the exact stage boundaries and triggers defined here rather than inventing new meanings for the same codes.
