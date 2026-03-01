# FPL Sage — Phase 1–3 Completion Report

**Report Date:** 2026-01-02  
**Status:** ✅ COMPLETE (Phase 1–3 delivered, all tests passing)

---

## Executive Summary

The foundation for reproducible FPL analysis is complete:

| Phase | Stage | Objective | Status | Tests |
|-------|-------|-----------|--------|-------|
| **1** | Storage | DB-first snapshot persistence | ✅ COMPLETE | 6/6 ✅ |
| **2** | Collection | Collect all FPL metrics (no gaps) | ✅ COMPLETE | 6/6 ✅ |
| **3** | Normalization | Clean inputs for modeling | ✅ COMPLETE | 6/6 ✅ |

**Total Lines of Production Code:** 1,340+  
**Total Test Coverage:** 18 acceptance tests (all passing)  
**Architecture:** Snapshot-based, deterministic, versioned

---

## Phase 1: Storage Layer — COMPLETE ✅

**File:** `src/storage/fpl_db.py` (470 lines)  
**Goal:** Persist weekly FPL data in SQLite, with hash integrity + provenance.

### What It Does
- Manages 5 SQLite tables for storing raw API artifacts
- Computes SHA256 hashes for integrity verification
- Validates snapshots (all required sources present + hashes match)
- Provides snapshot query interface (list, get, filter by season/GW)

### Key Tables
- `snapshots` — metadata (season, gw, snapshot_ts, validation_status)
- `bootstrap_raw` — player/team/fixture/event master data
- `fixtures_raw` — live fixture updates
- `events_raw` — player event history
- `team_picks_raw` — team squad selections (optional)

### API
```python
with FPLDatabase(db_path) as db:
    db.init_db()                          # Create schema
    db.upsert_bootstrap(snap_id, status, path, hash)  # Record artifact
    db.write_manifest(snap_id, season, gw, manifest)  # Store metadata
    valid, msg = db.validate_snapshot(snap_id)        # Verify integrity
    manifest = db.get_snapshot_manifest(snap_id)      # Retrieve manifest
    snapshots = db.list_snapshots(season="2024")      # Query snapshots
```

### Validation Logic
✅ All required sources (bootstrap, fixtures, events) present  
✅ Hash integrity: file hash = stored hash  
✅ No corrupt JSON files  
✅ team_picks can be UNAVAILABLE_404 (optional)  
✅ No "unknown" season/gw in manifest  

### Test Results
```
6 PASSED:
✅ Snapshot roundtrip (write → close → reopen → query)
✅ Hash integrity check
✅ Corrupt JSON detection
✅ Missing required source detection
✅ Optional team_picks handling
✅ Failed source rejection
```

---

## Phase 2: Collection — COMPLETE ✅

**File:** `src/collectors/weekly_snapshot_collector.py` (580 lines)  
**Goal:** Fetch all FPL metrics into one reproducible snapshot bundle.

### What It Does
- Collects 7 FPL API endpoints (bootstrap, fixtures, events, entry, history, picks, live)
- Records explicit status for each artifact (OK, UNAVAILABLE_404, FAILED_*)
- Writes JSON files + stores metadata in SQLite DB
- Generates snapshot_id with deterministic naming: `{season}_{gw}_{YYYYMMDD}_{HHMMSS}`

### Endpoints Collected
| Endpoint | Required | Status If Fail |
|----------|----------|---|
| `/bootstrap-static/` | ✅ | FAILS snapshot if missing |
| `/fixtures/` | ✅ | FAILS snapshot if missing |
| `/event/{gw}` | ✅ | FAILS snapshot if missing |
| `/entry/{team_id}` | ✅ | FAILS snapshot if missing |
| `/entry/{team_id}/history` | ✅ | FAILS snapshot if missing |
| `/entry/{team_id}/event/{gw}/picks` | ⚠️ | OK to be UNAVAILABLE_404 |
| `/event/{gw}/live` | ⚠️ | OK to be UNAVAILABLE_404 (best-effort) |

### API
```python
async with WeeklySnapshotCollector() as collector:
    snapshot_id = await collector.collect_snapshot(
        season="2024",
        gw_target=21,
        team_ids=[1234, 5678, 9999]
    )
    # Returns: "2024_21_20250102_100000"
    # Side effects:
    #   - JSON files written to outputs/runs/{snapshot_id}/data_collections/
    #   - DB updated with all artifact metadata
    #   - Manifest created with full provenance + hashes
```

