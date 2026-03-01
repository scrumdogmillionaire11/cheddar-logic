# FPL Sage - Technical Debt & Improvement Todos

*Created: 2026-02-05*
*Last Updated: 2026-02-07*

## Priority Legend
- **P0**: Blocking / causes incorrect output
- **P1**: High impact on user experience
- **P2**: Architectural improvement
- **P3**: Nice to have

---

## Chip Logic

### [P1] Free Hit threshold should be risk-posture aware
**File:** `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py:649`
**Current:** FH triggers at 3+ critical needs for everyone
**Proposed:**
- AGGRESSIVE: 2 critical needs (more willing to use chips)
- BALANCED: 3 critical needs (current)
- CONSERVATIVE: 4 critical needs (preserve chips longer)

### [P1] Window rank gate always passes without config
**File:** `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py:1434`
**Issue:** If no `chip_windows` in team_config.json, window_rank defaults to 1, so TC/BB always allowed
**Fix:** Provide sensible defaults for chip windows based on season calendar

### [P2] ChipAnalyzer is dead code
**Files:** `src/cheddar_fpl_sage/analysis/decision_framework/chip_analyzer.py`
**Issue:** ChipAnalyzer class is never called - all chip logic goes through EnhancedDecisionFramework
**Options:**
1. Delete ChipAnalyzer entirely
2. Refactor to use ChipAnalyzer as the single source of chip logic
**Note:** ChipAnalyzer returns `ChipRecommendation`, framework returns `DecisionOutput` - type mismatch

### [P2] Chip expiry override happens outside framework
**File:** `src/cheddar_fpl_sage/analysis/fpl_sage_integration.py:758-793`
**Issue:** Chip expiry logic overrides framework decision after `analyze_chip_decision()` returns
**Impact:** Breaks encapsulation, decision object may have inconsistent state
**Fix:** Move expiry logic into framework's `_decide_optimal_chip_strategy()`

### [P3] TC fails silently without projections
**File:** `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py:1110-1112`
**Issue:** If projections unavailable, TC target is None, no chip recommended
**Fix:** Provide fallback recommendation or clearer error message

---

## XI Optimization

### [P0] DOUBT players not penalized in XI selection
**File:** `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py:292`
**Issue:** XI optimization filters OUT players but doesn't penalize DOUBT players
**Example:** Stach (25% chance, 4.0 pts) starts over healthy players
**Fix:** Multiply expected points by chance of playing:
```python
effective_pts = nextGW_pts * (chance_of_playing / 100)
```

### [P1] Verify projection pipeline factors in injury chance
**Issue:** Foden showing 2.5 pts expected seems too low for a premium
**Investigation needed:** Check if projection engine already adjusts for injury, or if this is a data issue
**Files to check:**
- Projection engine / data pipeline
- How `nextGW_pts` is calculated

---

## Data & Type Issues

### [P2] manager_context type inconsistency
**Files:** Multiple throughout codebase
**Issue:** `manager_context` is sometimes a dict, sometimes a string
**Examples:**
- `enhanced_decision_framework.py:1419` - treats as dict
- `enhanced_decision_framework.py:1447` - treats as string
**Fix:** Standardize to always be a dict with consistent schema

### [P3] _manager_context_allows_tc is now dead code
**File:** `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py:1448-1457`
**Issue:** Method exists but is no longer called after TC gate removal
**Options:** Delete or repurpose for future risk gating

---

## Output & Display

### [DONE] Chip status display showed "None (all used)"
**Commit:** `056e648`
**Fixed:** chip_status structure is `{'Wildcard': {'available': True}}`, not boolean

### [DONE] ChipType/RiskLevel enums displayed as raw strings
**Commit:** `056e648`
**Fixed:** Added display formatting for enums

---

## UX & Feature Enhancements

### [P1] Lineups don't consider recommended transfers
**Issue:** When recommending lineup (starting XI), the system doesn't factor in transfers it just recommended
**Example:** Recommends transferring out Player A, but lineup still includes Player A
**Proposed:**
- After recommending transfers, apply them virtually to squad
- Then calculate optimal lineup from post-transfer squad
- Web UI could allow simulating transfers before requesting lineup

### [P1] Show bank balance to user
**Issue:** User's available bank (money in the bank) not displayed in output
**Check:** Does FPL API provide bank amount in bootstrap-static or manager endpoint?
**Fix:** If available, display in analysis output (CLI and Web)

### [P2] Simplify to single execution path (CLI or Web)
**Issue:** Having both CLI and Web modes creates maintenance burden and confusion
**Current state:** CLI works, Web may be broken (needs diagnosis)
**Decision needed:** Pick one path and deprecate the other
**Considerations:**
- CLI: Simpler, no frontend to maintain, power user focused
- Web: Better UX, visual, accessible to casual users

---

## Completed This Session

| Issue | Commit | Description |
|-------|--------|-------------|
| TC blocked by wrong field | `7a9f713` | Removed _manager_context_allows_tc gate |
| Legacy posture names | `7a9f713` | CHASE→AGGRESSIVE, DEFEND→CONSERVATIVE |
| Risk posture display | `ab70bac` | Added risk_posture to DecisionOutput edge cases |
| OptimizedXI access | `75ff3d2` | Fixed .starting_xi/.bench attribute access |
| Output formatting | `056e648` | Fixed chips display and enum formatting |

---

## How to Use This File

1. Pick a P0 or P1 item to address
2. Create a quick task: `/gsd:quick`
3. After fixing, move to "Completed" section with commit hash
4. Update "Last Updated" date

---

*This file tracks technical improvements identified during development. For feature work, see ROADMAP.md.*
