# Run Feedback Analysis — 2026-01-02

## Summary

Live run with manual chip/FT overrides revealed **10 distinct issues** grouped into **4 root causes**:

1. **Config plumbing broken** (4 issues) — Write path ≠ read path
2. **Crash handling incomplete** (3 issues) — Decision framework crash, season errors
3. **Bench injury coverage partial** (1 issue) — Not all squad players enriched
4. **Authority not downgrading** (1 issue) — Stale data should reduce autonomy
5. **Manager identity missing** (1 issue) — Not parsing from entry payload

---

## Issues (Detailed)

### Issue 1: Manual Chips Ignored

**Symptom**: User sets 4 manual chips (Wildcard, Free Hit, etc.), output confirms save, but analysis shows only Free Hit available.

**Root Cause**: Config write path stores chips, but analysis reads from different key/location.

**Sprint**: 3.5 (Config path alignment)

**Fix**: A) Config Write/Read Path Alignment

---

### Issue 2: Manual Free Transfers Ignored

**Symptom**: User sets manual FT=2, output confirms "Saved manual free transfers: 2", but analysis shows FT=0.

**Root Cause**: Same as Issue 1 — write and read use different config keys.

**Sprint**: 3.5 (Config path alignment)

**Fix**: A) Config Write/Read Path Alignment

---

### Issue 3: Config Cached Before Edit

**Symptom**: Edit made to config, file saved to disk, but next analysis run doesn't see changes.

**Root Cause**: Config loaded into memory at startup, edits written to disk, but analysis uses stale in-memory copy.

**Sprint**: 3.5 (Config reload)

**Fix**: B) Config Reload / Cache Invalidation

---

### Issue 4: Self-Contradictory Override Status

**Symptom**: Output claims BOTH:
- "✅ Using manual team overrides"
- "(No manual overrides set)"

**Root Cause**: Different code paths reading override existence (one sees data, one doesn't), or status checked before validation.

**Sprint**: 3.5 (Override messaging)

**Fix**: C) Override Status Reporting

---

### Issue 5: Season Unknown Errors

**Symptom**: Decision framework crash with "season unknown" or TypeError.

**Root Cause**: Season resolution missing for some players/scenarios.

**Sprint**: 3 (Already fixed by DeterministicSeasonResolver)

**Status**: Should be resolved; live run validation needed.

---

### Issue 6: Decision Framework Crash Mislabeled

**Symptom**: Crash in decision framework labeled as "projection failure" or generic error.

**Root Cause**: Crash not properly captured with context (function name, line, file).

**Sprint**: 3 (Already fixed by DecisionFrameworkCrashHandler)

**Status**: Should be resolved; live run validation needed.

---

### Issue 7: Chip Expiry Logic Incorrect

**Symptom**: Chip availability/expiry calculation wrong.

**Root Cause**: Internal concept error in chip expiry logic (not directly related to override plumbing).

**Sprint**: Not yet assigned (likely Sprint 3.5 or later)

**Note**: Lower priority; chips still available even if expiry wrong.

---

### Issue 8: Bench Injury Coverage Missing

**Symptom**: Bench players missing injury status. Example: Rodon (bench) shows no status; Estève (bench) shows correctly.

**Root Cause**: Injury enrichment not applied to full squad (only starting 11?).

**Sprint**: 3 (Already fixed by BenchInjuryEnricher)

**Status**: Should be resolved; live run validation needed.

---

### Issue 9: Manager Identity Missing/Unknown

**Symptom**: Output shows "Manager: Unknown Manager" instead of actual manager name.

**Root Cause**: Manager name in entry payload not extracted/mapped to team_state.

**Sprint**: 3.5 (Manager parsing)

**Fix**: D) Manager Identity Parsing

---

### Issue 10: Authority Not Downgrading on Stale Data

**Symptom**: System falls back to GW19 picks but still recommends chips/hits (high autonomy action).

**Root Cause**: Authority level (DAL) not downgraded on fallback; system still acts as if data is fresh.

**Sprint**: X+1 (Authority enforcement)

**Status**: Identified for future work; depends on Sprints 3.5 + 4.

---

