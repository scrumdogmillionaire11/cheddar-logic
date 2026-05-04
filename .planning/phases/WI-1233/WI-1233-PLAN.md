---
phase: WI-1233-surface-stability-calibration-roadmap
status: ready-for-execution
work_item: WI-1233
coordination: solo
depends_on: none
---

# WI-1233 Plan

## Objective

Turn the current “too many `SLIGHT_EDGE` outputs and not enough stable surface confidence” concern into an execution sequence that:

1. hardens the public surfaces
2. uses production data to redefine confidence/projection quality
3. determines whether the top of the current `SLIGHT_EDGE` cohort should become `PLAY`

## What The Codebase Already Has

### Existing promotion path

- High-end `LEAN -> PLAY` promotion already exists in `packages/models/src/decision-pipeline-v2.js`.
- Promotion scope is intentionally narrow and market-specific in `packages/models/src/decision-pipeline-v2-edge-config.js`.

### Existing calibration assets

- Calibration reports: `apps/worker/src/jobs/run_calibration_report.js`
- Isotonic fitting: `apps/worker/src/jobs/fit_calibration_models.js`
- Telemetry and tier audit: `apps/worker/src/jobs/report_telemetry_calibration.js`
- Drift reporting: `apps/worker/src/audit/performance_drift_report.js`
- Projection accuracy evaluation: `apps/worker/src/audit/projection_evaluator.js`

### Existing hardening lanes

- Visibility integrity: `WI-1232`
- Visibility monitoring: `WI-1229`
- FPL frozen-route cleanup: `WI-1223`
- NHL shadow-eval calibration infrastructure: `WI-1231`
- Completed calibration baseline precursor: `WI-1228`

## Phase 1: Stabilize Surface Authority

### Goal

Make it reliable that valid actionable rows appear where they are supposed to appear, and only there.

### Primary lanes

- `WI-1232`
- `WI-1229`
- `WI-1223`

### Required outcomes

- `/api/games` and `/wedge` stop dropping valid actionable rows for visibility-contract reasons.
- `/results` keeps strict display-proof semantics for odds-backed rows.
- `/results/projections` keeps projection-only visibility without contract drift.
- `/fpl` no longer behaves like an active product surface while the domain is frozen.
- `/api/cards/[gameId]` no longer suppresses unrelated cards after one settled card in the same game.
- surface dedupe keys stop collapsing distinct prop or multi-market rows into one row by `card_type`.
- stale/degraded `/api/games` fallback modes become visible user-facing states, not just console warnings.

### Exit criteria

- Missing-row reasons are deterministic and monitored.
- Surface discrepancies are visible in health reporting.
- FPL exposure matches frozen-domain policy.

## Phase 2: Build a Production-Data Baseline

### Goal

Create one empirical baseline for confidence, projection quality, and actionability by sport/market/family.

### Use these existing commands and assets

- `npm --prefix apps/worker run job:report-telemetry-calibration -- --json --days 30`
- `npm --prefix apps/worker run job:report-telemetry-calibration -- --json --days 90`
- `node apps/worker/src/audit/performance_drift_report.js --all`

### Questions this phase must answer

1. By sport-market, what share of rows end as `PLAY`, `LEAN`, `PASS`, and canonical `WATCH`?
2. Which reason codes most often block or demote would-be plays?
3. Which settled cohorts have positive CLV, acceptable ECE, and acceptable win rate?
4. Which projection families have stable bias / MAE / directional accuracy?
5. Which displayed rows are profitable but still below current promotion or POTD thresholds?
6. Which operational failures are currently masked by green job status or schema-blind readiness?

### Deliverables

- blocker frequency table by sport-market
- settled performance table by sport-market-family
- projection bias / MAE / directional accuracy table by family
- confidence-band calibration table comparing predicted bands vs actual outcomes
- health/readiness gap list for fail-open jobs and schema-blind routes
- split-brain config list where worker gates and shared-package thresholds disagree

### Exit criteria

- The team can identify whether the bottleneck is:
  - model quality
  - market cleanliness rails
  - projection confidence semantics
  - read-surface suppression

## Phase 3: Redefine Confidence From Production Data

### Goal

Stop treating confidence as mixed legacy metadata and make it a measurable contract.

### Focus files for follow-up execution

- `apps/worker/src/jobs/report_telemetry_calibration.js`
- `apps/worker/src/audit/projection_evaluator.js`
- `web/src/app/api/results/projection-settled/route.ts`
- `web/src/lib/results/query-layer.ts`
- `web/src/app/api/admin/model-health/route.ts`

### Proposed approach

- Define per-family confidence evaluation inputs:
  - odds-backed families: ECE, Brier, CLV, win rate
  - projection families: MAE, bias, directional accuracy, calibration buckets
- Normalize output into one confidence contract:
  - raw score
  - band
  - sample size
  - source
  - last refreshed at
- Keep the contract additive first. Do not immediately make it a hard play gate.
- Scheduler-wire `projection_accuracy_health` or equivalent materialization so projection market-health reads are current by default.
- Remove threshold drift between worker gating and shared calibration utilities before trusting any single confidence report as authoritative.

### Exit criteria

- Confidence labels mean the same thing across results, projection settlement, and admin health.
- Confidence can be audited against recent settled production data.
- The team can distinguish odds-backed confidence health from projection-family confidence health without split-brain thresholds.

## Phase 4: Audit the Upper `SLIGHT_EDGE` Cohort

### Goal

Determine whether the top end of today’s `SLIGHT_EDGE` pool should stay as-is, be promoted via existing logic, or be split into a new “plays” slice.

### Important rule

Do not lower global `PLAY` thresholds first.

### Evaluate three buckets separately

1. `LEAN` rows already eligible for current high-end promotion but blocked by cleanliness or blocker reasons
2. `LEAN` rows just below the current promotion registry thresholds
3. canonical `WATCH` rows that started as `LEAN` but were softened downstream by market/data blockers

### Candidate levers

- widen promotion coverage to additional sport-market pairs
- lower promotion-only thresholds for profitable, well-calibrated cohorts
- loosen specific demoters where production outcomes justify it
- create a display-only “top slight edges” slice without changing model status
- create a separate surfaced “Plays” slice from upper-cohort `LEAN` rows only if the cohort is measurably stable and visibility-integrity-safe

### Exit criteria

- Any change is tied to settled production evidence for a specific sport-market-family.
- No global threshold change is made without a market-by-market audit.

## Phase 5: POTD Integration Decision

### Goal

Decide whether the most stable upper `SLIGHT_EDGE` cohort should feed POTD or a separate “plays” surface.

### Inputs

- POTD shadow candidate outcomes
- near-miss settlement history
- promotion-cohort performance from Phase 4

### Rules

- POTD should consume only cohorts with evidence of stable edge and stable surface visibility.
- If the cohort is profitable but not POTD-grade, route it to a separate “plays” slice rather than weakening POTD standards.
- POTD health must be production-readable before this becomes an operational dependency.

## Recommended Execution Order

1. Finish the surface-integrity lanes already in flight: `WI-1232`, `WI-1229`, `WI-1223`
2. Harden health/readiness semantics so failures stop masquerading as green runs
3. Run the production-data baseline and blocker audit
4. Redefine confidence/projection contract from production evidence
5. Audit and possibly widen the upper `SLIGHT_EDGE` promotion slice
6. Revisit POTD eligibility only after phases 1-5 are stable

## Non-Goals

- No repo-wide threshold loosening
- No blanket promotion of `SLIGHT_EDGE` to `PLAY`
- No mixing projection-only rows into betting results
- No attempt to reactivate frozen FPL feature work without lifting the domain freeze
