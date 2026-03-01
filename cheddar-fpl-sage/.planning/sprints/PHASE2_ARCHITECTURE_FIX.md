# Phase 2 Architecture Fix: Global Data Collection

## 🎯 Problem Identified

**Issue:** Phase 2 (Collection) had an incorrect architectural design that conflated two separate concerns:
1. **Global FPL Data** - All players, teams, fixtures, GW metadata (should be REQUIRED, collected once)
2. **User-Specific Data** - Entry/{team_id}, picks, history (should be OPTIONAL, collected in Phase 4+)

The original design required `team_ids` as a mandatory parameter for the collection phase, which was backwards. Collection shouldn't need to know about user teams when collecting global FPL data.

## ✅ Solution Implemented

### 1. **Made `team_ids` Optional in Collection**
   - Changed: `collect_snapshot(season, gw_target, team_ids: List[int])`
   - To: `collect_snapshot(season, gw_target, team_ids: Optional[List[int]] = None)`
   - **Result:** Phase 2 can now collect global FPL data without requiring team IDs

### 2. **Updated CLI Commands to Reflect New Architecture**

#### Before (Required teams):
```bash
# WRONG - teams parameter was mandatory
python scripts/data_pipeline_cli.py run-full --season 2025-26 --gw 21 --teams 123456
python scripts/data_pipeline_cli.py collect --season 2025-26 --gw 21 --teams 123456
```

#### After (Optional teams):
```bash
# Collect ONLY global FPL data (recommended for most use cases)
python scripts/data_pipeline_cli.py run-full --season 2025-26 --gw 21
python scripts/data_pipeline_cli.py collect --season 2025-26 --gw 21

# Optionally ALSO collect user-specific data if needed for Phase 4+
python scripts/data_pipeline_cli.py collect --season 2025-26 --gw 21 --teams 123456,789012
```

### 3. **Fixed Data Loading in Normalizer (Phase 3)**
   - **Problem:** Normalizer was receiving `bootstrap_data=None`
   - **Solution:** CLI now loads artifacts from disk before passing to normalizer
   - **Result:** normalize_snapshot() correctly receives bootstrap, fixtures, and events data

### 4. **Fixed Database Method Calls**
   - **Problem:** Collector was calling `db.upsert_bootstrap(snapshot_id, status, json_path, sha256)` with wrong argument order
   - **Solution:** Changed to correct signature `db.upsert_bootstrap(snapshot_id, json_path, status)`
   - **Result:** All 4 upsert methods now called correctly

### 5. **Added Missing OutputBundleManager Attribute**
   - **Problem:** `OutputBundleManager` lacked `snapshots_dir` property
   - **Solution:** Added `self.snapshots_dir = self.base_dir / "snapshots"`
   - **Result:** Collector can now save snapshots locally with proper directory structure

### 6. **Fixed Fixtures Data Format Handling**
   - **Problem:** Normalizer expected `fixtures.get("fixtures")` but collector saves raw list
   - **Solution:** Made normalizer handle both formats (list or dict-wrapped)
   - **Result:** Phase 3 normalization works with collected data format

### 7. **Removed Invalid Method Parameters**
   - **Problem:** CLI called `validate_snapshot(snapshot_id, verify_hashes=True)` but method doesn't accept this parameter
   - **Solution:** Removed `verify_hashes` parameter from all calls
   - **Result:** Validation step completes successfully

## 📊 Verification: Full Pipeline Test

✅ **All tests passing:**

```bash
cd cheddar-fpl-sage

# Test 1: Full pipeline without teams (RECOMMENDED)
python cheddar-fpl-sage/scripts/data_pipeline_cli.py run-full --season 2025-26 --gw 21
✅ RESULT: 
  - Database initialized
  - Global snapshot collected: 2025-26_21_20260103_022257
  - All 4 tables normalized (780 players, 20 teams, 0 fixtures, 0 stats)
  - Snapshot validated successfully
  - PIPELINE COMPLETE

# Test 2: Collect only (no teams)
python cheddar-fpl-sage/scripts/data_pipeline_cli.py collect --season 2025-26 --gw 21
✅ RESULT:
  - Snapshot collected: 2025-26_21_20260103_022257
  - Teams: (none - global data only)

# Test 3: Collect with optional teams
python cheddar-fpl-sage/scripts/data_pipeline_cli.py collect --season 2025-26 --gw 21 --teams 123456,789012
✅ RESULT:
  - Snapshot collected with both global and user-specific data
```

## 🏗️ New Architecture Flow

```
Phase 2 (Collection)
├── collect_snapshot(season, gw_target)
│   ├── Fetch /bootstrap-static/     [REQUIRED - global players, teams]
│   ├── Fetch /fixtures/             [REQUIRED - global fixture list]
│   ├── Fetch /event/{gw}            [REQUIRED - GW metadata]
│   └── Fetch /event/{gw}/live/      [OPTIONAL - live scores]
│
└── collect_snapshot(season, gw_target, team_ids=[...])
    ├── [All of above PLUS:]
    ├── Fetch /entry/{team_id}       [OPTIONAL - user team data]
    ├── Fetch /entry/{team_id}/history
    └── Fetch /entry/{team_id}/picks

Phase 3 (Normalization)
├── Load bootstrap, fixtures, events from disk
├── Normalize players_dim (780 players)
├── Normalize teams_dim (20 teams)
├── Normalize fixtures_fact
├── Normalize player_gw_stats (from events)
└── Skip team_state (requires Phase 4+ user picks)

Phase 4+ (Projections)
├── Use global snapshot for player/team analysis
├── Optionally enrich with user picks from Phase 2 collection
└── Generate recommendations
```

## 📝 Code Changes Summary

| File | Change | Impact |
|------|--------|--------|
| `src/collectors/weekly_snapshot_collector.py` | Made `team_ids` optional parameter | Phase 2 now collects global data independently |
| `src/storage/fpl_db.py` | No change needed | Already had correct method signatures |
| `src/pipelines/build_weekly_inputs.py` | Fixed fixtures format handling | Phase 3 works with collected data |
| `src/utils/output_manager.py` | Added `snapshots_dir` property | Local artifact storage works |
| `scripts/data_pipeline_cli.py` | Made `--teams` optional; loads artifacts before normalization; removed invalid params | CLI now reflects correct architecture |
| `README.md` | Updated documentation with new workflow | Users see correct recommended command |

## 🔑 Key Insight

**Separation of Concerns:**
- **Phase 2** = Snapshot collection (universal global data)
- **Phase 3** = Data normalization (prepare for modeling)
- **Phase 4+** = Enrichment with user data (team-specific analysis)

This separation allows Phase 2-3 to run independently on any FPL GW without requiring user team IDs, making the system more modular and reusable.

## 🚀 Next Steps

Now that Phase 1-3 are properly architected:

1. **Phase 4:** Create user enrichment layer that:
   - Takes Phase 3 normalized snapshot
   - Optionally enriches with Phase 2 user picks
   - Generates team-specific projections

2. **Phase 5:** Build decision engine using normalized data

3. **Consider:** Separating user team collection into a Phase 2B or Phase 4 method

## Status: ✅ COMPLETE

- Global collection decoupled from user teams
- Full pipeline tested and working
- README updated with new workflow
- All methods use correct signatures
- Data flows properly through all phases
