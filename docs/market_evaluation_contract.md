# Market Evaluation Contract

**Module:** `packages/models/src/market-eval.js`
**Version:** IME-01 (April 2026)

---

## Overview

Every market candidate evaluated by `evaluateSingleMarket` must terminate in exactly one of the valid terminal statuses defined in `VALID_STATUSES`. No market may disappear silently — each must be accounted for in `official_plays`, `leans`, or `rejected`.

Covered market types: `F5_TOTAL`, `F5_ML`, `FULL_GAME_ML`, `FULL_GAME_TOTAL`, `TOTAL`, `SPREAD`, `PUCKLINE`, `MONEYLINE`.

This contract applies to both MLB and NHL game market evaluation, and is enforced at runtime by `assertNoSilentMarketDrop`.

---

## MarketEvalResult Shape

```js
{
  game_id: string,              // e.g. "2026-04-13_BOS_TOR"
  sport: string | null,         // "NHL" | "MLB" | "NBA" | null
  market_type: string,          // normalised from MARKET_TYPE_MAP; one of VALID_MARKET_TYPES
  candidate_id: string,         // `${game_id}::${market}` — unique per market per game

  inputs_ok: boolean,           // false when card had missing required inputs
  consistency_ok: boolean,      // false when pace/event-env/total-bias signals absent
  watchdog_ok: boolean,         // false when watchdog blocked execution

  model_edge: number | null,    // edge value from driver card (p_fair - p_implied)
  fair_price: number | null,    // model's fair-value price
  win_probability: number | null,

  official_tier: "PLAY" | "LEAN" | "PASS",  // derived tier
  status: string,               // one of VALID_STATUSES (terminal state)
  reason_codes: string[],       // must be non-empty when status starts with "REJECTED_"
  notes: string[],              // optional human-readable context

  inputs_status: "COMPLETE" | "PARTIAL" | "MISSING",
  evaluation_status: "EDGE_COMPUTED" | "NO_EVALUATION",
  raw_edge_value: number | null,
  threshold_required: number | null,
  threshold_passed: boolean | null,
  block_reasons: string[],
  pass_reason_code: string | null,
}
```

---

## GameMarketEvaluation Shape

```js
{
  game_id: string,
  sport: string,
  market_results: MarketEvalResult[],  // ALL evaluated markets — never omitted
  official_plays: MarketEvalResult[],  // status === "QUALIFIED_OFFICIAL"
  leans: MarketEvalResult[],           // status === "QUALIFIED_LEAN"
  rejected: MarketEvalResult[],        // status starts with "REJECTED_"
  status: string,                      // game-level status (see below)
}
```

### Game-Level Status Values

| Status | Meaning |
|--------|---------|
| `HAS_OFFICIAL_PLAYS` | At least one market qualified as PLAY |
| `LEANS_ONLY` | No PLAY-tier markets; at least one LEAN |
| `SKIP_MARKET_NO_EDGE` | All markets evaluated and rejected (no qualifying edge) |
| `SKIP_GAME_INPUT_FAILURE` | All markets rejected due to missing inputs |
| `SKIP_GAME_MIXED_FAILURES` | Rejected markets include at least one non-edge blocker or no-evaluation result |

---

## REASON_CODES

Sole source of rejection reason strings in `packages/models/src/market-eval.js`.

| Code | When Used |
|------|-----------|
| `MISSING_MARKET_ODDS` | Card is null or missing h2h/total odds |
| `MISSING_STARTING_PITCHER` | MLB card missing starting pitcher inputs |
| `MISSING_GOALIE_CONFIRMATION` | NHL card with UNKNOWN or CONFLICTING goalie certainty |
| `MISSING_CONSISTENCY_FIELDS` | `pace_tier`/`event_env`/`total_bias` absent |
| `WATCHDOG_UNSAFE_FOR_BASE` | Watchdog blocked execution at PLAY tier |
| `EDGE_BELOW_THRESHOLD` | `ev_threshold_passed === false` |
| `EV_BELOW_THRESHOLD` | Positive edge but below lean minimum |
| `DUPLICATE_MARKET_SUPPRESSED` | Identical candidate already evaluated in this game context |
| `DISPLAY_RANKED_BELOW_PRIMARY` | Show-only: ranked below primary market in display layer |
| `UNCLASSIFIED_MARKET_STATE` | Driver card missing required terminal classification fields |

---

## Invariants

1. **Terminal-state invariant:** every `market_result.status` must be in `VALID_STATUSES`. Checked by `assertNoSilentMarketDrop`.
2. **Count invariant:** `official_plays.length + leans.length + rejected.length === market_results.length`. Enforced by `assertNoSilentMarketDrop`; throws `UNACCOUNTED_MARKET_RESULTS` on violation.
3. **Reason-required invariant:** any result with `status` starting with `REJECTED_` must have `reason_codes.length >= 1`.
4. **PASS_NO_EDGE legality invariant:** `PASS_NO_EDGE` may appear only when inputs are complete, an edge was computed, the edge failed threshold, and `block_reasons` is empty. `assertLegalPassNoEdge` hard-throws on violations.

## Stored Payload Truth Surface

