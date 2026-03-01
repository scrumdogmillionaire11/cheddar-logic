# FPL Sage

**Smart Fantasy Premier League Transfer & Chip Advisor**

## What It Does

FPL Sage analyzes your FPL team and tells you:
- **Which transfers to make** (with specific player recommendations)
- **When to use chips** (Bench Boost, Triple Captain, etc.)
- **Who to captain** (with ownership and fixture context)
- **What risks to avoid** (injuries, rotation, price drops)

## Quick Start

### Standard Setup

```bash
git clone <repository-url>
pip install -r config/requirements.txt
```

### Development Setup (Offline-Compatible)

For sandboxed environments or offline development:

```bash
# One-time setup: download build tools and install project
python vendor_wheels.py
./bootstrap_offline_build_tools.sh --test

# Or run each step manually:
python -m pip install --no-index --find-links vendor/wheels setuptools wheel
PIP_NO_INDEX=1 python -m pip install -e . --no-build-isolation --no-deps
python -m pytest tests
```

This bootstrap approach solves setuptools/wheel availability issues in restricted environments.

### Data Pipeline CLI (Simplified Commands)

FPL Sage includes a unified CLI for Phase 1–3 operations. All commands use:

```bash
python scripts/data_pipeline_cli.py [command] [options]
```

#### Recommended: Full Workflow (One Command)

For most users, run the complete pipeline with a single command:

```bash
python scripts/data_pipeline_cli.py run-full --season 2025-26 --gw 25
```

This automatically:
1. ✅ Initializes the database (if needed)
2. ✅ Collects global FPL data from API (bootstrap, fixtures, events)
3. ✅ Normalizes the snapshot to model inputs
4. ✅ Validates the result

**Output:** Snapshot ID (e.g., `2025-26_21_20250103_022257`) + confirmation that all tables are populated.

**Note:** Phase 2 (Collection) collects **global FPL data only** (all players, teams, fixtures). User-specific data (team entries, picks, history) is collected separately in Phase 4+ if needed.

#### Advanced: Individual Commands

For power users who need to:
- Re-normalize after logic changes
- Collect multiple snapshots and normalize separately
- Debug individual phases

**Initialize Database (One-Time)**

```bash
python scripts/data_pipeline_cli.py init-db
```

#### Collect Global FPL Snapshot (Phase 2 - Recommended)

Collects global FPL data: all players, all teams, all fixtures, GW metadata.

```bash
python scripts/data_pipeline_cli.py collect --season 2025-26 --gw 25
```

**Optional: Also collect user-specific data for a team**

If you need entry/{team_id} data for injury enrichment (Phase 4+):

```bash
python scripts/data_pipeline_cli.py collect \
  --season 2025-26 \
  --gw 21 \
  --teams 123456,789012
```

#### Normalize Snapshot (Phase 3)

```bash
python scripts/data_pipeline_cli.py normalize \
  --snapshot-id 2025-26_21_20250103_022257
```

#### Validate Snapshot

```bash
# Use your actual snapshot ID from collect/normalize output
python scripts/data_pipeline_cli.py validate --snapshot-id 2025-26_21_20250103_022257
```

#### List Snapshots

```bash
# All snapshots
python scripts/data_pipeline_cli.py list-snapshots

# Filter by season
python scripts/data_pipeline_cli.py list-snapshots --season 2025-26
```

### Quick Analysis (Current Workflow)

Enter your FPL team ID when prompted.

### 🆕 Sprint 2: Tri-State Resolution System

**New in January 2026**: FPL Sage now includes an intelligent tri-state resolution system that:
- ✅ Eliminates all prompts from the automation path
- ✅ Loads data from API → Config file → Safe defaults
- ✅ Automatically restricts risky actions when data is uncertain
- ✅ Reports authority level (1=Limited, 2=Normal, 3=Full)
- ✅ Suggests how to unlock features when restricted

**What changed?** When running non-interactively or with incomplete data:
- Before: System asked for chips/transfers via prompts
- After: System loads from config, defaults safely, no prompts needed

See [SPRINT2_INTEGRATION_GUIDE.md](docs/SPRINT2_INTEGRATION_GUIDE.md) for details.

### Manual overrides (chips / free transfers / injuries)
When running `python fpl_sage.py`, choose `y` at the “Edit overrides” prompt to:
- Set chip availability (manual overrides trump API)
- Set free transfers (manual value is used and tagged as manual)
- Set injury overrides as `Name=STATUS[:chance]` (e.g., `Haaland=OUT:0,Foden=FIT`)

