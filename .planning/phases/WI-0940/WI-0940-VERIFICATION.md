---
phase: WI-0940
verified: 2026-04-14T22:40:00Z
status: passed
score: 5/5 must-haves verified
---

# WI-0940: NHL Blocking Remediation Verification Report

**Phase Goal:** Identify and fix NHL market-call blocking paths that suppress actionable cards beyond intended policy, while preserving intentional risk controls and making all blocks explicitly diagnosable.

**Verified:** 2026-04-14T22:40:00Z  
**Status:** ✅ PASSED

## Goal Achievement Summary

✅ **All three NHL market-call card types have explicit reason families**  
Verified: nhl-totals-call, nhl-spread-call, nhl-moneyline-call all classified into one of 7 explicit families

✅ **decision_v2 fields internally consistent across all three card types**  
Verified: official_status, action, classification, primary_reason_code all converge at persistence

✅ **No silent drop path between model decision and persisted payload**  
Verified: Each blocked candidate recorded with explicit reason code; check_pipeline_health.js diagnostics track reasons

✅ **Diagnostic counters available per reason family and card type**  
Verified: checkNhlMarketCallDiagnostics() outputs per-market reason-family summaries; logs queryable

✅ **tech-debt closeout complete**  
Verified:
- TD-01: Parity assertions prove no contradictory status/action/class fields
- TD-02: Post-publish last-write-wins overrides removed; stale comments pruned (rg proof)
- TD-03: Web transform assertions confirm canonical persisted reason preferred
- TD-04: Health diagnostics include per-family counters for all three card types
- TD-05: All outdated selector-era comments removed or documented as retained-intentional

## Key Commits

- **9544e7a4**: WI-0940 NHL blocking remediation — foundational consolidation
- **e8973d05**: Post-publish TOTAL no-odds-mode wiring (NHL precedent for WI-0941)

## Test Coverage

Tests covering at least one previously over-blocked path and one intentionally blocked path:
- Over-blocked scenario: Edge below threshold but above watchdog alert level → now surfaces at LEAN instead of PASS
- Intentionally blocked: Stale pricing → correctly remains PASS with explicit reason code

---

_Verified: 2026-04-14T22:40:00Z_  
_Verifier: Claude (gsd-verifier)_
