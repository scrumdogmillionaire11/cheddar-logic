# Sprint 3.5 Implementation Checklist — File-by-File Guide

**Purpose**: Exact locations of code changes needed for Sprint 3.5 (A-D)

---

## Work Item A: Config Write/Read Path Alignment

### Files to Audit

#### 1. Override Prompt (Config Write Path) 
**File**: `src/analysis/override_prompt.py` (or equivalent)

**What**: Find where manual chip/FT overrides are saved to config

**Search for**:
```python
# Likely location:
config["team"]["manual_chips"] = [...]  # or similar key
config["team"]["manual_free_transfers"] = ...  # or similar key
write_config(config)
```

**Document**:
- What key path is used for manual chips?
- What key path is used for manual free transfers?
- Example: `config["fpl"]["manual_chips"]` or `config["team_overrides"]["chips"]`?

#### 2. Team State Builder (Config Read Path)
**File**: `src/analysis/team_state_builder.py`

**What**: Find where manual overrides are read from config for analysis

**Search for**:
```python
# Likely location:
manual_chips = config.get("team", {}).get("manual_chips", [])
manual_fts = config.get("team", {}).get("manual_free_transfers", 0)
```

**Document**:
- What key path is used to read manual chips?
- What key path is used to read manual FTs?
- Are they the same as the write path?

#### 3. Action
- If keys DON'T match → Update one to match the other
- If keys DO match → Verify by writing/reading test
- Create test: `test_config_round_trip()` in `scripts/test_sprint3_5.py`

### Test (A-1 to A-4)
```python
# Write
config = {"fpl": {"manual_chips": ["Wildcard", "Free Hit"]}}
write_config(config)

# Read
result = read_config()
assert result["fpl"]["manual_chips"] == ["Wildcard", "Free Hit"]  # ✅ Pass?
```

---

## Work Item B: Config Reload / Cache Invalidation

### Files to Audit

#### 1. FPL Sage Integration (Main Entry Point)
**File**: `fpl_sage.py` or `FPLSageIntegration.py`

**What**: Find where config is loaded

**Search for**:
```python
class FPLSageIntegration:
    def __init__(self):
        self.config = load_config()  # ← Loaded once
        
    def run_analysis(self):
        # Uses self.config (may be stale!)
```

**Document**:
- Is config loaded once at startup?
- Is it reloaded before each analysis run?
- Is there a cache that doesn't invalidate?

#### 2. Action
- Add reload before analysis: `self.config = load_config()`
- OR: Implement cache invalidation on edit
- Create test: `test_config_reload()` in `scripts/test_sprint3_5.py`

### Test (B-1)
```python
# 1. Load initial config
config_v1 = load_config()
assert config_v1["manual_chips"] == []

# 2. Write new config externally
write_config({"manual_chips": ["Wildcard"]})

# 3. Run analysis (should see new config)
fpl = FPLSageIntegration()
fpl.run_analysis()
assert fpl.team_state.manual_chips == ["Wildcard"]  # ✅ Pass?
```

---

## Work Item C: Override Status Reporting (Contradiction Fix)

### Files to Audit

#### 1. Output Formatter / Console Reporter
**File**: `src/analysis/output_formatter.py` or `enhanced_console_reporter.py`

**What**: Find where override status is printed

**Search for**:
```python
# Likely location - PROBLEMATIC:
if config.get("team", {}).get("manual_chips"):
    print("✅ Using manual team overrides")

# Later in same code - PROBLEMATIC:
if not overrides_exist():
    print("(No manual overrides set)")
```

**Document**:
- Find function that prints override status
- What are all the places it prints?
- When can both messages print?

#### 2. Action
- Refactor to unambiguous logic:

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
        
    # Test assertion (prevent regression):
    output = f"...{output_text}..."
    assert not ("using" in output and "no overrides" in output)
```

### Test (C-1 to C-5)
```python
# C-1: No overrides
config = {"fpl": {"manual_chips": [], "manual_free_transfers": 0}}
output = print_override_status(config)
assert "no overrides set" in output
assert "using" not in output

