---
phase: 01-cli-stabilization
plan: 03
subsystem: config
tags: [pydantic, validation, config, serialization, schema]

# Dependency graph
requires:
  - phase: 01-01
    provides: Exception hierarchy with ConfigurationError
provides:
  - Pydantic TeamConfig model for config validation
  - Config round-trip consistency
  - Legacy format handling (stringified JSON, boolean chips)
  - Schema validation on load/save
affects: [api-design, web-backend]

# Tech tracking
tech-stack:
  added: [pydantic models for config]
  patterns: [Pydantic validation at boundaries, atomic config writes]

key-files:
  created:
    - src/cheddar_fpl_sage/analysis/decision_framework/config_models.py
    - tests/tests_new/test_config_validation.py
  modified:
    - src/cheddar_fpl_sage/analysis/decision_framework/__init__.py
    - src/cheddar_fpl_sage/utils/sprint3_5_config_manager.py

key-decisions:
  - "Use Pydantic v2 model_validate/model_dump for validation"
  - "Validate at boundaries (load/save) not on every access"
  - "Map legacy risk postures: CHASE->AGGRESSIVE, DEFEND->CONSERVATIVE"
  - "ConfigurationError raised for malformed JSON (not silent fallback)"

patterns-established:
  - "Pydantic models for config validation with field validators for legacy formats"
  - "extra='ignore' for forward compatibility with unknown fields"
  - "Path objects accepted in config file parameter"

# Metrics
duration: 6min
completed: 2026-01-23
---

# Phase 1 Plan 03: Config Schema Validation Summary

**Pydantic schema validation for team_config.json with legacy format handling and 18 test cases**

## Performance

- **Duration:** 6 min
- **Started:** 2026-01-23T22:56:58Z
- **Completed:** 2026-01-23T23:03:06Z
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments
- TeamConfig Pydantic model validates all config fields with proper types
- Legacy formats handled gracefully (stringified JSON, boolean chip status)
- Config round-trips cleanly without data loss
- 18 test cases cover edge cases from CONCERNS.md analysis

## Task Commits

Each task was committed atomically:

1. **Task 1: Create Pydantic config models** - `124f479` (feat)
2. **Task 2: Integrate Pydantic validation into config manager** - `fd6a9c9` (feat)
3. **Task 3: Add config validation tests** - `64f87fa` (test)

## Files Created/Modified
- `src/cheddar_fpl_sage/analysis/decision_framework/config_models.py` - Pydantic models: TeamConfig, ChipStatus, ManualTransfer, ChipPolicy, etc.
- `src/cheddar_fpl_sage/analysis/decision_framework/__init__.py` - Export config models
- `src/cheddar_fpl_sage/utils/sprint3_5_config_manager.py` - Integrated Pydantic validation on load/save
- `tests/tests_new/test_config_validation.py` - 18 test cases for validation edge cases

## Decisions Made
- Used Pydantic v2's `model_validate()` and `model_dump()` for schema validation
- Validation happens at boundaries (load from disk, save to disk) not on every config access
- Legacy risk posture names mapped: CHASE->AGGRESSIVE, DEFEND->CONSERVATIVE to match existing constants.py
- Malformed JSON raises ConfigurationError rather than silently using defaults (explicit is better)
- Extra fields ignored with `extra='ignore'` for forward compatibility

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] ChipWindow/ChipPolicy needed legacy format handling**
- **Found during:** Task 2 verification
- **Issue:** Existing configs might have chip_windows with startGW/endGW instead of start_gw/end_gw
- **Fix:** Added model_validator to normalize legacy field names, added field_validator to filter invalid entries
- **Files modified:** config_models.py
- **Committed in:** fd6a9c9 (Task 2 commit)

**2. [Rule 1 - Bug] Risk posture normalization direction was inverted**
- **Found during:** Task 3 verification
- **Issue:** Tests expected AGGRESSIVE->CHASE but existing codebase uses CONSERVATIVE/BALANCED/AGGRESSIVE
- **Fix:** Updated normalizer to map CHASE->AGGRESSIVE and DEFEND->CONSERVATIVE to match constants.py
- **Files modified:** config_models.py, test_config_validation.py
- **Committed in:** 64f87fa (Task 3 amend)

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both fixes necessary for compatibility with existing codebase. No scope creep.

## Issues Encountered
- Root `team_config.json` vs `config/team_config.json` - default path finds wrong file. Tests use explicit paths.

## Next Phase Readiness
- Config validation foundation complete
- Ready for further error handling improvements (Plan 01-04)
- Pydantic models available for future API request/response validation

---
*Phase: 01-cli-stabilization*
*Completed: 2026-01-23*
