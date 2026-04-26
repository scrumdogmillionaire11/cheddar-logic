---
phase: wi-1036-1039
verified: 2026-04-19T00:00:00Z
status: gaps_found
score: 8/8 must-haves verified
re_verification:
  previous_status: gaps_found
  previous_score: 7/8
  gaps_closed:
    - "POTD snapshot inclusion path is wired (DISCORD_INCLUDE_POTD_IN_SNAPSHOT)"
    - "OFFICIAL_PLAY-only POTD snapshot filtering is implemented"
    - "POTD leading section rendering in snapshot is implemented"
    - "Direct POTD post suppression when snapshot inclusion is enabled is implemented"
  gaps_remaining: []
  regressions:
    - "run-potd-engine test suite contains one failing suppression-path test"
gaps:
  - truth: "Direct POTD posting remains verifiable when DISCORD_INCLUDE_POTD_IN_SNAPSHOT=false"
    status: partial
    reason: "Automated verification is blocked by a failing test in run-potd-engine suite"
    artifacts:
      - path: "apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js"
        issue: "Test 'DISCORD_INCLUDE_POTD_IN_SNAPSHOT=false does NOT suppress direct POTD Discord post' fails (expected 1 webhook call, got 0)"
    missing:
      - "Fix test determinism or underlying behavior so the non-suppressed direct-post path is reliably exercised"
---

# WI-1036 and WI-1039 Re-Verification Report

