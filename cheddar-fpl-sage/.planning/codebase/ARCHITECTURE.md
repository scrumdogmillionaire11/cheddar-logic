# Architecture

**Analysis Date:** 2026-01-23

## Pattern Overview

**Overall:** Layered data processing pipeline with async IO, validation gates, and modular decision framework

**Key Characteristics:**
- Async-first architecture for FPL API collection (`aiohttp`, `asyncio`)
- Clear separation between data collection, validation, transformation, and analysis
- Configuration-driven overrides for manual inputs (chips, transfers, injuries)
- Deterministic data contracts via canonical models (projections, injury reports, team states)
- Exit gates validate data freshness before analysis proceeds

## Layers

**Data Collection Layer:**
- Purpose: Fetch FPL API data and personal team information
- Location: `src/cheddar_fpl_sage/collectors/`
- Contains:
  - `EnhancedFPLCollector`: Async HTTP client for bootstrap, fixtures, events, team picks, transfers
  - `WeeklyBundleCollector`: Coordinates collection of all required artifacts into timestamped bundles
  - `SimpleFPLCollector`: Basic fallback collector
- Depends on: `aiohttp`, FPL API endpoints, configuration files
- Used by: `FPLSageIntegration` (main orchestrator)

**Storage Layer:**
- Purpose: Persist weekly data snapshots to SQLite for reproducible analysis
- Location: `src/cheddar_fpl_sage/storage/fpl_db.py`
- Contains: `FPLDatabase` class managing snapshots table and raw artifact tracking
- Depends on: SQLite, Path operations
- Used by: Collection pipeline for snapshot validation

**Validation Layer:**
- Purpose: Guard against stale, incomplete, or invalid data before analysis
- Location: `src/cheddar_fpl_sage/validation/`
- Contains:
  - `DataGate` (`data_gate.py`): Validates bundle completeness and freshness (checks timestamps, required files)
  - `IdIntegrity` (`id_integrity.py`): Ensures player IDs are consistent across datasets
- Depends on: File system paths, timestamps
- Used by: `FPLSageIntegration` before analysis proceeds

**Transformation Layer:**
- Purpose: Convert raw FPL data into canonical contracts
- Location: `src/cheddar_fpl_sage/transformers/`
- Contains: `SlateBuilder` - constructs deterministic fixture slates by gameweek
- Depends on: Raw fixtures data
- Used by: Decision framework for fixture context

**Injury Processing Layer:**
- Purpose: Aggregate injury data from multiple sources (FPL API, secondary feed, manual overrides)
- Location: `src/cheddar_fpl_sage/injury/processing.py`
- Contains:
  - `build_fpl_injury_reports()`: Parse FPL API injury data
  - `build_manual_injury_reports()`: Apply user-provided manual overrides
  - `resolve_injury_payloads()`: Merge all sources with confidence/authority hierarchy
  - `build_injury_artifact_payload()`: Serialize for storage
- Depends on: `InjuryReport` model, configuration manager
- Used by: Decision framework for injury context

**Models/Data Contracts:**
- Purpose: Define canonical data structures consumed by downstream components
- Location: `src/cheddar_fpl_sage/models/`
- Contains:
  - `CanonicalPlayerProjection`: Single projection format (nextGW_pts, next6_pts, ceiling, floor, volatility, tags, ownership)
  - `CanonicalProjectionSet`: Collection of projections for all players
  - `OptimizedXI`: Enforces legal 11-player lineup with formation validation
  - `InjuryReport`: Status, confidence, source, expiry
- Used by: Decision framework, transfer advisor, captain logic

**Analysis/Decision Layer:**
- Purpose: Make recommendations about transfers, captaincy, chips, lineups
- Location: `src/cheddar_fpl_sage/analysis/`
- Contains:
  - `EnhancedDecisionFramework`: Core decision engine with risk scenarios, chip timing, formation optimization
  - `FPLSageIntegration`: Main orchestrator coordinating collection → validation → transformation → analysis
  - `Sprint2Integration`, `Sprint3Integration`: Legacy sprint-specific integrations
- Depends on: All lower layers, configuration manager
- Used by: Main entry point (`fpl_sage.py`)

**Configuration Management:**
- Purpose: Handle chips, free transfers, manual overrides, analysis preferences
- Location: `src/cheddar_fpl_sage/utils/`
- Contains:
  - `Sprint35ConfigManager`: Centralized config with cache invalidation
  - `ChipStatusManager`: Chip availability and usage tracking
  - `ManualTransferManager`: Personal team overrides
  - `OutputBundleManager`: Run output paths and pointers
- Depends on: JSON config files, file system
- Used by: `FPLSageIntegration`, `fpl_sage.py` entry point

**Utilities/Support:**
- Purpose: Shared helpers for state management, output serialization, restrictions
- Location: `src/cheddar_fpl_sage/utils/`
- Contains: Restriction coordinators, resolvers, output managers, atomic write helpers
- Used by: Analysis and decision layers

## Data Flow

**Primary Flow: Team Analysis (with team_id):**

1. **Input Collection** (`EnhancedFPLCollector`)
   - Fetch bootstrap static, fixtures, events from FPL API
   - Fetch team overview, history, picks, transfers for personal team
   - Resolve current/next gameweek automatically

2. **Config Loading** (`Sprint35ConfigManager`)
   - Load `team_config.json` with manual chip status, free transfers, injury overrides
   - Apply config to decision framework risk thresholds

3. **Weekly Bundle Assembly** (`WeeklyBundleCollector`)
   - Combine all fetched data into timestamped bundle in `outputs/snapshots/`
   - Write collection_meta.json with timestamp

