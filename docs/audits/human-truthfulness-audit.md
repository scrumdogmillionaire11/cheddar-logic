# Human Truthfulness Audit

## Purpose

Document the exact machine conditions used to render human-facing conviction labels in Discord so wording always reflects model strength.

## NHL Total Conviction Labels

The worker wrapper determines NHL total conviction from absolute edge with deterministic thresholds.

| Label | Tier token | Machine condition |
| --- | --- | --- |
| Strong Play Edge | STRONG_PLAY | abs(edge) >= 1.5 |
| Play-Grade Edge | PLAY_GRADE | 1.0 <= abs(edge) < 1.5 |
| Slight Edge | SLIGHT_EDGE | 0.5 <= abs(edge) < 1.0 |
| Slight Edge (fallback) | NO_EDGE | abs(edge) < 0.5 or edge missing |

Source logic:

- `apps/worker/src/models/cross-market.js`: `resolveNhlTotalConviction`
- `apps/worker/src/jobs/post_discord_cards.js`: `getNhlTotalConvictionTier`, `resolveLeanSectionTitle`

## Reason Code Paths

Reason-code wording is mapped in Discord output and must never leak internal tokens.

| Internal code(s) | Human label |
| --- | --- |
| EDGE_VERIFICATION_REQUIRED | Line unstable - waiting for confirmation |
| MODEL_PROB_MISSING | Model incomplete - no play |
| PASS_NO_EDGE | No edge |
| NO_EDGE_AT_PRICE | Price too sharp |
| PASS_LOW_CONFIDENCE | Low confidence |
| PASS_SHARP_MONEY_OPPOSITE | Sharp money against - no play |
| GATE_GOALIE_UNCONFIRMED | Goalie not confirmed |
| GATE_LINE_MOVEMENT | Line moved - re-evaluating |
| BLOCK_INJURY_RISK | Injury risk flag |
| BLOCK_STALE_DATA | Data stale - no play |

Source logic:

- `apps/worker/src/jobs/post_discord_cards.js`: `REASON_CODE_LABELS`, `humanReason`

## Verification Notes

- Regression tests validate low, play-grade, and strong NHL total lean labels map to distinct Discord text.
- Regression tests also assert reason codes such as PASS_NO_EDGE are not printed directly in snapshot output.
