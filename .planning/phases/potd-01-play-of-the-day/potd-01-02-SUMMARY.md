# potd-01-02 Summary: POTD Signal Engine

**Completed:** 2026-04-09
**Commit:** not committed

## What Was Done

Added the pure POTD signal engine and focused worker tests:

- `apps/worker/src/jobs/potd/signal-engine.js`
- `apps/worker/src/jobs/potd/__tests__/signal-engine.test.js`

The module now:

- builds spread, total, and moneyline candidates from normalized odds markets
- scores each candidate with `lineValue` and `marketConsensus`
- derives consensus fair probability with vig removal
- filters best-play selection to safe positive-edge candidates only
- sizes wagers with quarter-Kelly and a 20% bankroll cap

The candidate shape includes the locked odds context needed by the publish path in
the next wave.

## Verification

- `node -e "const se = require('./apps/worker/src/jobs/potd/signal-engine'); console.log(Object.keys(se))"`
- `npm --prefix apps/worker run test -- --runInBand src/jobs/potd/__tests__/signal-engine.test.js`

## Acceptance Criteria Status

- [x] Spread, total, and moneyline candidate generation covered
- [x] Scoring uses only `lineValue` and `marketConsensus`
- [x] Positive-edge filtering enforced by `selectBestPlay`
- [x] Kelly sizing floors at zero and caps at 20% bankroll
- [x] NHL totals-only path covered by unit tests
