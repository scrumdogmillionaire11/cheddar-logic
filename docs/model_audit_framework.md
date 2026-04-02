# Model Audit Framework

## Purpose

This document freezes the cross-sport audit contract for comparing two runs of the betting pipeline and answering three questions deterministically:

1. What changed?
2. Was the change allowed?
3. Which layer owns the fault: input, model, decision, or publish?

This audit contract extends existing runtime truth from [ADR-0004](./decisions/ADR-0004-decision-pipeline-v2-hard-cut.md) and [DATA_CONTRACTS](./DATA_CONTRACTS.md). It does not create a second decision system. The worker remains the sole decision authority, and web/API/UI remain pure consumers of worker-emitted `decision_v2` on hard-cut paths.

## Audit Mode

WI-0718 defines an **observational** audit. Drift is classified, attributed, and reported, but it does not block publish in this work item. Blocking behavior, if added later, must be defined in a follow-up work item.

## Existing Runtime Truth This Contract Extends

- `publishDecisionForCard` is the decisive boundary for worker-owned recommendation output.
- `decision_v2` remains the canonical decision object on hard-cut wave-1 paths.
- Watchdog owns runtime integrity, freshness, and consistency gating.
- Consistency fields define required environment and context completeness before publishable classification proceeds.
- `pipeline_state` is additive metadata only and must not mutate consumer-facing decision meaning.

Example reference shape from current runtime truth:

```json
{
  "decision_v2": {
    "watchdog_status": "OK",
    "official_status": "PLAY",
    "primary_reason_code": "EDGE_CLEAR",
    "pipeline_version": "v2"
  },
  "pipeline_state": {
    "projection_ready": true,
    "drivers_ready": true,
    "pricing_ready": true,
    "card_ready": true
  }
}
```

## Locked Audit Stages

### 1. INPUT

**Source of truth:** DB snapshot as loaded by the worker before enrichment.

**Allowed changes:** None. This stage is immutable raw input.

**Invariant:** No derived or synthesized fields are allowed here.

**Failure ownership:** Ingestion, parser, mapping, or snapshot capture.

Example:

```json
{
  "game_id": "nba-20260401-bos-nyk",
  "sport": "NBA",
  "market_type": "TOTAL",
  "book": "consensus",
  "line": 224.5,
  "price_over": -110,
  "price_under": -110,
  "captured_at": "2026-04-01T14:00:00Z"
}
```

### 2. ENRICHED_INPUT

**Source of truth:** Input plus enrichment, normalization, and tagging.

**Allowed changes:** Additive only.

**Invariant:** This stage may add fields, but it may not mutate raw values inherited from `INPUT`.

**Failure ownership:** Enrichment, normalization, tagging, or adapter logic.

If any raw input field changes here, the audit result is `INPUT_SHAPE_DRIFT`.

Example:

```json
{
  "game_id": "nba-20260401-bos-nyk",
  "sport": "NBA",
  "market_type": "TOTAL",
  "book": "consensus",
  "line": 224.5,
  "price_over": -110,
  "price_under": -110,
  "captured_at": "2026-04-01T14:00:00Z",
  "normalized_market_type": "TOTAL",
  "team_mapping_ok": true,
  "tags": ["AUDIT_BASELINE", "MAIN_MARKET"],
  "consistency": {
    "pace_tier": "HIGH",
    "event_env": "INDOOR",
    "event_direction_tag": "FAVOR_OVER",
    "vol_env": "STABLE",
    "total_bias": "OK"
  }
}
```

### 3. MODEL_OUTPUT

**Source of truth:** Pure math output before decision publication.

**Allowed changes:** Projections, fair prices, probabilities, drivers, and auditable model metadata.

**Invariant:** No final decision fields are allowed here. In particular, no `classification`, `official_status`, `execution_status`, or publish-facing reason assignment may appear in this stage.

**Failure ownership:** Model math, projection logic, pricing logic, or driver selection.

