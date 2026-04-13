---
phase: discord-3layer
plan: "02"
subsystem: discord-pipeline
tags: [discord, webhook, layer-b, bucket-classification, canonical-fields, test-fixtures]

dependency_graph:
  requires: [discord-3layer-01]
  provides:
    - "Layer B: Discord reads canonical webhook_* fields, never computes thresholds"
    - "classifyNhlTotalsBucketStatus deleted from Discord layer"
    - "classifyNhlTotalsStatus import removed from post_discord_cards.js"
    - "All four bucket/eligibility/side/lean functions are canonical-first"
  affects:
    - "All sports and markets that pass through post_discord_cards.js"

tech_stack:
  added: []
  patterns:
    - "Layer B read pattern: if (typeof canonicalField === X) return canonicalField; else fallback()"
    - "Test stamping pattern: stampNhlTotals(pd) simulates model-runner → publisher pipeline in test fixtures"

key_files:
  created: []
  modified:
    - apps/worker/src/jobs/post_discord_cards.js
    - apps/worker/src/jobs/__tests__/post_discord_cards.test.js

decisions:
  - id: "discord-layer-b-canonical-read"
    decision: "Discord bucket/eligibility/side/lean functions read canonical webhook_* fields first; legacy fallback kept for pre-deploy payloads"
    rationale: "Backward-safe migration — existing DB rows without webhook_* fields still process correctly"
  - id: "pass-blocked-upstream-filter"
    decision: "pass_blocked cards are excluded in isDisplayableWebhookCard before byGame grouping; sectionCounts.passBlocked only counts legacy-path leakage"
    rationale: "Canonical path: webhook_eligible=false means card never groups; passBlocked counter is legacy-only"
  - id: "test-fixture-stamp-helper"
    decision: "stampNhlTotals(pd) helper in test file calls classifyNhlTotalsStatus + computeWebhookFields to simulate model-runner + publisher"
    rationale: "Tests must prove the full Layer A → B contract, not just Discord inference"

metrics:
  duration: "~30min"
  completed: "2026-04-13"
  tests_passing: 99
  tests_added: 0
  tests_fixed: 10
---

# Phase discord-3layer Plan 02: Layer B — Discord reads canonical webhook fields

## One-liner
Discord bucket/eligibility/side/lean functions simplified to canonical `webhook_*` reads; `classifyNhlTotalsBucketStatus` deleted and `classifyNhlTotalsStatus` import removed.

## What Was Built

### Layer B simplification in `post_discord_cards.js`

Four functions now use canonical-first pattern:

| Function | Before | After |
|----------|--------|-------|
| `classifyDecisionBucket` | Ran 80-line NHL total classifier + 1P/action inference | Reads `webhook_bucket` first; legacy fallback preserved |
| `isDisplayableWebhookCard` | ~70-line field analysis | Reads `webhook_eligible` first; legacy fallback preserved |
| `selectionSummary` | 15-path waterfall from the top | Reads `webhook_display_side` first; waterfall unchanged below |
| `passesLeanThreshold` | Edge parsing + threshold math | Reads `webhook_lean_eligible` first; edge parsing unchanged below |

- `classifyNhlTotalsBucketStatus()` — deleted (103 LOC removed)
- `classifyNhlTotalsStatus` import — removed

### Test fixtures updated

All WI-0934 NHL totals test fixtures now call `stampNhlTotals(pd)`, which:
1. Calls `classifyNhlTotalsStatus` using `edge` as the directional delta
2. Stamps `nhl_totals_status` on the payload
3. Calls `computeWebhookFields` to stamp `webhook_bucket/eligible/display_side/lean_eligible/reason_code`

This correctly simulates production: `run_nhl_model.js` → `classifyNhlTotalsStatus` → `publishDecisionForCard` → `computeWebhookFields`.

## Deviations from Plan

### Auto-fixed: `passBlocked` counter assertion

- **Found during:** Slate regression test
- **Issue:** `sectionCounts.passBlocked` assertion expected `1` for NYR/FLA (PASS under OVER 6.5 fragility). With canonical path, `webhook_eligible=false` cards are filtered in `isDisplayableWebhookCard` before grouping, so they never reach the game loop `passBlocked` counter.
- **Fix:** Updated assertion from `.toBe(1)` to `.toBe(0)` with explanatory comment.
- **Contract change:** `passBlocked` counter is now explicitly legacy-only. Tests document this.

### Auto-fixed: Import path

- **Found during:** First test run
- **Issue:** Import path `'../models/nhl-totals-status'` incorrect from `__tests__/` subdirectory
- **Fix:** Changed to `'../../models/nhl-totals-status'`

## Architecture Verification

Layer A → Layer B contract is proven by tests:

```
run_nhl_model.js (not tested here — tested in market-calls test)
  → classifyNhlTotalsStatus(edge, line, side, integrityOk, goalieFlags, accel)
  → stamps nhl_totals_status.status = 'PLAY' | 'SLIGHT EDGE' | 'PASS'
  → publishDecisionForCard → computeWebhookFields
  → stamps webhook_bucket = 'official' | 'lean' | 'pass_blocked'

post_discord_cards.js (this plan)
  → classifyDecisionBucket reads webhook_bucket first
  → isDisplayableWebhookCard reads webhook_eligible first
  → selectionSummary reads webhook_display_side first
  → passesLeanThreshold reads webhook_lean_eligible first
  → ZERO inference from raw model fields in Discord
```

## Commits

| Hash | Message |
|------|---------|
| `cfbae4c2` | feat(discord-3layer-02): simplify discord layer to read canonical webhook fields |
| `a63df26f` | test(discord-3layer-02): fix WI-0934 NHL totals fixtures to simulate model-runner stamp |

## Tests

- **Suites:** post_discord_cards.test.js + decision-publisher.v2.test.js
- **Passing:** 99/99
- **Fixed in this plan:** 10 (all WI-0934 NHL totals policy tests)
