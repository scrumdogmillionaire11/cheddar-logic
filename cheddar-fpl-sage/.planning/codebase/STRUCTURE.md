# Codebase Structure

**Analysis Date:** 2026-01-23

## Directory Layout

```
cheddar-fpl-sage/
├── src/cheddar_fpl_sage/           # Main package (installable via pyproject.toml)
│   ├── __init__.py                 # Public API exports
│   ├── analysis/                   # Decision framework & orchestration
│   │   ├── enhanced_decision_framework.py     # Core decision logic with risk scenarios
│   │   ├── fpl_sage_integration.py            # Main orchestrator
│   │   ├── sprint2_integration.py             # Sprint 2 legacy integration
│   │   └── sprint3_integration.py             # Sprint 3 legacy integration
│   ├── collectors/                 # FPL API data fetching (async)
│   │   ├── enhanced_fpl_collector.py          # Async HTTP client with team data
│   │   ├── simple_fpl_collector.py            # Basic fallback collector
│   │   ├── weekly_bundle_collector.py         # Coordinates collection into bundles
│   │   └── weekly_snapshot_collector.py       # Snapshot management
│   ├── models/                     # Canonical data contracts
│   │   ├── canonical_projections.py           # CanonicalPlayerProjection, CanonicalProjectionSet, OptimizedXI
│   │   └── injury_report.py                   # InjuryReport model with status/confidence
│   ├── storage/                    # Persistence layer
│   │   └── fpl_db.py               # SQLite snapshots table and artifact tracking
│   ├── transformers/               # Data transformation
│   │   └── slate_builder.py        # Fixture slate building by gameweek
│   ├── validation/                 # Data quality gates
│   │   ├── data_gate.py            # Bundle completeness & freshness validation
│   │   └── id_integrity.py         # Player ID consistency checks
│   ├── injury/                     # Injury data processing
│   │   └── processing.py           # Merge FPL + secondary + manual injury data
│   ├── rules/                      # Rule engine
│   │   └── fpl_rules.py            # Ruleset loading & application
│   ├── pipelines/                  # Data pipeline stages
│   │   └── build_weekly_inputs.py  # Weekly preparation pipeline
│   └── utils/                      # Shared utilities
│       ├── __init__.py             # Public utility exports
│       ├── chip_status_manager.py  # Chip tracking (BB, TC, FH, WC)
│       ├── chip_resolver_sprint2.py         # Chip state resolution
│       ├── manual_transfer_manager.py       # Personal transfer overrides
│       ├── ft_resolver_sprint2.py           # Free transfer state resolution
│       ├── restriction_coordinator.py       # Restriction hierarchy & authority
│       ├── output_manager.py                # Run paths, atomic writes, run_id generation
│       ├── resolvable_states.py             # State enums & contracts
│       ├── sprint3_5_config_manager.py      # Centralized config with cache
│       ├── sprint3_fixes.py                 # Sprint 3 specific fixes
│       └── sprint2_integration.py           # Sprint 2 utilities
├── config/                         # Configuration & rulesets
│   ├── fpl_team_ids.json          # Quick-pick team profiles
│   ├── team_config.json           # Main config (chips, transfers, injuries, analysis preferences)
│   ├── team_config.template.json  # Config template
│   ├── requirements.txt           # Python dependencies
│   ├── requirements_minimal.txt   # Minimal dependency subset
│   ├── secondary_injury_feed.json # Cached secondary injury data
│   └── rulesets/                 # FPL rule definitions
├── tests/                         # Test suite
│   ├── integration_example.py     # Example integration test
│   ├── test_transfer_fixes.py     # Transfer-specific tests
│   ├── test_manager_name.py       # Name normalization tests
│   ├── debug_manager_name.py      # Debug utilities for naming
│   └── tests_new/                # New test suite (organized by feature)
│       ├── test_data_gate.py      # Validation gate tests
│       ├── test_slate_builder.py  # Fixture slate tests
│       ├── test_identity_integrity.py    # Player ID consistency tests
│       ├── test_injury_pipeline.py       # Injury processing tests
│       ├── test_chip_expiry_policy.py    # Chip timing logic tests
│       ├── test_window_summary.py        # Fixture window analysis tests
│       ├── test_formation_feasibility.py # XI constraint tests
│       ├── test_orchestrator_smoke.py    # End-to-end orchestrator tests
│       ├── test_phase3_normalizer.py     # Data normalization tests
│       ├── test_summary_and_injury_filters.py # Summary generation tests
│       └── test_pipeline_smoke.py        # Pipeline stage tests
├── scripts/                       # CLI scripts & utilities
│   ├── run_enhanced_analysis.py   # Main async analysis runner
│   ├── run_analysis.py            # Alternative analysis entry
│   ├── data_pipeline_cli.py       # Data collection & pipeline CLI
│   ├── manage_transfers.py        # Transfer management interface
│   ├── organize_outputs.py        # Output organization & cleanup
│   ├── setup_2025_season.py       # Season initialization
│   ├── simple_setup.py            # Simplified setup
│   ├── test_phase1.py             # Phase 1 testing
│   ├── test_phase2_collector.py   # Phase 2 collector tests
│   ├── test_sprint2.py            # Sprint 2 tests
│   ├── test_sprint3.py            # Sprint 3 tests
│   ├── test_sprint3_5.py          # Sprint 3.5 tests
│   ├── test_transfer_matching.py  # Transfer matching tests
│   ├── transfer_example.py        # Transfer usage example
│   ├── refresh_injury_secondary.py # Secondary feed refresh
│   ├── create_transfer_package.py # Transfer package creation
│   ├── validate_latest_outputs.py # Output validation
│   ├── prune_outputs.py           # Clean old outputs
│   ├── quick_test_names.py        # Quick name tests
│   ├── outputs_cli.py             # Output management CLI
│   └── test_sprint2_integration.py # Sprint 2 integration tests
├── outputs/                       # Analysis results (generated)
│   ├── runs/                      # Organized by team & run_id
│   │   ├── team_{TEAM_ID}/{run_id}/
│   │   │   ├── data/              # Raw collected data
│   │   │   ├── inputs/            # Model inputs & projections
│   │   │   ├── analysis/          # Decision output & recommendations
│   │   │   ├── report/            # Human-readable reports
│   │   │   ├── injury/            # Injury summaries & artifacts
│   │   │   └── {run_id}.log       # Run log
│   │   └── no_team/{run_id}/      # General analysis (no team_id)
│   ├── snapshots/                 # Weekly data snapshots
│   │   └── {season}/gw_{GW}/{snapshot_id}/
│   ├── LATEST.json               # Pointer to most recent run
│   └── DATA_SUMMARY.json         # Summary statistics
├── db/                           # Database files (generated)
│   └── fpl_snapshots.sqlite      # Weekly snapshot storage
├── outputs/                      # CLI output results
│   └── {team_id or general}/{timestamp}/
├── fpl_sage.py                   # Main entry point (root level)
├── pyproject.toml                # Package configuration & dependencies
├── README.md                     # Project documentation
└── .planning/
    ├── codebase/
    │   ├── ARCHITECTURE.md       # This file (architecture patterns)
    │   └── STRUCTURE.md          # Codebase organization (this file)
    └── [other planning docs]     # Design, requirements, etc.
```

