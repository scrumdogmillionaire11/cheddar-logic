# Phase 2 Readiness Checklist: Collect All FPL Metrics

**Current Status:** 🟡 PARTIALLY READY (bootstrap, fixtures, picks exist — needs enhancement)

**Goal:** Audit current collectors and identify **exact code changes** needed to meet Phase 2 spec.

---

## ✅ What You Already Have (Good Foundation)

### In `src/collectors/weekly_bundle_collector.py`:

| Item | Status | Details |
|------|--------|---------|
| Bootstrap collection | ✅ | Fetches `/bootstrap-static/` + writes JSON |
| Fixtures collection | ✅ | Fetches `/fixtures/` + writes JSON |
| Team picks collection | ✅ | Fetches `/entry/{team_id}/event/{gw}/picks` with 404 fallback |
| Events collection | ✅ | Fetches `/events/` but writes as events payload, not separate artifacts |
| Status tracking (basic) | ✅ | Tracks HTTP status (200, 404, 500) |
| Metadata writing | ✅ | Writes `collection_meta.json` with endpoints + statuses |
| GW derivation | ✅ | Resolves from `events.is_current` (good!) |
| Run directory structure | ✅ | Creates `outputs/runs/{run_id}/data_collections/` |

---

## 🔴 What You're MISSING for Phase 2

### ❌ 1. Team Entry & History Collection

**Current:** Not collected at all  
**Needed:** `/entry/{team_id}` and `/entry/{team_id}/history`

**Location to add:** `src/collectors/weekly_snapshot_collector.py` (NEW FILE)  
**Code pattern:**
```python
# After picking collection succeeds/fails:
entry_resp = await _fetch_json(session, f"{base_url}/entry/{team_id}/")
history_resp = await _fetch_json(session, f"{base_url}/entry/{team_id}/history/")
```

**Why required:**
- `entry/{team_id}` → team rank, bank, value, transfers
- `entry/{team_id}/history` → chip usage audit (Free Hit, 3x Cap, etc.)

---

### ❌ 2. Gameweek Live Stats Collection

**Current:** Not collected  
**Needed:** `/event/{gw}/live` (best-effort)

**Location to add:** `src/collectors/weekly_snapshot_collector.py`  
**Code pattern:**
```python
# Only if GW is current or finished:
if current_event or finished_event:
    live_resp = await _fetch_json(session, f"{base_url}/event/{gw}/live/")
```

**Why needed:**
- Provides per-player stat lines: minutes, goals, assists, cs, bonus, bps
- Phase 3 will normalize this into `player_gw_stats` table
- Best-effort: OK if 404 or timeout

---

### ❌ 3. Status Code Distinction

**Current:** Only HTTP status (200, 404, 500)  
**Needed:** Explicit FPL-specific status codes

**Current in `collection_meta.json`:**
```json
{
  "endpoints": {
    "bootstrap_static": 200,
    "fixtures": 200,
    "events": 200,
    "team_picks": 404
  }
}
```

**Should be:**
```json
{
  "artifacts": {
    "bootstrap_static": { "status": "OK", "path": "...", "sha256": "..." },
    "fixtures": { "status": "OK", "path": "...", "sha256": "..." },
    "events": { "status": "OK", "path": "...", "sha256": "..." },
    "entry_1234": { "status": "OK", "path": "...", "sha256": "..." },
    "entry_1234_history": { "status": "OK", "path": "...", "sha256": "..." },
    "entry_1234_event_21_picks": { "status": "UNAVAILABLE_404" },
    "event_21_live": { "status": "FAILED_TIMEOUT" }
  }
}
```

**Status codes to use:**
- `OK` — 200, data written, hash computed
- `UNAVAILABLE_404` — 404 (not available yet)
- `FAILED_TIMEOUT` — Timeout or connection error
- `FAILED_PARSE` — Valid HTTP 200 but corrupted/unparseable JSON
- `FAILED` — Other 5xx errors

---

### ❌ 4. Hash Computation & Recording

**Current:** Not computed, not recorded  
**Needed:** SHA256 hash for each artifact + stored in snapshot_manifest

**Location to add:** `src/collectors/weekly_snapshot_collector.py`  
**Code pattern:**
```python
import hashlib

def compute_sha256(json_data: Dict) -> str:
    """Compute SHA256 of JSON file"""
    json_bytes = json.dumps(json_data, sort_keys=True).encode()
    return hashlib.sha256(json_bytes).hexdigest()
```

**Usage:**
```python
bootstrap_hash = compute_sha256(bootstrap_resp["payload"])
# Record in manifest:
artifacts["bootstrap_static"] = {
    "status": "OK",
    "path": "bootstrap_static.json",
    "sha256": bootstrap_hash
}
```

---

### ❌ 5. Database Integration

**Current:** Writes JSON only (no DB)  
**Needed:** Call `FPLDatabase.upsert_*()` methods after each collection

