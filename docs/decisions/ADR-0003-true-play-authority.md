# ADR-0003: True-Play Authority Contract

- Status: Accepted
- Date: 2026-04-11
- Decision Makers: lane/worker, lane/web-platform
- Related: ADR-0002 (single-writer DB contract)

## Context

`/api/games` exposes one `true_play` row per game for downstream UI transforms. Historical behavior allowed multiple sources to influence that selection:

1. `card_payloads` (live model outputs)
2. `card_display_log` (historical display evidence, potentially mutated during settlement backfill)

That overlap created split-brain risk where settlement replay could change what was surfaced as the current `true_play` even when no new model run occurred.

## Decision

Use a single live authority:

- Live true-play authority source: `card_payloads` decision data (`decision_v2` + canonical play fields)
- `card_display_log` classification: historical/analytics evidence only
- Settlement classification: historical-only for true-play authority fields

### Canonical selection order (deterministic)

For each game, select from eligible `PLAY`-kind rows with official status in `{PLAY, LEAN}` using this precedence:

1. official status rank (`PLAY` > `LEAN`)
2. edge rank (`decision_v2.edge_delta_pct` then `decision_v2.edge_pct` then `edge`)
3. support score (`decision_v2.support_score`)
4. recency (`created_at`)
5. stable tie-break (`source_card_id` lexical)

The selected row must include authority metadata:

- `true_play_authority_source = CARD_PAYLOADS_DECISION_V2`
- `true_play_authority_version = ADR-0003`
- `true_play_authority_rationale = status_rank>edge_delta_pct>support_score>created_at>source_card_id`

## Ownership boundary

- Worker may settle results and write historical outcomes.
- Worker may not mutate or backfill fields used as live true-play authority.
- Web `/api/games` must not rank or select live true-play from `card_display_log`.

## Consequences

### Positive

- Live authority is deterministic and replay-stable.
- Settlement no longer acts as alternate authority path.
- Contract is testable with behavior-focused regression coverage.

### Negative

- Historical display logs no longer serve as a fallback authority source.
- Missing/invalid payload-side decision data now fails fast into explicit no-authority behavior.

## Non-goals

- Rewriting model scoring formulas
- Changing POTD logic
- UI styling/layout changes

## Migration notes

- WI-0891 consumes this boundary to remove remaining split-brain write/read paths.
- WI-0892 aligns projection visibility behavior across `/api/cards` and `/api/games` on top of this authority contract.
