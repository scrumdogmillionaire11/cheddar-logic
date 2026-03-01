# Phase 1: CLI Stabilization - Research

**Researched:** 2026-01-23
**Domain:** Python refactoring, error handling, config validation
**Confidence:** HIGH

## Summary

Research into the existing CLI codebase reveals a 3,681-line monolithic decision framework with specific technical debt patterns that must be addressed before wrapping in a web API. The file contains 1 main class (`EnhancedDecisionFramework`) with 57+ methods handling chip analysis, transfer recommendations, captain selection, and output formatting. Exception handling analysis found 26 bare `except Exception:` handlers across 7 files (with 4 in the main framework). Config management uses a custom manager (`Sprint35ConfigManager`) with atomic writes but lacks schema validation. Known bugs involve manual player fallback (hardcoded ID 999999 for "Collins") and chip window context availability.

The standard approach for this type of stabilization is: (1) extract cohesive modules from monolith using single-responsibility principle, (2) replace bare exceptions with specific exception types + logging, (3) add Pydantic schema validation for config round-tripping, (4) write targeted tests for edge cases using pytest fixtures.

**Primary recommendation:** Modularize by domain responsibility (chip analysis, transfers, captain selection, output formatting), introduce custom exception hierarchy, validate config with Pydantic models, and add pytest fixtures for manual player and chip window scenarios.

## Standard Stack

The established libraries/tools for this domain:

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| pytest | 8.x | Testing framework | Python de facto standard, excellent fixture system for edge cases |
| Pydantic | 2.x | Data validation | Most widely used validation library, handles serialization + schema validation |
| dataclasses | stdlib | Data models | Already used in codebase (InjuryReport), lightweight for internal models |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| pytest-asyncio | 0.23+ | Async test support | If refactored modules need async testing (collectors are async) |
| mypy | 1.x | Static type checking | Optional but recommended - catches type errors pre-runtime |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Pydantic 2.x | attrs + cattrs | attrs is lighter but Pydantic has better JSON schema + docs ecosystem |
| dataclasses | Plain dicts | Dicts are more flexible but lose type safety and validation |
| pytest | unittest | unittest is stdlib but pytest fixtures are superior for complex setup |

**Installation:**
```bash
# Already in project (likely)
pip install pytest pydantic

# Optional but recommended
pip install pytest-asyncio mypy
```

## Architecture Patterns

### Recommended Project Structure
```
src/cheddar_fpl_sage/analysis/
├── decision_framework/
│   ├── __init__.py           # Public API exports
│   ├── chip_analyzer.py      # Chip strategy logic (BB, TC, FH, WC)
│   ├── transfer_advisor.py   # Transfer recommendations, manual transfers
│   ├── captain_selector.py   # Captain/vice selection with XI optimization
│   ├── output_formatter.py   # Summary generation, markdown formatting
│   ├── exceptions.py         # Custom exception hierarchy
│   └── models.py             # Dataclasses for decisions, contexts
├── enhanced_decision_framework.py  # Orchestrator (thin layer calling modules)
```

### Pattern 1: Domain Module Extraction
**What:** Split monolithic class into cohesive modules by responsibility
**When to use:** File > 1000 lines, class has 50+ methods with distinct concerns
**Example:**
```python
# Before (enhanced_decision_framework.py - 3,681 lines)
class EnhancedDecisionFramework:
    def analyze_chip_decision(self, ...): pass
    def _analyze_bench_boost_decision(self, ...): pass
    def _analyze_triple_captain_decision(self, ...): pass
    def _recommend_transfers(self, ...): pass
    def _apply_manual_transfers(self, ...): pass
    def _recommend_captaincy(self, ...): pass
    def generate_decision_summary(self, ...): pass
    # ... 50+ more methods

# After (chip_analyzer.py)
class ChipAnalyzer:
    """Handles all chip timing strategy (BB, TC, FH, WC)"""
    def analyze_chip_decision(self, ...): pass
    def _analyze_bench_boost(self, ...): pass
    def _analyze_triple_captain(self, ...): pass
    # Only chip-related logic

# After (transfer_advisor.py)
class TransferAdvisor:
    """Handles transfer recommendations and manual overrides"""
    def recommend_transfers(self, ...): pass
    def apply_manual_transfers(self, ...): pass
    # Only transfer logic
```

