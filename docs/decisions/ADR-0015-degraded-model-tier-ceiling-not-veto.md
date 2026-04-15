# ADR-0015: Degraded Model Projections Must Be Tier-Downgraded, Not Silenced

- Status: Accepted
- Date: 2026-04-15
- Work item: WI-0944

## Context

While investigating why MLB full-game cards (moneyline and totals) were
universally showing as PASS/NO-PLAY despite having real model edge, two
independent bug patterns were uncovered that both cause modeled edges to be
silently dropped.

### Bug 1 — Confidence gate set at or above the degraded cap (totals)

`mlb-model.js:projectFullGameTotalCard()` set the confidence floor for
DEGRADED_MODEL projections at `confidenceGate + 0.1` (i.e., 6.1).
`DEGRADED_CONSTRAINTS.MAX_CONFIDENCE` caps confidence at 6 (on a 1–10 scale
for the MLB model). The result: every degraded projection had confidence capped
at the floor, which was then _below_ the veto gate, so `ev_threshold_passed`
was always false → market-eval rejected the card before the execution gate was
ever reached.

This is a latent bug class: if a model sets a hard confidence gate at or above
its own degraded cap, every projection in DEGRADED state is unconditionally
blocked regardless of edge. The original intent of the `+0.1` was to prevent
degraded games from "auto-passing" the confidence gate — but the correct
enforcement is a _tier ceiling_ (cap at WATCH, forbid FIRE/PLAY), not a veto.

### Bug 2 — `card_type` not stamped before execution gate is called (ML)

`run_mlb_model.js` set `payloadData.card_type` _after_ calling
`applyExecutionGateToMlbPayload()`. Inside that function, the
`_isMlbFullGameMl` detection keyed off `payloadData.card_type`, which was
always null at call time. Every sport-specific override branch was therefore
dead code — the global hard-veto thresholds applied unchanged to all MLB
full-game ML cards regardless of edge.

## Decision

### On degraded-model tier contract

The established contract in `input-gate.js` (`DEGRADED_CONSTRAINTS`) is
authoritative:

- Cap confidence at `MAX_CONFIDENCE` — never emit a confidence value above the cap
- Forbid tiers in `FORBIDDEN_TIERS` — downgrade to WATCH/LEAN at most; never FIRE/PLAY

**This is a tier ceiling, not a veto.** A projection in DEGRADED state that
exceeds the edge threshold must surface. It must not be silenced. Any
model-level confidence gate must be set _strictly below_ `MAX_CONFIDENCE` (or
omitted for degraded paths) so that a capped-confidence projection can still
reach `ev_threshold_passed = true`.

The fix applied in WI-0944 to `projectFullGameTotalCard()`:

- Removed the `+0.1` penalty from the confidence floor for DEGRADED_MODEL
- Added `isDegraded` boolean: `canPlay = hasEdge && (!confidenceBelowGate || isDegraded)`
- DEGRADED + edge → `status = 'WATCH'`; FULL_MODEL + `confidence < 6` → `status = 'PASS'`

### On metadata-before-gate stamping

Any field read by `evaluateExecution()` or a runner's gate wrapper must be
stamped on `payloadData` _before_ the gate call. This includes `card_type`,
`sport`, `market_type`, `period`, and any field that controls sport-specific
override logic.

The fix applied in WI-0944 to `run_mlb_model.js`:

- `payloadData.card_type` is now set immediately after the card object is
  constructed, before `applyExecutionGateToMlbPayload()` is called
- Multi-field detection (`card_type`, `market_type`, `recommended_bet_type`,
  `title`, `period`) provides fallback robustness if any single field is
  missing

## Consequences

- All models with a DEGRADED path must verify: is the model-level confidence
  gate strictly below `DEGRADED_CONSTRAINTS.MAX_CONFIDENCE` (scaled for the
  model's confidence range)? If not, all degraded projections are silently
  vetoed.
- All runners must verify: is every field that execution-gate logic branches on
  populated before the gate call?
- The `input-gate.js` `DEGRADED_CONSTRAINTS` contract comment has been updated
  to be explicit about this requirement.
- `cross-market.js` and `projections.js` already implement the correct pattern
  (cap + FORBIDDEN_TIERS only; no hard confidence veto). No change needed.
- MLB full-game totals and ML cards now surface as WATCH/LEAN when model edge
  is present in DEGRADED_MODEL state. Verified in DB run
  `job-mlb-model-2026-04-15T18:00:53-606930cb`.

## Checklist for any new model with a DEGRADED path

1. Does the model cap confidence at or below `DEGRADED_CONSTRAINTS.MAX_CONFIDENCE`
   (scaled to the model's numeric range)?
2. Is the model-level confidence gate (if any) set _strictly below_ that cap?
3. Does the model emit `status = 'WATCH'` (not 'PASS') when DEGRADED + hasEdge?
4. Does the runner stamp all gate-branch fields on `payloadData` before calling
   the execution gate function?