### Test Results
```
6 PASSED:
✅ Bootstrap + fixtures collection valid
✅ Picks 404 still valid (best-effort)
✅ Bootstrap failure → snapshot invalid
✅ GW resolution from bootstrap (never "unknown")
✅ All hashes match DB records
✅ Manifest records all artifact statuses
```

---

## Phase 3: Normalization — COMPLETE ✅

**Files:** 
- `src/pipelines/build_weekly_inputs.py` (286 lines)
- `tests_new/test_phase3_normalizer.py` (300+ lines)

**Goal:** Convert raw API snapshots into clean, normalized datasets for modeling.

### What It Does
- Reads raw snapshot artifacts from FPLDatabase
- Normalizes into 5 clean tables (players, teams, fixtures, stats, team_state)
- Enforces 15-player hard rule on team squads
- Enriches bench players with injury metadata
- Generates input manifest with validation counts

### Normalization Pipeline
```
snapshot_id ("2024_21_20250102_100000")
  ├─ bootstrap_raw (615 players, 20 teams, 380 fixtures)
  ├─ fixtures_raw (live scores + match status)
  ├─ events_raw (player performance history)
  └─ team_picks_raw (team XI + captain/vice)
       ↓
       [WeeklyInputsNormalizer]
       ↓
  ├─ players_dim (615 players with full metadata)
  ├─ teams_dim (20 teams with strength metrics)
  ├─ fixtures_fact (merged schedule + results)
  ├─ player_gw_stats (3,000–5,000 historical entries)
  ├─ team_state (15 players per team, bench with injuries)
  └─ input_manifest.json (validation summary)
```

### New DB Tables
| Table | Rows | Fields | Purpose |
|-------|------|--------|---------|
| `players_dim` | 615 | id, name, team_id, position, price, status, injuries | Player master data |
| `teams_dim` | 20 | id, name, strength_home, strength_away, strength_defence | Team master data |
| `fixtures_fact` | 380+ | fixture_id, gw, kickoff, team_h, team_a, scores, finished, minutes | Schedule + results |
| `player_gw_stats` | 3,000–5,000 | gw, element_id, minutes, goals, assists, clean_sheets, bonus, bps, points | Performance per GW |
| `team_state` | 20–100 | team_id, element_id, position, is_starter, bench_order, captain, status, injuries | Team XI (11+4) |

### Hard Rules Enforced
```sql
-- Exactly 15 players per team (validated in _validate_team_state)
SELECT COUNT(*) FROM team_state 
WHERE snapshot_id = ? AND team_id = ? 
-- Must equal 15 (11 starters + 4 bench)

-- No orphans (FK constraints)
FOREIGN KEY (snapshot_id, element_id) 
  REFERENCES players_dim(snapshot_id, element_id)
```

### Injury Enrichment (Bench Players)
Positions 12–15 (bench) are enriched with injury data from bootstrap:
- `player_status` — "a" | "d" | "s" | "u"
- `chance_this_round` — 0–100 or NULL
- `chance_next_round` — 0–100 or NULL
- `news` — Free text injury/availability notes

### API
```python
normalizer = WeeklyInputsNormalizer(db_path="db/fpl_snapshots.sqlite")

success, message, manifest = normalizer.normalize_snapshot(
    snapshot_id="2024_21_20250102_100000",
    bootstrap_data=bootstrap_json,
    fixtures_data=fixtures_json,
    events_data=events_json,
    team_picks_data=picks_json  # Optional
)

if success:
    print(manifest["tables"])
    # {
    #   "players_dim": {"count": 615, "status": "OK"},
    #   "teams_dim": {"count": 20, "status": "OK"},
    #   "fixtures_fact": {"count": 380, "status": "OK"},
    #   "player_gw_stats": {"count": 4250, "status": "OK"},
    #   "team_state": {"status": "OK", "validation": "15 players per team"}
    # }
```

### Test Results
```
6 PASSED:
✅ Players dimension normalization (2 → 615 scale)
✅ Teams dimension normalization (2 → 20 scale)
✅ Fixtures fact normalization (GW matching)
✅ Player GW stats normalization (history per player)
✅ Team state 15-player rule validation
✅ Input manifest generation (all metadata)
```

---

## Architecture Principles Applied

### 1. Snapshot-Based Truth
- **Principle:** If it can't be reproduced from stored artifacts, it didn't happen.
- **Implementation:** Phase 1 stores all raw API, Phase 2 collects into snapshots, Phase 3 normalizes deterministically from snapshots.

