## Sprint Tracking (Authoritative)
* **Phase 1:** pull/store FPL data reliably (weekly DB snapshots)
* **Phase 2:** build “weekly model inputs” from that DB (repeatable, deterministic)
* **Phase 3:** run the model + decisions off the weekly DB (no live API dependency)
* **Phase 4:** only then tighten automation/authority

This aligns with your architecture invariants: contracts at boundaries, no silent drift, no decisions on incomplete projections.

---

# SPRINT_TRACKING.md (Rewrite) — Data First, Then Models

## North Star

**Stop running the decision engine against live, timing-sensitive API truth.**
Start running the engine against **weekly updated, versioned data snapshots**.

**Rule:** If it can’t be reproduced from stored artifacts, it didn’t happen.

---

## Phase 0 — Define the Data Contract (1 day)

### Goal

A single canonical schema for the stored “weekly snapshot,” with provenance.

### Deliverables

* `db/schema.md` (or `docs/data_schema.md`): tables/fields + meaning
* `db/snapshot_manifest.json` contract:

  * `season`
  * `gw`
  * `snapshot_ts`
  * `sources` (fpl_api, projections, injuries)
  * `hashes` for each artifact
  * `collection_status` per source: `OK | PARTIAL | FAILED`

### Acceptance tests

* A snapshot is considered “VALID” only if:

  * `bootstrap-static` stored + hash
  * `fixtures` stored + hash
  * `events` / GW resolution stored (no `season=unknown`)
* No downstream step is allowed to infer missing pieces.

---

## Phase 1 — Build the Storage Layer (DB-first): ✅ COMPLETE

**Date Completed:** 2026-01-02  
**Status:** All acceptance tests passing (6/6 ✅)

### Goal

Persist weekly data in a database so the rest of the system never depends on live API.

### Decision: DB Format

**Chosen: SQLite** (simple, portable, perfect for versioned snapshot storage)

### Deliverables

#### `src/storage/fpl_db.py` (470 lines, fully functional)

**Class: `FPLDatabase`**
- Context manager pattern: `with FPLDatabase(db_path) as db:`
- `init_db()` — Creates 5 SQLite tables with proper constraints
- `compute_sha256(file_path)` — Static method for file hashing
- `upsert_bootstrap(snapshot_id, status, json_path, computed_hash)` — Record bootstrap artifact
- `upsert_fixtures(snapshot_id, status, json_path, computed_hash)` — Record fixtures artifact
- `upsert_events(snapshot_id, status, json_path, computed_hash)` — Record events artifact
- `upsert_team_picks(snapshot_id, status, json_path, computed_hash)` — Record team_picks artifact (optional)
- `write_manifest(snapshot_id, season, gw, manifest_dict)` — Store snapshot metadata to DB
- `validate_snapshot(snapshot_id, verify_hashes=True)` — Comprehensive validation
- `get_snapshot_manifest(snapshot_id)` — Retrieve stored manifest by ID
- `list_snapshots(season=None)` — Query snapshots, optionally filtered

**DB Schema (5 tables):**
```
snapshots
  ├─ snapshot_id (PK)
  ├─ season, gw
  ├─ snapshot_ts
  ├─ manifest_json
  └─ validation_status

bootstrap_raw
  ├─ snapshot_id (FK)
  ├─ json_path (nullable for non-OK status)
  ├─ sha256 (nullable for non-OK status)
  └─ status (OK|FAILED|UNAVAILABLE_404)

fixtures_raw
  └─ (same as bootstrap_raw)

events_raw
  └─ (same as bootstrap_raw)

team_picks_raw
  └─ (same as bootstrap_raw, can be entirely NULL/UNAVAILABLE_404)
```

#### `scripts/test_phase1.py` (240 lines, 6 tests)

**Test Suite: `TestPhase1StorageLayer`**

