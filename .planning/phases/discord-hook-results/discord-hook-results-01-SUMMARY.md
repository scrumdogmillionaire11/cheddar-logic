# Discord Hook Results 01 Summary

Completed: 2026-04-24T19:52:57Z
Work item: WI-1164

## Outcome

- Discord webhook sends now produce structured per-target `transportResults`.
- Returned job payload includes `transportSummary`, `partialFailure`, failed target details, and an operator-readable `resultBlock`.
- Per-sport target sends continue after a failed target, so mixed outcomes show partial failure while preserving successful target evidence.

## Verification

- `npm --prefix apps/worker test -- src/jobs/__tests__/post_discord_cards.test.js` — passed, 86 tests.
- `rg -n "deliveryResults|transportResults|partialFailure|retry|attempt|postedCardCount" apps/worker/src/jobs/post_discord_cards.js` — passed.
