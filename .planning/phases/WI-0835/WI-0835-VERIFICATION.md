---
phase: WI-0835
verified: 2026-04-08T01:00:00Z
status: passed
score: 6/6 must-haves verified
---

# WI-0835 Verification

Status: PASSED 6/6

| Truth | Status | Evidence |
|-------|--------|---------|
| NBA emits SIGMA_SOURCE log + annotates all pendingCards | VERIFIED | L1135 log; L1554-1559 loop before write tx |
| NHL emits SIGMA_SOURCE log + annotates driver + call cards | VERIFIED | L1706 log; L2015-2018 + L2091-2094 |
| MLB emits SIGMA_SOURCE log + annotates each card before insert | VERIFIED | L1527 log; L2119-2122 before insertCardPayload |
| sigma_source is direct value -- WI-0773 remapping removed | VERIFIED | No calibrated/default remap in nhl job |
| sigma_games_sampled uses nullish coalescing null | VERIFIED | All 3 sites; MLB unit confirms null on fallback |
| 132/132 tests pass; validator unchanged | VERIFIED | 5 test suites; card-payload.js untouched |

AC1 SATISFIED: sigma_source + sigma_games_sampled in payloadData.raw_data
AC2 SATISFIED: SIGMA_SOURCE log once per job run (NBA L1135, NHL L1706, MLB L1527)
AC3 SATISFIED: 132/132 tests pass; no validator change

Human check: run job:run-nba-model locally and inspect payloadData.raw_data fields.

_Verified: 2026-04-08 | Verifier: GitHub Copilot (pax-verifier)_