Sources (manual/api) are shown in the CLI and summaries. For bundle/output details, see `outputs/README.md`.

## How It Works

### 1. **Data Collection**
- Fetches your current team from FPL API
- Gets live player status (injuries, rotation risk)
- Analyzes fixtures and ownership data

### 2. **Smart Analysis** 
- Compares your players against all alternatives
- Calculates expected points for next gameweek
- Identifies the best transfer opportunities

### 3. **Conservative Recommendations**
- Only suggests transfers that gain significant points
- Avoids risky players (injured, unlikely to start)
- Times chips for maximum effectiveness

## 🆕 REST API (Interactive Mode)

**New in January 2026**: FPL Sage now includes a FastAPI backend for programmatic access and real-time analysis streaming.

### Quick Start: Run Backend + Frontend

```bash
# Terminal 1: Start backend (from project root)
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8001

# Terminal 2: Start frontend
cd frontend
npm install  # First time only
npm run dev
```

**🚨 STRICT RULE: Development URLs**

- **Frontend:** http://localhost:5173 (PORT 5173 ONLY - NEVER CHANGE)
- **Backend API:** http://localhost:8001/api/v1
- **WebSocket:** ws://localhost:8001/api/v1

See [DEV_SERVER_CONFIG.md](DEV_SERVER_CONFIG.md) for enforcement details.

### Web UI Features

The React + TypeScript web interface provides:

1. ✅ **5-Step Interactive Flow** (mimics CLI experience)
   - Team ID entry
   - Chip status selection
   - Free transfers count
   - Risk posture (Conservative/Balanced/Aggressive)
   - Manual transfer tracking

2. ✅ **Real-Time Progress** (WebSocket streaming)
   - Live analysis phases
   - Progress percentage
   - Automatic completion redirect

3. ✅ **Detailed Results**
   - Transfer recommendations with expected points
   - Chip strategy and timing
   - Captain selection with rationale
   - Risk flags and warnings

See [docs/COMPLETE_CLI_FLOW.md](docs/COMPLETE_CLI_FLOW.md) for web UI details.

**API Base URL:** `http://localhost:8001/api/v1`

### 🆕 Dashboard Data Export

**New in February 2026**: Export FPL Sage analysis to external dashboards!

```bash
# 1. Run analysis
curl -X POST http://localhost:8001/api/v1/analyze/interactive \
  -H "Content-Type: application/json" \
  -d '{"team_id": 1930561, "free_transfers": 1, "risk_posture": "balanced"}'

# 2. Get dashboard-friendly data
curl http://localhost:8001/api/v1/dashboard/{analysis_id}/simple
```

Returns structured data with:
- Transfer targets with priority (URGENT/HIGH/MEDIUM/LOW)
- Team weaknesses (injuries, form, squad rules)
- Captain recommendations with expected points
- Chip timing advice
- Decision summary with confidence scores

**Full Integration Guide:** [docs/DASHBOARD_INTEGRATION.md](docs/DASHBOARD_INTEGRATION.md)

### Key Features

- ✅ **Interactive Analysis** - Override chips, transfers, and injury status
- ✅ **Real-Time Streaming** - WebSocket progress updates
- ✅ **Detailed Projections** - Expected points for every player
- ✅ **RESTful Endpoints** - Easy integration with web/mobile apps

### Example: Trigger Analysis with Overrides

```bash
curl -X POST http://localhost:8001/api/v1/analyze/interactive \
  -H "Content-Type: application/json" \
  -d '{
    "team_id": 123456,
    "free_transfers": 2,
    "available_chips": ["bench_boost"],
    "injury_overrides": [
      {"player_name": "Haaland", "status": "DOUBTFUL", "chance": 50}
    ]
  }'
```

**Response:** `{"analysis_id": "a1b2c3d4", "status": "queued"}`

### Get Detailed Player Projections

```bash
curl http://localhost:8001/api/v1/analyze/a1b2c3d4/projections
```

**Returns:** Expected points, ownership, form, transfer targets, chip guidance, and risk scenarios.

### Real-Time Progress Streaming

```javascript
const ws = new WebSocket('ws://localhost:8001/api/v1/analyze/a1b2c3d4/stream');
ws.onmessage = (e) => {
  const { type, progress, phase } = JSON.parse(e.data);
  console.log(`${phase}: ${progress}%`);
};
```

