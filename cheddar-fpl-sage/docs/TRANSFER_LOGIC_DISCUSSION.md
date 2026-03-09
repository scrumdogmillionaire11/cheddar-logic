# Transfer Logic Discussion & Improvements Needed

**Date:** January 30, 2026  
**Status:** Active Discussion  
**Context:** With 4-5 free transfers, system still recommends "Roll Transfer"

## March 9, 2026 Update (Rank-Recovery Layer Implemented)

The transfer engine now uses an explicit rank-aware strategy mode before applying transfer gates.

### Strategy Mode Derivation

1. Base mode from rank bucket:
   - `<=50k -> DEFEND`
   - `50,001-500k -> CONTROLLED`
   - `500,001-3M -> BALANCED`
   - `>3M -> RECOVERY`
2. Risk posture nudge:
   - `conservative`: one step safer (if possible)
   - `aggressive`: one step riskier (if possible)

### Transfer Threshold Bases (before FT multiplier)

| Strategy Mode | Base Required Gain |
|---------------|--------------------|
| DEFEND | `2.8` |
| CONTROLLED | `2.2` |
| BALANCED | `1.8` |
| RECOVERY | `0.9` |

Free transfer multipliers remain active (`1 FT = 1.0x`, `2 FT = 0.75x`, `3 FT = 0.6x`, `4 FT = 0.5x`, `5 FT = 0.4x`), so `RECOVERY` materially lowers the barrier vs `BALANCED`.

### New Output Diagnostics

- `near_threshold_moves`: explicitly shows almost-qualifying moves and rejection reasons.
- `strategy_paths`: safe/balanced/aggressive alternatives surfaced for user override.
- `squad_issues`: structural problem list (lineup, bench, availability).
- `no_transfer_reason`: threshold-specific message (not generic).

## March 9, 2026 Update (DGW/BGW Forward Planner)

The solver now consumes an 8-GW fixture horizon from canonical bundle fixtures (`raw_data["fixtures"]`) and applies capped DGW/BGW modifiers in transfer and captain ranking.

### Fixture Horizon Normalization

- Source of truth: `fixtures.json` loaded via `fpl_sage_integration.py`
- Window: `start_gw = next_gameweek` fallback `current_gw`, horizon `start_gw..start_gw+7`
- Dedupe key: fixture `id`, fallback `(event, team_h, team_a, kickoff_time)`
- Inference:
  - `fixture_count == 0` => blank
  - `fixture_count >= 2` => double
- Difficulty: FPL FDR (`team_h_difficulty` / `team_a_difficulty`), fallback `3`

### Weighted Fixture Score

- Per-GW raw:
  - blank => `-4.0`
  - otherwise `fixture_count * (3.0 - avg_difficulty)` and `+1.0` extra if double
- Time decay: `[1.00, 0.92, 0.85, 0.78, 0.72, 0.66, 0.61, 0.56]`
- Aggregate: weighted average over the 8-GW horizon

### Solver Modifiers (Capped)

- Transfer adjustment:
  - `adj = clamp((0.55*near_dgw + 0.30*far_dgw) - (1.10*near_bgw + 0.60*far_bgw), -1.20, +0.90)`
- Captain adjustment:
  - `adj = clamp((0.40*near_dgw) - (0.95*near_bgw), -1.00, +0.70)`
- DGW bonus gate:
  - applied only if `xMins_next >= 60` and player is not injury-risk
- Dominance cap:
  - horizon adjustment capped to `20%` of base scorer magnitude per candidate

This keeps DGW/BGW context directional and meaningful while preventing horizon effects from overpowering core projection quality, availability filters, and existing avoid logic.

## 🔍 Current Issues Identified

### 1. **Max Free Transfers Cap** ✅ FIXED
- **Before:** CLI capped at 0-4 free transfers
- **After:** CLI now allows 0-5 free transfers (FPL rules)
- **Files Changed:**
  - `fpl_sage.py` lines 165, 174-179
  - `enhanced_decision_framework.py` lines 1550-1562
  - `transfer_advisor.py` lines 417-428

