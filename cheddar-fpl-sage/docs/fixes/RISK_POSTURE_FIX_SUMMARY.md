# Risk Posture Impact Verification

## Problem Identified
Risk posture was being stored but **NOT actually used** to filter or adjust transfer recommendations.

## Root Causes Found

### 1. Config Location Mismatch
- Risk posture stored at root level: `config.risk_posture`  
- Code was reading from: `config.analysis_preferences.risk_posture`
- **Result**: Always defaulted to BALANCED

### 2. Missing Risk-Based Filtering
- `TransferAdvisor` stored `self.risk_posture` but never used it
- No filtering logic applied to limit recommendations by risk tolerance
- **Result**: All users got same recommendations regardless of risk choice

## Fixes Implemented

### Fix 1: Correct Config Reading (fpl_sage_integration.py)
```python
# Priority order for reading risk_posture:
risk_posture = (
    self.config.get('risk_posture') or                           # Root level (primary)
    self.config.get('analysis_preferences', {}).get('risk_posture') or  # Nested (fallback)
    self.config_manager.get_risk_posture()                       # Config manager default
)
```

### Fix 2: Propagate to All Submodules (fpl_sage_integration.py) 
When overrides are applied, update **all** analysis modules:
```python
self.decision_framework.risk_posture = risk_posture
self.decision_framework._transfer_advisor.risk_posture = risk_posture
self.decision_framework._captain_selector.risk_posture = risk_posture
self.decision_framework._chip_analyzer.risk_posture = risk_posture
```

### Fix 3: Risk-Aware Filtering (risk_aware_filter.py)
Created new module with risk-based thresholds:

**CONSERVATIVE** (cautious):
- Min gain multiplier: 1.5x (require 50% more points)
- Max recommendations: 2 (fewer options)
- Example: Only show transfers gaining >2.25pts

**BALANCED** (default):
- Min gain multiplier: 1.0x (normal threshold)
- Max recommendations: 3 (standard)
- Example: Show transfers gaining >1.5pts

**AGGRESSIVE** (risk-taking):
- Min gain multiplier: 0.7x (accept 30% less gain)
- Max recommendations: 5 (more speculative options)
- Example: Show transfers gaining >1.05pts

### Fix 4: Apply Filtering in Result Transformer
```python
# Apply risk filtering BEFORE sending to frontend
risk_posture = decision_dict.get("risk_posture", "BALANCED")
transfer_recs = filter_transfers_by_risk(transfer_recs, risk_posture)
```

## Verification Test Results

Test with 5 sample transfers (gains: 3.5, 1.2, 2.8, 0.8, 4.0 pts):

**CONSERVATIVE** → 2 recommendations (only 3.5pts and 2.8pts transfers)
**BALANCED** → 3 recommendations (3.5, 2.8, 4.0 pts transfers)  
**AGGRESSIVE** → 4 recommendations (all except 0.8pts transfer)

✅ **Risk choice now directly impacts output**

## How to Test End-to-End

1. **Conservative user** (wants safe, high-gain moves):
   ```
   Select "Conservative" in UI → Get 2 recommendations, only high-value transfers
   ```

2. **Balanced user** (standard approach):
   ```
   Select "Balanced" in UI → Get 3 recommendations, medium+ value
   ```

3. **Aggressive user** (willing to take risks):
   ```
   Select "Aggressive" in UI → Get 5 recommendations, including speculative moves
   ```

## Performance Impact
- Zero performance impact (simple multiplier math + list slicing)
- Filtering happens once during result transformation
- Frontend receives already-filtered recommendations

## Files Modified
1. `src/cheddar_fpl_sage/analysis/fpl_sage_integration.py` - Config reading + override propagation
2. `backend/services/risk_aware_filter.py` - NEW: Risk filtering logic  
3. `backend/services/result_transformer.py` - Apply filtering before frontend

## Next Steps (Optional Enhancements)
1. Add risk-based captain selection (safe vs. differential)
2. Apply risk to chip timing decisions (patient vs. aggressive)
3. Add UI indicator showing risk filtering is active
4. Log risk-based filtering in analysis summary
