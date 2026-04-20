# Quick Task 165: WI-1013 - Resolve stale reason code alias confusion

**Date:** 2026-04-20
**Status:** In progress

## Goal

Complete the stale reason-code migration by emitting only `STALE_MARKET` and `STALE_SNAPSHOT`, removing alias-table dependency from production checks, and keeping only explicit read-side normalization needed for historical DB rows.

## Tasks

1. Update canonical reason-code definitions and producer code.
   - Files: `packages/data/src/reason-codes.js`, `packages/models/src/decision-pipeline-v2.js`, `packages/models/src/decision-policy.js`, `apps/worker/src/jobs/run_nhl_model.js`, `apps/worker/src/utils/decision-publisher.js`, `apps/worker/src/jobs/post_discord_cards.js`
   - Verify: old stale aliases are not emitted or explicitly checked by production decision/worker code.

2. Update web transforms and UI labels.
   - Files: `web/src/lib/game-card/reason-labels.ts`, `web/src/lib/game-card/transform/index.ts`, `web/src/lib/games/route-handler.ts`, `web/src/lib/game-card/transform/decision-surface.ts`
   - Verify: canonical labels remain, old UI label entries are removed, and retained normalizers document historical DB row compatibility.

3. Update tests and run work-item validation.
   - Files: scoped test files in `packages/data`, `packages/models`, and `apps/worker`
   - Verify: required test commands pass, `web` builds, and manual stale-alias search returns only allowed compatibility comments if any.
