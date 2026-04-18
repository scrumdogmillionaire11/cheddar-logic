# Reason Code Taxonomy

## Purpose

WI-0901 standardizes how suppression, downgrade, and hidden-output paths expose machine-readable reason metadata. The goal is not to rename every historical reason code; it is to ensure every non-survivor path carries:

- a canonical `drop_reason_code`
- a `drop_reason_layer`
- a complete `reason_codes` set for downstream diagnostics

## Canonical Layers

| Layer | Source | Meaning |
| --- | --- | --- |
| `worker_gate` | `execution_gate.drop_reason` from worker jobs | Live betting execution blocked after model output existed |
| `decision_watchdog` | `decision_v2.watchdog_reason_codes` | Input or freshness watchdog blocked the candidate before publish |
| `decision_price` | `decision_v2.price_reason_codes` | Pricing or downgrade logic capped the candidate to `LEAN` or `PASS` |
| `decision_primary` | `decision_v2.primary_reason_code` | Canonical decision explanation when no more specific watchdog/price layer applies |
| `publish_pass_reason` | `pass_reason_code` | Publish/read-surface pass reason when earlier layers did not emit explicit drop metadata |

## Canonical Expectations

### Verification blocker migration

`EDGE_VERIFICATION_REQUIRED` is a **sunset** legacy code. It must not be emitted by any current pipeline or model.
Old DB records may contain it; the read layer renders it as `'Line not confirmed'` for backward compat.
New canonical reasons for verification/integrity holds are:

- `LINE_NOT_CONFIRMED`
- `EDGE_RECHECK_PENDING`
- `EDGE_NO_LONGER_CONFIRMED`
- `MARKET_DATA_STALE`
- `PRICE_SYNC_PENDING`

Normalization rule:

- ingestion may preserve legacy values for backward compatibility,
- newly emitted `primary_reason_code` / `price_reason_codes` should use explicit
  canonical reasons above,
- `reason_codes` remains deterministic and unique after normalization.

### Executable candidate blocked by worker

- `execution_gate.drop_reason.drop_reason_code` must be present
- `execution_gate.drop_reason.drop_reason_layer` must be `worker_gate`
- `execution_gate.blocked_by` must include the same root cause family

Examples:

- `NO_EDGE_AT_CURRENT_PRICE`
- `STALE_SNAPSHOT_GATE`
- `CALIBRATION_GATE`
- `PROJECTION_ONLY_EXCLUSION`
- `NOT_BET_ELIGIBLE`

### Decision-layer PASS or LEAN

- `/api/games` must preserve the full decision reason set in `reason_codes`
- transform must derive `transform_meta.drop_reason` from the first authoritative layer in this order:
  1. explicit worker `execution_gate.drop_reason`
  2. blocked watchdog reason
  3. non-`EDGE_CLEAR` price reason
  4. `pass_reason_code`
  5. `primary_reason_code`

Examples:

- `WATCHDOG_STALE_SNAPSHOT`
- `PLAY_REQUIRES_FRESH_MARKET`
- `SIGMA_FALLBACK_DEGRADED`
- `PASS_EXECUTION_GATE_NET_EDGE_INSUFFICIENT`

### Hidden output / diagnostics-only surfacing

- Diagnostics mode may expose the reason-code set
- Default cards UI must remain unchanged
- Dev-mode route diagnostics may aggregate by `drop_reason_code` and `drop_reason_layer`

## Route Contract

`/api/games` play rows should expose:

- `reason_codes`: union of payload, decision-v2, execution-gate, and publish-pass codes
- `execution_gate.drop_reason`: explicit worker reason when present, otherwise derived layered fallback for diagnostics
- `execution_gate.blocked_by`: normalized machine-readable blocked-by list when available

## Regression Guard

Regression tests should fail when any scoped suppression path returns:

- no `drop_reason_code` for a blocked candidate
- no `drop_reason_layer` for a blocked candidate
- incomplete `reason_codes` on API/transform outputs
