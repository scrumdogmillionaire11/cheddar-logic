---
phase: potd-01-play-of-the-day
verified: 2026-04-09T03:30:00Z
status: passed
score: 13/13 must-haves verified
---

# Phase potd-01: Play of the Day Verification Report

**Goal:** Full POTD feature: DB migrations, worker signal/publish/settlement flow, scheduler ENABLE_POTD wiring, read-only web surface.
**Status:** PASSED | **Score:** 13/13 | **Re-verification:** No

---

## Observable Truths

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | potd_plays: play_date UNIQUE, card_id UNIQUE, settlement cols, 4 indexes | VERIFIED | 063: 47 lines, IF NOT EXISTS, correct DDL |
| 2 | potd_bankroll append-only ledger with FK to potd_plays(id) | VERIFIED | 064: FOREIGN KEY clause, 2 indexes |
| 3 | Migrations 063+064 run cleanly on fresh DB | VERIFIED | runner output: checkmark 063 + 064 confirmed |
| 4 | Signal engine: 0.625/0.375 weights; kelly=0.25; ELITE>=0.75 HIGH>=0.50 | VERIFIED | signal-engine.js L467, L503, L59-67, 542 lines |
| 5 | runPotdEngine: fetchOdds, score, INSERT potd_plays, insertCardPayload, sendDiscordMessages | VERIFIED | L18, L361, L390, L27, DISCORD_POTD_WEBHOOK_URL L258 |
| 6 | Bankroll auto-seeded $10 on first run; no-play days exit cleanly | VERIFIED | DEFAULT_BANKROLL=10 L31; ensureInitialBankroll L68; no_play L302/326 |
| 7 | Generic Discord snapshot excludes potd-call card type | VERIFIED | post_discord_cards.js L694 SQL filter; dedicated test L452 |
| 8 | settlement-mirror: pulls card_results, UPDATE potd_plays, INSERT potd_bankroll | VERIFIED | JOIN card_results L71; UPDATE L118; INSERT L124 |
| 9 | POTD enqueues once/day 12:00-16:00 ET; disabled without ENABLE_POTD=true | VERIFIED | main.js L80 flag; L228-244 block; shouldRunJobKey L233; windowEnd 16:00 |
| 10 | Mirror runs downstream of canonical settlement (settlementDue guard) | VERIFIED | main.js L249-261 settlementDue array guard |
| 11 | GET /api/potd: today/history/bankroll/schedule; read-only; closeReadOnlyInstance | VERIFIED | route.ts L354/369/389/430/458; closeReadOnlyInstance; no writes |
| 12 | /play-of-the-day: force-dynamic; 3 states; homepage link | VERIFIED | page.tsx L6 force-dynamic; PlayOfTheDayClient L11; homepage L39 |
| 13 | potd-call visible on /api/cards (Discord filter only, not cards feed) | VERIFIED | only post_discord_cards.js L694 filters it; /api/cards unchanged |

**Score: 13/13**

---

## Artifacts

| Artifact | Size | Status |
|---|---|---|
| packages/data/db/migrations/063_create_potd_plays.sql | 47 lines | VERIFIED |
| packages/data/db/migrations/064_create_potd_bankroll.sql | 25 lines | VERIFIED |
| apps/worker/src/jobs/potd/signal-engine.js | 542 lines | VERIFIED |
| apps/worker/src/jobs/potd/__tests__/signal-engine.test.js | substantive | VERIFIED |
| apps/worker/src/jobs/potd/run_potd_engine.js | substantive | VERIFIED |
| apps/worker/src/jobs/potd/format-discord.js | substantive | VERIFIED |
| apps/worker/src/jobs/potd/settlement-mirror.js | substantive | VERIFIED |
| apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js | substantive | VERIFIED |
| apps/worker/src/jobs/potd/__tests__/settlement-mirror.test.js | substantive | VERIFIED |
| apps/worker/src/jobs/__tests__/post_discord_cards.test.js | substantive | VERIFIED - potd-call exclusion test L452 |
| apps/worker/src/schedulers/main.js | substantive | VERIFIED - ENABLE_POTD block; both jobs wired |
| apps/worker/.env.example | 8 lines | VERIFIED - ENABLE_POTD, DISCORD_POTD_WEBHOOK_URL, POTD_KELLY_FRACTION, POTD_MAX_WAGER_PCT, POTD_STARTING_BANKROLL |
| apps/worker/src/__tests__/scheduler-windows.test.js | substantive | VERIFIED - 4 POTD tests L584+ |
| web/src/app/api/potd/route.ts | substantive | VERIFIED - GET; queries; closeReadOnlyInstance |
| web/src/app/play-of-the-day/page.tsx | 23 lines | VERIFIED - force-dynamic; PlayOfTheDayClient wired |
| web/src/components/play-of-the-day-client.tsx | substantive | VERIFIED - use client; bankroll/history/today rendering |
| web/src/__tests__/api-potd.test.js | substantive | VERIFIED - fallback smoke PASS |
| web/src/__tests__/ui-potd-smoke.test.js | substantive | VERIFIED - fallback smoke PASS |

