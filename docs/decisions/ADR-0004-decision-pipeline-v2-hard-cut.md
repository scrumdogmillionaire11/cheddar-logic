# ADR-0004: Decision Pipeline v2 Hard Cut (Worker-Owned)

- Status: Accepted
- Date: 2026-03-08
- Decision Makers: lane/data-platform, lane/web-platform

## Amendment (2026-04-25)

WI-1184 extends this ADR with an explicit canonical decision authority
object and fail-closed active read behavior.

### Added Clarifications

1. Two status vocabularies are intentional and both are normative:
   - Authority vocabulary: `PLAY` / `SLIGHT_EDGE` / `PASS`
   - Pipeline vocabulary: `PLAY` / `LEAN` / `PASS`
2. Worker stamps both layers at publish time:
   - `canonical_decision` (authority source of truth)
   - `decision_v2.canonical_envelope_v2` (pipeline-compatible envelope)
3. Status mapping is fixed and deterministic:
   - `PLAY -> PLAY`
   - `SLIGHT_EDGE -> LEAN`
   - `PASS -> PASS`
4. Active read surfaces are fail-closed when canonical status is missing:
   - `/api/cards` does not apply global run fallback in active lifecycle mode
   - `/api/games` rejects projection-surface decision synthesis in active mode
   - `/api/results` projection metrics do not infer actionability from
     legacy action/classification

## Context

Cards were showing contradictory verdicts because decision logic was split
across worker, API transform, and UI fallback layers. Legacy repair paths
also allowed downstream status synthesis from partial fields.

This created multiple truths for one market:

- Driver output could imply one side while UI badges showed another status.
- API repair/inference could mutate status independently of worker output.
- UI could recompute verdict labels from legacy `action/status/classification`.

## Decision

Adopt **Decision Pipeline v2** with a hard cut for wave-1 game-line markets:

- Wave-1 sports: `NBA`, `NHL`, `NCAAM`
- Wave-1 markets: `MONEYLINE`, `SPREAD`, `TOTAL`, `PUCKLINE`, `TEAM_TOTAL`
- Worker is the sole decision owner and emits both `canonical_decision`
   and canonicalized `decision_v2` before publish/insert.
- `/api/games` and `/cards` are pure consumers of worker `decision_v2`.
- No legacy repair metadata or downstream verdict recomputation on wave-1 path.

## Normative Contract

For wave-1 rows, the following rules are mandatory:

- Worker is the only decision authority and MUST emit canonical decision
   metadata before publish/insert.
- Web/API/UI layers are worker-only consumers and MUST NOT recompute verdicts.
- Authority verdict vocabulary is fixed to `PLAY/SLIGHT_EDGE/PASS`.
- Pipeline verdict vocabulary is fixed to `PLAY/LEAN/PASS`.
- Downstream layers MUST NOT derive wave-1 verdicts from legacy fields
   (`action`, `status`, `classification`) or title/repair heuristics.

## Contract Rules

1. Pipeline order is deterministic:
   - `DRIVERS -> WATCHDOG -> PRICE -> FINAL STATUS`
2. Layer responsibilities:
   - Drivers: direction/support/conflict only
   - Watchdog: integrity/freshness/consistency only
   - Price: sharp-vs-dull only
3. Final verdict vocabulary:
   - Authority: `PLAY`, `SLIGHT_EDGE`, `PASS`
   - Pipeline envelope: `PLAY`, `LEAN`, `PASS`
4. One candidate emits one canonical reason:
   - `decision_v2.primary_reason_code`
5. Blocking watchdog always forces `PASS`.
6. Read paths in active mode fail closed when canonical decision state is absent.

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
- If a wave-1 play is missing `decision_v2`, it is excluded from the
   wave-1 verdict path.
- If canonical status is missing in active mode, downstream APIs must not
   infer a replacement verdict from legacy action/classification fields.
- Out-of-scope sports/markets may keep legacy behavior until their own
   hard-cut ADR.

## Consequences

- Removes wave-1 split-brain verdict behavior.
- Eliminates web/API/UI repair and inference for wave-1 statuses.
- Makes canonical source provenance explicit
   (`source = decision_authority`) for worker, web, Discord, and POTD
   consumption.
- Preserves explicit no-play behavior (`PASS`) when no sharp edge exists.
- Keeps legacy behavior only for out-of-scope sports/markets until dedicated cutovers.
