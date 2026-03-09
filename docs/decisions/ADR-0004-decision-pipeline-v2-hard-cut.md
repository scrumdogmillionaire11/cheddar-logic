# ADR-0004: Decision Pipeline v2 Hard Cut (Worker-Owned)

- Status: Accepted
- Date: 2026-03-08
- Decision Makers: lane/data-platform, lane/web-platform

## Context

Cards were showing contradictory verdicts because decision logic was split across worker, API transform, and UI fallback layers. Legacy repair paths also allowed downstream status synthesis from partial fields.

This created multiple truths for one market:

- Driver output could imply one side while UI badges showed another status.
- API repair/inference could mutate status independently of worker output.
- UI could recompute verdict labels from legacy `action/status/classification`.

## Decision

Adopt **Decision Pipeline v2** with a hard cut for wave-1 game-line markets:

- Wave-1 sports: `NBA`, `NHL`, `NCAAM`
- Wave-1 markets: `MONEYLINE`, `SPREAD`, `TOTAL`, `PUCKLINE`, `TEAM_TOTAL`
- Worker is the sole decision owner and emits canonical `decision_v2` before publish/insert.
- `/api/games` and `/cards` are pure consumers of worker `decision_v2`.
- No legacy repair metadata or downstream verdict recomputation on wave-1 path.

## Normative Contract

For wave-1 rows, the following rules are mandatory:

- Worker is the only decision authority and MUST emit `decision_v2` before publish/insert.
- Web/API/UI layers are worker-only consumers and MUST NOT recompute verdicts.
- Wave-1 final verdict vocabulary is fixed to `PLAY/LEAN/PASS`.
- Downstream layers MUST NOT derive wave-1 verdicts from legacy fields (`action`, `status`, `classification`) or title/repair heuristics.

## Contract Rules

1. Pipeline order is deterministic:
   - `DRIVERS -> WATCHDOG -> PRICE -> FINAL STATUS`
2. Layer responsibilities:
   - Drivers: direction/support/conflict only
   - Watchdog: integrity/freshness/consistency only
   - Price: sharp-vs-dull only
3. Final verdict vocabulary:
   - `PLAY`, `LEAN`, `PASS`
4. One candidate emits one canonical reason:
   - `decision_v2.primary_reason_code`
5. Blocking watchdog always forces `PASS`.

## Fixed Wave-1 Constants

- Stale caution window: `5m..30m`
- Stale block window: `>30m`
- LEAN edge threshold: `0.03`
- PLAY edge threshold: `0.06`
- BEST edge threshold: `0.10`
- LEAN support threshold: `0.45`
- PLAY support threshold: `0.60`

## Reason Precedence

`primary_reason_code` precedence:

1. Blocking watchdog reason
2. Price failure reason
3. Qualification reason (`EDGE_CLEAR`, `SUPPORT_BELOW_PLAY_THRESHOLD`, etc.)

Exactly one top-level reason is emitted.

## Hard-Cut Legacy Removal Policy

- Wave-1 path excludes legacy repair metadata and legacy verdict inference.
- If a wave-1 play is missing `decision_v2`, it is excluded from the wave-1 verdict path.
- Out-of-scope sports/markets may keep legacy behavior until their own hard-cut ADR.

## Consequences

- Removes wave-1 split-brain verdict behavior.
- Eliminates web/API/UI repair and inference for wave-1 statuses.
- Preserves explicit no-play behavior (`PASS`) when no sharp edge exists.
- Keeps legacy behavior only for out-of-scope sports/markets until dedicated cutovers.
