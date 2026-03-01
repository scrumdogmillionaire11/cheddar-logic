# Section A: Critical Correctness Fixes - Implementation Summary

## Status: IN PROGRESS (3 of 5 completed)

### ✅ A3. Manual Transfer Validation (COMPLETED)
**Files Modified:**
- `src/cheddar_fpl_sage/utils/manual_transfer_manager.py`

**Changes Implemented:**
1. Added `_is_placeholder()` method to detect invalid placeholder values
   - Blocks: None, Unknown, ?, ??, ???, N/A, TBD, null, placeholders
   
2. Enhanced `_add_single_transfer()` with validation:
   - Validates out_input and in_input are not placeholders
   - Enforces `out_player_id` and `in_player_id` fields
   - Validates IDs are positive integers
   - Shows clear error messages for invalid inputs

3. Added `_is_valid_transfer()` method:
   - Validates required fields exist (out_player_id or out_id, in_player_id or in_id)
   - Checks for placeholder values in names
   - Validates IDs are positive numbers
   
4. Updated save logic (choice '4'):
   - Validates all transfers before saving
   - Removes invalid transfers with warnings
   - **Always saves `planned_transfers` array** (even if empty)
   - Prevents ghost transfers from being persisted

**Impact:**
- ✅ No more "None → ?" transfers in config
- ✅ Required fields enforced
- ✅ Empty array saved if user exits without adding transfers
- ✅ Clear user feedback on validation errors

---

### ✅ A2. Season Resolution (COMPLETED)
**Files Modified:**
- `src/cheddar_fpl_sage/analysis/fpl_sage_integration.py`
- `src/cheddar_fpl_sage/collectors/weekly_bundle_collector.py`

**Changes Implemented:**

1. **fpl_sage_integration.py** - Hard validation on season:
   - Checks if season is None or "unknown" after loading metadata
   - Raises ValueError with user-friendly message if season missing
   - Message includes:
     - Why it matters (chip windows, deadlines, rules)
     - How to fix (--season flag or config)
     - No silent fallback
   - Logs "✓ Season resolved: {season}" on success

2. **weekly_bundle_collector.py** - Removed silent fallback:
   - Changed from `season = "unknown"` to `season = None`
   - Added warning log when season can't be extracted
   - Forces validation upstream instead of masking the issue

**Impact:**
- ✅ Never allows `season = unknown`
- ✅ Clear, actionable error messages
- ✅ Logs which season/ruleset was loaded
- ✅ Fails fast with helpful guidance

---

### ✅ A1. Risk Posture Single Source of Truth (COMPLETED)
**Files Modified:**
- `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py`

**Changes Implemented:**

1. Added validation at start of `analyze_chip_decision()`:
   - Compares `self.risk_posture` (framework) vs `team_data['team_info']['risk_posture']`
   - If mismatch detected:
     - Logs critical error with both values
     - Returns DecisionOutput with BLOCKED status
     - Clear block_reason explaining the mismatch
     - Prevents inconsistent decisions
   - Logs "Risk posture validated: {value}" on success

**Impact:**
- ✅ Runtime value enforced across entire analysis
- ✅ Mismatch blocks analysis with clear error
- ✅ Summary reflects runtime value (framework's value is authoritative)
- ✅ Prevents silent inconsistencies in decision logic

---

### 🔄 A4. Chip Status Clarity (IN PROGRESS)
**Status:** Need to implement

**Required Changes:**
1. Separate display of:
   - Available chips (can still be used)
   - Active chips (being used this GW)
   
2. Never show all chips as "✅" without context

3. If a chip is active:
   - Disable chip recommendations
   - Run chip-specific logic only
   
4. Clear messaging about chip state

**Files to Modify:**
- `src/cheddar_fpl_sage/utils/chip_status_manager.py` - Display logic
- `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py` - Active chip detection
- Output formatter for chip status display

---

### 🔄 A5. GW Lineup Resolution Messaging (IN PROGRESS)
**Status:** Need to implement

**Required Changes:**
1. Replace noisy 404 logs with one clear message:
   - Example: `Lineup source: GW23 (GW24 picks not published yet)`
   
2. Store in metadata:
   - `current_gameweek`
   - `next_gameweek`
   - `lineup_source` (which GW was used)
   
3. Show this once in user output (not in logs)

4. Suppress HTTP 404 warnings in favor of user-friendly message

**Files to Modify:**
- `src/cheddar_fpl_sage/collectors/enhanced_fpl_collector.py` - 404 handling
- `src/cheddar_fpl_sage/collectors/weekly_bundle_collector.py` - Lineup source tracking
- Output formatter - Display lineup source message

---

## Next Steps

1. Complete A4 (Chip Status Clarity)
2. Complete A5 (GW Lineup Resolution)
3. Test all fixes together
4. Move to Section B (CLI UX) or Section D (Summary Output)

## Testing Checklist

- [ ] A1: Test risk posture mismatch triggers block
- [ ] A2: Test missing season triggers clear error
- [ ] A3: Test manual transfer validation prevents ghost transfers
- [ ] A3: Test empty planned_transfers array is saved
- [ ] A4: Test chip status shows available vs active clearly
- [ ] A5: Test lineup resolution message appears once
