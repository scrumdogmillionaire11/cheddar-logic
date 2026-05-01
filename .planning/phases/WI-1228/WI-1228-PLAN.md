---
phase: WI-1228
status: ready-for-execution
work_item: WI-1228
coordination: needs-sync
depends_on: none
requirements:
  - R1
  - R2
  - R3
  - R4
  - R5
  - R6
  - R7
  - R8
  - R9
  - R10
must_haves:
  - id: MH-01
    truth: Promotion eligibility is additive only and never lowers existing PLAY thresholds.
    artifacts:
      - packages/models/src/decision-pipeline-v2.js
      - packages/models/src/decision-pipeline-v2-edge-config.js
      - packages/models/src/__tests__/decision-pipeline-v2-promotion.test.js
  - id: MH-02
    truth: Promotion metadata persists on decision_v2 and remains queryable in emitted reason arrays.
    artifacts:
      - packages/models/src/decision-pipeline-v2.js
      - packages/data/src/reason-codes.js
      - web/src/lib/types/game-card.ts
      - apps/worker/src/utils/__tests__/decision-publisher.v2.test.js
  - id: MH-03
    truth: Primary reason precedence is deterministic for surviving promotions and later demotions.
    artifacts:
      - packages/models/src/decision-pipeline-v2.js
      - packages/models/src/__tests__/decision-pipeline-v2-promotion.test.js
      - apps/worker/src/utils/__tests__/decision-publisher.v2.test.js
  - id: MH-04
    truth: External canonical status mapping remains PLAY | SLIGHT_EDGE | PASS.
    artifacts:
      - apps/worker/src/utils/__tests__/decision-publisher.v2.test.js
      - packages/models/src/__tests__/decision-authority-lifecycle.test.js
key_links:
  - model/config logic in decision-pipeline-v2 + decision-pipeline-v2-edge-config
  - taxonomy/type propagation through reason-codes + game-card DecisionV2
  - publisher mapping invariants through decision-publisher.v2 + decision-authority lifecycle
verification_commands:
  wave_1:
    - npm --prefix packages/models test -- src/__tests__/threshold-registry-completeness.test.js --runInBand
    - npm --prefix packages/models test -- src/__tests__/decision-pipeline-v2-promotion.test.js --runInBand
  wave_2:
    - npm --prefix packages/data test -- src/__tests__/reason-codes.test.js --runInBand
    - npm --prefix packages/data test -- __tests__/decision-outcome.test.js --runInBand
    - npx tsc -p web/tsconfig.json --noEmit
  wave_3:
    - npm --prefix apps/worker run test -- src/utils/__tests__/decision-publisher.v2.test.js --runInBand
    - npm --prefix packages/models test -- src/__tests__/decision-authority-lifecycle.test.js --runInBand
---

# WI-1228 Plan

## Requirements

- `R1` Keep existing `PLAY` thresholds unchanged.
- `R2` Only current internal `LEAN` results are eligible for promotion.
- `R3` Never promote `PASS`.
- `R4` Promotion scope is explicit-only:
  - `NBA:SPREAD` edge `0.05`, support `0.40`
  - `NBA:TOTAL` edge `0.05`, support `0.40`
  - `NHL:MONEYLINE` edge `0.10`, support `0.30`
  - `NHL:TOTAL` edge `0.06`, support `0.35`
  - `MLB:MONEYLINE` edge `0.10`, support `0.30`
  - `MLB:TOTAL` edge `0.06`, support `0.35`
- `R5` Promotion requires strict cleanliness:
  - `watchdog_status === 'OK'`
  - `sharp_price_status === 'CHEDDAR'`
  - `exact_wager_valid === true`
  - `proxy_used !== true`
  - `proxy_capped !== true`
  - no sigma-fallback promotion
  - no hard invalidation / cap / stale / recheck blockers
- `R6` Reuse canonical blocker evaluators and existing reason-code families.
- `R7` Emit `decision_v2.promoted_from` and `decision_v2.promotion_reason_code`.
- `R8` Register `HIGH_END_SLIGHT_EDGE_PROMOTION` in canonical reason-code taxonomy and emitted reasons.
- `R9` Primary reason precedence:
  - final promoted `PLAY` -> promotion code is primary
  - later demoter fires -> demoter remains primary, promotion metadata remains
- `R10` External canonical statuses remain `PLAY | SLIGHT_EDGE | PASS`.

## Wave 1

- Add explicit promotion registry and resolver in `decision-pipeline-v2-edge-config.js`.
- Add `maybePromoteHighEndLean(...)` in `decision-pipeline-v2.js`.
- Run promotion only for baseline `LEAN` outcomes and only before later demoters.
- Block promotion using existing pipeline signals and helper logic rather than a duplicated blocker taxonomy.
- Create `packages/models/src/__tests__/decision-pipeline-v2-promotion.test.js` and cover:
  - unit promotion success/failure branches
  - integration promotion success
  - heavy-favorite post-promotion demotion
  - NBA total quarantine post-promotion demotion when enabled

## Wave 2

- Register `HIGH_END_SLIGHT_EDGE_PROMOTION` in canonical reason codes and label maps.
- Extend shared `DecisionV2` type with optional promotion metadata.
- Add/update decision-outcome compatibility assertions so additive metadata does not break normalization.

## Wave 3

- Add publisher regressions proving:
  - promotion metadata survives publish unchanged
  - emitted reason arrays include promotion code
  - final publish remains ordinary `PLAY`
  - internal `LEAN` still maps to external `SLIGHT_EDGE`
  - `PASS` behavior remains unchanged

## Acceptance

- Clean scoped-market `LEAN` above promotion floors becomes `PLAY`.
- High-edge but non-qualifying candidates remain non-promoted.
- Hard invalidation, non-OK watchdog, sigma fallback, proxy-used, and proxy-capped rows do not promote.
- Heavy-favorite and NBA-total quarantine demoters still override promoted rows when applicable.
- Promotion metadata remains additive and traceable.
