---
phase: 01-cli-stabilization
plan: 02
subsystem: analysis
tags: [refactoring, modularization, risk-posture, decision-framework]

# Dependency graph
requires:
  - phase: 01-cli-stabilization/01
    provides: Repository cleanup and exception hierarchy
provides:
  - ChipAnalyzer module for chip timing decisions
  - TransferAdvisor module for transfer recommendations
  - CaptainSelector module for captain/vice-captain picks
  - OutputFormatter module for summary generation
  - Risk posture enum with tri-state precedence (CLI > Runtime > Config > Default)
  - Volatility multipliers for risk-aware transfer scoring
affects:
  - 01-cli-stabilization/03 (config validation)
  - 02-api-layer (will use modular decision framework)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Delegation pattern for orchestrator to domain modules
    - Centralized risk posture validation in constants.py
    - Config-driven risk tolerance with CLI override

key-files:
  created:
    - src/cheddar_fpl_sage/analysis/decision_framework/chip_analyzer.py
    - src/cheddar_fpl_sage/analysis/decision_framework/transfer_advisor.py
    - src/cheddar_fpl_sage/analysis/decision_framework/captain_selector.py
    - src/cheddar_fpl_sage/analysis/decision_framework/output_formatter.py
    - tests/tests_new/test_risk_posture_precedence.py
  modified:
    - src/cheddar_fpl_sage/analysis/decision_framework/__init__.py
    - src/cheddar_fpl_sage/analysis/decision_framework/constants.py
    - src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py
    - src/cheddar_fpl_sage/analysis/decision_framework/config_models.py
    - src/cheddar_fpl_sage/utils/sprint3_5_config_manager.py
    - fpl_sage.py

key-decisions:
  - "Kept enhanced_decision_framework.py at 2,197 lines (41% reduction from 3,681) as further extraction would require architectural changes"
  - "Risk posture uses canonical values (CONSERVATIVE|BALANCED|AGGRESSIVE), legacy values (CHASE|DEFEND) mapped automatically"
  - "Volatility multipliers: CONSERVATIVE 1.25x, BALANCED 1.0x, AGGRESSIVE 0.8x"

patterns-established:
  - "Module delegation: Orchestrator creates module instances with risk_posture, delegates method calls"
  - "Config model normalization: TeamConfig pydantic model normalizes legacy values to canonical on load"
  - "Tri-state precedence: CLI arg > Runtime prompt > team_config.json > BALANCED default"

# Metrics
duration: 5min
completed: 2026-01-23
---

# Phase 01 Plan 02: Domain Module Extraction Summary

**Extracted 4 domain modules from monolith, implemented Manager Risk Tolerance with tri-state precedence and volatility multipliers**

## Performance

- **Duration:** 5 min
- **Started:** 2026-01-23T22:57:26Z
- **Completed:** 2026-01-23T23:02:49Z
- **Tasks:** 4
- **Files modified:** 11

## Accomplishments

- Extracted ChipAnalyzer, TransferAdvisor, CaptainSelector, OutputFormatter modules
- Reduced enhanced_decision_framework.py from 3,681 to 2,197 lines (41% reduction)
- Implemented Manager Risk Tolerance enum with centralized validation
- Added CLI argument --risk-posture and runtime prompt in edit_overrides() flow
- Created 24 acceptance tests for risk posture precedence and validation

## Task Commits

Each task was committed atomically:

1. **Task 1: Extract ChipAnalyzer module** - `9b5a9a2` (feat)
2. **Task 2: Extract TransferAdvisor and CaptainSelector** - `5882634` (feat)
3. **Task 3: Extract OutputFormatter, finalize orchestrator** - `391c548` (feat)
4. **Task 4: Implement Manager Risk Tolerance** - `17330e2` (feat)

**Bug fix commit:** `959e07f` (fix) - Risk posture normalization and config handling

## Files Created/Modified