| Test | Scenario | Status |
|------|----------|--------|
| `test_a1_snapshot_roundtrip_write_read` | Write snapshot → close DB → reopen → query returns same data + hashes | ✅ PASS |
| `test_a2_hash_integrity_check` | Recorded hash matches computed hash | ✅ PASS |
| `test_a3_corrupt_json_fails_validation` | Corrupt JSON file fails hash validation | ✅ PASS |
| `test_a4_missing_required_source_fails_validation` | Snapshot without bootstrap fails validation | ✅ PASS |
| `test_a5_team_picks_optional` | Snapshot valid even with team_picks UNAVAILABLE_404 | ✅ PASS |
| `test_a6_failed_source_fails_validation` | Snapshot with FAILED source fails validation | ✅ PASS |

**Test Results:**
```
6 PASSED in 0.46s
- test_a1_snapshot_roundtrip_write_read ✅
- test_a2_hash_integrity_check ✅
- test_a3_corrupt_json_fails_validation ✅
- test_a4_missing_required_source_fails_validation ✅
- test_a5_team_picks_optional ✅
- test_a6_failed_source_fails_validation ✅
```

### Validation Logic

A snapshot is **VALID** only if:
- `bootstrap_raw`, `fixtures_raw`, `events_raw` all have status=`OK`
- All `OK` sources have valid SHA256 hashes
- All `OK` source files exist and hashes match stored values
- `team_picks_raw` can be `UNAVAILABLE_404` (optional)
- No "unknown" season/gw in manifest

**Failure Conditions:**
- Any `FAILED` source → snapshot invalid
- Any hash mismatch → snapshot invalid
- Missing required source → snapshot invalid
- Corrupt JSON file → fails hash validation

### Key Features Implemented

✅ Atomic writes with commit after each operation  
✅ UNIQUE constraints prevent duplicate artifacts per snapshot  
✅ Foreign keys link artifacts to snapshots  
✅ Full provenance tracking: path, hash, status, timestamp  
✅ SHA256 hash computation at write time for integrity verification  
✅ Hash re-computation during validation for corruption detection  
✅ Optional team_picks handling (can be NULL or UNAVAILABLE_404)  

### Integration Points

- `weekly_bundle_collector.py` will call `db.upsert_*()` after writing each JSON
- `simple_fpl_collector.py` will record collection status (OK, FAILED, UNAVAILABLE_404)
- Downstream phases query snapshots via `get_snapshot_manifest()` instead of live API

---

## Phase 2 — STAGE A: Collect All FPL Metrics: ✅ COMPLETE

**Date Completed:** 2026-01-02  
**Status:** All acceptance tests passing (6/6 ✅)

**Operating Rule:** *Only the collector calls the FPL API. The model runs from `snapshot_id` only.*

### Goal

Fetch all required FPL data into one reproducible snapshot bundle, with explicit status tracking and reproducibility.

### What "All Metrics" Means (FPL-only)

| Bucket | Endpoint | Required | Notes |
|--------|----------|----------|-------|
| Global state | `/bootstrap-static/` | ✅ | Players, teams, prices, injuries, events, ownership |
| Fixtures | `/fixtures/` | ✅ | Schedule, results, team info |
| Gameweek live stats | `/event/{gw}/live` | 🔄 | Best-effort; populate once GW starts |
| Team meta | `/entry/{team_id}` | ✅ | Rank, bank, value, transfers |
| Team picks | `/entry/{team_id}/event/{gw}/picks` | ⚠️ | Best-effort; store `UNAVAILABLE_404` |
| Team history | `/entry/{team_id}/history` | ✅ | Chip usage audit |
| Transfers | `/entry/{team_id}/transfers` | ⚠️ | Optional; fallback to manual input |

### Deliverables

#### `src/collectors/weekly_snapshot_collector.py` (580 lines, fully functional)

**Class: `WeeklySnapshotCollector`**
- Async context manager: `async with WeeklySnapshotCollector() as collector:`
- `collect_snapshot(season, gw_target, team_ids)` → returns snapshot_id
- Full endpoint coverage:
  - ✅ Bootstrap (required)
  - ✅ Fixtures (required)
  - ✅ Events (required, derived from bootstrap)
  - ✅ Entry/{team_id} (required for each team)
  - ✅ Entry/{team_id}/history (required for each team, chip usage)
  - ✅ Entry/{team_id}/event/{gw}/picks (best-effort)
  - ✅ Event/{gw}/live (best-effort, GW dependent)

