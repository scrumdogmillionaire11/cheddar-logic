# Technology Stack

**Analysis Date:** 2026-01-23

## Languages

**Primary:**
- Python 3.10+ (requires-python: >=3.10) - Core application logic
- Python 3.12.10 - Current development environment

**Secondary:**
- JSON - Configuration and data serialization
- YAML - Build system configuration (bmad-core)

## Runtime

**Environment:**
- Python 3.10+ with standard library

**Package Manager:**
- pip (with setuptools and wheel)
- Lockfile: Not present (dependencies defined in requirements.txt and pyproject.toml)

## Frameworks

**Core:**
- None (pure Python with library dependencies)

**Testing:**
- pytest 7.4.0+ - Test runner and framework
- pytest-asyncio 0.21.0+ - Async test support

**Build/Dev:**
- setuptools - Python package management
- wheel - Binary package distribution
- black 23.0.0+ - Code formatting
- flake8 6.0.0+ - Linting

## Key Dependencies

**Critical:**
- aiohttp 3.9.0+ - Async HTTP client for FPL API calls
- asyncio-throttle 1.0.2+ - Rate limiting for async requests
- tenacity 8.2.0+ - Retry mechanism for resilience
- python-dotenv 1.0.0+ - Environment variable loading from `.env` files

**Data & Storage:**
- pandas 2.0.0+ - Data manipulation and analysis
- sqlalchemy 2.0.0+ - ORM and database toolkit (prepared but not actively used)
- psycopg2-binary 2.9.0+ - PostgreSQL adapter (defined but not currently used)
- sqlite3 - Standard library, used for FPL snapshot storage in `src/cheddar_fpl_sage/storage/fpl_db.py`
- redis 5.0.0+ - Redis client (defined but not currently integrated)

**Utilities:**
- requests 2.31.0+ - HTTP library (backup to aiohttp)
- click 8.1.0+ - CLI framework for command-line tools
- schedule 1.2.0+ - Job scheduling (prepared for future automation)

**Optional (Enhanced Features):**
- beautifulsoup4 4.12.0+ - Web scraping support
- lxml 4.9.0+ - XML/HTML parsing
- flask 3.0.0+ - Health check endpoints and monitoring (optional)
- prometheus-client 0.19.0+ - Metrics collection for monitoring (optional)

**Development/Testing:**
- pytest 7.4.0+ - Test framework
- pytest-asyncio 0.21.0+ - Async test support
- black 23.0.0+ - Code formatter
- flake8 6.0.0+ - Linter

## Configuration

**Environment:**
- `.env` files supported via python-dotenv
- `team_config.json` - Team configuration (template at `config/team_config.template.json`)
- `run_context.json` - Runtime context configuration
- `.bmad-core/core-config.yaml` - Build system configuration

**Build:**
- `pyproject.toml` - Python project metadata and tool configuration
- `setup.cfg` - Setuptools configuration (using declarative setup)
- Package discovery: `src/cheddar_fpl_sage*` in `src` directory

**Key Config Files:**
- `config/requirements.txt` - Runtime dependencies
- `pyproject.toml` - Project metadata and test configuration
- `config/team_config.template.json` - Team configuration template with chip status

## Database

**Storage:**
- **SQLite** (`db/fpl_snapshots.sqlite`) - Primary storage for FPL weekly snapshots
  - Schema: snapshots, bootstrap_raw, fixtures_raw, events_raw, team_picks_raw tables
  - Used by: `src/cheddar_fpl_sage/storage/fpl_db.py` (FPLDatabase class)
  - Hash-based validation with SHA256 checksums

**Prepared (Not Active):**
- PostgreSQL via psycopg2 and sqlalchemy (available if migration needed)
- Redis (available for caching/session management if needed)

## Platform Requirements

**Development:**
- Python 3.10 or higher
- pip package manager
- Optional: Virtual environment (venv)
- Recommended: Unix-like environment (macOS, Linux)

**Production:**
- Python 3.10+ runtime
- Async-capable environment (tested on macOS 25.2.0)
- Network access to Fantasy Premier League API (https://fantasy.premierleague.com/api)
- SQLite database directory with write permissions (`db/` directory)

## Key Entry Points

**Main Application:**
- `src/cheddar_fpl_sage/` - Main package
- `fpl_sage.py` - Legacy CLI entry point
- `scripts/data_pipeline_cli.py` - Unified data pipeline CLI

**Test Entry:**
- `tests/` - Test suite directory
- Run via: `pytest tests/` with configuration in `pyproject.toml`

## Development Workflow

**Installation (Standard):**
```bash
pip install -r config/requirements.txt
python -m pytest tests
```

**Installation (Offline/Sandboxed):**
```bash
python vendor_wheels.py
./bootstrap_offline_build_tools.sh --test
```

**Run Tests:**
```bash
pytest tests/  # All tests
pytest -v      # Verbose output
pytest -x      # Stop on first failure
```

---

*Stack analysis: 2026-01-23*
