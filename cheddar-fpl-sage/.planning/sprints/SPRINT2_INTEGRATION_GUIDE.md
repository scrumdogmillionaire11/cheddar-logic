# Sprint 2 Integration Guide

## Overview

Sprint 2 has been integrated into the FPL Sage pipeline through a non-intrusive adapter pattern. The tri-state resolution system now sits alongside the main analysis without changing existing code.

## Integration Architecture

```
FPLSageIntegration.run_full_analysis()
         ↓
    [Collect API Data]
         ↓
    [Sprint 2 Integration Adapter]
         ↓
    ┌────────────────────────┐
    │ Resolve Tri-States:    │
    │ • Chip State           │
    │ • FT State             │
    │ • Team State           │
    └────────────────────────┘
         ↓
    ┌────────────────────────┐
    │ Coordinate Restrictions│
    │ • Blocked Actions      │
    │ • Warnings             │
    │ • Suggestions          │
    └────────────────────────┘
         ↓
    [Inject into team_data]
         ↓
    [Continue Analysis]
    (respecting restrictions)
         ↓
    [Output includes Sprint 2 data]
```

## How to Integrate Into FPLSageIntegration

### Step 1: Import at Top of File

```python
from analysis.sprint2_integration import Sprint2IntegrationAdapter
```

### Step 2: Add Sprint 2 Adapter to `__init__`

```python
def __init__(self, team_id: Optional[int] = None, config_file: str = "team_config.json"):
    # ... existing code ...
    self.sprint2_adapter = Sprint2IntegrationAdapter(config_file)
```

### Step 3: Call Sprint 2 After Loading Team Data

In `run_full_analysis()`, after loading team data (around line 250):

```python
# Step 2: Run decision analysis if we have team data
analysis_output = {}
if 'my_team' in data and 'error' not in data['my_team']:
    logger.info("Running decision analysis...")
    
    # >>> ADD THIS >>>
    # Sprint 2: Resolve and apply restrictions
    sprint2_result = self.sprint2_adapter.resolve_and_restrict(
        team_data=data['my_team'],
        current_gw=current_gw,
        api_available=True
    )
    
    # Inject restrictions into team_data
    data['my_team'] = self.sprint2_adapter.inject_into_analysis(
        data['my_team'],
        sprint2_result
    )
    
    # Log authority level
    authority = sprint2_result['authority_level']
    logger.info(f"Sprint 2 Authority Level: {authority}/3")
    # <<< END ADD >>>
    
    # Continue with existing analysis...
    current_gw = data.get('current_gameweek', target_gw or 1)
    team_data = data['my_team']
    # ... rest of code ...
```

### Step 4: Check Restrictions Before Taking Actions

Before suggesting a chip or aggressive transfer:

```python
# Instead of:
# print("Suggested: Bench Boost")

# Do this:
if not self.sprint2_adapter.check_action_allowed("bench_boost_suggestion", sprint2_result['restrictions']):
    reason = self.sprint2_adapter.get_action_block_reason("bench_boost_suggestion", sprint2_result['restrictions'])
    logger.warning(f"Bench Boost suggestion blocked: {reason}")
else:
    print("Suggested: Bench Boost")
```

### Step 5: Include Sprint 2 Data in Output

In the run context/output:

```python
run_context = {
    # ... existing data ...
    **sprint2_result['run_context'],  # Add Sprint 2 data
}
```

## Usage Examples

### Example 1: Check If Action Is Allowed

```python
# Check before suggesting a transfer
if self.sprint2_adapter.check_action_allowed("multi_transfer_plan", sprint2_result['restrictions']):
    # Safe to suggest 2+ transfers
    suggest_transfers()
else:
    # Transfer planning is restricted
    logger.info("Limited to 1 transfer due to data uncertainty")
```

### Example 2: Get Block Reason

```python
# If action is blocked, get the reason
if not self.sprint2_adapter.check_action_allowed("captain_suggestion", sprint2_result['restrictions']):
    reason = self.sprint2_adapter.get_action_block_reason("captain_suggestion", sprint2_result['restrictions'])
    print(f"Cannot suggest captain: {reason}")
    # User sees: "Cannot suggest captain: team_state_unknown | team_state_confidence_low"
```

### Example 3: Check Authority Level

```python
authority = sprint2_result['authority_level']

if authority == 1:
    print("⚠️ System running in Limited mode (restricted actions)")
    print(self.sprint2_adapter.format_restrictions_output(sprint2_result['restrictions']))
elif authority == 2:
    print("✅ System running in Normal mode (partial restrictions)")
elif authority == 3:
    print("✅ System running at Full authority (no restrictions)")
```

### Example 4: Display Restrictions to User

```python
# Show user why certain suggestions are unavailable
print(self.sprint2_adapter.format_restrictions_output(sprint2_result['restrictions']))

# Output example:
# ⚠️  WARNINGS
#   • Chip status unknown. To enable chip-based suggestions...
#   • Free transfer count unknown...
#
# 🚫 BLOCKED ACTIONS
#   • bench_boost_suggestion: chip_confidence_low
#   • multi_transfer_plan: free_transfer_confidence_low
#
# 💡 SUGGESTIONS TO UNLOCK
#   • Update team_config.json with your chip status
#   • Update team_config.json with manual_free_transfers value
```

