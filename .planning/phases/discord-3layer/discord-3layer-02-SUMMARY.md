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
    - "All four bucket/eligibility/side/lean functions are canonical-first with legacy fallbacks"
    - "9 canonical-path tests verify direct field reading behavior"
  affects:
    - "All sports and markets that pass through post_discord_cards.js"

tech_stack:
  added: []
  patterns:
    - "Layer B read pattern: if (typeof canonicalField === X) return canonicalField; else fallback()"
    - "Test stamping pattern: stampNhlTotals(pd) simulates model-runner → publisher pipeline in test fixtures"
    - "Direct function testing: internal helpers exported for unit-level canonical path verification"

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
  - id: "export-internal-helpers"
    decision: "Exported classifyDecisionBucket, classifyDecisionBucketLegacy, selectionSummary, passesLeanThreshold for direct testing"
    rationale: "Direct unit tests are clearer than indirect testing via buildDiscordSnapshot; easier to debug canonical precedence logic"

metrics:
  duration: "~35min total (prior: ~30min, this session: ~5min)"
  completed: "2026-04-13"
  tests_passing: 111
  tests_added: 9
  tests_fixed_prior: 10
---

# Phase discord-3layer Plan 02: Layer B — Discord reads canonical webhook fields

## One-liner
Discord bucket/eligibility/side/lean functions simplified to canonical `webhook_*` reads; `classifyNhlTotalsBucketStatus` deleted; `classifyNhlTotalsStatus` import removed; 9 canonical-path tests added.

## What Was Built

### Layer B simplification in `post_discord_cards.js`

Four functions now use canonical-first pattern:

| Function | Before | After |
|----------|--------|-------|
| `classifyDecisionBucket` | Ran 80-line NHL total classifier + 1P/action inference | Reads `webhook_bucket` first; legacy fallback preserved |
| `isDisplayableWebhookCard` | ~70-line field analysis | Reads `webhook_eligible` first; legacy fallback preserved |
| `selectionSummary` | 15-path waterfall from the top | Reads `webhook_display_side` first; waterfall unchanged below |
| `passesLeanThreshold` | Edge parsing + threshold math | Reads `webhook_lean_eligible` first; edge parsing unchanged below |

- `classifyNhlTotalsBucketStatus()` — deleted (103 LOC removed, prior work)
- `classifyNhlTotalsStatus` import — removed (line 17, corrected in this session)

### Test enhancements (this session)

- Exported internal helpers: `classifyDecisionBucket`, `classifyDecisionBucketLegacy`, `selectionSummary`, `passesLeanThreshold`
- Added 9 canonical-path tests in new `describe('canonical webhook fields path')` block
- Tests verify direct reads of all four canonical fields with expected return values
- Tests verify fallback behavior when canonical field absent

### Test fixtures updated (prior work)

All WI-0934 NHL totals test fixtures now call `stampNhlTotals(pd)`, which:
1. Calls `classifyNhlTotalsStatus` using `edge` as the directional delta
2. Stamps `nhl_totals_status` on the payload
3. Calls `computeWebhookFields` to stamp `webhook_bucket/eligible/display_side/lean_eligible/reason_code`

This correctly simulates production: `run_nhl_model.js` → `classifyNhlTotalsStatus` → `publishDecisionForCard` → `computeWebhookFields`.

## Deviations from Plan

### None in this session

Work executed exactly as specified:
- ✅ Task 1: Remove unused import, ensure all canonical reads present in functions
- ✅ Task 2: Add canonical-path tests covering all four functions

### Prior session deviations (documented in earlier commits)

1. **Auto-fixed: `passBlocked` counter assertion** — Updated assertion from `.toBe(1)` to `.toBe(0)` with explanatory comment (canonical-path cards filtered upstream)

2. **Auto-fixed: Import path** — Corrected `'../models/nhl-totals-status'` to `'../../models/nhl-totals-status'` from test subdirectory

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
| `e14e3472` | docs(discord-3layer-02): complete Layer B plan — Discord reads canonical webhook fields |
| `df643148` | WI-0935/discord-3layer-02: Remove Discord inference functions with canonical webhook field reads (this session) |

## Tests

- **Test Files:** post_discord_cards.test.js + decision-publisher.v2.test.js
- **Passing:** 111/111 (66 decision-publisher + 45 Discord)
- **Added in this session:** 9 canonical-path tests
- **Fixed in prior session:** 10 (all WI-0934 NHL totals policy tests)
- **Coverage:**
  - classifyDecisionBucket (4 tests: official, lean, pass_blocked, fallback)
  - isDisplayableWebhookCard (2 tests: true, false)
  - passesLeanThreshold (2 tests: true, false)
  - selectionSummary (1 test: returns OVER)
  - All prior WI-0934 tests still passing (36 original)