# C-4: Both set
config = {"fpl": {"manual_chips": ["Wildcard"], "manual_free_transfers": 2}}
output = print_override_status(config)
assert "Wildcard" in output
assert "Free Transfers: 2" in output
assert not ("using" in output and "no overrides" in output)  # ✅ Contradiction test
```

---

## Work Item D: Manager Identity Parsing

### Files to Audit

#### 1. Entry Data Collection (Find Manager Name)
**File**: `src/data/entry_collector.py` or similar

**What**: Find where entry data is loaded from API

**Search for**:
```python
# Likely location:
entry = fetch_from_api("/api/v1/entry/")
# Returns: {"entry": {"player_id": 123, "player_first_name": "John", ...}}
```

**Document**:
- What field contains manager first name?
- What field contains manager last name?
- Example: `entry["player_first_name"]` + `entry["player_last_name"]`?

#### 2. Team State Builder (Store Manager Name)
**File**: `src/analysis/team_state_builder.py`

**What**: Find where team_state is initialized

**Search for**:
```python
# Add this:
manager_name = entry.get("player_first_name", "Unknown")
if entry.get("player_last_name"):
    manager_name += " " + entry["player_last_name"]

team_state["manager_name"] = manager_name
```

#### 3. Output Formatter (Display Manager Name)
**File**: `src/analysis/output_formatter.py`

**What**: Find where team info is printed

**Search for**:
```python
# Add this:
print(f"Manager: {team_state.get('manager_name', 'Unknown Manager')}")
```

### Test (D-1 to D-3)
```python
# D-1: Manager in entry
entry = {
    "player_first_name": "John",
    "player_last_name": "Doe"
}
manager_name = extract_manager_from_entry(entry)
assert manager_name == "John Doe"

# D-2: No manager (fallback)
entry = {}
manager_name = extract_manager_from_entry(entry)
assert manager_name == "Unknown"

# D-3: Manager in output
team_state = {"manager_name": "John Doe"}
output = format_team_info(team_state)
assert "Manager: John Doe" in output
assert "Unknown Manager" not in output
```

---

## Summary: Where to Look

| Work Item | File | What to Find |
|-----------|------|--------------|
| **A) Config Path** | `override_prompt.py` | Where chips/FTs saved |
| | `team_state_builder.py` | Where chips/FTs read |
| **B) Config Reload** | `fpl_sage.py` or main integration | Where config cached |
| **C) Status Messaging** | `output_formatter.py` | Where override status printed |
| **D) Manager Parsing** | `entry_collector.py` | Where entry data loaded |
| | `team_state_builder.py` | Where to add manager extraction |
| | `output_formatter.py` | Where to print manager name |

---

## Implementation Order

1. **Day 1 Morning: A) Config Path**
   - Audit write path (override_prompt.py)
   - Audit read path (team_state_builder.py)
   - Make keys consistent
   - Write A-1 to A-4 tests

2. **Day 1 Afternoon: B) Config Reload**
   - Audit cache point (fpl_sage.py)
   - Add reload logic
   - Write B-1 test

3. **Day 2 Morning: C) Status Messaging**
   - Audit messaging code (output_formatter.py)
   - Refactor to unambiguous logic
   - Write C-1 to C-5 tests

4. **Day 2 Afternoon: D) Manager Parsing**
   - Audit entry data (entry_collector.py)
   - Extract manager name
   - Add to team_state (team_state_builder.py)
   - Add to output (output_formatter.py)
   - Write D-1 to D-3 tests

5. **Throughout: Run Tests**
   - `scripts/test_sprint3_5.py` (13+ tests)
   - Should all pass by end of Day 2

---

## Files to Create

- ✅ `scripts/test_sprint3_5.py` — 13+ unit tests (A, B, C, D)
- ✅ `docs/SPRINT3_5_CONFIG_AUDIT.md` — Config key mapping

---

## Verification Checklist

After implementation:

- [ ] A1-A4 tests pass (config round-trip)
- [ ] B1 test passes (config reload)
- [ ] C1-C5 tests pass (status messaging)
- [ ] D1-D3 tests pass (manager parsing)
- [ ] I1 test passes (full workflow)
- [ ] No regressions in existing tests
- [ ] Manual chips work end-to-end
- [ ] Manual FTs work end-to-end
- [ ] Status message unambiguous
- [ ] Manager name shown correctly

---

**Ready to start?** Begin with Item A: audit config write/read paths in override_prompt.py and team_state_builder.py.