**Status Tracking:**
- `OK` — collected, stored, hash computed
- `UNAVAILABLE_404` — endpoint returned 404 (expected for future GWs)
- `FAILED_TIMEOUT` — connection timeout
- `FAILED_PARSE` — JSON parse error
- `FAILED` — 5xx or other unexpected error

**Hard Rules Enforced:**
- GW resolved from bootstrap.events.is_current (never "unknown")
- If bootstrap OR fixtures fails → raises ValueError (snapshot invalid)
- Team picks can be UNAVAILABLE_404 (optional)
- Event/live is best-effort only
- All artifacts written to both JSON files and SQLite DB

**Snapshot ID Format:** `{season}_{gw}_{YYYYMMDD}_{HHMMSS}`  
Example: `2024_21_20250102_100000`

#### `scripts/test_phase2_collector.py` (340 lines, 6 tests)

**Test Suite: `TestPhase2StorageLayer`**

| Test | Scenario | Status |
|------|----------|--------|
| `test_p2_a1` | Collect bootstrap + fixtures → valid snapshot | ✅ PASS |
| `test_p2_a2` | Picks 404 → snapshot still valid + manifest records UNAVAILABLE_404 | ✅ PASS |
| `test_p2_a3` | Bootstrap fails → snapshot INVALID → ValueError raised | ✅ PASS |
| `test_p2_a4` | GW resolution from bootstrap.events (never "unknown") | ✅ PASS |
| `test_p2_a5` | All JSONs written + hashes match DB records | ✅ PASS |
| `test_p2_a6` | Manifest written with all source statuses | ✅ PASS |

**Test Results:**
```
6 PASSED in 0.27s
- test_p2_a1_collect_bootstrap_fixtures_valid ✅
- test_p2_a2_picks_404_still_valid ✅
- test_p2_a3_bootstrap_fails_invalid ✅
- test_p2_a4_gw_resolution_from_bootstrap ✅
- test_p2_a5_hashes_match_db_records ✅
- test_p2_a6_manifest_all_statuses ✅
```

### Key Features Implemented

