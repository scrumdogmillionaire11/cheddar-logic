---
phase: mlb-k-harden
plan: all
type: summary
completed: "2026-04-03"
duration: "~30 minutes"
subsystem: mlb-model
tags: [mlb, pitcher-k, model-quality, audit, input-contract, quality-classifier]

dependency_graph:
  requires: [WI-0742, WI-0744]
  provides:
    - "classifyMlbPitcherKQuality pure function: FULL_MODEL | DEGRADED_MODEL | FALLBACK"
    - "Pre-model MLB_K_AUDIT per-pitcher log in run_mlb_model.js"
    - "INV-007 audit invariant enforcing proxy-exclusion rule"
    - "docs/mlb_projection_input_contract.md — canonical field tier table"
  affects: [WI-0745, future mlb_model quality reporting]

tech_stack:
  added: []
  patterns:
    - "Pure-function classifier module (zero imports, fully testable)"
    - "Pre-model completeness audit block logging structured JSON before k_mean"
    - "INV-007 audit invariant pattern matching INV-001 through INV-006 style"

key_files:
  created:
    - apps/worker/src/jobs/mlb-k-input-classifier.js
    - apps/worker/src/jobs/__tests__/mlb-k-input-classifier.test.js
    - apps/worker/src/audit/__tests__/audit_invariants.test.js
    - apps/worker/src/audit/fixtures/mlb/mlb_pitcher_k_proxy_degraded_01.json
    - docs/mlb_projection_input_contract.md
  modified:
    - apps/worker/src/jobs/run_mlb_model.js
    - apps/worker/src/audit/audit_invariants.js
    - apps/worker/src/audit/fixtures/mlb/mlb_pitcher_k_clean_01.json
    - apps/worker/src/audit/fixtures/mlb/mlb_pitcher_k_missing_data_01.json
    - WORK_QUEUE/COMPLETE/WI-0742.md
    - WORK_QUEUE/WI-0747.md

decisions:
  - "FALLBACK is correct tier when any FALLBACK_TRIGGER field (proxy or core miss) is present — not DEGRADED_MODEL"
  - "Pre-model audit reads proxy/missing signals from driver.prop_decision (set by mlb-model.js scorePitcherK) and maps them to classifier inputs — avoids reading DB twice"
  - "chase_pct_vs_hand absence is DEGRADED_OK, not FALLBACK_TRIGGER — aligns with WI-0742 spirit"
  - "INV-007 skips cards where prop_decision is null (PASS/UNQUALIFIED cards that never ran the K scorer)"

metrics:
  completed: "2026-04-03"
  tasks_completed: 8
  tests_added: 22
  tests_total_after: 112
---

# Phase mlb-k-harden: MLB K Pipeline Hardening Summary

**One-liner:** Deterministic `classifyMlbPitcherKQuality` classifier + pre-model `[MLB_K_AUDIT]` log + INV-007 invariant eliminates silent proxy substitution in the MLB pitcher-K pipeline.

---

## What Was Built

### Wave 1 — Classifier module + spec doc (Plans 01 + 02, parallel)

**`apps/worker/src/jobs/mlb-k-input-classifier.js`** — Pure-function module:
- `classifyMlbPitcherKQuality(inputs)` — single deterministic quality decision
- `buildCompletenessMatrix(starter, opponent, leash)` — per-pitcher audit object
- `dedupeFlags(flags)` — `[...new Set(flags)]`

The FALLBACK triggers are locked:
- `starter_whiff_proxy` present (no real `swstr_pct`/`csw_pct`)
- `ip_proxy` present (no real `pitch_count_avg`/`ip_avg`)
- `contact_pct_vs_hand` absent
- `k_pct_vs_hand` absent
- `starter_k_pct` absent

**`docs/mlb_projection_input_contract.md`** — Canonical field tier table: `FULL_MODEL_REQUIRED`, `DEGRADED_OK`, `FALLBACK_TRIGGER` — with full pseudocode, FALLBACK behavior description, and three open upstream questions.

**WI-0742 FALLBACK addendum** — Locks the semantics that were implied but never written down.

### Wave 2 — Runner wiring (Plan 03)

**`apps/worker/src/jobs/run_mlb_model.js`**:
- Requires `classifyMlbPitcherKQuality` and `dedupeFlags` from the new module
- Pre-model audit block in `pitcherKDriverCards.map()`, before card write:
  - Maps `driver.prop_decision.missing_inputs` + `degraded_inputs` → classifier inputs
  - Sets `prop_decision.model_quality`, `.proxy_fields`, `.degradation_reasons`
  - Deduplicates `missing_inputs` and `flags` via `dedupeFlags`
  - Emits `[MLB_K_AUDIT]` JSON log per pitcher per slate
- `payloadData.missing_inputs` also wrapped in `dedupeFlags` at card assembly

