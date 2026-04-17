# Mispricing Scanner

Cross-book odds discrepancy detection. Emits `MispricingCandidate` objects — pure detection primitive, no model edge, no recommendations.

---

## Purpose and Invariants

The mispricing scanner detects when one bookmaker's price or line is materially out of sync with the consensus of other bookmakers for the same game and market.

**What it is:** A stateless, database-free function that takes a list of odds snapshot rows and returns disagreement signals.

**What it is NOT:** An edge model, a play selector, or a recommendation engine.

### Hard invariants (from WI-0811)

1. No candidate field (reason codes, classification labels, market type, selection) contains the words `bet`, `play`, or `recommend`. This is enforced at runtime via assertion.
2. Fewer than 2 comparison books → no candidate emitted (insufficient consensus).
3. Snapshots older than the recency window (default 30 minutes) are excluded.
4. Props (`PROP`) market is not scanned in v1 — silently ignored.
5. Scanner never writes to the database (pure function).
6. Scanner never throws on malformed input — all errors are logged and skipped.

## Backtest Price Provenance Policy (WI-0832)

Backtest and audit simulation paths must only use prices available before the event starts.

- Enforcement rule: `snapshot_time <= event_start - PRICE_BUFFER_MINUTES`
- Default `PRICE_BUFFER_MINUTES`: `60`
- Any game with no qualifying pre-game snapshot must be excluded from backtest/audit simulation scoring (never substituted with a closing line).
- If the excluded-game rate is `>= 20%`, the validation gate fails.

Validation command:

```bash
npm --prefix apps/worker run audit:validate-no-closing-line-sub
```

Optional report output:

```bash
npm --prefix apps/worker run audit:validate-no-closing-line-sub -- --out apps/worker/audit-output/manual/closing-line-substitution-report.json
```

---

## MispricingCandidate Output Schema

| Field              | Type                         | Description                                                              |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------ |
| `game_id`          | `string`                     | Game identifier from `odds_snapshots`                                    |
| `sport`            | `string`                     | Sport code (e.g. `NHL`, `NBA`)                                           |
| `market_type`      | `"SPREAD" \| "TOTAL" \| "ML"` | Market category                                                         |
| `selection`        | `string`                     | `HOME`, `AWAY`, `OVER`, or `UNDER`                                       |
| `source_book`      | `string`                     | The bookmaker being evaluated as the potential outlier                   |
| `consensus_books`  | `string[]`                   | Books used to build the consensus (excludes `source_book`)               |
| `source_line`      | `number \| null`             | Source book's line (`null` for ML — line not applicable)                 |
| `source_price`     | `number \| null`             | Source book's American-odds price                                        |
| `consensus_line`   | `number \| null`             | Median line across consensus books                                       |
| `consensus_price`  | `number \| null`             | Median price across consensus books                                      |
| `edge_type`        | `"LINE" \| "PRICE" \| "HYBRID"` | What dimension the disagreement is on                                 |
| `stale_delta`      | `number \| null`             | Reserved: seconds between source and consensus timestamps (always null in v1) |
| `implied_edge_pct` | `number \| null`             | Absolute implied probability difference (populated for ML; null for line markets) |
| `threshold_class`  | `"NONE" \| "WATCH" \| "TRIGGER"` | Severity of the detected disagreement                              |
| `reason_codes`     | `string[]`                   | Machine-readable codes explaining the classification (e.g. `LINE_DELTA_TRIGGER`) |
| `captured_at`      | `string`                     | ISO UTC timestamp from the source snapshot                               |

Only candidates with `threshold_class` of `WATCH` or `TRIGGER` are emitted. `NONE` candidates are suppressed.

---

## Threshold Table

### Line Markets (SPREAD, TOTAL)

Comparison is the absolute delta between `source_line` and median consensus line.

| Class     | Condition              |
| --------- | ---------------------- |
| `NONE`    | `delta < 0.5`          |
| `WATCH`   | `delta >= 0.5`         |
| `TRIGGER` | `delta >= 1.0`         |

