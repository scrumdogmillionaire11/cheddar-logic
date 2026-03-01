# Coding Conventions

**Analysis Date:** 2026-01-23

## Naming Patterns

**Files:**
- `snake_case.py` for all modules
- Test files: `test_*.py` in `tests/` or `tests_new/` directories
- Component grouping: Related functionality grouped in directories by domain (e.g., `collectors/`, `analysis/`, `utils/`, `models/`, `validation/`)

**Functions:**
- `snake_case` for all function names
- Helper/private functions prefixed with `_` (e.g., `_ensure_cache_dir()`, `_map_fpl_status()`, `_load_json()`)
- Factory/builder functions prefixed descriptively: `build_*`, `make_*`, `load_*`, `get_*` (e.g., `build_slate()`, `make_projection()`, `load_ruleset()`)

**Variables:**
- `snake_case` for all local and module variables
- Constants: `UPPER_CASE` (e.g., `CACHE_DIR`, `MANUAL_EXPIRY_HOURS`, `FPL_STALE_HOURS`)
- Enums: `PascalCase` for enum classes, `UPPER_CASE` for enum members

**Types:**
- `PascalCase` for dataclass names (e.g., `CanonicalPlayerProjection`, `InjuryReport`, `OptimizedXI`)
- `PascalCase` for Enum classes (e.g., `InjuryStatus`, `InjurySource`, `InjuryConfidence`)
- Type hints required for function parameters and return values

## Code Style

**Formatting:**
- Standard Python formatting (PEP 8 compliant)
- 4-space indentation
- Line breaks after imports, before function definitions, before class definitions
- No strict line length enforcement observed; lines up to ~100 characters common

**Linting:**
- Ruff cache present (`.ruff_cache/`) indicates Ruff is used
- Configuration: `pyproject.toml` contains pytest and build settings
- No ESLint/Prettier config (Python project)

## Import Organization

**Order:**
1. Standard library imports (e.g., `json`, `logging`, `dataclasses`)
2. Third-party imports (e.g., `aiohttp`, `asyncio`)
3. Relative local imports (e.g., `from ..utils.output_manager import write_json_atomic`)

**Path Aliases:**
- No path aliases observed; uses relative imports from package root
- Absolute imports from `cheddar_fpl_sage` package namespace (e.g., `from cheddar_fpl_sage.models.canonical_projections import CanonicalPlayerProjection`)

**Barrel Files:**
- Used in `__init__.py` files to expose key exports (see `src/cheddar_fpl_sage/__init__.py`)
- Example: `__all__` list explicitly defines public API

```python
# From src/cheddar_fpl_sage/__init__.py
__all__ = [
    "EnhancedDecisionFramework",
    "FPLSageIntegration",
    "EnhancedFPLCollector",
    "ChipStatusManager",
]
```

## Error Handling

**Patterns:**
- Explicit exception raising with descriptive messages:
  ```python
  # From src/cheddar_fpl_sage/validation/id_integrity.py
  if str(canonical_team) != str(team_id):
      raise ValueError(f"DATA_INTEGRITY: player_id {pid} has conflicting team_id {team_id} vs {canonical_team}")
  ```

- Try-except with fallback logic:
  ```python
  # From src/cheddar_fpl_sage/collectors/enhanced_fpl_collector.py
  try:
      picks_data = await self.fetch_json(f"/entry/{team_id}/event/{picks_gw}/picks/")
  except Exception as exc:
      if next_gw and picks_gw == next_gw:
          logger.warning(f"Next GW picks not available (GW{next_gw}), falling back to current GW{current_gw}: {exc}")
          picks_gw = current_gw
          picks_data = await self.fetch_json(f"/entry/{team_id}/event/{picks_gw}/picks/")
      else:
          raise
  ```

- Silent skipping with logging warnings:
  ```python
  # From src/cheddar_fpl_sage/validation/data_gate.py
  except Exception:
      return 1e9  # Large value to indicate parse failure
  ```

- Dataclass validation in `__post_init__`:
  ```python
  # From src/cheddar_fpl_sage/models/canonical_projections.py
  def __post_init__(self):
      assert len(self.starting_xi) == 11, f"XI must have 11 players, got {len(self.starting_xi)}"
      assert all(p in self.starting_xi for p in self.captain_pool), "Captain pool must be subset of XI"
  ```

## Logging

**Framework:** Standard Python `logging` module

**Patterns:**
- Module-level logger: `logger = logging.getLogger(__name__)`
- Info for state changes and collection progress: `logger.info(f"✅ bootstrap_static: {bootstrap_hash}")`
- Warning for degradation/fallback: `logger.warning(f"⚠️  entry_{team_id}: {entry_result['status']} - {entry_result['error']}")`
- Error for failures: `logger.error(f"FAIL: {str(e)}", exc_info=True)`
- Messages include context (IDs, names, file paths)
- Emoji used for log clarity (✅, ⚠️, 🔄, etc.)

## Comments

**When to Comment:**
- Module docstrings: Always include (triple-quoted)
- Function docstrings: For public functions, especially in models and utils
- Inline comments: Sparingly, only for non-obvious logic
- Type intentions: Comments explain purpose of complex fields

**JSDoc/TSDoc:**
- Not used (Python project)
- Docstrings in Google/PEP 257 style with brief one-liner followed by explanation
- Example from `src/cheddar_fpl_sage/models/canonical_projections.py`:
  ```python
  @property
  def effective_ownership(self) -> Optional[float]:
      """Calculate EO only when we have captaincy data"""
  ```

## Function Design

**Size:** Functions are typically 15-50 lines; longer functions exist for data transformation pipelines

**Parameters:**
- Explicit parameters preferred over `*args`, `**kwargs`
- Type hints on all parameters
- Optional parameters use `Optional[Type]` or `Type | None`
- Config dicts passed as-is when necessary (minimal unpacking)

**Return Values:**
- Explicit return types specified
- Return dicts for multi-value returns (not tuples)
- Dataclasses return from factory functions (e.g., `build_slate()` returns dict representation)
- Early returns for validation/guard clauses:
  ```python
  # From src/cheddar_fpl_sage/validation/data_gate.py
  if not bootstrap_path.exists():
      return GateResult(status="HOLD", block_reason="MISSING_BOOTSTRAP_STATIC", missing=["bootstrap_static.json"])
  ```

## Module Design

**Exports:**
- Dataclasses and main classes exported in `__init__.py`
- Public functions exported via `__all__`

**Barrel Files:**
- Used to expose high-level API without exposing implementation details
- `src/cheddar_fpl_sage/utils/__init__.py` exports commonly used utilities

**Organization:**
- One primary class/dataclass per file when possible
- Related functions grouped (e.g., mapping functions, validation functions)
- Constants defined at module level with descriptive names

---

*Convention analysis: 2026-01-23*
