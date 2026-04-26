---
phase: WI-0811
plan: WI-0811
subsystem: models
tags: [mispricing, cross-book, odds, scanner, sprint-2]
requires: [odds-snapshot-ingestion]
provides: [mispricing-scanner, run_mispricing_scan, mispricing_scanner.md]
affects: [WI-0824, downstream execution-gate consumers]
tech-stack:
  added: []
  patterns: [pure-stateless-function, median-consensus, configurable-threshold]
key-files:
  created:
    - packages/models/src/mispricing-scanner.js
    - packages/models/src/__tests__/mispricing-scanner.test.js
    - apps/worker/src/jobs/run_mispricing_scan.js
    - docs/models/mispricing_scanner.md
  modified: []
decisions:
  - "Scheduler registration deferred per coordination flag (needs-sync); run_mispricing_scan.js exposes CLI entrypoint only"
  - "PROP market intentionally excluded from v1; silently ignored"
  - "Forbidden-terms assertion (bet/play/recommend) enforced at runtime on every emitted candidate"
  - "Recency window and minBooks configurable; defaults 30 min / 2 books"
metrics:
  duration: "~1 session"
  completed: "2026-04-10"
---

# Phase WI-0811: Book-to-Book Mispricing Scanner Summary

**One-liner:** Stateless cross-book mispricing scanner grouping same-event/market prices, building median consensus, and emitting `MispricingCandidate` objects classified as NONE/WATCH/TRIGGER — zero recommendation language enforced by runtime assertion.

## What Was Built

### `packages/models/src/mispricing-scanner.js` (561 lines)

Pure stateless export `scanForMispricing(snapshots, config) → MispricingCandidate[]`.

- **Step 1 – Normalize:** Per-market type entry normalizers (`normalizeSpreadEntry`, `normalizeTotalEntry`, `normalizeH2hEntry`) validate numeric values, log warnings and skip malformed rows.
- **Step 2 – Deduplicate:** `deduplicateByBook` removes duplicate same-book rows by keeping first occurrence.
- **Step 3 – Consensus:** Builds median reference from all books *excluding* source book; rejects if `< minBooks` comparison books remain.
- **Step 4 – Classify:** `classifyLineDelta` for SPREAD/TOTAL; `classifyML` with near-even vs big-favorite path.
- **Step 5 – Emit:** Candidate objects match the `MispricingCandidate` schema exactly; `assertNoForbiddenTerms` runs on every candidate before push.
- **Recency gate:** Snapshots older than `recencyWindowMs` (default 30 min) are silently excluded.

### `packages/models/src/__tests__/mispricing-scanner.test.js` (664 lines)

43 assertions covering all acceptance test cases from WI-0811:

- Spread 0.5 delta → WATCH; 1.0 delta → TRIGGER
- ML 15¢ implied spread → WATCH at near-even price
- Fewer than 2 comparison books → no candidate
- Snapshot outside recency window → ignored
- Mixed market types → not compared
- Missing prices → skipped, no crash
- Duplicate same-book rows → deduped correctly
- Malformed line value → skipped with warning
- Unsupported market type → rejected gracefully
- 4-book event → expected candidate set produced
- Aligned market → no candidate emitted
- Consensus excludes target book

### `apps/worker/src/jobs/run_mispricing_scan.js` (101 lines)

Worker job using `getOddsSnapshots` (per sport, configurable recency window). Logs candidate counts grouped by `sport:market_type` with WATCH/TRIGGER breakdown. CLI entrypoint via `require.main === module`. Scheduler registration deferred per `needs-sync` coordination flag.

### `docs/models/mispricing_scanner.md` (167 lines)

Spec doc covering: purpose/invariants, `MispricingCandidate` schema, threshold tables, failure guard mapping, configuration reference, open questions.

## Tests Run

| Suite | Result | Notes |
| --- | --- | --- |
| `packages/models` mispricing-scanner | **43/43 pass** | All WI-0811 acceptance test cases covered |
| `packages/models` full suite | **51/51 pass** (2 suites skipped due to pre-existing node:test/Jest conflict) | Pre-existing failures unrelated to WI-0811 |
| `apps/worker` full suite | **1348/1359 pass** (1 pre-existing settlement-mirror failure, 10 skipped) | Pre-existing failures unrelated to WI-0811 |

## Decisions Made

| Decision | Rationale |
| --- | --- |
| Scheduler registration deferred | WI-0811 coordination flag: `needs-sync` if `main.js` touched; job ships as CLI-invokable only |
| PROP market excluded v1 | WI-0811 spec explicit: skip unless canonical player+stat+line match is solid |
| Forbidden term runtime assertion | Invariant 1 from WI-0811: no candidate field or reason_code may contain "bet", "play", or "recommend" |
| Median not mean for consensus | Failure guard: thin market / bad consensus resistance per WI-0811 invariants |
| Float rounding in ML classification | `Math.round(x * 1e6) / 1e6` prevents boundary failures (e.g. 0.0999... vs 0.10) |

## Deviations from Plan

None — implementation executed exactly as scoped in WI-0811.

## Acceptance Criteria — All Met

- [x] Scanner groups same-event same-market same-selection prices across books
- [x] Scanner computes consensus from books excluding source book
- [x] Scanner emits candidate only when configured threshold is breached
- [x] Scanner supports spread line delta, total line delta, and moneyline price mispricing
- [x] Scanner rejects: insufficient books, mixed lines, stale snapshots outside recency window
- [x] Output includes source book, consensus reference, stale delta, implied edge, threshold class, reason codes
- [x] Job logs candidate count grouped by sport and market type
- [x] No consumer is forced to treat candidates as official plays
- [x] `docs/models/mispricing_scanner.md` covers schema, thresholds, invariants
- [x] No scope creep into recommendation or model logic
