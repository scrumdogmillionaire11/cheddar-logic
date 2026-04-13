# ADR-0012: `/results` Active Betting Whitelist

- Status: Accepted
- Date: 2026-04-13
- Supersedes: ADR-0010 for `/results` betting-family classification only
- Work item: WI-0922

## Context

`/results` currently has a narrow parity problem rather than a worker-capability
problem.

The worker already emits active, real odds-backed game-line card types for
current NBA, NHL, and MLB betting rows, but `/api/results` still carries stale
alias expectations for some NHL and MLB families. That drift causes dev/prod
classification mismatches even when the underlying card is already truly
`ODDS_BACKED`.

At the same time, `ADR-0010` remains correct for markets that still do not have
fully supported odds, pricing, and settlement contracts. Props, F5, and NHL 1P
lanes must not be promoted into Betting Record in this ADR.

## Decision

`/results` Betting Record remains **odds-backed only**.

For active `/results` betting-family classification, the allowed executable
whitelist is:

- `NBA`: full-game total, spread
- `NHL`: full-game total, full-game moneyline
- `MLB`: full-game total, full-game moneyline

For this ADR:

1. `/api/results` may classify these active families as betting families when
   the settled row is truly `ODDS_BACKED`.
2. Projection-only fallback rules from `ADR-0010` remain authoritative for any
   non-whitelisted or not-yet-capable market.
3. This ADR does **not** change worker odds ingestion, scheduler behavior,
   settlement contracts, or token-budget policy.

The following markets remain projection-only or excluded from Betting Record
unless a future work item deliberately changes worker capability and policy:

- `MLB_F5_*`
- `NHL_1P_TOTAL`
- `MLB_PITCHER_K`
- `NHL_PLAYER_SHOTS`
- `NHL_PLAYER_BLOCKS`

## Consequences

- `/results` parity can be fixed by aligning family mapping to real
  worker-emitted card types and by exposing the existing MLB filter in the UI.
- This ADR does not authorize new prop/F5 odds support, new settlement logic, or
  any change to `packages/data` market identity contracts.
- Future promotion of props, F5, or NHL 1P into Betting Record requires a new
  work item plus explicit worker odds and settlement support.

## Revisit Condition

Revisit this ADR only if a future work item adds all of the following for a new
market lane:

- real locked odds and price capture
- stable settlement contract support
- explicit `/results` classification tests
- policy approval to expand Betting Record scope beyond the active whitelist