Example:

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

### 4. DECISION_OUTPUT

**Source of truth:** Payload immediately after `publishDecisionForCard` returns.

**Allowed changes:** Final decision assignment and publish eligibility labeling.

**Invariant:** Decision-authoritative fields become fixed here. At minimum, the audit must treat the following as authoritative strict fields:

- `classification`
- `official_status`
- `execution_status`
- `reason_codes`
- `card_type`
- `market_type`

If present, the following are also strict at this stage:

- `decision_v2.primary_reason_code`
- `decision_v2.play_tier`
- `action`
- `status`

**Failure ownership:** Decision layer, watchdog integration, or publish boundary preparation.

Example:

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
    "watchdog_status": "OK"
  }
}
```

### 5. PUBLISH_OUTPUT

**Source of truth:** Final payload written to DB for downstream consumption.

**Allowed changes:** Formatting-only additions, read-only metadata, presentation aids, timestamps, and other non-decision annotations.

**Invariant:** This stage must be a pure pass-through of `DECISION_OUTPUT` for strict fields. If a strict field changes between `DECISION_OUTPUT` and `PUBLISH_OUTPUT`, the audit result is `PUBLISH_DRIFT`.

**Failure ownership:** Publish adapter, write-path transform, API repair logic, or any downstream mutator.

Example:

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
    "watchdog_status": "OK"
  },
  "generated_at": "2026-04-01T14:01:02Z",
  "run_id": "run-wi0718-demo-001"
}
```

## Spine Rule: No Mutation After `publishDecisionForCard`

After `publishDecisionForCard` returns, the system is read-only for decision-authoritative fields.

- Downstream layers may format or annotate.
- Downstream layers may not upgrade, downgrade, or reinterpret decision meaning.
- Web/API/UI must not recompute wave-1 verdicts from legacy `action`, `status`, `classification`, title text, repair metadata, or heuristics.
- Any post-decision mutation of strict fields is an audit failure even if the resulting card still "looks reasonable."

This rule exists to eliminate split-brain verdict behavior. If `DECISION_OUTPUT` is not authoritative, the audit contract is not useful.

## Comparison Classes

### Strict

Strict fields have zero tolerance. Any value change is a failure at the relevant stage boundary.

Strict fields:

- `classification`
- `official_status`
- `execution_status`
- `reason_codes`
- `card_type`
- `market_type`
- `decision_v2.primary_reason_code`
- `decision_v2.play_tier`
- `decision_v2.watchdog_status`
- `decision_v2.watchdog_reason_codes`

Example strict comparison:

```json
{
  "before": {
    "classification": "PASS",
    "official_status": "PASS",
    "reason_codes": ["STALE_MARKET_INPUT"]
  },
  "after": {
    "classification": "PLAY",
    "official_status": "PLAY",
    "reason_codes": ["EDGE_CLEAR"]
  }
}
```

Result: not allowed. This is `DECISION_DRIFT` if the change happened between decision snapshots, or `PUBLISH_DRIFT` if it happened between `DECISION_OUTPUT` and `PUBLISH_OUTPUT`.

### Tolerant

Tolerant fields use explicit numeric thresholds. This WI defines thresholds only for fields covered by current audited paths and the baseline examples in `model_audit_baselines.md`.

| Field | Scope | Allowed Drift |
| --- | --- | --- |
| `fair_prob_*`, `implied_prob_*` | Any covered sport example using probabilities | `±0.02` |
| `projection_total` | NBA totals examples | `±1.0` |
| `projection_total` | NHL totals examples | `±0.25` |
| `fair_price_*` | Covered examples using fair odds/prices | `±3%` |

If a field is not listed here, it is not tolerant by default.

Example tolerant comparison:

```json
{
  "field": "projection_total",
  "sport": "NHL",
  "before": 5.75,
  "after": 5.9,
  "tolerance": 0.25
}
```

Result: allowed. The delta is `0.15`, which remains within the NHL totals tolerance.