### 2. **Transfer Threshold Too High** ✅ PARTIALLY FIXED
- **Current State:**
  - AGGRESSIVE base: 1.2 points (lowered from 2.0)
  - With 4 FTs: 1.2 × 0.5 = **0.6 points threshold**
  - With 5 FTs: 1.2 × 0.4 = **0.48 points threshold**
  
- **Problem:** Even with lowered thresholds, system may not find enough players meeting criteria
- **Root Cause:** Need to investigate why viable replacements aren't being found

### 3. **Output Inconsistency** ⚠️ NEEDS DISCUSSION
- **CLI Output:** Very verbose with logs, debug info, full projections
- **Web UI Output:** Minimal summary with decision cards
- **Issue:** No way to test web UI by running CLI (different UX completely)

## 🤔 Questions for Discussion

### A. Transfer Recommendation Philosophy

**Current Logic:**
1. Find players with issues (injured, doubtful, poor form)
2. Find replacements in same position
3. Check if gain > threshold
4. If YES → recommend, if NO → "Roll Transfer"

**Questions:**
1. With 4-5 FTs, should we be **proactive** instead of **reactive**?
   - Currently: Only react to injuries/problems
   - Alternative: Actively seek upgrades even if no problems?

2. Should multiple FTs trigger **squad optimization** mode?
   - Example: With 5 FTs, analyze best 2-3 moves to maximize overall squad
   - Current: Only evaluates 1 transfer at a time

3. What's the user expectation with 5 FTs?
   - "Give me something to do with these transfers"
   - Or: "Only recommend if there's real value"

### B. Transfer Value Calculation

**Current Issues:**
1. Only compares `nextGW_pts` (1 gameweek projection)
2. Doesn't consider 4-6 week horizon value
3. Doesn't account for price rises/falls
4. Doesn't consider fixture difficulty trends

**Should we add:**
- ✅ 4-week projection comparison (data already available)
- ✅ Fixture difficulty weighting
- ⚠️ Price change prediction (complex, may not be reliable)
- ⚠️ Form trajectory (3-match rolling average)

### C. Multiple Transfer Planning

**Current Behavior:**
- Evaluates each transfer independently
- Doesn't plan 2-3 move sequences
- Doesn't consider team balance after multiple moves

**Should we implement:**
1. **2-Transfer Combos** (e.g., "Downgrade A → Upgrade B")
2. **Position Rebalancing** (e.g., shift budget from DEF to MID)
3. **Premium Player Swaps** (e.g., Haaland → Salah + funds)

### D. CLI vs Web UI Alignment

**Current State:**
- CLI: Raw engine output with all details
- Web UI: Formatted decision cards
- Problem: Can't use CLI to test web experience

**Options:**

**Option 1: Add CLI Formatting Flag**
```bash
python fpl_sage.py --format=web  # Output web-style decision cards
python fpl_sage.py --format=cli  # Current verbose output (default)
```

**Option 2: Unified Output Engine**
- Core engine returns structured JSON
- CLI renderer formats for terminal
- Web renderer formats for UI
- Both use same data structure

**Option 3: Web-Style CLI Mode**
```bash
python fpl_sage.py --style=clean  # Mimics web UI cards in terminal
```

## 📊 Data Already Available

The system already has rich data that's not being fully utilized:

**In `projections` object:**
- `nextGW_pts` - Next gameweek points ✅ USED
- `next4gw_pts` - 4-week projection ⚠️ NOT USED in transfer logic
- `recent_form` - Last 3 games average ⚠️ NOT USED
- `fixture_difficulty` - Next 6 weeks ⚠️ PARTIALLY USED
- `points_per_million` - Value metric ✅ USED for sorting

**In `team_data` object:**
- `manual_overrides.planned_transfers` - User's intended moves ✅ USED
- `bank_value` - Available funds ✅ USED
- `free_transfers` - FT count ✅ USED
- `risk_posture` - AGGRESSIVE/BALANCED/CONSERVATIVE ✅ USED