MLB game-line card payloads written to `card_payloads.payload_data` must carry
the same provenance fields so downstream consumers can distinguish true
no-edge from blocked edge and no-evaluation states:

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

Display, health, and API consumers must not synthesize `PASS_NO_EDGE` when
these fields are absent. See `docs/decisions/ADR-0016-pass-reason-integrity-contract.md`.

---

## `assertNoSilentMarketDrop` Contract

```js
assertNoSilentMarketDrop(gameEval: GameMarketEvaluation): void
```

- Exported from `packages/models/src/market-eval.js`
- Validates the **count invariant**: throws `Error('UNACCOUNTED_MARKET_RESULTS for {game_id}: ...')` when partition counts do not sum to `market_results.length`
- Validates the **terminal-state invariant**: throws `Error('MISSING_MARKET_TERMINAL_STATUS for {candidate_id}: ...')` when a result has an invalid or missing status
- Validates the **reason-codes shape**: throws `Error('MISSING_REASON_CODES_ARRAY for {candidate_id}')` when `reason_codes` is not an array
- Called **before DB writes** in `run_mlb_model.js` and `run_nhl_model.js`

---

## Forbidden Cross-Market Behaviors

Cross-market orchestration logic (`cross-market.js`, `generateMLBMarketCallCards`, `generateNHLMarketCallCards`) **MAY**:

- Rank markets by score and choose a single primary display market
- Apply exposure caps that reduce stake without removing the card
- Deduplicate genuinely correlated angles with `DUPLICATE_MARKET_SUPPRESSED`
- Gate card generation on `gameEval.official_plays`/`leans`

Cross-market orchestration logic **MUST NOT**:

- Delete a `QUALIFIED_OFFICIAL` or `QUALIFIED_LEAN` result from `market_results` before `assertNoSilentMarketDrop`
- Treat empty card output as a clean success without an explicit `SKIP_*` status
- Suppress a qualified market solely because a different market has a higher rank
- Call `evaluateSingleMarket` on a card that has already been assigned a terminal status

---

## Smoke Test Scenarios

### Scenario 1: MLB Multi-Qualify

**Setup:** F5 total qualifies (FIRE) + full-game ML qualifies (WATCH) + full-game total fails (PASS/no edge)

**Expected `GameMarketEvaluation`:**
```
official_plays: [F5_TOTAL]
leans:          [FULL_GAME_ML]
rejected:       [FULL_GAME_TOTAL]
status:         HAS_OFFICIAL_PLAYS
```

**Expected card output:** 2 insertions (f5-totals-call, mlb-game-lines-call) + 1 rejection log.

---

### Scenario 2: NHL TOTAL + ML

**Setup:** TOTAL=PLAY + ML=LEAN + SPREAD=PASS

**Expected `GameMarketEvaluation`:**
```
official_plays: [TOTAL]
leans:          [MONEYLINE]
rejected:       [SPREAD]
status:         HAS_OFFICIAL_PLAYS
```

**Expected card output:** `nhl-totals-call` (PLAY tier) + `nhl-moneyline-call` (LEAN tier).
`choosePrimaryDisplayMarket` returns TOTAL as primary; ML card's `is_primary_display = false` but still emitted.

---

### Scenario 3: Empty-Edge Game

**Setup:** All markets evaluated, none cross threshold (all PASS)

**Expected `GameMarketEvaluation`:**
```
official_plays: []
leans:          []
rejected:       [TOTAL, SPREAD, MONEYLINE]   ← all with REJECTED_THRESHOLD
status:         SKIP_MARKET_NO_EDGE
```

**Expected card output:** 0 card insertions. Log line emitted for each rejected market.

---

## VALID_STATUSES

All ten terminal states; exported from `packages/models/src/market-eval.js`:

```js
VALID_STATUSES = [
  'QUALIFIED_OFFICIAL',
  'QUALIFIED_LEAN',
  'REJECTED_INPUTS',
  'REJECTED_CONSISTENCY',
  'REJECTED_WATCHDOG',
  'REJECTED_THRESHOLD',
  'REJECTED_SELECTOR',
  'REJECTED_DUPLICATE',
  'REJECTED_MARKET_POLICY',
  'SKIP_GAME_MIXED_FAILURES',
]
```

## VALID_MARKET_TYPES

All supported normalised market type tokens; exported from `packages/models/src/market-eval.js`:

```js
VALID_MARKET_TYPES = [
  'F5_ML',
  'F5_TOTAL',
  'FULL_GAME_ML',
  'FULL_GAME_TOTAL',
  'PUCKLINE',
  'SPREAD',
  'TOTAL',
  'MONEYLINE',
  'FIRST_PERIOD',
  'UNKNOWN',
]
```

---

## Module Exports Reference

```js
const {
  evaluateSingleMarket,
  finalizeGameMarketEvaluation,
  assertNoSilentMarketDrop,
  logRejectedMarkets,
  REASON_CODES,
  VALID_STATUSES,
  VALID_MARKET_TYPES,
} = require('@cheddar-logic/models/src/market-eval');
```

> See also: [CROSS_MARKET_ORCHESTRATION.md](./CROSS_MARKET_ORCHESTRATION.md), [MARKET_REGISTRY.md](./MARKET_REGISTRY.md)