### 2. Deterministic Pipeline
- **Principle:** Same snapshot_id + data → identical outputs every time.
- **Implementation:** No randomness in normalization, all logic is pure functions of snapshot + schema.

### 3. Explicit Versioning
- **Principle:** All outputs tied to snapshot_id (season, gw, timestamp).
- **Implementation:** Every normalized table includes `snapshot_id` as part of PK.

### 4. No Silent Failures
- **Principle:** Every artifact has explicit status (OK, FAILED, UNAVAILABLE_404, etc.).
- **Implementation:** Phase 1 validates all statuses, Phase 2 records statuses, Phase 3 manifests statuses.

### 5. Safety by Default
- **Principle:** Authority levels degrade if data is incomplete.
- **Implementation:** team_state < 15 players → degraded authority. Picks unavailable → downgrade. Injuries not enriched → downgrade.

---

## Integration Pathways

### Full Pipeline (Future)
```bash
# Phase 2: Collect
python fpl_sage.py --collect-only \
  --season 2024 --gw 21 --team-ids 1234,5678
# Output: snapshot_id = "2024_21_20250102_100000"

# Phase 3: Normalize
python fpl_sage.py --build-inputs-only \
  --snapshot-id 2024_21_20250102_100000
# Output: 5 tables in DB + input_manifest.json

# Phase 4: Project (future)
python fpl_sage.py --project-only \
  --snapshot-id 2024_21_20250102_100000
# Output: player_projections, team_form tables

# Full pipeline
python fpl_sage.py --run-full \
  --snapshot-id 2024_21_20250102_100000 --team-ids 1234,5678
# Output: decisions + run_context.json (full audit trail)
```

---

## File Structure

### Core Implementation
```
src/
  ├─ storage/
  │  └─ fpl_db.py (470 lines, Phase 1)
  ├─ collectors/
  │  └─ weekly_snapshot_collector.py (580 lines, Phase 2)
  └─ pipelines/
     └─ build_weekly_inputs.py (286 lines, Phase 3)
```

### Tests
```
tests_new/
  ├─ test_phase1_storage.py (240 lines, 6 tests)
  ├─ test_phase2_collector.py (340 lines, 6 tests)
  └─ test_phase3_normalizer.py (300 lines, 6 tests)
```

### Documentation
```
docs/
  ├─ SPRINT_TRACKING.md (updated with Phase 3 completion)
  ├─ PHASE3_COMPLETION.md (new, detailed summary)
  └─ data_schema.md (schema definitions)
```

---

## Next Phase: Phase 4 (2–4 days)

**Objective:** Use normalized inputs to build feature engineering + projections.

**Inputs:**
- `players_dim` — player master data
- `teams_dim` — team strength metrics
- `fixtures_fact` — schedule + results
- `team_state` — squad composition with injuries
- `player_gw_stats` — historical performance

**Outputs (new tables):**
- `player_derived_features` — rolling avg, form, minutes consistency, points/90
- `team_attacking_defensive_form` — xG for/against, defensive form
- `player_projections` — projected points, floor/ceiling
- `fixture_projections` — home/away xG, win probabilities

**Authority System:**
- `HIGH` — picks available + team_state complete + gw_stats available → chips allowed
- `MEDIUM` — picks unavailable or gw_stats missing → transfers only
- `LOW` — team_state < 15 or injuries not enriched → hold

---

## Summary Table

| Phase | Lines | Tables | Tests | Status |
|-------|-------|--------|-------|--------|
| 1 | 470 | 5 raw | 6 ✅ | COMPLETE |
| 2 | 580 | (same) | 6 ✅ | COMPLETE |
| 3 | 286 | +5 normalized | 6 ✅ | COMPLETE |
| 4 | TBD | +3 features | TBD | IN PROGRESS |

**Total Production Code:** 1,336+ lines  
**Total Test Code:** 880+ lines  
**Test Coverage:** 18/18 tests passing (100%)  

---

## Validation Checklist

✅ Phase 1: Storage layer complete + tested  
✅ Phase 2: Collection complete + tested  
✅ Phase 3: Normalization complete + tested  
✅ All 5 phase 1–3 tables working  
✅ 15-player hard rule enforced  
✅ Injury enrichment pipeline working  
✅ Deterministic pipeline (no randomness)  
✅ All FK constraints active  
✅ Input manifest generation working  
✅ Ready for Phase 4 projection engine  

---

**Approved for Phase 4 Kickoff** ✅

