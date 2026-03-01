# Sprint 3.5 Work Plan — Config/Override Persistence Fix

**Date**: 2026-01-02  
**Status**: PLANNED (follows Sprint 3)  
**Priority**: CRITICAL (blocks Sprint 4)  
**Estimated Effort**: 2 days

---

## Executive Summary

Live run with manual chip/FT overrides revealed **config persistence is broken**:
- Manual chips set → Config saved → But analysis ignores them
- Manual FTs set → Config saved → But analysis uses 0
- Output claims "using overrides" but also claims "no overrides set" (contradiction)
- Config write path may differ from read path

Sprint 3.5 fixes the override plumbing so manual inputs actually work.

---

## Root Problems

### Problem 1: Write Path ≠ Read Path

**Write Path** (when user edits overrides):
1. Prompt collects manual chip choices
2. Prompt saves to: `team_config.json["team"][team_id]["manual_chips"]` (or similar key)
3. Output confirms: "Configuration saved to team_config.json"

**Read Path** (when analysis runs):
1. Load team_config.json
2. Read from: ???
3. Use value in: ???

**Gap**: Write path key/location != read path key/location

**Evidence**: 
- User sets chips manually
- Output confirms save
- But runtime shows only "Free Hit" available
- Config file probably has the data, but analysis isn't reading it

---

### Problem 2: Config Cached Before Edit

**Scenario**:
1. System loads team_config.json into memory: `config = load_config()`
2. User edits config via prompt: `config["manual_chips"] = [...]`
3. Prompt saves to disk: `write_config(team_config.json, config)`
4. Analysis runs but reads stale in-memory config (not re-reading from disk)

**Result**: Edit written to disk but not loaded into runtime because memory copy is old.

---

### Problem 3: Override Status Messaging Contradiction

**Output**:
```
✅ Using manual team overrides
...
(No manual overrides set)
```

