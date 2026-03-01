# Sprint 2 Quick Reference

## For Developers: How to Use the New Tri-State System

### Basic Usage

```python
from utils import (
    NonInteractiveChipResolver,
    NonInteractiveFTResolver,
    RestrictionCoordinator,
    FullRunStateResolution,
    compute_authority_level,
    format_restrictions_for_display,
)

# 1. Resolve chip state (no prompts!)
chip_resolver = NonInteractiveChipResolver()
chip_state = chip_resolver.resolve_chip_state(
    api_chip_data=None,  # None if API failed
    current_gw=15
)

# 2. Resolve FT state (no prompts!)
ft_resolver = NonInteractiveFTResolver()
ft_state = ft_resolver.resolve_ft_state(
    api_ft_count=None,  # None if API failed
    current_gw=15
)

# 3. Create full state
full_state = FullRunStateResolution(
    chip_state=chip_state,
    free_transfer_state=ft_state,
    # team_state=... (set separately)
)

# 4. Coordinate restrictions
coordinator = RestrictionCoordinator()
restrictions = coordinator.coordinate_restrictions(full_state)

# 5. Check authority level
authority = compute_authority_level(restrictions)  # 1, 2, or 3

# 6. Display to user
print(format_restrictions_for_display(restrictions))

# 7. Make decisions based on restrictions
if not restrictions.is_action_blocked("bench_boost_suggestion"):
    # Safe to suggest Bench Boost
    pass
else:
    reason = restrictions.block_reason("bench_boost_suggestion")
    # Skip or log reason
```

### Checking Restrictions

```python
# Is an action blocked?
if restrictions.is_action_blocked("multi_transfer_plan"):
    print("Cannot plan multi-transfer")

# Why is it blocked?
reason = restrictions.block_reason("captain_suggestion")
print(f"Blocked because: {reason}")

# What should the user do?
for suggestion in restrictions.suggestions:
    print(f"💡 {suggestion}")
```

### Setting Manual Overrides (Users)

```python
# Users update team_config.json manually:
# {
#   "manual_free_transfers": 2,
#   "manual_chip_status": {
#     "Wildcard": {"available": false, "played_gw": 12},
#     "Bench Boost": {"available": true, "played_gw": null},
#     ...
#   }
# }

# On next run, resolver will use KNOWN_MANUAL instead of UNKNOWN
ft_resolver = NonInteractiveFTResolver(config_file="team_config.json")
ft_state = ft_resolver.resolve_ft_state()
# Result: KNOWN_MANUAL, confidence: MED
```

### Understanding Tri-States

```python
from utils import ResolutionState, ConfidenceLevel

# State hierarchy (in priority order)
ResolutionState.KNOWN_API      # From FPL API (most trusted)
ResolutionState.KNOWN_MANUAL   # From config file (user confirmed)
ResolutionState.UNKNOWN        # Data unavailable (safe default)

# Confidence levels
ConfidenceLevel.HIGH           # Fresh, complete, recent
ConfidenceLevel.MED            # Partial, slightly stale, or derived
ConfidenceLevel.LOW            # Missing, very stale, or conflicted

# Common combinations:
# KNOWN_API + HIGH confidence      → Full authority for this component
# KNOWN_MANUAL + MED confidence    → Normal authority
# UNKNOWN + LOW confidence         → Safe default (restrictions applied)
```

### Blocked Actions Reference

```python
# Chip-related (blocked when chip_state is UNKNOWN/LOW):
"bench_boost_suggestion"          # Don't suggest Bench Boost
"free_hit_suggestion"             # Don't suggest Free Hit
"wildcard_suggestion"             # Don't suggest Wildcard
"aggressive_triple_captain"       # Don't suggest TC aggressively

# Transfer-related (blocked when ft_state is UNKNOWN/LOW):
"multi_transfer_plan"             # Don't suggest 2+ transfers
"aggressive_transfer_plan"        # Conservative transfer limits

# Lineup-related (blocked when team_state is UNKNOWN/LOW):
"lineup_suggestion"               # Don't suggest lineup changes
"captain_suggestion"              # Don't suggest captain

# Combo-related:
"aggressive_chip_transfer_combo"  # Risky: unknown FT + available chips
```

### Authority Levels

```python
authority = compute_authority_level(restrictions)

# Level 1 (Limited): Many restrictions
# Use for:
#   • Emergency fallback
#   • Validation runs
#   • Low-confidence periods
# Behavior:
#   • No chips, hits, or aggression
#   • Hold or captain only

# Level 2 (Normal): Few restrictions
# Use for:
#   • Production runs when data is partial
#   • Mixed API + manual overrides
# Behavior:
#   • Standard suggestions
#   • Some caution on uncertain elements

# Level 3 (Full): No restrictions
# Use for:
#   • Production runs with full data
#   • All systems operational
# Behavior:
#   • All suggestions enabled
#   • Aggressive optimization allowed
```

