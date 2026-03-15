---
phase: 44-wi-0437-soccer-data-hardening-tier-1-mar
plan: "01"
subsystem: soccer-model
tags: [soccer, ohio-scope, tier1-markets, validator, data-hardening]
dependency_graph:
  requires: []
  provides:
    - normalizeToCanonicalSoccerMarket (run_soccer_model.js)
    - buildSoccerTier1Payload (run_soccer_model.js)
    - soccerOhioScopeSchema (card-payload.js)
  affects:
    - apps/worker/src/jobs/run_soccer_model.js
    - packages/data/src/validators/card-payload.js
    - apps/worker/src/jobs/__tests__/run_soccer_model.test.js
    - web/src/__tests__/canonical-play-decision.test.js
tech_stack:
  added: []
  patterns:
    - Ohio allowlist routing via normalizeToCanonicalSoccerMarket
    - Degradation emitter: missing_context_flags + structured pass_reason
    - Price cap enforcement at builder + validator layers
    - soccer-ohio-scope skips deriveLockedMarketContext (self-contained validator)
key_files:
  created: []
  modified:
    - apps/worker/src/jobs/run_soccer_model.js
    - packages/data/src/validators/card-payload.js
    - apps/worker/src/jobs/__tests__/run_soccer_model.test.js
    - web/src/__tests__/canonical-play-decision.test.js
decisions:
  - "PASS cards (pass_reason set) are structurally valid per soccerOhioScopeSchema — validator accepts them to allow clean downstream routing"
  - "deriveLockedMarketContext skipped for soccer-ohio-scope; the schema is self-contained and does not use SPREAD/TOTAL/MONEYLINE market key format"
  - "Price cap enforcement at two layers: builder sets pass_reason=PRICE_CAP_VIOLATION, validator adds schema error — both signal independently"
metrics:
  duration: "3 minutes"
  completed_date: "2026-03-15"
  tasks_completed: 3
  files_modified: 4
---

# Phase 44 Plan 01: Soccer Data Hardening Tier 1 Market Payloads Summary

**One-liner**: Ohio-scoped canonical market router + Tier 1 packet builders (player_shots, team_totals, TSOA) with structured degradation emitter and zod validator hard-bouncer.

## What Was Built

### Task 1: Canonical market router + Tier 1 packet builders (run_soccer_model.js)

Added the following to `apps/worker/src/jobs/run_soccer_model.js`:

- `OHIO_TIER1_MARKETS`, `OHIO_TIER2_MARKETS`, `OHIO_BANNED_MARKETS` Set constants at module scope
- `normalizeToCanonicalSoccerMarket(rawKey)`: lowercases, trims, normalizes separators, returns canonical key or null; logs blocked reason at debug level
- `buildSoccerTier1Payload(gameId, oddsSnapshot, canonicalMarket)`: builds full card payload for all three Tier 1 markets and qualifying Tier 2 markets
  - team_totals: line validation (allowed set), price, edge_ev derived from fair/implied prob, missing context flags
  - player_shots: eligibility object (starter_signal, proj_minutes, role_tags, per90_hints), starter gate, price cap >= -150
  - to_score_or_assist: eligibility object, qualifying role tag check (TERMINAL_NODE/PRIMARY_CREATOR/SET_PIECE_ROLE), price cap >= -140
  - Degradation (Stage E): no placeholder strings ('unknown', 'tbd', 'n/a'); missing fields accumulate in missing_context_flags; structured pass_reason set per gap
- Job loop updated: when `raw_data.soccer_market` is a canonical Ohio key, routes to `buildSoccerTier1Payload` instead of `generateSoccerCard`
- Legacy `generateSoccerCard` path unchanged; all existing moneyline tests still pass

### Task 2: soccer_ohio_scope validator block (card-payload.js)

Added `soccerOhioScopeSchema` to `packages/data/src/validators/card-payload.js`:

- `canonical_market_key`: z.enum of exactly the 6 Ohio canonical keys — any other key rejected
- `market_family`: 'tier1' | 'tier2'
- `projection_basis`: z.string().nullable() with superRefine rejecting PLACEHOLDER_STRINGS set
- `edge_ev`: z.number().nullable() with superRefine rejecting 0 without missing_context_flags acknowledgement
- `missing_context_flags`: z.array(z.string()) — required, may be empty
- `eligibility`: optional object with starter_signal, proj_minutes, role_tags, per90_hints
- superRefine price cap checks per market key (shots >= -150, TSOA >= -140, SOT >= -130, anytime_goalscorer > +180)
- Registered as `'soccer-ohio-scope'` in schemaByCardType
- `validateCardPayload` skips `deriveLockedMarketContext` when `cardType === 'soccer-ohio-scope'`

### Task 3: Updated test files

Worker tests (`run_soccer_model.test.js`) — new describe block 'soccer ohio scope — Tier 1 market hardening':
- 8 normalizeToCanonicalSoccerMarket cases (all Tier 1/2 keys, banned markets, undefined)
- buildSoccerTier1Payload happy-path tests for all three Tier 1 markets
- Degradation cases: missing line, no starter signal, price cap violation, missing role tag
- Validator rejection: placeholder projection_basis, banned market key

Web decision tests (`canonical-play-decision.test.js`) — 3 new scenarios:
- Scenario 6: SOCCER player_shots with no edge -> PASS/NO_EDGE
- Scenario 7: SOCCER TSOA PASS -> action=PASS, why_code=CLASSIFICATION_PASS
- Scenario 8: SOCCER team_totals with real edge -> BASE/FIRE

## Test Results

| Suite | Result | Count |
|-------|--------|-------|
| npm --prefix apps/worker test -- run_soccer_model.test.js | PASS | 21/21 |
| npm --prefix apps/worker run job:run-soccer-model:test | exit 0 | — |
| npm --prefix web run test:decision:canonical | PASS | 32/32 |

## Commits

| Hash | Description |
|------|-------------|
| a3c469a | test(44-01): add failing tests for soccer Ohio scope Tier 1 market hardening (RED) |
| 35beaae | feat(44-01): add Ohio scope market router + Tier 1 packet builders + validator |
| 66da2d5 | feat(44-01): add soccer Tier 1 scenarios to canonical-play-decision tests |

## Deviations from Plan

None — plan executed exactly as written.

## WI-0437 Acceptance Criteria Status

| Criterion | Status |
|-----------|--------|
| 1. Every emitted card declares canonical Tier 1 market family | DONE |
| 2. Tier 1 payloads include hardened projection context | DONE |
| 3. Player markets carry eligibility context, no fake confidence | DONE |
| 4. Missing context emitted as structured flags, not silent backfill | DONE |
| 5. Validator enforces Ohio scope as hard allowlist | DONE |
| 6. Soccer cards remain output-compatible with /api/games and /api/cards | DONE (legacy path unchanged) |
| 7. Remaining gaps documented with defer rationale | DONE (in WI-0437 "Remaining Gaps" section) |

## Deferred Gaps (documented in WI-0437)

- Draw-market ingestion (draw_odds) — not currently sourced; deferred to follow-up WI
- Full environment-projector re-architecture — out of scope
- Legacy market restoration (1X2, DNB, AH) — explicitly deferred
- Dedicated /api/soccer/slate endpoint — deferred

## Self-Check: PASSED

Files confirmed present:
- apps/worker/src/jobs/run_soccer_model.js — FOUND
- packages/data/src/validators/card-payload.js — FOUND
- apps/worker/src/jobs/__tests__/run_soccer_model.test.js — FOUND
- web/src/__tests__/canonical-play-decision.test.js — FOUND

Commits confirmed:
- a3c469a — FOUND
- 35beaae — FOUND
- 66da2d5 — FOUND