## 🎯 Proposed Improvements

### Short-Term (Fix Current Issue)

1. ✅ **DONE:** Increase FT cap to 5
2. ✅ **DONE:** Lower thresholds with FT multiplier
3. ⚠️ **NEEDS TESTING:** Verify fixes with actual user data
4. ⚠️ **INVESTIGATE:** Why viable_replacements empty even with low thresholds?

### Medium-Term (Better Transfer Logic)

1. **Multi-GW Value Calculation**
   ```python
   # Instead of just nextGW_pts
   value_score = (
       0.5 * nextGW_pts +           # 50% weight on next game
       0.3 * next4gw_pts / 4 +      # 30% weight on 4-week average
       0.2 * fixture_difficulty      # 20% weight on fixtures
   )
   ```

2. **Transfer Opportunity Scanner**
   - Run even when no injuries
   - Find "upgrade paths" with 4-5 FTs
   - Compare current squad vs optimal squad
   - Suggest moves to close the gap

3. **Multi-Transfer Planning**
   - Identify 2-3 move sequences
   - Calculate combined impact
   - Consider team structure balance

### Long-Term (Architecture Improvements)

1. **Unified Output Format**
   - Core engine returns structured JSON
   - Multiple renderers (CLI verbose, CLI clean, Web UI, API)
   - Same data, different presentations

2. **Transfer Strategy Engine**
   - Separate module for multi-transfer planning
   - Optimization algorithms (greedy, simulated annealing)
   - Budget reallocation strategies

3. **Testing Infrastructure**
   - Mock projections for unit tests
   - Regression tests for "Roll Transfer" scenarios
   - Test cases with 1/2/3/4/5 FTs

## 💡 Immediate Next Steps

1. **Test Current Fixes**
   ```bash
   python fpl_sage.py
   # Enter "aaron" profile
   # Check if transfer recommendations appear
   ```

2. **Debug Why No Recommendations**
   - Add logging to see viable_replacements count
   - Check if projections are loaded correctly
   - Verify threshold calculations are working

3. **Decide on Philosophy**
   - Should 4-5 FTs trigger proactive mode?
   - Or keep reactive (only fix problems)?
   - This determines algorithm changes needed

4. **Design CLI/Web Alignment**
   - Choose Option 1, 2, or 3 above
   - Implement formatting layer
   - Test both interfaces match

## 🔧 Code Locations

**Transfer Logic:**
- `src/cheddar_fpl_sage/analysis/decision_framework/transfer_advisor.py`
  - `recommend_transfers()` - Main entry point (lines 200-395)
  - `context_allows_transfer()` - Threshold gating (lines 397-435)
  - `build_transfer_plan()` - Plan construction (lines 437-470)

**Threshold Configuration:**
- `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py`
  - `_context_allows_transfer()` - Threshold logic (lines 1535-1570)
  - `_recommend_transfers()` - Calls TransferAdvisor (lines 1520-1530)

**CLI Interface:**
- `fpl_sage.py` - User prompts and overrides (lines 160-190)

**Web API:**
- `backend/services/engine_service.py` - Wraps FPLSageIntegration (lines 100-150)
- `frontend/src/components/analysis/` - Result display components

## 📝 Discussion Topics

Please provide guidance on:

1. **Transfer Philosophy:** Reactive vs Proactive with 4-5 FTs?
2. **Value Calculation:** Use multi-GW projections or stick with nextGW only?
3. **CLI/Web Alignment:** Which option (1, 2, or 3) for unified experience?
4. **Multi-Transfer Planning:** Worth implementing or over-engineering?
5. **Threshold Tuning:** Are current values (AGGRESSIVE=1.2, 4FT=0.5x) appropriate?

---

**Note:** All fixes have been applied but not tested yet. User should run `python fpl_sage.py` to validate improvements work as expected.
