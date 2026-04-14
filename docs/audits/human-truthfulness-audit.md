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

## Web Surface — Decision-Surface Gating Logic

The canonical web surface is determined by `buildFinalMarketDecision` in
`web/src/lib/game-card/transform/decision-surface.ts`. The gating precedence
(highest priority first) determines `surfaced_status`:

| Gate | Condition | Effect on surfaced_status |
| --- | --- | --- |
| verification FAILED | codes include PASS_DATA_ERROR or MISSING_DATA_NO_ODDS | forced PASS |
| certainty UNCONFIRMED | any goalie status is UNKNOWN or CONFLICTING | forced PASS |
| verification PENDING | sharp_price_status=PENDING_VERIFICATION or EDGE_VERIFICATION_REQUIRED in codes | PLAY → SLIGHT EDGE |
| certainty PARTIAL | one goalie EXPECTED/missing, other CONFIRMED | PLAY → SLIGHT EDGE |
| market unstable | codes include EDGE_VERIFICATION_REQUIRED, BLOCKED_BET_VERIFICATION_REQUIRED, or GATE_LINE_MOVEMENT | PLAY → SLIGHT EDGE |
| official LEAN | official_status=LEAN and no gate triggered | SLIGHT EDGE |
| official PLAY and all gates pass | | PLAY |
| official anything else | | PASS |

Source: `web/src/lib/game-card/transform/decision-surface.ts`: `buildFinalMarketDecision`

`surfaced_status` drives the primary label users see in the cards UI
(`GameCardItem.tsx` reads `final_market_decision.surfaced_status`).

### Web PASS Surfaced Reason Mapping

When `surfaced_status` is PASS or SLIGHT EDGE, users see `surfaced_reason`.
All known reason codes map to explicit human phrases. No internal token
substitution is used (raw `replace(/_/g, ' ')` fallback was removed in WI-0905).

| Internal code | Human phrase (web) |
| --- | --- |
| EDGE_VERIFICATION_REQUIRED | Waiting on line verification |
| BLOCKED_BET_VERIFICATION_REQUIRED | Waiting on line verification |
| GATE_LINE_MOVEMENT | Line moved - re-evaluating |
| GATE_GOALIE_UNCONFIRMED / *GOALIE* | Waiting on goalie confirmation |
| PASS_NO_EDGE | No edge |
| NO_EDGE_AT_PRICE | Price too sharp |
| PASS_LOW_CONFIDENCE | Low confidence |
| PASS_SHARP_MONEY_OPPOSITE | Sharp money against |
| MODEL_PROB_MISSING | Model incomplete |
| MARKET_PRICE_MISSING | Market price unavailable |
| BLOCK_INJURY_RISK | Injury risk flag |
| BLOCK_STALE_DATA | Data stale |
| EXACT_WAGER_MISMATCH | Line mismatch |
| HEAVY_FAVORITE_PRICE_CAP | High price cap |
| PROXY_EDGE_CAPPED | Edge capped by proxy |
| PARSE_FAILURE | Model data unavailable |
| PASS_DATA_ERROR | Data error - no play |
| MISSING_DATA_NO_ODDS | Odds unavailable |
| SUPPORT_BELOW_LEAN_THRESHOLD | Insufficient support |
| SUPPORT_BELOW_PLAY_THRESHOLD | Insufficient support |
| FIRST_PERIOD_NO_PROJECTION | No 1P projection available |
| (unknown) | No edge at current price (safe fallback) |

Source: `web/src/lib/game-card/transform/decision-surface.ts`: `SURFACED_REASON_LABELS`, `mapSurfacedReason`

### Web `whyText` Fallback

The `fallbackDecision` path in `GameCardItem.tsx` (used when `card.play` is absent)
previously used raw `whyReason.replace(/_/g, ' ')` which bypassed the LABELS table
and could surface internal tokens. Fixed in WI-0905 to route through `formatReasonCode`.

Source: `web/src/components/cards/GameCardItem.tsx` line ~138, `web/src/components/cards/game-card-helpers.tsx`: `formatReasonCode`

## Discord vs Web Cross-Surface Consistency

Both surfaces share semantics for the same decision state after WI-0935:

| Decision state | Discord label | Web surfaced_status | Consistency |
| --- | --- | --- | --- |
| official_status=PLAY, all gates pass | Play (lean section) | PLAY | ✅ |
| official_status=LEAN | Lean section | SLIGHT EDGE | ✅ |
| blocked high-signal pass with gate reason | Watch (Would be PLAY) | PASS with surfaced_reason | ✅ improved |
| PASS_NO_EDGE | "No edge" (REASON_CODE_LABELS) | "No edge" (SURFACED_REASON_LABELS) | ✅ |
| EDGE_VERIFICATION_REQUIRED | "Line unstable - waiting for confirmation" | "Waiting on line verification" | ⚠️ minor wording variant |
| GATE_GOALIE_UNCONFIRMED | "Goalie not confirmed" | "Waiting on goalie confirmation" | ⚠️ minor wording variant |
| GATE_LINE_MOVEMENT | "Line moved - re-evaluating" | "Line moved - re-evaluating" | ✅ |
| BLOCK_STALE_DATA | "Data stale - no play" | "Data stale" | ⚠️ minor wording variant |

Minor wording variants (⚠️) are acceptable — they reflect different surface contexts
(Discord prose vs web label) and carry the same meaning. WI-0905 now surfaces
high-signal blocked Discord rows as `WATCH (Would be PLAY)` instead of silently
omitting them, which better matches the web PASS + surfaced_reason state.

Source: `apps/worker/src/jobs/post_discord_cards.js`: `REASON_CODE_LABELS`

## Mismatch Classes Documented (WI-0905)

| Mismatch class | Description | Status |
| --- | --- | --- |
| SLIGHT EDGE vs not-vetoed | official_status maps to SLIGHT EDGE; does not mean actively vetoed — just below PLAY threshold or gated | Documented above |
| No driver plays loaded vs transform suppression | `transform_meta.quality=BROKEN` triggers fallback path, not an explicit suppression code | Covered by `transform_meta` in WI-0901 |
| Fallback whyText raw token exposure | `fallbackDecision.whyReason` was set as raw stripped string, bypassing phrase lookup | Fixed in WI-0905 |
| mapSurfacedReason unknown-code fallback | Unknown codes fell through to `replace(/_/g, ' ')` producing internal-looking text | Fixed in WI-0905 |
| Blocked play omission in Discord | high-signal gated passes were hidden from Discord entirely | Fixed in WI-0905 |

## Verification Notes

- Regression tests validate low, play-grade, and strong NHL total lean labels map to distinct Discord text.
- Regression tests also assert reason codes such as PASS_NO_EDGE are not printed directly in snapshot output.
- `web/src/__tests__/game-card-pass-surface-contract.test.js` covers `buildFinalMarketDecision` gating logic.