## Directory Purposes

**`src/cheddar_fpl_sage/`** (Main package)
- Purpose: Installable Python package with all core logic
- Entry point: `src/cheddar_fpl_sage/__init__.py` exports public API
- Package namespace: `cheddar_fpl_sage`

**`src/cheddar_fpl_sage/analysis/`**
- Purpose: Decision frameworks and orchestration
- Key files: `fpl_sage_integration.py` (main), `enhanced_decision_framework.py` (core logic)
- Imports from: collectors, models, validation, injury, rules

**`src/cheddar_fpl_sage/collectors/`**
- Purpose: Async API data fetching
- Key dependency: `aiohttp` for async HTTP
- Pattern: Context managers for session lifecycle management
- Returns: Raw JSON from FPL API, preprocessed into bundle structure

**`src/cheddar_fpl_sage/models/`**
- Purpose: Canonical data contracts
- No I/O: Pure dataclasses with validation in `__post_init__`
- Consumed by: All downstream analysis components
- Key: Single source of truth prevents format divergence

**`src/cheddar_fpl_sage/validation/`**
- Purpose: Guard against invalid/stale data
- `DataGate`: File existence, freshness (age < max minutes)
- `IdIntegrity`: Player ID consistency across bootstrap/fixtures/picks

**`src/cheddar_fpl_sage/injury/`**
- Purpose: Multi-source injury aggregation
- Merges: FPL API + secondary feed + manual overrides
- Authority hierarchy: Manual > Secondary > FPL
- Outputs: `InjuryReport` objects with confidence scores