---

## Key Link Verification

| From | To | Via | Status |
|---|---|---|---|
| 064 migration | potd_plays | FOREIGN KEY (play_id) REFERENCES potd_plays(id) | WIRED |
| run_potd_engine.js | @cheddar-logic/odds | fetchOdds L18 | WIRED |
| run_potd_engine.js | signal-engine.js | buildCandidates/scoreCandidate/selectBestPlay/kellySize | WIRED |
| run_potd_engine.js | potd_plays | INSERT INTO potd_plays L361 | WIRED |
| run_potd_engine.js | potd_bankroll | INSERT INTO potd_bankroll L79 | WIRED |
| run_potd_engine.js | @cheddar-logic/data | insertCardPayload L390 | WIRED |
| run_potd_engine.js | post_discord_cards.js | sendDiscordMessages L27 | WIRED |
| settlement-mirror.js | card_results | JOIN card_results cr ON cr.card_id = p.card_id L71 | WIRED |
| main.js | run_potd_engine.js | require('../jobs/potd/run_potd_engine') L57 | WIRED |
| main.js | settlement-mirror.js | require('../jobs/potd/settlement-mirror') L58 | WIRED |
| main.js | shouldRunJobKey | potd|YYYY-MM-DD key L233 | WIRED |
| route.ts | potd_plays | SELECT * FROM potd_plays L369/378 | WIRED |
| route.ts | potd_bankroll | SELECT amount_after FROM potd_bankroll L389/398 | WIRED |
| page.tsx | route.ts | getPotdResponseData() L3 | WIRED |
| page.tsx | play-of-the-day-client.tsx | PlayOfTheDayClient initialData L11 | WIRED |
| homepage page.tsx | /play-of-the-day | Link href="/play-of-the-day" L39 | WIRED |

---

## Single-Writer Contract Compliance

| Check | Status |
|---|---|
| route.ts uses closeReadOnlyInstance (not closeDatabase) | PASS |
| route.ts: no runMigrations/db.exec/stmt.run calls | PASS |
| page.tsx calls closeDatabaseReadOnly() in teardown | PASS |
| Worker is sole writer to potd_plays and potd_bankroll | PASS |

---

## Test Results

| Suite | Result |
|---|---|
| signal-engine.test.js | PASS |
| run-potd-engine.test.js | PASS |
| settlement-mirror.test.js | PASS |
| post_discord_cards.test.js (potd-call exclusion) | PASS |
| scheduler-windows.test.js POTD block | PASS - 4 tests: before-window, at-target, dedup, mirror-ordering |
| api-potd.test.js | PASS (fallback smoke - no live server) |
| ui-potd-smoke.test.js | PASS (fallback smoke - no live server) |
| TypeScript web/tsconfig.json --noEmit | CLEAN |
| Migrations 063+064 on fresh DB | CLEAN |
| All 5 matched suites total | 42/42 tests pass |

---

## Anti-Patterns Found

None. All `return null` / `return []` occurrences in signal-engine.js and settlement-mirror.js are valid guard returns for invalid numeric inputs or empty result sets, not stubs.

---

## Human Verification Required

1. **Live end-to-end POTD publish**
   Test: Set ENABLE_POTD=true and valid DISCORD_POTD_WEBHOOK_URL, run scheduler at 12:30 ET on a live game day.
   Expected: Row written to potd_plays, matching ledger row in potd_bankroll, potd-call in card_payloads, Discord message visible in POTD channel.
   Why human: Requires live odds API keys and market data not available in CI.

2. **Post-settlement mirror**
   Test: After a settled POTD game, run mirrorPotdSettlement.
   Expected: potd_plays.result = win/loss/push; potd_bankroll has a result_settled row with correct PnL.
   Why human: Requires a settled card_results row linked to a real POTD card ID.

3. **/play-of-the-day UI visual states**
   Test: Hit /play-of-the-day in browser with (a) no data, (b) posted unfilled, (c) settled result.
   Expected: Each state renders without crash; bankroll and history panels display correctly.
   Why human: Visual rendering; web smoke tests used fallback checks (no live Next.js server available in verification env).

---

_Verified: 2026-04-09 | Verifier: Claude (pax-verifier)_
