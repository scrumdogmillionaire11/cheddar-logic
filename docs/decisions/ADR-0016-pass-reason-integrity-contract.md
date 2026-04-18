# ADR-0016: PASS Reason Integrity and Stored Payload Provenance

- Status: Accepted
- Date: 2026-04-18
- Work item: pass-reason-integrity

## Context

The MLB pipeline previously used `PASS_NO_EDGE` for multiple incompatible
states:

- Edge was computed and failed threshold
- Edge cleared threshold but was blocked by confidence/model-quality gates
- Edge never had a trustworthy evaluation because inputs or synthetic fallback
  prevented a real market evaluation

That collapsed the evaluation, qualification, and execution layers into a
single label. Downstream consumers such as health checks, Discord summaries,
and web API payloads could not prove whether a model found no edge or found
edge and chose not to act.

## Decision

`PASS_NO_EDGE` is a derived conclusion, not a default fallback. It is legal
only when all of the following are true:

1. `inputs_status === 'COMPLETE'`
2. `evaluation_status === 'EDGE_COMPUTED'`
3. `raw_edge_value` is finite
4. `threshold_passed === false`
5. `block_reasons.length === 0`

Any other PASS condition must use a more specific code. Examples:

| Code | Meaning |
|------|---------|
| `PASS_CONFIDENCE_GATE` | Edge cleared the raw threshold, but confidence blocked action |
| `PASS_MODEL_DEGRADED` | Edge cleared, but model quality/degraded inputs blocked action in a model family that treats degraded reliability as a veto |
| `PASS_INPUTS_INCOMPLETE` | Required inputs were missing before reliable edge evaluation |
| `PASS_SYNTHETIC_FALLBACK` | Projection came from fallback/synthetic mode, not a real evaluated market edge |
| `PASS_NO_DISTRIBUTION` | Required distribution could not be built |
| `PASS_UNKNOWN` | Model contract failed to provide a specific reason |
| `PASS_NO_EDGE` | Edge was computed, inputs were complete, and edge failed threshold with no other blocker |

MLB full-game ML currently follows ADR-0015: degraded positive-edge signals are
tier-downgraded to WATCH rather than vetoed, so they normally should not emit
`PASS_MODEL_DEGRADED`. That code remains reserved for model families where
degraded reliability is explicitly a PASS blocker.

## Required MarketEvalResult Fields

Every `MarketEvalResult` produced by `packages/models/src/market-eval.js` must
carry:

```js
{
  inputs_status: 'COMPLETE' | 'PARTIAL' | 'MISSING',
  evaluation_status: 'EDGE_COMPUTED' | 'NO_EVALUATION',
  raw_edge_value: number | null,
  threshold_required: number | null,
  threshold_passed: boolean | null,
  block_reasons: string[],
  pass_reason_code: string | null
}
```

`assertLegalPassNoEdge(result)` must hard-throw on illegal `PASS_NO_EDGE` from
either `reason_codes` or `pass_reason_code`.

## Required Stored Card Payload Fields

Every MLB game-line payload written to `card_payloads.payload_data` must expose
the same truth surface for downstream debugging:

```json
{
  "inputs_status": "COMPLETE",
  "evaluation_status": "EDGE_COMPUTED",
  "raw_edge_value": 0.031,
  "threshold_required": 0.025,
  "threshold_passed": true,
  "blocked_by": "PASS_CONFIDENCE_GATE",
  "block_reasons": ["PASS_CONFIDENCE_GATE"]
}
```

`blocked_by` is the primary blocker string for human and dashboard use.
`block_reasons` is the structured array used by contract enforcement. For a
true no-edge PASS, `blocked_by` is `PASS_NO_EDGE` and `block_reasons` is empty.

## Game-Level Status

`SKIP_MARKET_NO_EDGE` is legal only when every rejected candidate had an edge
evaluation and no non-edge blockers. If any rejected candidate has
`evaluation_status === 'NO_EVALUATION'` or non-empty `block_reasons`, the
game-level status must be `SKIP_GAME_MIXED_FAILURES`.

## Downstream Consumers

- Health checks may classify pass families from `pass_reason_code`, but must
  not infer no-edge from a missing reason.
- Discord display helpers must return `null` when no reason exists. They must
  never fabricate `PASS_NO_EDGE`.
- Web/API consumers should use the stored truth surface to answer whether a
  card found no edge, found blocked edge, or never evaluated.

## Consequences

- Model/card builders may not use `?? 'PASS_NO_EDGE'` as a generic fallback.
- Synthetic fallback and no-edge are mutually exclusive unless a real edge was
  computed against complete inputs and failed threshold.
- Tests must cover both model output and final stored payload shape.