**`src/cheddar_fpl_sage/storage/`**
- Purpose: Snapshot persistence
- SQLite schema tracks raw artifacts and validation status
- Used for reproducible analysis & historical trend analysis

**`src/cheddar_fpl_sage/utils/`**
- Purpose: Shared helpers & state management
- Key: Centralized `Sprint35ConfigManager` for config loading & caching
- Contains: Chip/transfer state resolvers, output path managers, atomic writers

**`config/`**
- Purpose: Configuration & static data
- `team_config.json`: User-provided overrides (chips, transfers, injuries, analysis preferences)
- `secondary_injury_feed.json`: Cached injury data beyond FPL API
- `fpl_team_ids.json`: Team ID shortcuts for quick profile selection
- `rulesets/`: FPL rule definitions loaded at runtime

**`tests/`**
- Purpose: Test suite organized by feature
- `tests_new/`: Modern tests organized by component
- Pattern: Unit tests for models, integration tests for full pipelines
- Run: `pytest tests/` or specific test file

**`scripts/`**
- Purpose: CLI entry points & utilities
- Runnable scripts (executable via `python script.py`)
- Example: `run_enhanced_analysis.py` is the recommended analysis script
- Not meant for import; use `src/cheddar_fpl_sage/` modules instead

**`outputs/`** (Generated)
- Purpose: Results storage
- Structure: `runs/team_{TEAM_ID}/{run_id}/` for organized results
- Pointer: `LATEST.json` tracks most recent run
- Atomic writes prevent partial writes on crash

**`db/`** (Generated)
- Purpose: Persistent snapshot storage
- SQLite database for historical data access
- Created automatically by storage layer

## Key File Locations

**Entry Points:**
- `fpl_sage.py` (root): Main CLI for interactive analysis with team ID prompt
- `scripts/run_enhanced_analysis.py`: Async wrapper with detailed logging
- `scripts/data_pipeline_cli.py`: Data collection & pipeline operations

**Configuration:**
- `config/team_config.json`: Manual chips, transfers, injuries, analysis preferences
- `config/fpl_team_ids.json`: Team ID profiles for quick selection
- `config/secondary_injury_feed.json`: Cached secondary injury data
- `pyproject.toml`: Package metadata & dependencies

**Core Logic:**
- `src/cheddar_fpl_sage/analysis/fpl_sage_integration.py`: Main orchestrator
- `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py`: Decision engine
- `src/cheddar_fpl_sage/collectors/enhanced_fpl_collector.py`: API client
- `src/cheddar_fpl_sage/utils/sprint3_5_config_manager.py`: Config management

**Testing:**
- `tests/tests_new/`: Modern test suite organized by feature
- `tests/integration_example.py`: Example of integration testing
- Config: `pyproject.toml` with `[tool.pytest.ini_options]` (testpaths=["tests"], addopts="-q")

## Naming Conventions

**Files:**
- Module files: `snake_case.py` (e.g., `enhanced_fpl_collector.py`, `data_gate.py`)
- Test files: `test_*.py` or `*_test.py` (e.g., `test_data_gate.py`)
- Config files: `snake_case.json` (e.g., `team_config.json`)

