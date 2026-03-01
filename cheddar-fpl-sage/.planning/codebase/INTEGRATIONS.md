# External Integrations

**Analysis Date:** 2026-01-23

## APIs & External Services

**Fantasy Premier League (FPL) API:**
- Service: Fantasy Premier League REST API
- What it's used for: Real-time player data, fixture information, gameweek metadata, team entries, picks, transfer history, ownership percentages
- Endpoint: `https://fantasy.premierleague.com/api`
  - `/bootstrap-static/` - Global FPL data (all players, teams, events, fixtures)
  - `/fixtures/` - Match fixtures and results
  - `/entry/{team_id}/` - Personal team overview
  - `/entry/{team_id}/event/{gw}/picks/` - Team picks for specific gameweek
  - `/entry/{team_id}/history/` - Team season history and chip usage
  - `/entry/{team_id}/transfers/` - Team transfer history
- SDK/Client: `aiohttp 3.9.0+` (async HTTP client)
- Auth: Public API (no authentication required for global data; team data requires team ID)
- Rate Limiting: Handled via `asyncio-throttle 1.0.2+`
- Retry Logic: `tenacity 8.2.0+` for resilience

**Implementations:**
- `src/cheddar_fpl_sage/collectors/simple_fpl_collector.py` - Minimal collector with aiohttp
- `src/cheddar_fpl_sage/collectors/enhanced_fpl_collector.py` - Full collector with team-specific data
- `src/cheddar_fpl_sage/collectors/weekly_snapshot_collector.py` - Production snapshot collector
- `src/cheddar_fpl_sage/collectors/weekly_bundle_collector.py` - Bundle-based collector

## Data Storage

**Databases:**

**SQLite (Primary):**
- Provider: SQLite3 (standard library)
- Connection: File-based at `db/fpl_snapshots.sqlite`
- Client: sqlite3 (Python standard library)
- Purpose: Store FPL weekly snapshots with validation
  - Tables: snapshots, bootstrap_raw, fixtures_raw, events_raw, team_picks_raw
  - Features: Hash-based validation (SHA256), snapshot_id as primary key
- Implementation: `src/cheddar_fpl_sage/storage/fpl_db.py` (FPLDatabase class)

**PostgreSQL (Prepared, Not Active):**
- Client: psycopg2-binary 2.9.0+ and SQLAlchemy 2.0.0+
- Status: Installed but not currently used
- Migration path: Available if moving to production multi-user environment

**Redis (Prepared, Not Active):**
- Client: redis 5.0.0+
- Status: Installed but not currently used
- Purpose: Prepared for caching and distributed job management

**File Storage:**
- Local filesystem - JSON files in output directories
- JSON atomic write patterns: `src/cheddar_fpl_sage/utils/output_manager.py`
- Directory structure:
  - `outputs/` - All analysis outputs (organized by run_id and season)
  - `data_collections/` - Raw collected data
  - `db/` - SQLite database directory

## Authentication & Identity

**Auth Provider:**
- FPL API: Public (no authentication required for global endpoints)
- Team Data: Team ID required for personal entry/{team_id} endpoints
- Configuration: Team ID stored in `config/team_config.json`

**Implementation:**
- Custom (simple): Team ID passed directly to API calls
- No OAuth or API keys required for basic global data
- Manager identity extraction: `src/cheddar_fpl_sage/utils/sprint3_5_config_manager.py`

## Configuration Management

**Config Sources:**
1. **JSON Config Files:**
   - `config/team_config.json` - Team-specific settings (chip status, manual overrides)
   - `config/team_config.template.json` - Configuration template
   - Structure: Manual chip status, data sources, override settings

2. **Environment Variables:**
   - `FPL_SAGE_DEBUG_SUMMARY` - Debug output toggle (checked in enhanced_decision_framework.py)
   - `.env` files: Supported via python-dotenv (optional)

3. **Runtime Context:**
   - `run_context.json` - Per-run configuration

**Config Manager:**
- `src/cheddar_fpl_sage/utils/sprint3_5_config_manager.py` (Sprint35ConfigManager)
  - Unified read/write for config
  - Cache invalidation to ensure fresh reads
  - Atomic file operations
  - Normalization of chip status

## Monitoring & Observability

**Error Tracking:**
- Not detected - No external error tracking service integrated (Sentry, etc.)
- Local logging only

**Logs:**
- Approach: Python logging module with configurable levels (basicConfig used)
- Loggers: Module-level loggers in each collector/analyzer
- Output: Console (stderr) - no file logging configured

**Monitoring & Metrics:**
- Prometheus Client 0.19.0+ - Installed (optional)
- Flask 3.0.0+ - Available for health check endpoints (optional)
- Status: Prepared but not actively integrated

## CI/CD & Deployment

**Hosting:**
- Not detected as deployed service
- Local/desktop application for single user

**CI Pipeline:**
- Not detected - No GitHub Actions or other CI service configured
- Manual test execution via pytest

**Testing:**
- Local pytest execution
- Test configuration in `pyproject.toml`
- Tests at: `tests/` directory

## Webhooks & Callbacks

**Incoming:**
- None detected - Application is pull-based (no webhook listeners)

**Outgoing:**
- None detected - No external system callbacks

## Dependencies & Network

**Network Calls:**
- FPL API: `https://fantasy.premierleague.com/api` (primary)
- No external APIs beyond FPL
- Internet required for data collection

**Fallback Behavior:**
- Offline collection not supported (requires FPL API access)
- Cached snapshot approach for repeated analysis: stored snapshots can be normalized without network

## Data Flow

**Collection Pipeline:**
1. Collectors fetch from `https://fantasy.premierleague.com/api`
2. Raw JSON stored in SQLite (bootstrap_raw, fixtures_raw, events_raw tables)
3. Hash validation (SHA256) for data integrity
4. Normalized snapshots built from validated raw data
5. Analysis performed on normalized data

**Snapshot Lifecycle:**
1. Collect global FPL data (command: `collect`)
2. Validate snapshot completeness
3. Normalize to model inputs (command: `normalize`)
4. Run analysis with normalized data

## Environment Configuration

**Required Environment:**
- Internet connectivity to FPL API
- Python 3.10+
- Writable `db/` directory for SQLite
- Writable `outputs/` directory for results

**Optional Environment:**
- `FPL_SAGE_DEBUG_SUMMARY` - Enable debug output in enhanced_decision_framework
- `.env` file for python-dotenv configuration

**Database Initialization:**
- Automatic schema creation on first FPLDatabase init
- Manual: `python scripts/data_pipeline_cli.py init-db`

## Scaling & Performance

**Rate Limiting:**
- asyncio-throttle: Built-in rate limiting for concurrent FPL API requests
- No explicit rate limit configuration visible

**Caching:**
- SQLite snapshots: Historical data cached for reproducibility
- No distributed caching (Redis prepared but unused)

**Concurrency:**
- Async/await patterns throughout (aiohttp, asyncio-throttle)
- Context managers for resource management

---

*Integration audit: 2026-01-23*