### Wave 3 — Audit enforcement (Plan 04)

**`audit_invariants.js` INV-007** (`checkMlbPitcherKQualityContract`):
1. `model_quality` must be `FULL_MODEL | DEGRADED_MODEL | FALLBACK`
2. `proxy_fields` non-empty → `model_quality` must be `FALLBACK`
3. `degradation_reasons` must be an array

**Fixtures updated:**
- `mlb_pitcher_k_clean_01.json` — adds `prop_decision_model_quality: "FULL_MODEL"`
- `mlb_pitcher_k_proxy_degraded_01.json` — new: McGreevy-style FALLBACK (whiff_proxy + no opp contact)
- `mlb_pitcher_k_missing_data_01.json` — adds `prop_decision_model_quality: "FALLBACK"`

---

## Test Results

| Suite | Tests | Status |
|-------|-------|--------|
| mlb-k-input-classifier.test.js | 10 | ✅ PASS |
| audit_invariants.test.js | 12 | ✅ PASS |
| All audit/__tests__/ (90 pre-existing + 12 new) | 102 | ✅ PASS |

---

## Commits

| Hash | Message |
|------|---------|
| `0fd53f0` | feat(mlb-k-harden): add MLB K input classifier module + 10 unit tests |
| `c7cecd6` | docs(mlb-k-harden): add MLB K input contract spec + WI-0742 FALLBACK addendum |
| `c669f00` | feat(mlb-k-harden): wire quality classifier into run_mlb_model.js |
| `e4c3b91` | feat(mlb-k-harden): INV-007 audit invariant and MLB_PITCHER_K fixtures |

---

## Deviations from Plan

**1. [Rule 1 - Bug] `allCorePresent()` test helper missing `chase_pct_vs_hand`**

- **Found during:** Task 2 (unit test writing)
- **Issue:** Classifier correctly flags absent `chase_pct_vs_hand` as `DEGRADED_MODEL`; test helper without it produced `DEGRADED_MODEL` instead of `FULL_MODEL`
- **Fix:** Added `chase_pct_vs_hand: 0.31` to `allCorePresent()` in test helper
- **Files modified:** `mlb-k-input-classifier.test.js`
- **Commit:** `0fd53f0`

**2. [Rule 1 - Bug] Plan 03 audit block reads proxy signals from existing `prop_decision` fields — not from raw DB row**

- **Found during:** Task 1 of Plan 03
- **Issue:** Pre-model audit block (as specified in plans) called to read `row.season_swstr_pct` etc., but by the time the `pitcherKDriverCards.map()` callback runs, there is no `row` — the model has already run and written `prop_decision.missing_inputs` / `degraded_inputs`
- **Fix:** Audit block maps the pre-existing `driver.prop_decision.missing_inputs` and `degraded_inputs` signals to classifier inputs rather than re-reading from DB. Still achieves the same diagnostic result: classifies quality, logs `[MLB_K_AUDIT]`, and sets `model_quality` on `prop_decision`.
- **Files modified:** `run_mlb_model.js`
- **Commit:** `c669f00`

---

## Open Questions (from WI-0747 — still unanswered)

These diagnostic questions require upstream audit; this WI provides the instrumentation to answer them but does not resolve them:

1. **Why `starter_whiff_proxy`?** — Per `[MLB_K_AUDIT]` logs, `scorePitcherK` in `mlb-model.js` pushes `'starter_whiff_proxy'` to `degradedInputs` when `starterSwStrPct` is null (line 1094). Root cause: `season_swstr_pct` is **always null** in `buildPitcherKObject` — the comment says "Statcast — null until pull_mlb_statcast is added." This is a missing ingest job, not a model bug.

2. **Why `IP_PROXY`?** — `leash_metric` is pushed to `hardMissing` when neither `pitch_count_avg` nor `ip_avg` is available. In `buildPitcherKObject`, `ip_avg = row.recent_ip`. This is populated, but `last_three_pitch_counts` may be null for thin-sample starters.

3. **Does upstream have `contact_pct_vs_hand`?** — WI-0744 documents that `mlb_team_batting_stats` table does not exist yet (`team_stats` is NHL-only). So `opp_contact_pct` is always null → always `FALLBACK` for opponent contact. This is a **dataset gap confirmed**, not a wiring bug.

---

## Next Phase Readiness

With this work in place, the three open questions above have instrumented answers available on the next model run (`[MLB_K_AUDIT]` logs). The next sprint should be:

1. **Add `pull_mlb_statcast` ingest job** — resolves `starter_whiff_proxy` for most pitchers (WI-0744 or new WI)
2. **Add `mlb_team_batting_stats` table + pull job** — resolves `opp_contact_profile` (WI-0744)
3. Once both are wired: most cards should promote from `FALLBACK` → `FULL_MODEL` or at worst `DEGRADED_MODEL`
