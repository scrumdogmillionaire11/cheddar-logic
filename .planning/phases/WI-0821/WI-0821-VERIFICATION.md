---
phase: WI-0821
verified: 2026-04-08T00:00:00Z
status: passed
score: 9/9 must-haves verified
---

# WI-0821 Verification Report

Status: PASSED | Score: 9/9 | Re-verification: No

Goal: Replace four-term multiplicative offense chain with a single bounded composite. Cap elite-offense at <=1.14x, eliminate double-counting.

## Observable Truths

1. Elite-offense no longer stacks >1.14x - VERIFIED (resolveOffenseComposite clamps [0.88,1.14])
2. ISO and hard_hit_pct removed from F5 projection - VERIFIED (awk scan CLEAN)
3. bb_pct double-counting eliminated - VERIFIED (awk scan CLEAN)
4. k_pct team offense multiplier removed - VERIFIED (awk scan CLEAN)
5. Teams missing iso no longer trigger SYNTHETIC_FALLBACK - VERIFIED (null-guard line 155: wrcPlus===null only)
6. Rolling 14d overlay capped at +/-3% - VERIFIED (clampValue 0.97,1.03 at lines 310-311)
7. offense_composite in payload metadata - VERIFIED (line 327; contact_mult removed; zero downstream refs)
8. Pre-existing MLB model tests pass - VERIFIED (25/25 across 3 suites)
9. New unit tests cover average/elite/weak - VERIFIED (6 tests in mlb-model.test.js)

## Artifacts

- apps/worker/src/models/mlb-model.js - VERIFIED SUBSTANTIVE WIRED
- apps/worker/src/models/__tests__/mlb-model.test.js - VERIFIED SUBSTANTIVE WIRED (57 lines, 6 tests)

## Key Links

- projectTeamF5RunsAgainstStarter -> resolveOffenseComposite: WIRED (line 304)
- offense_composite -> return object: WIRED (line 327)
- mlb-model.test.js -> resolveOffenseComposite: WIRED via export (line 2528)
- contact_mult removed: CLEAN - zero callers in apps and web

## Anti-Patterns

None found in modified sections.

## Human Verification Required

1. Elite-offense deflation check
   Test: Find game with wRC+ > 115 vs pitcher ERA > 4.5, compare adjustedRa9 pre/post commit ddd2270.
   Expected: New value is lower for the offensive-team side.
   Why human: No production snapshot for automated diff.

2. SYNTHETIC_FALLBACK suppression with missing iso
   Test: Ingest game snapshot where offense profile has no iso field.
   Expected: projection_source is FULL_MODEL or DEGRADED_MODEL, not SYNTHETIC_FALLBACK.
   Why human: Requires live or fixture data with missing iso.

_Verified: 2026-04-08_
_Verifier: Claude (pax-verifier)_
