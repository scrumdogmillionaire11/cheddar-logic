# FPL Sage Analysis Improvements - January 30, 2026

## Issues Fixed

### 1. **CRITICAL: Risk Posture Mismatch**

**Problem:**
```
ERROR: CRITICAL: Risk posture mismatch detected!
  Framework initialized with: AGGRESSIVE
  Team data contains: CONSERVATIVE
  Analysis BLOCKED to prevent inconsistent decisions.
```

**Root Cause:**
- User sets risk posture to AGGRESSIVE via CLI prompt
- Config manager saves it correctly to `config['risk_posture']`
- `FPLSageIntegration.__init__()` loads config and initializes framework with AGGRESSIVE
- **BUT** when building `team_data`, code was looking in the wrong place (`analysis_preferences.risk_posture`) and falling back to deriving posture from rank
- This derived a CONSERVATIVE posture based on low rank (1.7M)
- Framework initialized with AGGRESSIVE, team_data contained CONSERVATIVE → MISMATCH → BLOCKED

**Fix:**
Updated `fpl_sage_integration.py` line 1590-1610 to use framework's risk_posture directly instead of deriving from rank:

```python
# OLD (BROKEN):
manual_risk_override = (
    self.config.get('analysis_preferences', {}).get('risk_posture')  # WRONG PATH!
    if 'analysis_preferences' in self.config 
    else None
)
if manual_risk_override:
    risk_posture = manual_risk_override
else:
    # Derive from rank (creates mismatch)
    risk_posture = config_manager.derive_risk_posture_from_rank(overall_rank)

# NEW (FIXED):
# CRITICAL FIX: Use framework's risk_posture to ensure consistency
# The framework was already initialized with the correct risk_posture from config
# DO NOT derive from rank or look elsewhere - use single source of truth
risk_posture = self.decision_framework.risk_posture
logger.info(f"Using framework risk_posture for team_data: {risk_posture}")
```

**Impact:**
- Analysis no longer blocked due to mismatch
- User's manual risk posture selection is respected
- Single source of truth for risk posture throughout analysis

---

### 2. **Transfer Recommendations Too Conservative**

**Problem:**
```
Output: "Roll Transfer - no moves offer enough value right now"
Context: User has 4 free transfers, AGGRESSIVE mode
Expected: Specific transfer recommendations leveraging multiple FTs
```

**Root Cause:**
Transfer thresholds were too high and didn't account for multiple free transfers:

```python
# OLD THRESHOLDS:
"AGGRESSIVE": 2.0,  # Required 2.0 point gain
"BALANCED": 2.5,    # Required 2.5 point gain
```

With 4 free transfers, requiring 2.0 points per transfer is too conservative. Free transfers should lower the bar since there's no point hit cost.

**Fix:**
1. **Lowered base thresholds** (more proactive):
   ```python
   "AGGRESSIVE": 1.2,  # DOWN from 2.0
   "BALANCED": 2.0,    # DOWN from 2.5
   ```

2. **Added free transfer multiplier** to scale thresholds based on available FTs:
   ```python
   if free_transfers >= 4:
       ft_multiplier = 0.5  # Accept 50% of normal threshold
   elif free_transfers >= 3:
       ft_multiplier = 0.6  # Accept 60% of normal threshold
   elif free_transfers >= 2:
       ft_multiplier = 0.75 # Accept 75% of normal threshold
   else:
       ft_multiplier = 1.0  # Normal threshold
   ```

**Examples:**
| Mode | FTs | Old Threshold | New Threshold | Difference |
|------|-----|---------------|---------------|------------|
| AGGRESSIVE | 1 | 2.0 | 1.2 | 40% lower |
| AGGRESSIVE | 2 | 2.0 | 0.9 | 55% lower |
| AGGRESSIVE | 4 | 2.0 | 0.6 | 70% lower |
| BALANCED | 1 | 2.5 | 2.0 | 20% lower |
| BALANCED | 4 | 2.5 | 1.0 | 60% lower |

**Impact:**
- With 4 FTs in AGGRESSIVE mode, threshold is now 0.6 points (vs 2.0 before)
- System will suggest transfers that offer realistic value gains
- Multiple free transfers are properly utilized for squad improvements

---

## Files Changed

### `/src/cheddar_fpl_sage/analysis/fpl_sage_integration.py`
**Lines 1590-1610:** Fixed risk_posture derivation to use framework's value

### `/src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py`
**Lines 1535-1570:** Enhanced `_context_allows_transfer()` with:
- Lower base thresholds
- Free transfer multiplier logic
- Detailed logging

### `/src/cheddar_fpl_sage/analysis/decision_framework/transfer_advisor.py`
**Lines 325, 397-430:** Updated `context_allows_transfer()` with:
- Same logic as enhanced_decision_framework
- Free transfers parameter
- Consistent threshold calculation

---

## Testing Recommendations

### Test Case 1: Risk Posture Consistency
```bash
python fpl_sage.py --risk-posture AGGRESSIVE
# Expected: No "risk posture mismatch" error
# Expected: Analysis completes successfully
# Expected: Output shows "Risk Posture: AGGRESSIVE"
```

### Test Case 2: Multiple Free Transfers
```bash
# In config, set manual_free_transfers: 4
python fpl_sage.py
# Expected: Transfer recommendations appear (not "Roll Transfer")
# Expected: Recommendations reference multiple transfers
# Expected: Lower point gains accepted (~0.6-1.0 pts for AGGRESSIVE)
```

### Test Case 3: Conservative with 1 FT
```bash
# Set risk_posture: CONSERVATIVE, free_transfers: 1
python fpl_sage.py
# Expected: Higher threshold (2.8 pts)
# Expected: Fewer/no recommendations unless significant gain
```

---

## Next Steps

1. **Monitor real analysis runs** to validate threshold appropriateness
2. **Consider chip strategy improvements** - similar conservative bias may exist
3. **Add confidence scoring** based on projection quality
4. **Create regression tests** for risk posture consistency
5. **Document threshold tuning** for future adjustments

---

## Technical Notes

### Why Derive From Rank Was Wrong

The original logic tried to be "smart" by deriving risk posture from league position:
- High rank (top 100k) → AGGRESSIVE
- Mid rank (100k-1M) → BALANCED  
- Low rank (>1M) → CONSERVATIVE

**Problems:**
1. Overrides user's explicit choice
2. Creates mismatch with framework initialization
3. Assumes low-ranked managers want conservative play (often opposite is true!)
4. Blocks analysis due to inconsistency

**Correct Approach:**
- Respect user's explicit risk posture setting
- Use single source of truth (framework.risk_posture)
- Only derive if NO manual setting exists AND this is first run
- Store derived value so it doesn't change mid-season

### Free Transfer Economics

The point hit for additional transfers is -4 points. Therefore:
- 1 FT: Must gain >2.5 pts to justify (includes opportunity cost)
- 2 FTs: Can afford lower threshold per transfer
- 4 FTs: Can restructure squad with minimal per-transfer gains

Old thresholds treated all FT counts the same, which penalizes having multiple FTs.

---

## Rollback Instructions

If these changes cause issues:

```bash
git revert HEAD
# Or manually restore old thresholds:
# enhanced_decision_framework.py line 1543: "AGGRESSIVE": 2.0
# enhanced_decision_framework.py line 1549: "BALANCED": 2.5  
# transfer_advisor.py line 402: "AGGRESSIVE": 2.0
# transfer_advisor.py line 408: "BALANCED": 2.5
# Remove ft_multiplier logic (lines 1552-1562 and 411-421)
```