4. **Validation Gate** (`DataGate`)
   - Check all required artifacts exist (bootstrap, fixtures, events, slate)
   - Verify data freshness (age < max_minutes, default 24h)
   - Block analysis if missing or stale

5. **ID Integrity Check** (`IdIntegrity`)
   - Ensure player IDs consistent across bootstrap, fixtures, picks

6. **Injury Resolution** (`injury/processing.py`)
   - Parse FPL API injury flags
   - Load secondary injury feed (cached at `config/secondary_injury_feed.json`)
   - Apply manual overrides from config
   - Merge with confidence hierarchy: manual > secondary > FPL API

7. **Transformation** (`SlateBuilder`)
   - Build fixture slate for target gameweek with blank/double detection

8. **Analysis** (`EnhancedDecisionFramework`)
   - Input: canonical projections, injury reports, slate, team state, config
   - Output: `DecisionOutput` with recommendations, risk scenarios, chip guidance

9. **Output Serialization** (`OutputBundleManager`)
   - Write results to `outputs/runs/team_{team_id}/{run_id}/`
   - Update `outputs/LATEST.json` pointer
   - Persist analysis, reports, injury summaries

**Secondary Flow: General Analysis (no team_id):**

1. Steps 1, 3-7 same as above (skip personal team data)
2. Analysis produces general league insights
3. Output to `outputs/runs/no_team/{run_id}/`

**Config-Driven Overrides:**

- Manual chip status: Bypasses FPL API chip availability
- Free transfers: Overrides computed value
- Injury overrides: Format `{player_name: {status_flag, chance_of_playing_next_round, injury_note}}`

## Key Abstractions

**DecisionOutput:**
- Purpose: Standardized decision format with risk scenarios
- Example: "Sell Haaland", reasoning, risk scenarios, confidence 0.85
- Fields: primary_decision, reasoning, risk_scenarios, decision_status (PASS/HOLD/BLOCKED), confidence_score
- Used by: All downstream analysis consumers

**CanonicalProjectionSet:**
- Purpose: Single source of truth for player projections post-engine
- Prevents format divergence between captain logic, transfer advisor, XI builder
- Methods: get_by_position(), get_by_id(), filter_by_tags(), top_by_points()

**InjuryReport:**
- Purpose: Unified injury status across sources
- Fields: player_id, status (OUT/DOUBT/FIT), source (FPL/SECONDARY/MANUAL), confidence, chance_of_playing, expiry
- Enables retroactive confidence updates as sources diverge

**ChipDecisionContext:**
- Purpose: Explicit chip timing analysis
- Fields: current_gw, chip_type, available_chips, fixture_conflicts, next_optimal_window, window_rank, reason_codes

**OptimizedXI:**
- Purpose: Enforce legal 11-player formations (GK 1, DEF 3-5, MID 2-5, FWD 1-3)
- Prevents XI construction errors during optimization
- Post-init assertion validates constraints

## Entry Points

**Main CLI Entry Point:**
- Location: `fpl_sage.py` (root)
- Triggers: User runs `python fpl_sage.py` or `asyncio.run(main())`
- Responsibilities:
  - Prompt for team ID (with profile shortcuts from `config/fpl_team_ids.json`)
  - Interactive chip/free transfer/injury override setup
  - Instantiate `FPLSageIntegration`, run full analysis
  - Display results summary (team info, rank, available chips)

**Scripts Entry Points:**
- `scripts/run_enhanced_analysis.py`: Async wrapper for analysis with error handling
- `scripts/data_pipeline_cli.py`: CLI for data collection/pipeline operations
- `scripts/manage_transfers.py`: Transfer management interface
- `scripts/setup_2025_season.py`: Season initialization

**Test Entry Points:**
- `tests/integration_example.py`: Example integration test
- `tests/tests_new/test_*.py`: Specific feature tests (data gate, identity, chip policy, etc.)

## Error Handling

**Strategy:** Graceful degradation with explicit block codes

**Patterns:**

1. **Data Gate Failures**: Return `GateResult` with status="HOLD" and block_reason
   - Missing artifacts: `MISSING_BOOTSTRAP_STATIC`, `MISSING_TEAM_PICKS`, etc.
   - Stale data: `STALE_COLLECTION` with age description
   - Proceed with fallback data or wait for refresh

2. **Collection Errors**: Async context manager ensures session cleanup
   - API timeouts: Logged, can retry
   - 404 on next GW picks: Falls back to current GW
   - Invalid JSON responses: Raises with context

3. **Config Errors**: Warnings logged, sensible defaults applied
   - Stringified JSON detected and auto-parsed
   - Missing config file: Returns empty dict, uses code defaults
   - Invalid injury overrides: Skipped, logs warning

4. **Model Validation**: Post-init assertions in dataclasses
   - `OptimizedXI`: Exactly 11 starters, 4 bench, legal formation
   - `CanonicalProjectionSet`: Validates projection count and data

5. **Storage Errors**: Atomic writes prevent corruption
   - Use `.tmp` files, fsync to disk, atomic rename
   - Ensures consistent state even if process crashes

## Cross-Cutting Concerns

**Logging:**
- Python `logging` module with level INFO by default
- Loggers created per-module (e.g., `logger = logging.getLogger(__name__)`)
- Key decision points logged: data age, collection steps, validation results, decision confidence

**Validation:**
- Hard gate in `DataGate`: No analysis if data invalid/stale
- Soft validation in models: Assertions catch programming errors early
- ID integrity check: Prevents inconsistent player references

**Authentication:**
- No auth required; FPL API is public
- Personal team data uses public team_id endpoint (no password)

**Async/Concurrency:**
- `aiohttp` for concurrent API requests
- `asyncio.run()` in entry points
- Context managers ensure proper resource cleanup