Both cannot be true. Root causes:
- Different code paths reading override status (one sees data, one doesn't)
- Status printed before checking if data actually exists
- Logic inverted somewhere

---

### Problem 4: Manager Identity Not Parsed

**Output**:
```
Manager: Unknown Manager
```

Should be:
```
Manager: [actual manager name from entry payload]
```

Root: Entry endpoint provides manager name, but it's not being extracted/mapped.

---

## Work Breakdown

### A) Config Write/Read Path Alignment

**Objective**: Ensure manual overrides written to config are readable by runtime.

**Step 1: Map Current Paths**

Create audit document showing:
- Write path: Where override prompt saves data
- Read path: Where analysis loads data
- Schema: Key names, nesting, data types

**Example (hypothetical)**:

Write path:
```json
{
  "fpl": {
    "team_id": 12345,
    "manual_chips": ["Wildcard", "Free Hit"],
    "manual_free_transfers": 2
  }
}
```

Read path:
```python
# src/analysis/team_state_builder.py
chips = config.get("fpl", {}).get("manual_chips", [])
fts = config.get("fpl", {}).get("manual_free_transfers", 0)
```

**Deliverable**: Config mapping document + code audit

---

**Step 2: Align Keys**

If write and read paths use different keys:

```python
# WRONG (inconsistent):
# Write: config["team_overrides"]["chips"] = [...]
# Read:  config["overrides"]["manual_chips"]

# RIGHT (consistent):
# Write: config["fpl"]["manual_chips"] = [...]
# Read:  config["fpl"]["manual_chips"]
```

**Fix**: Ensure write and read use identical key paths.

**Deliverable**: Unified config schema + updated write/read code

---

**Step 3: Validate Round-Trip**

Unit test:
```python
# Write
write_config({"fpl": {"manual_chips": ["Wildcard"]}})

# Read
result = read_config()
assert result["fpl"]["manual_chips"] == ["Wildcard"]
```

**Deliverable**: Test in scripts/test_sprint3_5.py (A-1 through A-3)

---

**Acceptance Criteria A**:
- ✓ Config write and read use same key paths (no mismatch)
- ✓ Manual chips written → read back unchanged
- ✓ Manual FTs written → read back unchanged
- ✓ Unit test: write/read round-trip succeeds

---

### B) Config Caching / Pre-edit Snapshot

**Objective**: Ensure analysis reads current config, not stale in-memory copy.

**Step 1: Identify Cache Points**

Search code for:
- Where config is loaded into memory
- How long it lives (across multiple runs? within a run?)
- Whether it's invalidated after user edits

**Example (hypothetical)**:
```python
class FPLSageIntegration:
    def __init__(self):
        self.config = load_config()  # ← Loaded once, reused
        
    def run_analysis(self):
        # ← Uses self.config (may be stale!)
```

**Deliverable**: Cache audit document

---

**Step 2: Reload After Edit**

Option 1 (simple): Reload config from disk before analysis:
```python
def run_analysis(self):
    self.config = load_config()  # Reload fresh
    # ... proceed with analysis ...
```

Option 2 (sophisticated): Invalidate cache on edit:
```python
def on_override_edit(self):
    self.config_cache = None  # Invalidate

def run_analysis(self):
    if self.config_cache is None:
        self.config_cache = load_config()  # Reload if needed
```

**Deliverable**: Updated code with fresh config load

---

**Step 3: Integration Test**

Test: Edit config externally, run analysis, verify new config used:
```python
# 1. Load initial state
config_v1 = load_config()
assert config_v1["manual_chips"] == []

# 2. Externally modify config
write_config({"manual_chips": ["Wildcard"]})

# 3. Run analysis (should see new config)
result = run_analysis()
assert result.manual_chips == ["Wildcard"]
```

**Deliverable**: Integration test in scripts/test_sprint3_5.py (B-1)

---

**Acceptance Criteria B**:
- ✓ Config reloaded from disk on each analysis run
- ✓ Config changes written during override edit are visible to next analysis
- ✓ No stale in-memory config used
- ✓ Integration test passes

---

### C) Override Status Reporting (Contradiction Fix)

**Objective**: Output status message is never self-contradictory.

**Step 1: Identify Logic**

Find code that prints:
```
✅ Using manual team overrides
(No manual overrides set)
```

Determine:
- What condition triggers each message?
- Are they in same code path or different?
- Why would both print?

---

**Step 2: Implement Unambiguous Logic**

```python
def print_override_status(config):
    chips = config.get("fpl", {}).get("manual_chips", [])
    fts = config.get("fpl", {}).get("manual_free_transfers")
    
    has_chip_overrides = len(chips) > 0
    has_ft_overrides = fts is not None and fts != 0
    
    if has_chip_overrides or has_ft_overrides:
        print("✅ Manual overrides active:")
        if has_chip_overrides:
            print(f"  Chips: {', '.join(chips)}")
        if has_ft_overrides:
            print(f"  Free Transfers: {fts}")
    else:
        print("ℹ️  No manual overrides set")
```

**Result**: Either lists overrides OR says none; never both.

---

**Step 3: Add Assertion**

Prevent regression:
```python
# Code review check:
# "Does this function ever print both 'using' and 'no overrides'?"
# Answer should always be: NO

# Test assertion:
assert not ("Using manual" in output and "No manual" in output)
```

---

**Acceptance Criteria C**:
- ✓ Output never simultaneously claims "using overrides" AND "no overrides set"
- ✓ If overrides exist: explicitly lists what's overridden
- ✓ If no overrides: clearly states "no overrides set"
- ✓ Test ensures non-contradiction

---

### D) Manager Identity Parsing

**Objective**: Extract manager name from entry payload and include in output.

**Step 1: Locate Manager Data**

Entry endpoint provides:
```json
{
  "entry": {
    "player_id": 123456,
    "player_first_name": "...",
    "player_last_name": "...",
    "favourite_team": 1,
    ...
  }
}
```

Find where manager name field is. Likely:
- `entry["player_first_name"] + entry["player_last_name"]`
- Or a separate `entry["manager_name"]` field

**Deliverable**: Entry schema audit showing manager field location

---

**Step 2: Extract and Store**

```python
# In data collection phase
manager_name = entry.get("player_first_name", "Unknown")
if entry.get("player_last_name"):
    manager_name += " " + entry["player_last_name"]

team_state["manager_name"] = manager_name
```

**Deliverable**: Updated team_state_builder.py with manager extraction

---

**Step 3: Include in Output**

```python
# In output formatter
print(f"Manager: {team_state.get('manager_name', 'Unknown Manager')}")
```

**Deliverable**: Updated output formatting

---

**Acceptance Criteria D**:
- ✓ Manager name extracted from entry payload
- ✓ Included in team_state
- ✓ Printed in output: "Manager: [name]" (not "Unknown Manager")
- ✓ Test: Entry with manager name → output shows name

---

## Files to Create/Modify

### New Files
- `scripts/test_sprint3_5.py` — Comprehensive test suite (A-D tests)
- `docs/SPRINT3_5_CONFIG_AUDIT.md` — Config write/read path audit

### Modified Files
- `src/analysis/team_state_builder.py` — Config read paths (A), manager extraction (D)
- `src/analysis/override_prompt.py` (or similar) — Config write paths (A), reload logic (B)
- `src/analysis/output_formatter.py` — Override status messaging (C), manager output (D)

---

## Test Plan

### Unit Tests (scripts/test_sprint3_5.py)

**Section A: Config Round-Trip**
- A-1: Write manual chips → read back
- A-2: Write manual FTs → read back
- A-3: Write both → both readable
- A-4: Write empty → read empty

**Section B: Config Reload**
- B-1: Edit config on disk → analysis sees new values

**Section C: Override Status**
- C-1: No overrides → prints "no overrides set"
- C-2: Chips overridden → lists chips
- C-3: FTs overridden → lists FTs
- C-4: Both overridden → lists both
- C-5: Contradiction check (never both "using" and "no" simultaneously)

**Section D: Manager Parsing**
- D-1: Entry with manager name → extracted correctly
- D-2: Entry without manager → defaults to "Unknown"
- D-3: Output includes manager name

### Integration Tests
- Full override workflow: edit → save → run analysis → verify changes used
- Verify old output contradictions gone

---

## Success Criteria

| Criterion | Before | After |
|-----------|--------|-------|
| Config write/read consistency | ❌ Mismatch | ✅ Same keys |
| Config persistence | ❌ Ignored | ✅ Loaded |
| Override status messaging | ❌ Contradictory | ✅ Unambiguous |
| Manager identity | ❌ "Unknown Manager" | ✅ Actual name |
| Test coverage | ⚠️ Partial | ✅ 13+ tests |

---

## Dependencies

- **Blocks**: Sprint 4 (manual input layering depends on correct override plumbing)
- **Related**: Sprint 3 (crash handling, output codes)
- **Unblocks**: Proper authority downgrade on stale data (Sprint X+1)

---

## Rollout

1. **Implement A-B** (write/read alignment + reload)
2. **Test A-B** with round-trip test
3. **Implement C** (status messaging)
4. **Test C** with contradiction check
5. **Implement D** (manager parsing)
6. **Test D** with manager extraction
7. **Integration test** — full override workflow
8. **Verify** no regressions in existing flows

---

## Estimated Timeline

- **Day 1**: Config audit (A), implement alignment (A-B), initial tests (A)
- **Day 2**: Reload logic (B), status messaging (C-D), full test suite, integration test

Ready to proceed once Sprint 3 integration validated.