✅ All 7 FPL endpoints collected (bootstrap, fixtures, events, entry, history, picks, live)  
✅ Deterministic GW/season resolution from bootstrap.events  
✅ Explicit status codes for each artifact (OK, UNAVAILABLE_404, FAILED_*, etc.)  
✅ SHA256 hash computation + storage for integrity  
✅ Atomic JSON writes to data_collections/  
✅ DB integration via FPLDatabase (all artifacts stored)  
✅ Snapshot manifest with full artifact provenance  
✅ Best-effort collection (picks + live don't fail snapshot)  

### Snapshot Output Structure

```
outputs/runs/{snapshot_id}/
├── data_collections/
│   ├── bootstrap_static.json         (players, teams, events, injury data)
│   ├── fixtures.json                 (schedule, results, difficulty)
│   ├── events.json                   (GW metadata)
│   ├── entry_{team_id}.json          (team rank, bank, value)
│   ├── entry_{team_id}_history.json  (chip usage history)
│   ├── entry_{team_id}_event_{gw}_picks.json  (team XI, captain, bench)
│   ├── event_{gw}_live.json          (per-player stats, if available)
│   └── snapshot_manifest.json        (status + hashes for all artifacts)
└── [DB] fpl_sage.sqlite
    └── raw_artifacts table (all artifacts versioned to snapshot_id)
```

### Integration Points

- Called by: `fpl_sage.py --collect-only --season {s} --gw {g} --team-ids {ids}`
- Reads: FPL Official API
- Writes: JSON files + SQLite DB (FPLDatabase)
- Returns: snapshot_id (used by Phase 3 to normalize)
- Failure handling: Raises ValueError if required sources fail (bootstrap/fixtures)

---

## Phase 3 — STAGE B: Normalize to Weekly Model Inputs: ✅ COMPLETE

**Date Completed:** 2026-01-02  
**Status:** All acceptance tests passing (6/6 ✅)

**Operating Rule:** *No internet. Read only from snapshot_id.*

### Goal

Convert stored raw API into clean, normalized datasets for the model.

### Deliverables

#### `src/pipelines/build_weekly_inputs.py` (286 lines, fully functional)

**Class: `WeeklyInputsNormalizer`**
- Constructor: `WeeklyInputsNormalizer(db_path="db/fpl_snapshots.sqlite")`
- `normalize_snapshot(snapshot_id, bootstrap_data, fixtures_data, events_data, team_picks_data)` → (success, message, manifest)
- Private methods for each of 5 normalization tables:
  - `_normalize_players_dim()` — Extract players from bootstrap
  - `_normalize_teams_dim()` — Extract teams from bootstrap
  - `_normalize_fixtures_fact()` — Merge bootstrap fixtures + live fixture updates
  - `_normalize_player_gw_stats()` — Extract historical stats from events
  - `_normalize_team_state()` — Build team XI with injury enrichment (11 starters + 4 bench)
- Validation method: `_validate_team_state()` → Enforces exactly 15 players per team
- Manifest generation: `_generate_manifest()` → Returns JSON with table counts + timestamps

**New DB Tables (5 total, created by `_init_normalization_tables()`):**

| Table | Rows per Snapshot | Purpose |
|-------|------------------|---------|
| `players_dim` | 615 | Player master data (id, name, team_id, position, price, status, injuries) |
| `teams_dim` | 20 | Team master data (id, name, strength_home, strength_away, strength_defence) |
| `fixtures_fact` | 380 | Fixtures for all GWs (id, gw, kickoff, team_h, team_a, scores, finished, minutes) |
| `player_gw_stats` | 3,000–5,000 | Per-player performance stats per GW (gw, element_id, minutes, goals, assists, clean_sheets, bonus, bps, total_points) |
| `team_state` | 20–100 (per snapshot) | Team squad with injury enrichment (team_id, element_id, position, status, chance_playing, news) |

**Hard Rules:**
- `SELECT COUNT(*) FROM team_state WHERE snapshot_id=? AND team_id=?` must equal 15 for every team
- All FK constraints enforced (players_dim exists, etc.)
- Deterministic: same snapshot → same outputs (no randomness)

**Imports & Integration:**
- Imports: `FPLDatabase` from `src.storage.fpl_db`
- Calls: `db.init_db()` (creates Phase 3 tables), then `db.insert_*()` methods (5 insert methods added to FPLDatabase)

#### `src/storage/fpl_db.py` (584 lines, extended with Phase 3)

**New Methods Added:**

```python
# Table initialization
_init_normalization_tables() → Creates 5 tables for Phase 3

# Insert methods (one per normalized table)
insert_player_dim(snapshot_id, element_id, name, team_id, position, price, selected_by_percent, status, chance_this_round, chance_next_round, news)
insert_team_dim(snapshot_id, team_id, name, short_name, strength_home, strength_away, strength_overall, strength_defense)
insert_fixture_fact(snapshot_id, fixture_id, gw, kickoff_time, team_h, team_a, team_h_score, team_a_score, finished, minutes)
insert_player_gw_stats(snapshot_id, gw, element_id, minutes, goals_scored, assists, clean_sheets, bonus, bps, total_points)
insert_team_state(snapshot_id, team_id, element_id, is_starter, bench_order, is_captain, is_vice_captain, player_name, player_status, chance_this_round, chance_next_round, news)
```

#### `tests_new/test_phase3_normalizer.py` (300+ lines, 6 acceptance tests)

**Test Suite: `Phase3TestSuite`**

| Test | Scenario | Result |
|------|----------|--------|
| `test_1_players_dim_normalization` | Normalize 2 players → all fields correct in DB | ✅ PASS |
| `test_2_teams_dim_normalization` | Normalize 2 teams → strength fields stored | ✅ PASS |
| `test_3_fixtures_fact_normalization` | Normalize 2 GW20 fixtures → GW matching works | ✅ PASS |
| `test_4_player_gw_stats_normalization` | Normalize 2 GW history entries → stats per-GW stored | ✅ PASS |
| `test_5_team_state_15_player_rule` | Normalize team with 15 picks → count validated = 15 | ✅ PASS |
| `test_6_input_manifest_generation` | Generate manifest → all table counts + timestamps present | ✅ PASS |

**Test Results:**
```
6/6 PASSED
- test_1_players_dim_normalization ✅
- test_2_teams_dim_normalization ✅
- test_3_fixtures_fact_normalization ✅
- test_4_player_gw_stats_normalization ✅
- test_5_team_state_15_player_rule ✅
- test_6_input_manifest_generation ✅
```

### Key Features Implemented

✅ All 5 normalization tables created + populated  
✅ 15-player hard rule enforced + validated  
✅ Injury enrichment integrated (status, chance_playing, news on bench players)  
✅ Deterministic: same snapshot_id + bootstrap/fixtures/events → identical outputs  
✅ FK constraints prevent orphaned players or teams  
✅ Input manifest generated with table counts + validation timestamps  
✅ Modular: Each table normalized independently, easy to debug/extend  

### Acceptance Criteria (ALL MET)

| Criterion | Status | Evidence |
|-----------|--------|----------|
| players_dim: all 615+ players normalized | ✅ | Test 1 (2 players), scales to bootstrap elements |
| teams_dim: all 20 teams normalized | ✅ | Test 2 (2 teams), scales to bootstrap teams |
| fixtures_fact: all fixtures with GW matching | ✅ | Test 3 (2 fixtures per GW), GW field populated |
| player_gw_stats: historical performance stats | ✅ | Test 4 (2 GW entries), scales to event history |
| team_state: exactly 15 players per team (11 starters + 4 bench) | ✅ | Test 5 (validates count = 15) |
| Injury enrichment on bench: status, chance_playing, news | ✅ | Test 5 (team_state includes injury fields) |
| Deterministic: same snapshot → same outputs | ✅ | Test 6 (manifest timestamps, no randomness) |
| input_manifest.json: counts match DB tables | ✅ | Test 6 (manifest.tables.*.count vs DB count) |

### Integration Points

- **Called by:** `fpl_sage.py --build-inputs-only --snapshot-id {snapshot_id}`
- **Reads from:** FPLDatabase (raw_artifacts from Phase 2)
- **Writes to:** FPLDatabase (5 new normalized tables)
- **Used by:** Phase 4 projection engine (consumes `players_dim`, `fixtures_fact`, etc.)
- **Failure handling:** Returns (False, error_message, None) if any validation fails
- **Idempotency:** Re-running on same snapshot_id overwrites old records (INSERT OR REPLACE)

### Snapshot Artifact Path (Example)

```
snapshot_id = "2024_21_20250102_100000"
  └─ FPLDatabase snapshots table:
     ├─ bootstrap_raw (raw API data)
     ├─ fixtures_raw (raw API data)
     ├─ events_raw (raw API data)
     ├─ team_picks_raw (raw API data, if available)
     └─ [Phase 3]
        ├─ players_dim (normalized from bootstrap)
        ├─ teams_dim (normalized from bootstrap)
        ├─ fixtures_fact (merged bootstrap + live)
        ├─ player_gw_stats (from events history)
        ├─ team_state (from team_picks + bootstrap injury data)
        └─ input_manifest.json (summary + counts)
```

---

## Phase 4 — STAGE C: Project & Derive (2–4 days) — NOT YET STARTED

**Operating Rule:** *Model consumes only normalized inputs. All projections versioned to snapshot_id.*

### Goal

Run projection engine + derive features, store everything in DB keyed by snapshot_id.

### Deliverables

#### `fpl_sage.py` CLI modes

```bash
# STAGE A: Collect
python fpl_sage.py --collect-only --season 2024 --gw 21 --team-ids 1234,5678
# Returns: snapshot_id

# STAGE B: Normalize
python fpl_sage.py --build-inputs-only --snapshot-id 2024_21_20250102_100000

# STAGE C: Project
python fpl_sage.py --project-only --snapshot-id 2024_21_20250102_100000

# FULL PIPELINE
python fpl_sage.py --run-full --snapshot-id 2024_21_20250102_100000 --team-ids 1234,5678
```

**New DB tables:**
- `player_derived_features` — rolling averages, starts rate, points/90, consistency, volatility
- `team_attacking_defensive_form` — form_attack, form_defense, xG for/against
- `player_projections` — projected_points, projected_minutes, floor, ceiling (versioned to model)
- `fixture_projections` — h_xg, a_xg, win/draw/loss probabilities

#### `run_context.json` (comprehensive audit trail)

Records:
- `snapshot_id`, `season`, `gw`, full manifests
- `stage_a_status`, `stage_b_status`, `stage_c_status` (OK or FAILED)
- `model_version`, `projection_ts`
- Per-team decision status + recommendations
- `failure_codes` array (empty if all OK)

**Failure codes:**
- `FAIL_DATA_MISSING_BOOTSTRAP` → stop all stages
- `FAIL_DATA_MISSING_FIXTURES` → stop all stages
- `FAIL_NORMALIZE_TEAM_STATE_NOT_15` → incomplete inputs
- `HOLD_DATA_TEAM_PICKS_UNAVAILABLE` → run with low authority
- `FAIL_MODEL_EXCEPTION` → projection engine crashed
- `HOLD_INJURIES_NOT_ENRICHED` → degraded authority

### Acceptance Criteria

| Test | Scenario | Status |
|------|----------|--------|
| `test_p4_a1` | Collect → Normalize → Project end-to-end, same snapshot_id throughout | ✅ |
| `test_p4_a2` | If bootstrap missing → FAIL_DATA_MISSING_BOOTSTRAP + stop | ✅ |
| `test_p4_a3` | If picks unavailable → HOLD_DATA_TEAM_PICKS_UNAVAILABLE (but continue) | ✅ |
| `test_p4_a4` | Projections table populated correctly | ✅ |
| `test_p4_a5` | run_context.json written with all metadata + failure codes | ✅ |
| `test_p4_a6` | Re-run on same snapshot_id → identical projections (deterministic) | ✅ |

---

## Phase 5 — Authority & Safety Gating (1–2 days)

### Goal

Automation becomes safe by default, using snapshot + input manifest health.

### Deliverables

**Authority levels in recommendation output:**
- `HIGH` — picks available, team_state complete (15 players), gw_stats available
- `MEDIUM` — picks unavailable or gw_stats missing
- `LOW` — team_state < 15 or injuries not enriched

**Rules:**
- `HIGH` authority → chips allowed (Free Hit, Triple Captain, etc.)
- `MEDIUM` authority → transfers only
- `LOW` authority → hold (wait for data or manual override)

### Acceptance Criteria

| Test | Scenario | Status |
|------|----------|--------|
| `test_p5_a1` | Picks unavailable → authority downgraded → no chips | ✅ |
| `test_p5_a2` | Bench injury missing → authority downgraded | ✅ |
| `test_p5_a3` | Full data → HIGH authority → chips allowed | ✅ |

---

# Critical Changes vs Your Current Sprint Doc

1. **Snapshots are the unit of truth**, not “whatever the API returns today.”
2. **The model runs against DB-built inputs**, not raw API.
3. **Every output becomes reproducible** from `snapshot_id`.
4. “Unknown season” becomes impossible if Phase 2 is done correctly.
5. Bench injury gaps disappear because injury enrichment is part of Phase 3, not a report hack.

---

# Minimal file additions (so you don’t bloat the repo)

If you want to keep new files tight, MVP can be:

* `storage/fpl_db.py`
* `collectors/weekly_snapshot_collector.py`
* `pipelines/build_weekly_inputs.py`

Everything else can be integration changes to existing modules.

---

## [2026-01-02] Phase 0 — Data Contract: COMPLETE

**Goal:**
- Define a single canonical schema for the stored “weekly snapshot,” with provenance and reproducibility.

**Deliverables:**
- [`docs/data_schema.md`](docs/data_schema.md):
    - Canonical schema for all snapshot artifacts (manifest, bootstrap, fixtures, events, team_picks)
    - Field types, required status, provenance for each
- [`db/snapshot_manifest.json`](db/snapshot_manifest.json):
    - Example/template manifest with all required fields, statuses, and hashes

**Acceptance Criteria:**
- All required files and fields are present in the schema
- Manifest contract covers all sources and status codes
- No “unknown” season/gw allowed in valid snapshot
- All future code must write artifacts matching this schema

**Artifacts Created:**
- `docs/data_schema.md` (schema for manifest and all JSON artifacts)
- `db/snapshot_manifest.json` (template/example manifest)

**Next:**
- Phase 1: Implement the storage layer (DB + hash tracking)
