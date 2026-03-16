---
phase: 48-wi-0435-projection-contract-alignment
plan: 01
subsystem: data-validation
tags: [documentation, contracts, card-payload, data-contracts]
dependency_graph:
  requires: []
  provides: [explicit write-path/read-path contract in card-payload.js, validator-to-route alignment in DATA_CONTRACTS.md]
  affects: [packages/data/src/validators/card-payload.js, docs/DATA_CONTRACTS.md]
tech_stack:
  added: []
  patterns: [contract documentation in file headers, cross-reference to DATA_CONTRACTS.md]
key_files:
  created: []
  modified:
    - packages/data/src/validators/card-payload.js
    - docs/DATA_CONTRACTS.md
decisions:
  - "No code changes — documentation only. All four test suites confirmed unaffected."
  - "Historical-only endpoints (server/model-outputs, /api/models/*, etc.) are explicitly called out as non-runtime to prevent future confusion."
metrics:
  duration: "~2 minutes"
  completed: "2026-03-16"
  tasks_completed: 3
  files_changed: 2
---

# Phase 48 Plan 01: WI-0435 Projection/Card Contract Alignment Summary

**One-liner:** Added explicit write-path/read-path/backward-compat contract block to card-payload.js header and validator-to-route alignment bullet to DATA_CONTRACTS.md with zero behavior changes.

## What Was Done

Documentation-only changes to make the card_payloads pipeline contract explicit:

1. **card-payload.js header replaced** — Sparse 3-line comment replaced with a structured CONTRACT block naming the write path (worker jobs → packages/data → card_payloads), the three active read surfaces (/api/games, /api/cards, /api/cards/[gameId]), the backward-compat policy (cross-reference to Legacy Alias Policy table in DATA_CONTRACTS.md), and the historical-only endpoint list.

2. **DATA_CONTRACTS.md updated** — New "Validator-to-route alignment" bullet inserted in the Betting Card Validation (Zod) Rules section immediately after the `deriveLockedMarketContext(...)` bullet. States card-payload.js is the single write-path boundary and names the three active read surfaces.

3. **API route files verified** — All three routes already contained "deprecated references only" comments. No edits were needed.

## Test Results

| Suite | Result |
|-------|--------|
| cards-total-projection-source | PASSED |
| cards-1p-projection-source | PASSED |
| test:decision:canonical | 32/32 PASSED |
| run_nhl_model.market-calls | 6/6 PASSED |

## Commits

| Hash | Message |
|------|---------|
| b5d4f05 | docs(48-01): replace card-payload.js header with explicit contract block |
| b753fd3 | docs(48-01): add validator-to-route alignment note in DATA_CONTRACTS.md |
| 8922015 | chore(48-01): verify API route deprecated comments + all 4 test suites pass |

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

- [x] packages/data/src/validators/card-payload.js — modified, loads cleanly (validateCardPayload: function)
- [x] docs/DATA_CONTRACTS.md — "Validator-to-route alignment" at line 796
- [x] All three GET route files contain "deprecated references only" (grep returned 3)
- [x] All four test suites passed
- [x] Commits b5d4f05, b753fd3, 8922015 exist in working-branch

## Self-Check: PASSED
