---
phase: ime-01-independent-market-eval
plan: "05"
subsystem: market-eval-contract
tags: [contract-doc, market-eval, validation, exports]
requires:
  - ime-01-01
  - ime-01-02
  - ime-01-03
  - ime-01-04
provides:
  - docs/market_evaluation_contract.md
  - VALID_STATUSES
  - VALID_MARKET_TYPES
  - assertNoSilentMarketDrop-enhanced
affects: []
tech-stack:
  added: []
  patterns: [contract-documentation, frozen-validation-arrays]
key-files:
  created:
    - docs/market_evaluation_contract.md
  modified:
    - packages/models/src/market-eval.js
decisions:
  - VALID_STATUSES and VALID_MARKET_TYPES placed before assertNoSilentMarketDrop in file to avoid const TDZ
  - assertNoSilentMarketDrop extended with terminal-state and reason_codes shape checks before count invariant
  - ML market normalised to MONEYLINE in VALID_MARKET_TYPES to match normaliseMarketType output
metrics:
  duration: "~20 minutes"
  completed: "2026-04-13"
  tasks_completed: 2
  files_changed: 2
---

# Phase ime-01 Plan 05: Market Evaluation Contract & Validation Exports Summary

**One-liner:** Write `docs/market_evaluation_contract.md` (shapes, REASON_CODES, invariants, smoke tests, forbidden behaviors) and export `VALID_STATUSES`/`VALID_MARKET_TYPES` from market-eval.js with extended `assertNoSilentMarketDrop`.

## Objective

Lock the IME contract in writing and export typed validation arrays so downstream code can verify compliance. Addresses audit finding that silent market drops are invisible to operators.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Write docs/market_evaluation_contract.md | 40a4e35 | docs/market_evaluation_contract.md |
| 2 | Export VALID_STATUSES and VALID_MARKET_TYPES; extend assertNoSilentMarketDrop | 40a4e35 | packages/models/src/market-eval.js |

## Implementation Details

### market-eval.js additions

- `VALID_STATUSES`: frozen array of 9 terminal status strings (placed before `assertNoSilentMarketDrop`)
- `VALID_MARKET_TYPES`: frozen array of 10 market type tokens
- `assertNoSilentMarketDrop`: extended with terminal-state check (`VALID_STATUSES.includes(r.status)`) and reason_codes shape check before count invariant

### docs/market_evaluation_contract.md

Covers: Overview, `MarketEvalResult` shape, `GameMarketEvaluation` shape, all 10 `REASON_CODES`, 3 invariants, `assertNoSilentMarketDrop` contract, forbidden cross-market behaviors, 3 smoke test scenarios (MLB multi-qualify, NHL TOTAL+ML, empty-edge game), `VALID_STATUSES` and `VALID_MARKET_TYPES` reference, module exports table.

## Test Coverage

| Suite | Tests | Result |
|-------|-------|--------|
| packages/models (all) | 79/79 | PASS |

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

- [x] `docs/market_evaluation_contract.md` exists
- [x] Contains `UNACCOUNTED_MARKET_RESULTS` and `DUPLICATE_MARKET_SUPPRESSED`
- [x] `VALID_STATUSES` exports as frozen array of length 9
- [x] `VALID_MARKET_TYPES` exports as frozen array of length 10
- [x] `assertNoSilentMarketDrop` includes `VALID_STATUSES.includes(r.status)` check
- [x] Commit 40a4e35 exists, 79 tests pass

## Self-Check: PASSED
