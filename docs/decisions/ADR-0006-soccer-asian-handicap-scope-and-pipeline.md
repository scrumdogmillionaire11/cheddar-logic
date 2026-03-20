# ADR-0006: Soccer Asian Handicap Scope and Pipeline Contract

- Status: Accepted
- Date: 2026-03-20
- Decision Makers: lane/data-platform, lane/modeling

## Context

Soccer Tier-1 currently supports odds-backed main markets (`soccer_ml`, `soccer_game_total`, `soccer_double_chance`) while Asian Handicap (AH) remained policy-gated. Implementation work now requires a single explicit policy to avoid mixed routing and ambiguous payload contracts.

Two options were evaluated:

- Option A: keep AH out of Tier-1 and continue with current market scope
- Option B: reintroduce AH as a dedicated Tier-1 main-market pipeline

## Decision

Adopt **Option B**.

Asian Handicap is reintroduced as a **separate Tier-1 main-market pipeline** and is not part of the soccer props path.

## Normative Contract

- AH must be routed only under `FOOTIE_MAIN_MARKETS`.
- Canonical market keys are fixed to:
  - `asian_handicap_home`
  - `asian_handicap_away`
- AH must never be routed through Tier-1 props ingestion/routing (`player_shots`, `to_score_or_assist`, etc.).
- Worker remains the sole owner of AH grading/pricing output semantics; downstream layers consume worker output.

## Required Line Coverage

Implementation must support these line families:

- Whole lines: `±1.0`, `±2.0`, etc.
- Half lines: `±0.5`, `±1.5`, etc.
- Quarter lines: `±0.25`, `±0.75`, etc. (stake split semantics)
- Zero / Draw No Bet equivalent: `0`

## Outcome Taxonomy

- Whole + zero lines: `win | push | loss`
- Half lines: `win | loss`
- Quarter lines: `full_win | half_win | half_loss | full_loss`

## Non-Goals

- No backfill/rewrite of historical soccer cards.
- No schema migration beyond fields required for AH payload validation.
- No fallback routing of AH into props paths.
- No UI-specific feature expansion beyond existing card contract consumption.

## Consequences

- Unblocks AH implementation work (`WI-0521`, `WI-0522`, `WI-0523`).
- Establishes deterministic boundaries between soccer main-market and props pipelines.
- Reduces risk of split-brain behavior by fixing canonical AH keys and outcome semantics before coding.
