---
phase: WI-0762-pull-public-splits
verified: 2026-04-04T00:00:00Z
status: passed
score: 9/9 must-haves verified
human_verification:
  - test: Run pull_public_splits.js then query odds_snapshots
    expected: public_bets_pct_home IS NOT NULL row with splits_source=action_network returned
    why_human: Requires live AN API + active upcoming games in DB
  - test: Run pull_vsin_splits.js then query odds_snapshots
    expected: dk_bets_pct_home IS NOT NULL row with vsin_captured_at populated returned
    why_human: Requires live VSIN HTML scrape + game-ID match
  - test: Run NHL/NBA model with splits data present
    expected: splits_divergence non-null (PUBLIC_HEAVY_HOME/AWAY or BALANCED) in card payload pricing_context
    why_human: Requires non-null public_bets_pct_* in DB to exercise non-null branch
---

# WI-0762 Verification Report

**WI Goal:** Build `pull_public_splits.js` (Action Network) + `pull_vsin_splits.js` (VSIN/DK), populate migration 055 + 058 columns, wire `splits_divergence` signal into NHL and NBA model payloads.
**Verified:** 2026-04-04T00:00:00Z
**Status:** PASSED (automated)
**Re-verification:** No — initial verification

---

## Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | Migration 058 adds `dk_*` columns + `vsin_captured_at` to `odds_snapshots` | VERIFIED | `058_add_vsin_splits_to_odds_snapshots.sql` — 6 dk_* cols + vsin_captured_at (7 ALTER TABLE stmts) |
| 2 | `pull_public_splits.js` writes `splits_source=action_network` and `public_bets_pct_home` | VERIFIED | L109, L264 — source set, column written |
| 3 | `pull_vsin_splits.js` calls `updateOddsSnapshotVsinSplits` to write `dk_*` cols | VERIFIED | L25 import, L143 call — 184 lines, no stub patterns |
| 4 | `updateOddsSnapshotVsinSplits` fully implemented in `packages/data/src/db/odds.js` | VERIFIED | L853-895 — full parameterized SQL UPDATE for all 6 dk_* + vsin_captured_at |
| 5 | `updateOddsSnapshotVsinSplits` exported from `packages/data/src/db/index.js` | VERIFIED | L41 |
| 6 | `main.js` registers `runPullVsinSplits` (hourly section) | VERIFIED | L73 import, L228 key fn, L803-807 job block |
| 7 | NHL model `splits_divergence` in all 3 payloadData blocks (TOTAL/SPREAD/ML) | VERIFIED | L1093, L1262, L1439 — identical IIFE pattern |
| 8 | NBA model `splits_divergence` in both payloadData blocks (TOTAL/SPREAD) | VERIFIED | L868, L1043 |
| 9 | `splits_divergence` logic: null-gate + 15-point threshold | VERIFIED | `if (h - a > 15) return 'PUBLIC_HEAVY_HOME'` — correct in all blocks |

**Score:** 9/9 truths verified

---

## Required Artifacts

| Artifact | Expected | Status | Details |
|---------|----------|--------|---------|
| `packages/data/db/migrations/058_add_vsin_splits_to_odds_snapshots.sql` | 6 dk_* + vsin_captured_at | VERIFIED | 7 ALTER TABLE statements |
| `apps/worker/src/jobs/pull_public_splits.js` | AN splits pull job | VERIFIED | 319 lines, action_network source, real DB writes |
| `apps/worker/src/jobs/pull_vsin_splits.js` | VSIN/DK splits pull job | VERIFIED | 184 lines, calls updateOddsSnapshotVsinSplits |
| `packages/data/src/db/odds.js` — `updateOddsSnapshotVsinSplits` | Write dk_* columns | VERIFIED | Full parameterized UPDATE at L853, exported at L913 |
| `packages/data/src/db/index.js` | Export updateOddsSnapshotVsinSplits | VERIFIED | L41 |
| `apps/worker/src/schedulers/main.js` | Register VSIN splits job | VERIFIED | Import + key fn + job block |
| `apps/worker/src/jobs/run_nhl_model.js` | `splits_divergence` in 3 payload blocks | VERIFIED | L1093, L1262, L1439 |
| `apps/worker/src/jobs/run_nba_model.js` | `splits_divergence` in 2 payload blocks | VERIFIED | L868, L1043 |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `pull_vsin_splits.js` | `odds_snapshots` dk_* cols | `updateOddsSnapshotVsinSplits` | WIRED | L25 import, L143 call |
| `pull_public_splits.js` | `odds_snapshots` public_* cols | `updateOddsSnapshotSplits` | WIRED | L105-130 write block |
| `main.js` | `pull_vsin_splits.js` | `runPullVsinSplits` require + job block | WIRED | L73, L803-807 |
| `run_nhl_model.js` | `oddsSnapshot.public_bets_pct_home/away` | inline IIFE in payloadData | WIRED | 3 occurrences |
| `run_nba_model.js` | `oddsSnapshot.public_bets_pct_home/away` | inline IIFE in payloadData | WIRED | 2 occurrences |

---

## Anti-Patterns Found

None detected in scoped files.

---

## Human Verification Required

### 1. Action Network splits write

**Test:** `CHEDDAR_DB_ALLOW_MULTI_PROCESS=true node apps/worker/src/jobs/pull_public_splits.js`, then:
```sql
SELECT public_bets_pct_home, splits_source
FROM odds_snapshots
WHERE public_bets_pct_home IS NOT NULL
LIMIT 1;
```
**Expected:** At least one row with `splits_source='action_network'`
**Why human:** Requires live AN API + active upcoming games in DB

### 2. VSIN/DK splits write

**Test:** `CHEDDAR_DB_ALLOW_MULTI_PROCESS=true node apps/worker/src/jobs/pull_vsin_splits.js`, then:
```sql
SELECT dk_bets_pct_home, vsin_captured_at
FROM odds_snapshots
WHERE dk_bets_pct_home IS NOT NULL
LIMIT 1;
```
**Expected:** At least one row with non-NULL `dk_bets_pct_home` and `vsin_captured_at`
**Why human:** Requires live VSIN HTML availability and game-ID match

### 3. splits_divergence in model output

**Test:** Run NHL or NBA model after step 1 populates splits, inspect card payload `pricing_context`
**Expected:** `splits_divergence` key shows `PUBLIC_HEAVY_HOME`, `PUBLIC_HEAVY_AWAY`, or `BALANCED` (not null) for at least one card
**Why human:** Requires non-null `public_bets_pct_*` in DB to exercise non-null branch

---

## Summary

All 9 automated must-haves pass. Full dual-track implementation is in place:

- **AN track** (`pull_public_splits.js`): writes `public_*` + `splits_source='action_network'` into migration-055 columns
- **VSIN/DK track** (`pull_vsin_splits.js`): writes `dk_*` + `vsin_captured_at` into migration-058 columns via `updateOddsSnapshotVsinSplits`
- **Model signal**: both NHL (3 blocks) and NBA (2 blocks) calculate `splits_divergence` from `public_bets_pct_home/away`, returning null gracefully when data absent
- **Scheduler**: `runPullVsinSplits` registered hourly in `main.js` alongside AN splits block

All structural wiring verified. Only live-data runtime validation remains for human.

---

_Verified: 2026-04-04T00:00:00Z_
_Verifier: Claude (pax-verifier)_