### Ignored

Ignored fields may vary without drift classification because they do not change decision meaning.

Ignored fields:

- `generated_at`
- `decided_at`
- `run_id`
- UUID-like identifiers for run-local tracing
- log-only metadata
- display-only timestamps

Example ignored comparison:

```json
{
  "before": {
    "generated_at": "2026-04-01T14:01:02Z",
    "run_id": "run-a"
  },
  "after": {
    "generated_at": "2026-04-01T14:01:09Z",
    "run_id": "run-b"
  }
}
```

Result: allowed, because neither field changes decision meaning.

### Ignored-Field Guardrail

Ignored fields must never influence classification. If a field can change `classification`, `official_status`, `execution_status`, or reason assignment, it is not ignorable and must be reclassified as strict or tolerant.

## Fault Attribution Rules

Use the earliest violated invariant as the owner of the defect:

| First Broken Boundary | Fault Domain |
| --- | --- |
| `INPUT` malformed or incomplete | Input |
| `ENRICHED_INPUT` mutates raw input | Input / enrichment |
| `MODEL_OUTPUT` exceeds tolerance or includes forbidden decision fields | Model |
| `DECISION_OUTPUT` changes strict decision meaning unexpectedly | Decision |
| `PUBLISH_OUTPUT` diverges from decision truth | Publish |

The audit is deterministic because ownership always attaches to the first stage where the contract stopped holding.

## Relation To Watchdog And Consistency

The audit framework is above runtime gating, not beside it.

- **Watchdog** answers: is this row safe, fresh, and internally valid right now?
- **Consistency** answers: are required environment and context fields present for a trustworthy decision?
- **Audit** answers: did historical state mutate across stages or across runs, and who owns the mutation?

Example:

```json
{
  "watchdog_status": "BLOCKED",
  "watchdog_reason_codes": ["WATCHDOG_STALE_SNAPSHOT", "STALE_MARKET_INPUT"],
  "official_status": "PASS"
}
```

This is a valid watchdog outcome. It becomes an audit issue only if the blocked decision mutates later without a legitimate upstream change.

## Sport Handling

| Sport | Contract Status | Notes |
| --- | --- | --- |
| NBA | Full parity with wave-1 hard-cut authority | `decision_v2` is already the canonical worker-owned contract on covered markets. |
| NHL | Full parity with wave-1 hard-cut authority | Same as NBA; downstream layers are consumers only. |
| MLB | Same 5-stage audit model, lower current enforcement maturity | Use the same stage, drift, and comparison vocabulary, but do not claim full runtime parity with NBA/NHL hard-cut enforcement until MLB receives the same hard-cut guarantees. |

MLB is included now because audit comparability still matters even where runtime enforcement maturity is not yet identical.

## Non-Negotiable Rules

- No derived fields in `INPUT`.
- No raw-field mutation in `ENRICHED_INPUT`.
- No decision fields in `MODEL_OUTPUT`.
- No mutation of strict decision fields after `publishDecisionForCard`.
- `pricing_ready=false` implies `execution_status` must not be `EXECUTABLE`.
- Projection-floor outputs must carry `execution_status=PROJECTION_ONLY`; they must never carry `execution_status=EXECUTABLE`.
- Watchdog and consistency fields must exist before publishable classification proceeds.
- No workflow may surface a `PLAY` when no qualified edge exists.

## Audit Review Checklist

For every audited comparison:

1. Compare stage shapes and field types.
2. Check raw input immutability from `INPUT` to `ENRICHED_INPUT`.
3. Check that `MODEL_OUTPUT` remains a pure math layer.
4. Freeze strict fields at `DECISION_OUTPUT`.
5. Confirm `PUBLISH_OUTPUT` is a pass-through for strict fields.
6. Attribute the first broken boundary to its fault domain.

If these six checks cannot determine what changed, whether it was allowed, and who owns it, the audit packet is incomplete.