**Full API Documentation:** [backend/API_DOCUMENTATION.md](backend/API_DOCUMENTATION.md)

**Note:** CLI (`python fpl_sage.py`) and API analyses are currently independent. To use the API features, trigger analysis through the API endpoints shown above, not through the CLI.

## Sample Output

```
TEAM ANALYSIS: The Masterminds (ID: 123456)
Current Gameweek: 18 | Available Transfers: 2

=== TRANSFER RECOMMENDATIONS ===
🚨 PRIORITY 1: Remove High-Risk Players
OUT: Bruno Fernandes (injury - no return date)
IN: Kevin De Bruyne (home vs Brighton, 8.3 expected pts)

💰 OPTIONAL: Value Plays
OUT: Isak (tough fixtures, high ownership) 
IN: Watkins (easier run, lower ownership)

=== CHIP STRATEGY ===
RECOMMENDATION: SAVE Bench Boost
Current GW potential: 6.2 points
Best window: GW21-22 (11.8 points)

=== CAPTAINCY ===
CAPTAIN: Salah (9.4 expected pts, 45% owned)
VICE: Haaland (8.8 expected pts, 67% owned)
```

## Key Features

- ✅ **Specific Player Recommendations**: Names actual players to buy/sell
- ✅ **Injury Risk Warnings**: Flags players unlikely to play  
- ✅ **Chip Timing**: Compares current vs future chip opportunities
- ✅ **Team-Specific Analysis**: Works with your actual squad
- ✅ **Transfer Count Aware**: Optimizes based on available transfers

## Architecture: Phase 1–3 (Data Pipeline)

**January 2026 Update**: FPL Sage now uses a 3-phase snapshot-based architecture for reproducible analysis.

### Injury Feed Enrichment

- **Artifacts**: Each run now persists `injury_fpl.json`, `injury_secondary.json`, `injury_manual.json`, and `injury_resolved.json` under `outputs/runs/<team>/<run>/data_collections`.
- **Secondary Feed Cache**: Run `./scripts/refresh_injury_secondary.py` (or schedule it every 6 hours + a pre-deadline window) to refresh `outputs/injury_cache/secondary_feed.json` before running analysis.
- **Manual Overrides**: Injury overrides recorded in `config/team_config.json` are now incorporated into `injury_manual.json`, merged into `injury_resolved.json`, and surfaced in run summaries.

### Phase 1: Storage Layer (`src/storage/fpl_db.py`)

Persists weekly FPL data in SQLite with hash integrity + provenance.

```bash
# Initialize database (one-time)
python scripts/data_pipeline_cli.py init-db
```

**Tables created:**
- `snapshots` — metadata (season, gw, validation_status)
- `bootstrap_raw` — player/team/fixture master data
- `fixtures_raw` — live fixture updates
- `events_raw` — player event history
- `team_picks_raw` — team squad selections (optional)

### Phase 2: Collection (`src/collectors/weekly_snapshot_collector.py`)

Collects all 7 FPL API endpoints into a versioned snapshot.

```bash
# Collect snapshot for GW21, season 2025-26
python scripts/data_pipeline_cli.py collect \
  --season 2025-26 --gw 21 --teams 123456,789012
```

**Endpoints collected:**
- ✅ `/bootstrap-static/` (players, teams, events, injuries)
- ✅ `/fixtures/` (schedule, results)
- ✅ `/event/{gw}` (GW metadata)
- ✅ `/entry/{team_id}` (team rank, transfers)
- ✅ `/entry/{team_id}/history` (chip usage)
- ⚠️ `/entry/{team_id}/event/{gw}/picks` (team XI, best-effort)
- ⚠️ `/event/{gw}/live` (live player stats, best-effort)

### Phase 3: Normalization (`src/pipelines/build_weekly_inputs.py`)

Converts raw snapshot into 5 clean, normalized tables.

```bash
# Normalize snapshot (use snapshot_id from Phase 2)
python scripts/data_pipeline_cli.py normalize \
  --snapshot-id 2025_21_20250102_100000
```

**Tables normalized:**

| Table | Records | Purpose |
|-------|---------|---------|
| `players_dim` | 615 | Player master (id, name, team_id, position, price, status, injuries) |
| `teams_dim` | 20 | Team master (id, name, strength metrics) |
| `fixtures_fact` | 380+ | Fixture schedule + results |
| `player_gw_stats` | 3,000–5,000 | Per-player performance by GW |
| `team_state` | 100 | Team squads (15 players each: 11 starters + 4 bench) |

