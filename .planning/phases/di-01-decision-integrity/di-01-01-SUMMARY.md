---
phase: di-01-decision-integrity
plan: "01"
subsystem: web-platform
completed: 2026-04-11
---

# di-01-01 Summary

Stored `decision_v2.official_status` is now authoritative in the web transform for non-wave1 fallback paths.

- Added a transform guard so stored `PLAY`/`LEAN`/`PASS` statuses are preserved instead of being re-derived from deprecated web thresholds.
- Marked `THRESHOLDS` as deprecated and added `reason_source` to the canonical play decision contract.
- Added `game-card-decision-authority.test.ts` covering stored `PASS`, stored `LEAN`, and fallback `NON_CANONICAL_RENDER_FALLBACK`.

Verification:
- `cd web && npx tsc --noEmit`
- `cd web && node --import tsx/esm src/__tests__/game-card-decision-authority.test.ts`