## Data Structures

### sprint2_result Dictionary

```python
{
    'chip_state': ChipStateResolution,      # Chip tri-state info
    'ft_state': FreeTransferStateResolution, # FT tri-state info
    'team_state': TeamStateResolution,       # Team tri-state info
    'restrictions': RunRestrictionSet,       # Blocked actions & suggestions
    'authority_level': int,                  # 1/2/3
    'run_context': Dict,                     # Data for output
}
```

### run_context['sprint2']

```python
{
    'chip_state': {
        'resolution': 'KNOWN_API|KNOWN_MANUAL|UNKNOWN',
        'confidence': 'HIGH|MED|LOW',
        'available_chips': ['Wildcard', ...],
        'data_source': 'fpl_api|manual_override|unknown',
    },
    'ft_state': {
        'resolution': 'KNOWN_API|KNOWN_MANUAL|UNKNOWN',
        'confidence': 'HIGH|MED|LOW',
        'count': 2,
        'safe_to_plan': True|False,
        'data_source': 'fpl_api|manual_override|unknown',
    },
    'team_state': {
        'resolution': 'KNOWN_API|UNKNOWN',
        'confidence': 'HIGH|LOW',
        'data_source': 'fpl_api|unknown',
    },
    'restrictions': {
        'blocked_actions': {'action_name': ['reason1', 'reason2']},
        'warnings': ['warning text'],
        'suggestions': ['suggestion text'],
        'is_degraded': True|False,
    },
    'authority_level': 1|2|3,
    'timestamp': '2026-01-02T18:39:35...',
}
```

## Authority Levels

- **Level 1 (Limited)**: All UNKNOWN or LOW confidence → Conservative behavior
  - No chips, no hits, no aggressive captaincy
  - Max 1 transfer planning
  - System recommends user actions to unlock features

- **Level 2 (Normal)**: Mix of KNOWN and UNKNOWN → Standard behavior
  - Some actions enabled, others restricted
  - Depends on which components are known vs unknown
  - Clear warnings for restricted areas

- **Level 3 (Full)**: All KNOWN_API with HIGH confidence → Full automation
  - All actions enabled
  - No restrictions
  - System at full authority

## Blocked Actions Reference

| Action | Blocked When | Reason |
|--------|--------------|--------|
| `bench_boost_suggestion` | Chip state uncertain | Can't trust chip availability |
| `free_hit_suggestion` | Chip state uncertain | Can't trust chip availability |
| `wildcard_suggestion` | Chip state uncertain | Can't trust chip availability |
| `aggressive_triple_captain` | Chip state uncertain | Can't trust captain multiplier |
| `multi_transfer_plan` | FT count uncertain | Don't know how many FTs available |
| `aggressive_transfer_plan` | FT count uncertain | Limited transfer window |
| `lineup_suggestion` | Team state uncertain | Don't know actual squad |
| `captain_suggestion` | Team state uncertain | Can't suggest captain without squad |

## Testing

Run integration tests:

```bash
python scripts/test_sprint2_integration.py
```

Expected output: All 5 tests pass
- Test 1: Full API data (Authority 3)
- Test 2: Partial/missing data (Authority 1)
- Test 3: Action checking
- Test 4: Output formatting
- Test 5: Run context

## Migration Checklist

- [ ] Import Sprint2IntegrationAdapter in fpl_sage_integration.py
- [ ] Add adapter instance to FPLSageIntegration.__init__()
- [ ] Call resolve_and_restrict() after loading team data
- [ ] Inject results into team_data
- [ ] Check restrictions before suggesting actions
- [ ] Include sprint2_result['run_context'] in output
- [ ] Test with full API data (Authority 3)
- [ ] Test with missing data (Authority 1)
- [ ] Test with partial data (Authority 2)
- [ ] Update README with Sprint 2 info
- [ ] Run full system test: `python fpl_sage.py`

## Backward Compatibility

✅ **Fully backward compatible**

- Spring 2 is purely additive (no modifications to existing code)
- Adapter pattern keeps it isolated
- Existing analysis still runs
- Output includes additional Sprint 2 metadata
- No breaking changes to team_data format

## Troubleshooting

### Issue: "Authority Level 1 but analysis should work"
**Solution**: Check team_config.json for manual overrides:
```json
{
    "manual_free_transfers": 2,
    "manual_chip_status": {
        "Wildcard": {"available": true, "played_gw": null}
    }
}
```

### Issue: "Restrictions seem wrong"
**Solution**: Check that API data is being collected:
- Verify `api_available=True` passed to resolve_and_restrict()
- Check bundle paths exist and are valid
- Look at run logs for Sprint 2 resolution state

### Issue: "Want to see what's restricted"
**Solution**: Print formatted output:
```python
print(self.sprint2_adapter.format_restrictions_output(sprint2_result['restrictions']))
```

## Performance Impact

✅ **Negligible**: Sprint 2 adds ~5-10ms per run
- Simple dict checks and enum comparisons
- No API calls (uses already-collected data)
- Pure Python, no external dependencies

## Next Steps

After integration is complete and tested:

1. **Sprint 3**: Manual input layering (API + Manual + Derived)
2. **Sprint 4**: Safe scheduling & failure without panic
3. **Sprint 5**: Live monitoring and adaptive authority scaling