**Hard rule enforced**: Every team must have exactly 15 players in `team_state`.

### Deterministic & Reproducible

**Key principle**: Same `snapshot_id` → identical normalized outputs every time.

See [docs/PHASE1_3_COMPLETION_REPORT.md](docs/PHASE1_3_COMPLETION_REPORT.md) for full architecture details.

## When API Data Is Stale

The FPL API often shows last week's team. When this happens:

1. **Run normal analysis** - Get FPL Sage's complete data foundation
2. **Copy the analysis** - Everything from "TEAM ANALYSIS" to "END"  
3. **Use with ChatGPT for context resolution**:

```
CONTEXT: FPL Sage Analysis + Team Update
[Paste FPL Sage output here]

My ACTUAL current team is:
- GK: Flekken, Fabianski
- DEF: Gabriel, Gvardiol, Lewis, Robinson, Taylor
- MID: Salah(C), Bruno, Saka, Rogers, Gray
- FWD: Haaland, Isak, Stewart

Please validate these recommendations against my real team.
```

**Note**: GPT resolves stale team context and validates the recommendation space. FPL Sage provides the analytical foundation - GPT doesn't make the core decisions.

## Configuration

### Manual Overrides (`config/team_config.json`)
```json
{
    "team_id": 123456,
    "available_transfers": 2,
    "available_chips": ["bench_boost", "triple_captain"]
}
```

Use this when:
- You know your real transfer count
- FPL website shows different chip status
- You want to test "what if" scenarios

## Troubleshooting

### Development Setup Issues

**"ModuleNotFoundError: No module named 'setuptools'"**
```bash
# Use the offline bootstrap method:
python vendor_wheels.py
./bootstrap_offline_build_tools.sh
```

**"Permission denied" on bootstrap script**
```bash
chmod +x bootstrap_offline_build_tools.sh
```

**Missing wheels in vendor directory**
```bash
# Download wheels if you have internet access:
python vendor_wheels.py

# Or manually place .whl files in vendor/wheels/
```

### Runtime Issues

### "Analysis not found" from API
- CLI analysis IDs don't work with API endpoints
- Trigger analysis via API: `POST /api/v1/analyze/interactive`
- API and CLI are separate systems (for now)

### "No transfer recommendations"
- Check if you have available transfers in config
- Verify your team ID is correct
- Make sure analysis found valid alternatives

### "Player status unknown" 
- API might be delayed on injury news
- Check FPL website for latest updates
- Use manual override if needed

### Wrong team data
- Use GPT integration method above
- Update team_config.json with correct details
- API typically updates after each gameweek

## Philosophy

**Process-Driven + Conservative**: FPL Sage enforces quantified thresholds and blocks marginal hits. It prefers structural team health over point chasing and follows disciplined decision rules. 

**The engine prefers being silent over being wrong.**

When it recommends a transfer, it's because the math clearly supports it - not because of gut feelings or short-term trends.

## Project Structure

For project organization details, see [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md)

For technical architecture, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Quick Reference Commands

### Recommended: Full Workflow (One Command)
```bash
python scripts/data_pipeline_cli.py run-full \
  --season 2025-26 --gw 21 --teams 123456,789012
```
```bash
python fpl_sage.py
```

### Advanced: Individual Commands

**Initialize Database**
```bash
python scripts/data_pipeline_cli.py init-db
```

**Collect Snapshot**
```bash
python scripts/data_pipeline_cli.py collect \
  --season 2025-26 --gw 21 --teams 123456,789012
```

**Normalize Snapshot**
```bash
python scripts/data_pipeline_cli.py normalize \
  --snapshot-id 2025_21_20250102_100000
```

**Validate Snapshot**
```bash
python scripts/data_pipeline_cli.py validate \
  --snapshot-id 2025_21_20250102_100000
```

**List Snapshots**
```bash
python scripts/data_pipeline_cli.py list-snapshots --season 2025-26
```

### Run Tests
```bash
# Phase 1 Storage Tests
python tests_new/test_phase1_storage.py

# Phase 2 Collector Tests  
python tests_new/test_phase2_collector.py

# Phase 3 Normalizer Tests
python tests_new/test_phase3_normalizer.py
```