### Moneyline (ML) — Near-Even Prices (|source price| ≤ 150 AND median |consensus price| ≤ 150)

Comparison is the absolute difference in implied probabilities.

| Class     | Condition                   |
| --------- | --------------------------- |
| `NONE`    | `implied_spread < 0.10`     |
| `WATCH`   | `implied_spread >= 0.10`    |
| `TRIGGER` | `implied_spread >= 0.20`    |

### Moneyline (ML) — Big Favorite / Big Dog (either side |price| > 150)

| Class     | Condition                  |
| --------- | -------------------------- |
| `NONE`    | `implied_edge < 0.03`      |
| `WATCH`   | `implied_edge >= 0.03`     |
| `TRIGGER` | `implied_edge >= 0.05`     |

---

## Failure Guards

| Scenario                        | Behaviour                                                        |
| ------------------------------- | ---------------------------------------------------------------- |
| `raw_data` is invalid JSON      | Log warn, skip snapshot, continue                                |
| Entry has `NaN` or string line  | Entry skipped (`parseFinite` returns `null`), warn logged        |
| Entry has `null` price          | Entry included for line comparison; price-based classification skipped |
| Duplicate book in same snapshot | First occurrence kept, duplicates discarded                      |
| Only 1 book in snapshot         | No candidate (coverage check: need ≥ 2 comparison books)         |
| Snapshot older than window      | Excluded before parsing                                          |
| `scanForMispricing` throws      | Error logged at top level, empty array returned                  |

---

## Configuration Options

```js
scanForMispricing(snapshots, {
  recencyWindowMs: 30 * 60 * 1000,  // default: 30 minutes
  minBooks: 2,                       // default: 2 comparison books required
  thresholds: {                      // override any threshold
    spread: { watch: 0.5, trigger: 1.0 },
    total:  { watch: 0.5, trigger: 1.0 },
    ml: {
      nearEven: { maxAbsPrice: 150, watch: 0.10, trigger: 0.20 },
      big:      { watch: 0.03, trigger: 0.05 },
    },
  },
})
```

---

## Per-Book Market Entry Shapes

These are parsed from `odds_snapshots.raw_data` → `markets.spreads / markets.totals / markets.h2h`.

**Spread entry:**
```js
{ book: string, home: number, away: number, price_home: number, price_away: number }
```

**Total entry:**
```js
{ book: string, line: number, over: number, under: number }
```

**H2H (ML) entry:**
```js
{ book: string, home: number, away: number }
```

---

## Manual Invocation

```bash
# Scan all default sports (NBA/NHL/MLB/NFL) with 30-minute recency window
node apps/worker/src/jobs/run_mispricing_scan.js
```

Output example:
```
[MispricingScan] NHL SPREAD: 3 candidates (2 WATCH, 1 TRIGGER)
[MispricingScan] NHL ML: 1 candidates (1 WATCH, 0 TRIGGER)
[MispricingScan] Total candidates: 4 across 3 games
```

---

## Scheduler Registration

Scheduler registration in `apps/worker/src/schedulers/main.js` is **intentionally deferred**. See WI-0811 coordination flag. The job must be explicitly added to the scheduler in a separate work item with a `needs-sync` flag to avoid conflicts with concurrent main.js changes.

---

## Open Questions / Deferred to v2

| Topic                     | Status                  | Decision needed                                                                     |
| ------------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| **Sharp-book subset**     | Deferred to v2          | Whether to compare only vs a curated "sharp book" set (Pinnacle, Circa, etc.)       |
| **PROP market support**   | Deferred to v2          | Schema for per-player per-prop multi-book comparison; needs new data contract       |
| **Scheduler cadence**     | TBD                     | How frequently to run (5-min tick? Hourly?); depends on odds pull frequency         |
| **Stale-delta tracking**  | v1 always null          | Track timestamp skew between source and consensus books; needs per-book `captured_at` |
| **Downstream consumers**  | None yet                | What acts on TRIGGER candidates? Discord alert? Pipeline flag? Separate WI needed  |