## Root Cause Grouping

### Group A: Config Write/Read Path Mismatch (Issues 1, 2, 3, 4, 9)

**Hypothesis**: Write path and read path use different key paths or read doesn't happen.

**Test Plan**:
1. Audit where config written (override prompt)
2. Audit where config read (team_state_builder)
3. Verify keys match
4. Verify read happens after edit (no caching)

**Sprint**: 3.5 (A, B, C, D work items)

**Blocks**: Sprint 4 (manual input layering depends on correct override plumbing)

---

### Group B: Incomplete Sprint 3 Coverage (Issues 5, 6, 8)

**Hypothesis**: Sprint 3 code written but not yet integrated into live run.

**Test Plan**:
1. Integrate Sprint 3 (sprint3_integration.py adapter)
2. Re-run with same data that produced feedback
3. Verify issues 5, 6, 8 resolved

**Sprint**: 3 (validation phase)

**Action**: Don't implement new fixes; validate existing fixes work.

---

### Group C: Future Work (Issues 7, 10)

**Issue 7** (Chip expiry): Likely Sprint 3.5 or later (lower priority).

**Issue 10** (Authority downgrade): Sprint X+1 (depends on Sprints 3.5 + 4).

---

## Work Sequencing

```
Sprint 3 ✅ (code written)
    ├→ Integrate into live run
    ├→ Validate issues 5, 6, 8 fixed
    └→ Document fixes

Sprint 3.5 (NEW - NEXT)
    ├→ A) Config write/read path alignment
    ├→ B) Config reload / cache invalidation
    ├→ C) Override status unambiguous
    ├→ D) Manager identity parsing
    └→ Test all 4 items

Sprint 4 (BLOCKED until 3.5 complete)
    ├→ Manual input layering
    ├→ Depends on working override plumbing from 3.5
    └→ Can start only after 3.5 validated

Sprint X+1 (FUTURE)
    ├→ Authority downgrade on stale data (issue 10)
    └→ Depends on Sprints 3.5 + 4
```

---

## Quick Reference: What's Done vs What's Next

| Category | Status | Issues | Action |
|----------|--------|--------|--------|
| **Crash handling** | ✅ Sprint 3 code written | 5, 6 | Integrate + validate |
| **Injury enrichment** | ✅ Sprint 3 code written | 8 | Integrate + validate |
| **Config plumbing** | ❌ Broken | 1, 2, 3, 4, 9 | Sprint 3.5 (new work) |
| **Chip expiry** | ⚠️ Incorrect logic | 7 | Sprint 3.5+ (lower priority) |
| **Authority downgrade** | ❌ Not implemented | 10 | Sprint X+1 (future) |

---

## Next Steps

1. **Immediate**: Integrate Sprint 3 into live run, re-validate issues 5, 6, 8
2. **Short-term**: Execute Sprint 3.5 to fix config plumbing (issues 1, 2, 3, 4, 9)
3. **Medium-term**: Execute Sprint 4 (manual input layering) once 3.5 unblocks
4. **Future**: Execute Sprint X+1 (authority downgrade on stale data)

---

## Code Locations (For Reference)

**Sprint 3 (Already written, not yet integrated)**:
- `src/utils/sprint3_fixes.py` — Implementation (400+ lines)
- `src/analysis/sprint3_integration.py` — Integration adapter (250+ lines)
- `scripts/test_sprint3.py` — Unit tests (23 tests, all passing)
- `scripts/test_sprint3_integration.py` — Integration tests (16 tests, all passing)

**Sprint 3.5 (To be written)**:
- `src/analysis/team_state_builder.py` — Config read (A), manager extraction (D)
- `src/analysis/override_prompt.py` — Config write (A), reload (B)
- `src/analysis/output_formatter.py` — Status messaging (C), manager output (D)
- `scripts/test_sprint3_5.py` — New test suite (A-D tests)

---

## Documentation

- Full work plan: [SPRINT3_5_WORK_PLAN.md](SPRINT3_5_WORK_PLAN.md)
- Sprint tracking: [SPRINT_TRACKING.md](SPRINT_TRACKING.md) (Sprint 3.5 section)