### Saving State

```python
# Save full state to output
run_context = {
    "chip_state": full_state.chip_state.to_dict() if hasattr(...) else {...},
    "free_transfer_state": {...},
    "team_state": {...},
    "restrictions": restrictions.to_dict(),
    "authority_level": authority,
}

# Save for debugging
import json
with open("run_state_debug.json", "w") as f:
    json.dump({
        "chip_state_resolution": chip_state.resolution_state.value,
        "chip_state_confidence": chip_state.confidence.value,
        "ft_state_resolution": ft_state.resolution_state.value,
        "ft_state_confidence": ft_state.confidence.value,
        "blocked_actions": restrictions.blocked_actions,
    }, f, indent=2)
```

### Common Patterns

**Pattern 1: Safe Non-Interactive Mode**
```python
# Always runs, degrades gracefully
chip_resolver = NonInteractiveChipResolver()
ft_resolver = NonInteractiveFTResolver()

chip_state = chip_resolver.resolve_chip_state(api_data=api_response.get("chips"))
ft_state = ft_resolver.resolve_ft_state(api_ft_count=api_response.get("free_transfers"))

coordinator = RestrictionCoordinator()
restrictions = coordinator.coordinate_restrictions(
    FullRunStateResolution(chip_state=chip_state, free_transfer_state=ft_state)
)

authority = compute_authority_level(restrictions)
# Even if authority=1, system still runs. Just more conservative.
```

**Pattern 2: Check Before Acting**
```python
# Only apply suggestion if not blocked
if not restrictions.is_action_blocked("bench_boost_suggestion"):
    suggestions.append(suggest_bench_boost())
else:
    log_reason = restrictions.block_reason("bench_boost_suggestion")
    console.log(f"Bench Boost blocked: {log_reason}")
```

**Pattern 3: Report State to User**
```python
# Always show what data we have
output = {
    "system_state": {
        "authority_level": compute_authority_level(restrictions),
        "data_sources": {
            "chips": chip_state.resolution_state.value,
            "free_transfers": ft_state.resolution_state.value,
        },
        "warnings": restrictions.warnings,
        "suggestions": restrictions.suggestions,
    }
}
```

### Testing

```bash
# Run full Sprint 2 test suite
python scripts/test_sprint2.py

# Test a specific state resolution
python -c "
from src.utils import NonInteractiveChipResolver
resolver = NonInteractiveChipResolver()
state = resolver.resolve_chip_state()
print(f'Chips: {state.available_chips()}')
print(f'Resolution: {state.resolution_state.value}')
print(f'Confidence: {state.confidence.value}')
"

# Test restrictions
python -c "
from src.utils import RestrictionCoordinator, FullRunStateResolution
coordinator = RestrictionCoordinator()
restrictions = coordinator.coordinate_restrictions(FullRunStateResolution())
print(format_restrictions_for_display(restrictions))
"
```

### Debugging Tips

1. **Check resolution state:**
   ```python
   print(f"Chip resolution: {chip_state.resolution_state.value}")
   print(f"Chip confidence: {chip_state.confidence.value}")
   print(f"Chip data source: {chip_state.data_source}")
   ```

2. **See what's being blocked:**
   ```python
   for action, reasons in restrictions.blocked_actions.items():
       print(f"{action}: {reasons}")
   ```

3. **Check authority level:**
   ```python
   authority = compute_authority_level(restrictions)
   print(f"Authority: {authority}/3")
   ```

4. **View human-readable output:**
   ```python
   print(format_restrictions_for_display(restrictions))
   ```

### Migration from Old System

Old way (prompts):
```python
# ❌ OLD
chip_manager = ChipStatusManager()
chip_status = chip_manager.interactive_chip_setup()  # Prompts!
```

New way (no prompts):
```python
# ✅ NEW
chip_resolver = NonInteractiveChipResolver()
chip_state = chip_resolver.resolve_chip_state(api_data)
```

### FAQ

**Q: What if all data is UNKNOWN?**
A: System returns authority level 1 (Limited) and blocks aggressive actions.
   Still runs successfully, just conservatively.

**Q: Can I override the tri-states?**
A: Yes, update team_config.json with manual_* fields. Resolver will use
   KNOWN_MANUAL next time instead of UNKNOWN.

**Q: How do I know if system is degraded?**
A: Check authority level (1-3) or look at restrictions.blocked_actions.
   If it's empty, system has full authority.

**Q: Should I use level 1 authority?**
A: Only for validation/testing. Production should target level 2+ for real decisions.

**Q: Can new data sources be added?**
A: Yes! Add a new ResolutionState type and update the resolvers to check it
   before defaulting to UNKNOWN.