**Location to add:** `src/collectors/weekly_snapshot_collector.py`  
**Code pattern:**
```python
from src.storage.fpl_db import FPLDatabase

with FPLDatabase() as db:
    db.init_db()
    
    # After bootstrap write:
    db.upsert_bootstrap(
        snapshot_id=resolved_snapshot_id,
        status="OK",
        json_path=str(bootstrap_path),
        computed_hash=bootstrap_hash
    )
    
    # After fixtures write:
    db.upsert_fixtures(...)
    
    # After events write (if separate):
    db.upsert_events(...)
    
    # After team picks (best-effort):
    db.upsert_team_picks(
        snapshot_id=resolved_snapshot_id,
        status="UNAVAILABLE_404",  # If picks 404
        json_path=None,
        computed_hash=None
    )
    
    # Write final manifest:
    db.write_manifest(
        snapshot_id=resolved_snapshot_id,
        season=season,
        gw=derived_gw,
        manifest_dict={...}
    )
```

---

### ❌ 6. Snapshot ID Format

**Current:** `{run_id}` — somewhat opaque  
**Needed:** Deterministic `{season}_{gw}_{date}_{time}` format

**Example:**
- `2024_21_20250102_100000` → season 2024, GW 21, collected 2025-01-02 10:00:00

**Location to add:** `src/collectors/weekly_snapshot_collector.py`  
**Code pattern:**
```python
from datetime import datetime

def create_snapshot_id(season: int, gw: int) -> str:
    """Create deterministic snapshot_id"""
    now = datetime.now()
    return f"{season}_{gw}_{now.strftime('%Y%m%d_%H%M%S')}"
```

---

### ❌ 7. Separate Snapshot Collector Class

**Current:** Logic in `collect_weekly_bundle()`  
**Needed:** New `WeeklySnapshotCollector` class with clear contract

**Location:** Create `src/collectors/weekly_snapshot_collector.py` (NEW)

**Signature:**
```python
class WeeklySnapshotCollector:
    async def collect_snapshot(
        self, 
        season: int, 
        gw_target: int, 
        team_ids: List[int]
    ) -> str:
        """
        Fetch all metrics → write JSONs → DB rows → manifest.
        Returns: snapshot_id
        """
```

---

## 🔧 Exact File Changes Needed

### New Files to Create:

| Path | Purpose | Size | Dependency |
|------|---------|------|------------|
| `src/collectors/weekly_snapshot_collector.py` | Main Phase 2 collector | 350+ lines | FPLDatabase |
| `scripts/test_phase2_collector.py` | Acceptance tests | 200+ lines | WeeklySnapshotCollector |

### Files to Modify:

| Path | Changes | Lines |
|------|---------|-------|
| `src/storage/fpl_db.py` | Already complete ✅ | N/A |
| `src/collectors/weekly_bundle_collector.py` | Optional refactor (keep for backward compat) | — |

---

## ⚡ Quick Implementation Roadmap

### Step 1: Create `WeeklySnapshotCollector` class (1–2 hours)
- Copy logic from `collect_weekly_bundle()`
- Add `/entry/{team_id}` + `/entry/{team_id}/history` collection
- Add `/event/{gw}/live` collection (best-effort)
- Add hash computation for each artifact
- Use explicit status codes

### Step 2: Integrate with `FPLDatabase` (30 min)
- After each JSON write, call `db.upsert_*()` and pass hash + status
- After all collections, call `db.write_manifest()`

### Step 3: Write acceptance tests (1 hour)
- `test_p2_a1`: Bootstrap + fixtures → snapshot valid
- `test_p2_a2`: Picks 404 → snapshot still valid + manifest recorded
- `test_p2_a3`: Bootstrap fails → snapshot INVALID
- `test_p2_a4`: GW deterministic from bootstrap.events
- `test_p2_a5`: All JSONs + hashes match DB
- `test_p2_a6`: Manifest written with all statuses

### Step 4: Run & validate (30 min)
- `pytest scripts/test_phase2_collector.py -v`
- All 6 tests pass ✅

---

## 📋 Acceptance Criteria (from SPRINT_TRACKING.md)

Phase 2 is COMPLETE when:
- ✅ Collect bootstrap + fixtures → valid snapshot
- ✅ Picks 404 → snapshot still valid, manifest records UNAVAILABLE_404
- ✅ Bootstrap fails → snapshot INVALID, run stops
- ✅ GW resolution from bootstrap.events (never "unknown")
- ✅ All JSONs written + hashes match DB records
- ✅ Manifest written with all source statuses

---

## 🎯 Decision Points

**Q: Keep `weekly_bundle_collector.py` or replace with `weekly_snapshot_collector.py`?**  
A: Keep both for now (backward compat). `weekly_snapshot_collector.py` is Phase 2 spec-compliant.

**Q: Should phase 2 collector write to both JSON and DB?**  
A: YES. JSON for human audit, DB for model consumption.

**Q: What if a team_id doesn't have picks for a GW?**  
A: OK. Record `UNAVAILABLE_404`, continue. Phase 5 will downgrade authority but snapshot stays valid.

**Q: Should `/event/{gw}/live` be required or best-effort?**  
A: Best-effort. If fails or times out, record status but don't fail snapshot. Allows runs to proceed without latest live stats.

---

## 🚀 Next Action

**You asked:** "Is my system ready to collect all required data already?"

**Answer:** 
- ✅ 60% ready (bootstrap, fixtures, team picks)
- 🔴 40% missing (entry, history, event live, DB integration, proper status tracking)

**Recommendation:** 
Begin Phase 2 by creating `WeeklySnapshotCollector` with full endpoint coverage, hash computation, and FPLDatabase integration. This is **doable in 3–5 days** with your current foundation.