**Phase Goal:** Confirm WI-1036 and WI-1039 are completed to spec based on implemented behavior (not summary claims).
**Verified:** 2026-04-19T00:00:00Z
**Status:** gaps_found
**Re-verification:** Yes - after prior gap report

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `/api/cards` defaults to today's UTC date when `date` is omitted | ✓ VERIFIED | [web/src/app/api/cards/route.ts](web/src/app/api/cards/route.ts#L344), [web/src/app/api/cards/route.ts](web/src/app/api/cards/route.ts#L399), [web/src/app/api/cards/route.ts](web/src/app/api/cards/route.ts#L408) |
| 2 | `/api/cards?date=all` bypasses date filtering | ✓ VERIFIED | [web/src/app/api/cards/route.ts](web/src/app/api/cards/route.ts#L399) |
| 3 | WI-1039 market filter hygiene is implemented (allow/deny, normalized logs, parse-once) | ✓ VERIFIED | [apps/worker/src/jobs/post_discord_cards.js](apps/worker/src/jobs/post_discord_cards.js#L693), [apps/worker/src/jobs/post_discord_cards.js](apps/worker/src/jobs/post_discord_cards.js#L1470) |
| 4 | 429 retry logic has retry-after parsing, jittered one-time retry, and timeout guards | ✓ VERIFIED | [apps/worker/src/jobs/post_discord_cards.js](apps/worker/src/jobs/post_discord_cards.js#L1158), [apps/worker/src/jobs/post_discord_cards.js](apps/worker/src/jobs/post_discord_cards.js#L1182), [apps/worker/src/jobs/post_discord_cards.js](apps/worker/src/jobs/post_discord_cards.js#L1189) |
| 5 | POTD timing state machine + heartbeat are implemented | ✓ VERIFIED | [apps/worker/src/jobs/potd/run_potd_engine.js](apps/worker/src/jobs/potd/run_potd_engine.js#L135), [apps/worker/src/jobs/potd/run_potd_engine.js](apps/worker/src/jobs/potd/run_potd_engine.js#L153), [apps/worker/src/jobs/potd/run_potd_engine.js](apps/worker/src/jobs/potd/run_potd_engine.js#L302) |
| 6 | No-pick alerts fire only in `NO_PICK_FINAL` and use required wording/edge logic | ✓ VERIFIED | [apps/worker/src/jobs/potd/run_potd_engine.js](apps/worker/src/jobs/potd/run_potd_engine.js#L171), [apps/worker/src/jobs/potd/run_potd_engine.js](apps/worker/src/jobs/potd/run_potd_engine.js#L829) |
| 7 | POTD snapshot inclusion is now wired: OFFICIAL_PLAY-only SQL + leading section + filter bypass | ✓ VERIFIED | [apps/worker/src/jobs/post_discord_cards.js](apps/worker/src/jobs/post_discord_cards.js#L1203), [apps/worker/src/jobs/post_discord_cards.js](apps/worker/src/jobs/post_discord_cards.js#L1211), [apps/worker/src/jobs/post_discord_cards.js](apps/worker/src/jobs/post_discord_cards.js#L1298) |
| 8 | Direct POTD post is suppressed when snapshot inclusion is enabled | ✓ VERIFIED | [apps/worker/src/jobs/potd/run_potd_engine.js](apps/worker/src/jobs/potd/run_potd_engine.js#L1119), [apps/worker/src/jobs/potd/run_potd_engine.js](apps/worker/src/jobs/potd/run_potd_engine.js#L1138) |

**Score:** 8/8 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `web/src/app/api/cards/route.ts` | Date filter default + opt-out | ✓ VERIFIED | Date query parsing and SQL predicate are present |
| `apps/worker/src/jobs/post_discord_cards.js` | Filter hygiene + retry + POTD snapshot inclusion | ✓ VERIFIED | All required branches and env wiring present |
| `apps/worker/src/jobs/potd/run_potd_engine.js` | Timing states + no-pick alert + suppression guard | ✓ VERIFIED | State constants and suppression guard implemented |
| `apps/worker/src/jobs/__tests__/post_discord_cards.test.js` | WI-1039 tests including B2 cases | ✓ VERIFIED | Includes dedicated `WI-1039-B2` describe block |
| `apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js` | Timing/suppression behavior tests | ⚠ PARTIAL | Contains required tests, but one suppression-path test fails |
| `env.example` | New env vars documented | ✓ VERIFIED | Includes `DISCORD_CARD_WEBHOOK_MARKETS_DENY`, `DISCORD_INCLUDE_POTD_IN_SNAPSHOT`, retry timeout vars |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `post_discord_cards.js` | snapshot SQL | `includePotd` gate + `final_play_state='OFFICIAL_PLAY'` | WIRED | Conditional SQL clause implemented |
| `post_discord_cards.js` | snapshot rendering | POTD leading section in `buildDiscordSnapshot` | WIRED | POTD rendered before regular game sections |
| `run_potd_engine.js` | Discord sender | `snapshotIncludeActive` guard around send | WIRED | Direct post suppressed when inclusion flag is true |
| `route.ts` | cards SQL filtering | `DATE(g.game_time_utc)=?` bind from parsed date | WIRED | Correct default/explicit/all behavior |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| WI-1036 acceptance | [WORK_QUEUE/WI-1036.md](WORK_QUEUE/WI-1036.md) | Date default/all/specific handling in `/api/cards` | ✓ SATISFIED | Route implementation + successful web build |
| WI-1039-A acceptance | [WORK_QUEUE/WI-1039.md](WORK_QUEUE/WI-1039.md) | Market filter hygiene and logs | ✓ SATISFIED | `post_discord_cards.js` + passing suite |
| WI-1039-B acceptance | [WORK_QUEUE/WI-1039.md](WORK_QUEUE/WI-1039.md) | POTD timing/alerts/snapshot behavior | ⚠ PARTIAL | Behavior implemented; one related engine test failing |
| WI-1039-C acceptance | [WORK_QUEUE/WI-1039.md](WORK_QUEUE/WI-1039.md) | 429 retry and timeout resilience | ✓ SATISFIED | Implementation + passing tests in `post_discord_cards` suite |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| `apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js` | 1259 | Failing assertion in suppression-path test | ⚠ Warning | Prevents full automated proof that non-suppressed path still posts |

### Human Verification Required

None identified for this pass; remaining blocker is automated test failure, not visual/manual UX behavior.

### Gaps Summary

Previous gap is closed: the POTD snapshot inclusion contract (flag wiring, OFFICIAL_PLAY filtering, leading section, suppression guard) now exists and is tested in `post_discord_cards` coverage.

Residual gap is verification confidence on one direct-post path because `run-potd-engine` still has one failing suppression test (`include=false` case). Until that test is fixed (or behavior adjusted), completion cannot be marked fully green in adversarial verification.

---

_Verified: 2026-04-19T00:00:00Z_
_Verifier: Claude (gsd-verifier)_