**Cohesion principle:** Methods that access the same subset of data belong in the same module.

### Pattern 2: Custom Exception Hierarchy
**What:** Replace bare `except Exception:` with domain-specific exceptions
**When to use:** Generic exception handling masks bugs and makes debugging hard
**Example:**
```python
# exceptions.py
class FPLSageError(Exception):
    """Base exception for all FPL Sage errors"""
    pass

class DataValidationError(FPLSageError):
    """Invalid data structure or missing required fields"""
    pass

class ConfigurationError(FPLSageError):
    """Config file invalid or cannot be loaded"""
    pass

class PlayerNotFoundError(FPLSageError):
    """Player ID or name lookup failed"""
    pass

# Usage
try:
    report = InjuryReport.from_dict(entry)
except (KeyError, ValueError, TypeError) as e:
    raise DataValidationError(f"Invalid injury report: {e}") from e
```

**Recovery strategy:**
- Low-level functions: Raise specific exceptions (don't catch)
- Mid-level: Transform exceptions (wrap with context)
- Top-level (CLI/API): Catch and log/display user-friendly messages

### Pattern 3: Pydantic Config Validation
**What:** Schema-based validation for config serialization
**When to use:** JSON config files that must round-trip cleanly
**Example:**
```python
# models.py
from pydantic import BaseModel, Field
from typing import Optional

class ChipStatus(BaseModel):
    available: bool
    played_gw: Optional[int] = None

class TeamConfig(BaseModel):
    manager_id: int
    manager_name: str
    risk_posture: str = Field(default="BALANCED", pattern="^(CHASE|DEFEND|BALANCED)$")
    manual_chip_status: dict[str, ChipStatus] = {}
    manual_free_transfers: Optional[int] = None

    class Config:
        validate_assignment = True  # Validate on attribute changes

# Usage - write
config = TeamConfig(manager_id=123, manager_name="Test")
with open("config.json", "w") as f:
    f.write(config.model_dump_json(indent=2))

# Usage - read (auto-validates)
with open("config.json") as f:
    config = TeamConfig.model_validate_json(f.read())
```

**Benefits:** Type coercion, validation errors with field names, guaranteed round-trip

### Pattern 4: Pytest Fixtures for Edge Cases
**What:** Reusable test setup for complex scenarios
**When to use:** Testing manual player fallback, missing data, chip window edge cases
**Example:**
```python
# conftest.py
import pytest

@pytest.fixture
def manual_player_squad():
    """Squad with hardcoded manual player (Collins ID 999999)"""
    return {
        'current_squad': [
            {'player_id': 1, 'name': 'Salah', 'position': 'MID'},
            {'player_id': 999999, 'name': 'Collins', 'position': 'DEF', 'team': 'CRY'},
        ]
    }

@pytest.fixture
def empty_chip_windows():
    """Config with no chip windows defined (tests UNAVAILABLE path)"""
    return {
        'chip_policy': {
            'chip_windows': []  # Empty windows
        }
    }

# test_manual_player.py
def test_manual_player_gets_fallback_projection(manual_player_squad, projections):
    framework = EnhancedDecisionFramework()
    decision = framework.analyze_chip_decision(
        team_data=manual_player_squad,
        fixture_data={},
        projections=projections
    )
    # Assert Collins gets fallback projection, not crash
    assert any(p.player_id == 999999 for p in decision.optimized_xi.starters)
```

### Anti-Patterns to Avoid
- **God Object:** Don't create one `Utils` module - be specific (ChipAnalyzer, not ChipUtils)
- **Leaky Abstractions:** Don't expose internal data structures - use dataclasses/models
- **Silent Failures:** Don't catch exceptions without logging or re-raising
- **Circular Imports:** Keep dependency graph acyclic (orchestrator depends on modules, not vice versa)

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Config validation | Custom dict checking | Pydantic BaseModel | Schema evolution, type coercion, clear error messages |
| Test fixtures | Manual setup in each test | pytest fixtures + conftest.py | Reusable, composable, automatic cleanup |
| JSON serialization | to_dict/from_dict by hand | Pydantic model_dump/model_validate | Handles nested objects, enums, dates automatically |
| Exception context | String messages only | Exception chaining (raise X from e) | Preserves stack traces, aids debugging |

**Key insight:** Config round-tripping fragility comes from manual serialization. Pydantic guarantees `write(model) → read() → same_model`.

## Common Pitfalls

### Pitfall 1: Breaking Changes During Refactor
**What goes wrong:** Extracting modules changes import paths, breaking existing scripts/tests
**Why it happens:** No deprecation path, all-at-once refactor
**How to avoid:**
1. Create new modules alongside old file
2. Import new modules in old file, delegate to them
3. Add deprecation warnings to old locations
4. Update tests incrementally
5. Remove old code in final commit
**Warning signs:** Tests suddenly fail with ImportError after refactor commit

### Pitfall 2: Losing Exception Context
**What goes wrong:** `except Exception:` catches KeyboardInterrupt, SystemExit - kills Ctrl+C
**Why it happens:** Bare except catches BaseException subclasses, not just errors
**How to avoid:**
- Use `except Exception as e:` (not bare `except:`)
- Catch specific exceptions when possible (ValueError, KeyError, TypeError)
- Let system exceptions propagate (KeyboardInterrupt, SystemExit)
**Warning signs:** Ctrl+C doesn't stop script, pytest hangs

### Pitfall 3: Pydantic Validation in Hot Paths
**What goes wrong:** Validating large configs in tight loops causes 10x+ slowdown
**Why it happens:** Pydantic does full validation on every model creation
**How to avoid:**
- Validate at boundaries (load config once at startup, not per analysis)
- Use `model_validate()` for untrusted input, `model_construct()` for trusted (skips validation)
- Cache validated models, don't re-parse JSON repeatedly
**Warning signs:** Analysis takes >2 seconds when it should be <500ms

### Pitfall 4: Test Isolation Failures
**What goes wrong:** Tests pass individually but fail when run together
**Why it happens:** Shared global state (config manager cache, module-level singletons)
**How to avoid:**
- Use pytest fixtures with function scope (default)
- Reset caches in teardown: `config_manager.invalidate_cache()`
- Avoid module-level state, pass dependencies explicitly
**Warning signs:** `pytest test_file.py::test_one` passes but `pytest test_file.py` fails

### Pitfall 5: Hardcoded Test Data Becomes Stale
**What goes wrong:** Tests use fake player ID 999999, but logic changes break it
**Why it happens:** Magic numbers in tests aren't updated when business logic changes
**How to avoid:**
- Use fixtures with realistic data structures
- Document why special IDs exist (e.g., "999999 is manual player fallback")
- Test with actual FPL player IDs from fixtures (avoids hardcoded assumptions)
**Warning signs:** Tests pass but manual players break in production

## Code Examples

Verified patterns from codebase analysis:

### Current Exception Handling (To Replace)
```python
# enhanced_decision_framework.py:142 (CURRENT - BARE EXCEPTION)
try:
    report = InjuryReport.from_dict(entry)
except Exception as exc:
    logger.warning("Failed to parse injury report entry: %s", exc)
    continue
```

**Issue:** Catches everything including typos, makes debugging hard.

### Recommended Exception Handling
```python
# exceptions.py (NEW)
class DataValidationError(FPLSageError):
    """Invalid data structure or missing fields"""
    pass

# enhanced_decision_framework.py (REFACTORED)
try:
    report = InjuryReport.from_dict(entry)
except (KeyError, ValueError, TypeError) as e:
    logger.warning("Failed to parse injury report entry: %s", e)
    raise DataValidationError(f"Invalid injury report structure: {e}") from e
```

**Benefits:** Specific exceptions, preserves stack trace, caller can handle differently.

### Current Config Loading (Sprint35ConfigManager)
```python
# sprint3_5_config_manager.py:104 (CURRENT)
with open(self.config_file, 'r') as f:
    raw = json.load(f)
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = {}
    # Manual dict field normalization
    for key in ['manual_chip_status', 'chip_policy', ...]:
        raw[key] = self._ensure_dict(raw.get(key))
```

**Issue:** Manual normalization, no schema validation.

### Recommended Config Loading (Pydantic)
```python
# models.py (NEW)
from pydantic import BaseModel, Field, field_validator

class TeamConfig(BaseModel):
    manager_id: int
    manager_name: str = "Unknown Manager"
    risk_posture: str = Field(default="BALANCED", pattern="^(CHASE|DEFEND|BALANCED)$")
    manual_chip_status: dict[str, ChipStatus] = Field(default_factory=dict)

    @field_validator('manual_chip_status')
    def validate_chips(cls, v):
        # Ensure all chips present with defaults
        for chip in ["Wildcard", "Free Hit", "Bench Boost", "Triple Captain"]:
            if chip not in v:
                v[chip] = ChipStatus(available=True, played_gw=None)
        return v

# config_manager.py (REFACTORED)
def load_config(self) -> TeamConfig:
    with open(self.config_file) as f:
        return TeamConfig.model_validate_json(f.read())  # Auto-validates
```

**Benefits:** Schema ensures completeness, validation errors name field, round-trips guaranteed.

### Manual Player Fallback (Current Bug)
```python
# enhanced_decision_framework.py:219 (CURRENT - HARDCODED)
elif player_id == 999999:  # Manually added player (Collins)
    fallback_proj = CanonicalPlayerProjection(
        player_id=player_id,
        name=player.get('name', 'Manual Player'),
        position=player.get('position', 'DEF'),
        # ... hardcoded projection
    )
```

**Issue:** Hardcoded ID, "Collins" specific, fragile.

### Recommended Manual Player Handling
```python
# constants.py (NEW)
MANUAL_PLAYER_ID_START = 900000  # Reserved range for manual players

# transfer_advisor.py (REFACTORED)
def _is_manual_player(player_id: int) -> bool:
    return player_id >= MANUAL_PLAYER_ID_START

def _create_fallback_projection(player: Dict) -> CanonicalPlayerProjection:
    """Create conservative projection for manually added players"""
    if not _is_manual_player(player.get('player_id', 0)):
        raise ValueError("Only call for manual players")

    return CanonicalPlayerProjection(
        player_id=player['player_id'],
        name=player.get('name', 'Manual Player'),
        position=player.get('position', 'DEF'),
        nextGW_pts=5.0,  # Conservative default
        # ... rest of projection
    )
```

**Benefits:** Documented ID range, testable with any manual player, not Collins-specific.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| unittest | pytest with fixtures | ~2018+ | Better edge case testing, less boilerplate |
| Manual dict validation | Pydantic models | 2020+ (Pydantic 2.x in 2023) | Schema evolution, round-trip guarantees |
| Bare except Exception: | Specific exceptions + context | Always best practice | Better debugging, intentional error handling |
| Single file scripts | Package structure with modules | N/A | Maintainable at scale, testable components |

**Deprecated/outdated:**
- `except:` (bare except) - Catches system exceptions, breaks Ctrl+C
- Manual to_dict/from_dict methods - Pydantic handles this better
- Module-level global config - Hard to test, use dependency injection

## Open Questions

Things that couldn't be fully resolved:

1. **Module boundaries for chip analysis**
   - What we know: ~20 methods related to chip decisions (BB, TC, FH, WC)
   - What's unclear: Should chip window scoring be separate module or part of chip analyzer?
   - Recommendation: Start with ChipAnalyzer class, extract ChipWindowScorer if >500 lines

2. **Backwards compatibility strategy**
   - What we know: Scripts import `EnhancedDecisionFramework` directly
   - What's unclear: How many external scripts depend on current structure?
   - Recommendation: Delegate from old class to new modules for 1-2 versions, then deprecate

3. **Test coverage baseline**
   - What we know: 21 tests exist in tests_new/, mostly smoke tests
   - What's unclear: What percentage of decision framework is covered?
   - Recommendation: Run pytest --cov before refactor to establish baseline, aim for 70%+ on new modules

4. **Chip window context "UNAVAILABLE" bug**
   - What we know: Occurs when chip_windows is empty or scoring fails
   - What's unclear: Is this a data issue (missing windows in config) or logic issue?
   - Recommendation: Add test with empty chip_windows, ensure graceful fallback (not "UNAVAILABLE")

## Sources

### Primary (HIGH confidence)
- Codebase analysis: `/src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py` (3,681 lines, 57 methods)
- Codebase analysis: `/src/cheddar_fpl_sage/utils/sprint3_5_config_manager.py` (551 lines, config handling patterns)
- Codebase analysis: `/src/cheddar_fpl_sage/models/injury_report.py` (dataclass pattern already in use)
- Codebase analysis: Exception handler count via grep (26 instances across 7 files)

### Secondary (MEDIUM confidence)
- [Pydantic Documentation - Models](https://docs.pydantic.dev/latest/concepts/models/) - Schema validation patterns
- [Pydantic Documentation - Serialization](https://docs.pydantic.dev/latest/concepts/serialization/) - model_dump/model_validate
- [Python Official Docs - Errors and Exceptions](https://docs.python.org/3/tutorial/errors.html) - Specific exception handling
- [Real Python - Exception Handling Best Practices](https://realpython.com/ref/best-practices/exception-handling/) - Catch specific, log, re-raise
- [Real Python - Python Refactoring](https://realpython.com/python-refactoring/) - Extract method, decompose conditionals

### Tertiary (LOW confidence - principles validated by practice)
- [Qodo - Python Refactoring Techniques](https://www.qodo.ai/blog/8-python-code-refactoring-techniques-tools-practices/) - Extract methods, decompose conditionals
- [CodeSee - Python Refactoring](https://www.codesee.io/learning-center/python-refactoring) - Large file refactoring strategies
- [Medium - Exception Handling Best Practices](https://medium.com/@saadjamilakhtar/5-best-practices-for-python-exception-handling-5e54b876a20) - Avoid bare except, use specific

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Pytest, Pydantic are industry standard, verified via docs
- Architecture: HIGH - Patterns observed in existing codebase (dataclasses, fixtures), refactoring is well-documented practice
- Pitfalls: HIGH - Based on actual codebase analysis (bare exceptions, hardcoded IDs) and Python best practices

**Research date:** 2026-01-23
**Valid until:** 60 days (stable domain - Python refactoring best practices don't change rapidly)

**Codebase-specific findings:**
- Enhanced decision framework: 3,681 lines, 1 class, 57+ methods
- Exception handlers: 26 bare `except Exception:` across 7 files (4 in main framework)
- Config manager: Custom atomic write system, but no schema validation
- Known bugs: Manual player ID 999999 hardcoded, chip window "UNAVAILABLE" with empty windows
- Test coverage: 21 tests in tests_new/, focused on smoke tests and pipelines
- Existing patterns: dataclasses (InjuryReport), pytest fixtures (test_orchestrator_smoke.py), async collectors