**Directories:**
- Package directories: `snake_case` (e.g., `collectors`, `analysis`, `utils`)
- Test directories: `tests` or `tests_new` (organized by feature in subdirs)
- Output directories: Generated with patterns like `team_{TEAM_ID}`, `gw_{GW}`

**Classes:**
- PascalCase (e.g., `EnhancedFPLCollector`, `FPLSageIntegration`, `CanonicalProjectionSet`)

**Functions:**
- snake_case (e.g., `build_slate()`, `validate_bundle()`, `resolve_injury_payloads()`)

**Variables:**
- snake_case for locals/params (e.g., `team_id`, `current_gw`, `bundle_paths`)
- UPPERCASE for constants (e.g., `MANUAL_EXPIRY_HOURS`)

**Types/Enums:**
- PascalCase (e.g., `ChipType`, `RiskLevel`, `InjuryStatus`, `InjurySource`)

## Where to Add New Code

**New Feature (e.g., new decision type):**
- Primary code: `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py` (add decision method)
- Tests: `tests/tests_new/test_new_decision_type.py`
- Config: Update `team_config.json` template with new analysis_preferences keys
- Entry point: Update `fpl_sage.py` or scripts as needed

**New Data Validation Rule:**
- Primary code: `src/cheddar_fpl_sage/validation/data_gate.py` (add validation method) or create new file in `validation/`
- Tests: `tests/tests_new/test_data_gate.py` (add test case)
- Integration: Hook into `FPLSageIntegration.run_full_analysis()` before decision framework

**New Data Model:**
- Primary code: `src/cheddar_fpl_sage/models/{model_name}.py`
- Dataclass with validation in `__post_init__`
- Tests: `tests/tests_new/test_{model_name}.py`
- Export: Add to `src/cheddar_fpl_sage/__init__.py` `__all__`

**New Utility Helper:**
- Primary code: `src/cheddar_fpl_sage/utils/{helper_name}.py` or add method to existing manager class
- Tests: `tests/tests_new/test_{helper_name}.py`
- Export: Add to `src/cheddar_fpl_sage/utils/__init__.py` `__all__`

**New CLI Script:**
- Location: `scripts/{script_name}.py`
- Pattern: Use `asyncio.run()` if async, import from `src/cheddar_fpl_sage/` modules
- Should NOT contain core logic; instead call `src/cheddar_fpl_sage/` classes/functions

**Integration Tests:**
- Location: `tests/tests_new/test_{feature}_integration.py` or add to `test_orchestrator_smoke.py`
- Pattern: Mock external APIs (FPL endpoints), test full pipeline from collection → decision

## Special Directories

**`outputs/`** (Generated at runtime):
- Purpose: Results storage
- Generated: Yes (created by `OutputBundleManager`)
- Committed: No (git-ignored)
- Cleanup: Use `scripts/prune_outputs.py` to remove old runs

**`db/`** (Generated at runtime):
- Purpose: SQLite snapshot database
- Generated: Yes (created by `FPLDatabase`)
- Committed: No (git-ignored)
- Structure: Managed by `fpl_db.py` schema initialization

**`.planning/`** (Documentation):
- Purpose: GSD planning & analysis docs
- Committed: Yes (part of repo)
- Structure: `codebase/` contains ARCHITECTURE.md, STRUCTURE.md, CONVENTIONS.md, TESTING.md, CONCERNS.md

**`vendor/`** (Third-party code):
- Purpose: Vendored dependencies if any
- Committed: Yes (if present)
- Avoid: Import from `src/cheddar_fpl_sage/` instead

**`archive/`** (Legacy code):
- Purpose: Old code kept for reference
- Committed: Yes
- Do NOT import from: Use current `src/` only

**`.bmad-core/`** (Framework):
- Purpose: Appears to be internal build/framework directory
- Do NOT modify: Part of framework setup

**`web-bundles/`** (Web assets):
- Purpose: Web UI resources (if applicable)
- Committed: Yes
- Do NOT modify for backend logic
