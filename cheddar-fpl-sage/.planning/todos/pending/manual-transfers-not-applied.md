# Manual Transfers Not Applied to Recommendations

**Created:** 2026-01-23
**Source:** User report during Phase 1 execution
**Priority:** High

## Description

When user enters manual transfers they've already made, the system still recommends those same transfers instead of:
1. Applying the manual transfers to the squad state
2. Generating recommendations based on the updated squad

## Expected Behavior

If user says "I transferred out Guéhi for Thiaw", the next recommendation should NOT tell them to transfer out Guéhi — it should treat Thiaw as already in the squad.

## Likely Location

- `src/cheddar_fpl_sage/analysis/decision_framework/transfer_advisor.py` — `apply_manual_transfers()` or `_ensure_projections()`
- `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py` — where manual transfers are processed

## Related

- Plan 01-05 fixes manual player *display* name, but not this logic issue