- `src/cheddar_fpl_sage/analysis/decision_framework/chip_analyzer.py` - ChipAnalyzer class with chip timing logic
- `src/cheddar_fpl_sage/analysis/decision_framework/transfer_advisor.py` - TransferAdvisor class with transfer recommendations
- `src/cheddar_fpl_sage/analysis/decision_framework/captain_selector.py` - CaptainSelector class with captain picks
- `src/cheddar_fpl_sage/analysis/decision_framework/output_formatter.py` - OutputFormatter class with summary generation
- `src/cheddar_fpl_sage/analysis/decision_framework/constants.py` - Added normalize_risk_posture(), get_volatility_multiplier()
- `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py` - Orchestrator with delegation to domain modules
- `src/cheddar_fpl_sage/analysis/decision_framework/config_models.py` - Fixed risk posture normalization mapping
- `src/cheddar_fpl_sage/utils/sprint3_5_config_manager.py` - Added get/set_risk_posture(), fixed derive_risk_posture_from_rank()
- `fpl_sage.py` - Added --risk-posture CLI argument and runtime prompt
- `tests/tests_new/test_risk_posture_precedence.py` - 24 acceptance tests

## Decisions Made

1. **Orchestrator line count (2,197 vs 1,500 target):** The enhanced_decision_framework.py was reduced by 41% but remains above the 1,500 line target. Further reduction would require significant architectural changes (splitting optimize_starting_xi, _decide_optimal_chip_strategy) which are out of scope for this extraction plan.

2. **Risk posture canonical values:** Chose CONSERVATIVE|BALANCED|AGGRESSIVE as canonical values (more intuitive than CHASE|DEFEND). Legacy values mapped automatically via config_models.py normalization.

3. **Config model normalization:** TeamConfig pydantic model normalizes risk_posture on load, ensuring legacy configs work seamlessly with new canonical values.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed config_models.py risk posture mapping**
- **Found during:** Task 4 testing
- **Issue:** TeamConfig.normalize_risk_posture() mapped AGGRESSIVE->CHASE instead of preserving canonical value
- **Fix:** Inverted mapping to convert legacy CHASE->AGGRESSIVE, DEFEND->CONSERVATIVE
- **Files modified:** src/cheddar_fpl_sage/analysis/decision_framework/config_models.py
- **Committed in:** 959e07f

**2. [Rule 1 - Bug] Fixed sprint3_5_config_manager derive_risk_posture_from_rank**
- **Found during:** Task 4 testing
- **Issue:** derive_risk_posture_from_rank() returned legacy values (CHASE/DEFEND) not canonical
- **Fix:** Updated to return CONSERVATIVE/AGGRESSIVE
- **Files modified:** src/cheddar_fpl_sage/utils/sprint3_5_config_manager.py
- **Committed in:** 959e07f

**3. [Rule 1 - Bug] Fixed fpl_sage_integration.py null handling**
- **Found during:** Task 4 testing (test_orchestrator_smoke.py failure)
- **Issue:** `self.config.get('manual_overrides', {})` returns None when key exists with null value
- **Fix:** Changed to `self.config.get('manual_overrides') or {}`
- **Files modified:** src/cheddar_fpl_sage/analysis/fpl_sage_integration.py
- **Committed in:** 959e07f

---

**Total deviations:** 3 auto-fixed bugs
**Impact on plan:** All fixes necessary for correctness. No scope creep.

## Issues Encountered

- Test isolation issues with config manager cache required adding invalidate_cache() calls after file writes
- The orchestrator reduction from 3,681 to <1,500 lines was not achieved (ended at 2,197) - the remaining code is tightly coupled and would require architectural changes to extract further

## Next Phase Readiness

- Domain modules ready for independent unit testing
- Risk posture system ready for use in transfer scoring and chip decisions
- Modular architecture enables easier web API wrapping in Phase 2

---
*Phase: 01-cli-stabilization*
*Completed: 2026-01-23*
