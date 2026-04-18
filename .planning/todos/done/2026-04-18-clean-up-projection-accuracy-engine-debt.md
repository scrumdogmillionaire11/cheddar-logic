---
created: 2026-04-18T10:56:48.162Z
title: Clean up projection accuracy engine debt
area: database
files:
  - WORK_QUEUE/WI-1009.md
  - packages/data/db/migrations/080_create_projection_accuracy_evals.sql
  - packages/data/db/migrations/081_projection_accuracy_confidence_engine.sql
  - packages/data/src/db/projection-accuracy.js
  - packages/data/__tests__/projection-accuracy-engine.test.js
  - web/src/app/api/results/projection-accuracy/route.ts
  - web/src/__tests__/api-results-projection-accuracy.test.js
---

## Problem

WI-1009 shipped the Projection Accuracy Evaluation + Confidence Engine as an additive layer over existing projection accuracy/proxy infrastructure. It is functional and tested, but several legacy seams remain and should be addressed after the feature is stable:

- `projection_accuracy_line_evals` still inherits the original table-level `UNIQUE(card_id, line_role)` from migration 080. Migration 081 adds a `UNIQUE(card_id, eval_line)` index and the runtime uses `INSERT OR IGNORE`, but SQLite cannot drop the old table constraint without a table rebuild. This is acceptable for compatibility, but the final schema should be normalized once production migration safety is planned.
- Existing rows created before 081 will not have `projection_raw`, `synthetic_line`, `synthetic_direction`, `failure_flags`, `projection_confidence`, expected probabilities, or calibration buckets backfilled. Reporting can read nulls, but historical market health will be incomplete until a worker-owned backfill is added.
- The older `projection_proxy_evals` / `getProjectionAccuracySummary` path still coexists with the new `projection_accuracy_evals` engine. This preserves compatibility, but it leaves two projection-evaluation concepts in the codebase that future work can confuse.
- Market trust status is recomputed when grading rows and summarized read-side, but there is no explicit nightly worker-owned materialization job yet. The user-facing plan called for nightly market-level health computation.
- `/api/results/projection-accuracy` has a source-contract test but not a seeded database route test that asserts live payload shape, filters, weak-direction counts, calibration, and read-only teardown behavior.
- The v1 confidence score falls back to neutral historical bucket hit rate and default variance until enough settled rows exist. This is deterministic, but future calibration work should make the transition from neutral priors to empirical buckets explicit and auditable.

## Solution

Create a follow-up work item after WI-1009 lands:

1. Rebuild `projection_accuracy_line_evals` in a new migration if needed so `(card_id, eval_line)` is the canonical uniqueness rule and legacy `(card_id, line_role)` no longer constrains common-line simulations.
2. Add a worker-owned backfill for existing projection accuracy rows, preserving raw projection integrity and flagging rows where reconstruction is impossible.
3. Decide whether `projection_proxy_evals` remains a separate legacy report or should be consolidated behind the new projection accuracy API.
4. Add a nightly market-health materialization job owned by the worker, with tests for `INSUFFICIENT_DATA`, `NOISE`, `WATCH`, `TRUSTED`, and `SHARP`.
5. Add a seeded `/api/results/projection-accuracy` route test that exercises real DB rows instead of only source-contract assertions.
6. Document confidence-score priors and the minimum-sample transition from neutral priors to empirical bucket hit rate and market variance.
