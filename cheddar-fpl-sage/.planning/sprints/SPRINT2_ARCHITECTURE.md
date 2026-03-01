# Sprint 2 Architecture: Tri-State Resolution System

## System Flow

```
┌─────────────────────────────────────────────────────────────┐
│                   RUN START (No Prompts)                    │
└─────────────────────────────────────────────────────────────┘
                            ↓
        ┌───────────────────────────────────────┐
        │  Collect Available Data Sources       │
        ├───────────────────────────────────────┤
        │ • API responses (if available)        │
        │ • Config file overrides               │
        │ • Historical data                     │
        └───────────────────────────────────────┘
                            ↓
        ┌───────────────────────────────────────────────────────────┐
        │           RESOLUTION PHASE (Tri-State Priority)          │
        └───────────────────────────────────────────────────────────┘
            ↓                       ↓                       ↓
    ┌──────────────┐       ┌──────────────┐       ┌──────────────┐
    │ Chip State   │       │ FT State     │       │ Team State   │
    │ Resolver     │       │ Resolver     │       │ Resolver     │
    └──────────────┘       └──────────────┘       └──────────────┘
            ↓                       ↓                       ↓
    Try API Data           Try API Data           Try API Data
         ↓ no               ↓ no                  ↓ no
    Try Manual             Try Manual            Try Manual
         ↓ no               ↓ no                  ↓ no
    DEFAULT SAFE:          DEFAULT SAFE:         DEFAULT SAFE:
    UNKNOWN chips          1 FT conservative     UNKNOWN team
        ↓                       ↓                       ↓
    Return:                Return:                 Return:
    ChipState              FTState                 TeamState
    (with tri-state)       (with tri-state)       (with tri-state)
        ↓                       ↓                       ↓
        └───────────────────────────────────────┬───────────────┘
                                ↓
        ┌─────────────────────────────────────────────┐
        │  Merge into FullRunStateResolution         │
        │  (all components with their tri-states)    │
        └─────────────────────────────────────────────┘
                                ↓
        ┌─────────────────────────────────────────────────────────┐
        │         RESTRICTION COORDINATION PHASE                 │
        │  (Convert UNKNOWN/LOW → Blocked Actions)               │
        └─────────────────────────────────────────────────────────┘
            ↓                           ↓                       ↓
    ┌──────────────────┐      ┌──────────────────┐    ┌──────────────────┐
    │ Chip Restrictions│      │ FT Restrictions  │    │ Team Restrictions│
    └──────────────────┘      └──────────────────┘    └──────────────────┘
    If UNKNOWN/LOW:           If UNKNOWN/LOW:        If UNKNOWN/LOW:
    • Block Bench Boost       • Block multi-trans    • Block lineup sugg
    • Block Free Hit          • Block aggressive     • Block captain sugg
    • Block Wildcard          • Limit to 1 FT        • Log warnings
    • Restrict TC                                    
            ↓                           ↓                       ↓
            └───────────────────────────────────────┬───────────────┘
                                ↓
        ┌────────────────────────────────────────────┐
        │   RestrictionCoordinator                   │
        │   • Merges all restrictions                │
        │   • Detects risky combos                   │
        │   • Generates suggestions                  │
        │   • Computes authority level               │
        └────────────────────────────────────────────┘
                                ↓
        ┌────────────────────────────────────────────┐
        │   RunRestrictionSet                        │
        │   • blocked_actions: Dict[str, List[str]]  │
        │   • warnings: List[str]                    │
        │   • suggestions: List[str]                 │
        │   • authority_level: 1|2|3                 │
        └────────────────────────────────────────────┘
                                ↓
        ┌────────────────────────────────────────────┐
        │   Format for Display                       │
        │   • Human-readable warnings                │
        │   • Clear action blocking reasons          │
        │   • Suggestions to unlock features         │
        └────────────────────────────────────────────┘
                                ↓
┌─────────────────────────────────────────────────────────────┐
│                   ANALYSIS PROCEEDS                         │
│   Only unblocked actions are considered                     │
└─────────────────────────────────────────────────────────────┘
```

## Tri-State Priority Order

```
Priority 1: KNOWN_API (HIGH confidence)
  └─ From FPL API, fresh, reliable
  └─ No restrictions applied

Priority 2: KNOWN_MANUAL (MED confidence)
  └─ From config file override
  └─ User explicitly set this
  └─ Light restrictions for some actions

Priority 3: UNKNOWN (LOW confidence)
  └─ No data available, or stale
  └─ Safe defaults applied
  └─ Heavy restrictions
  └─ Clear suggestions to user
```

## Example Scenario: Full Safe Mode

```
Input State:
├─ Chip data from API: None
├─ Chip data from config: None
├─ FT count from API: None
├─ FT count from config: None
├─ Team state from API: None
└─ Team state from config: None

Resolution Results:
├─ ChipState: UNKNOWN (confidence: LOW)
├─ FTState: UNKNOWN, count=1 (confidence: LOW)
└─ TeamState: UNKNOWN (confidence: LOW)

Restrictions Applied:
├─ ❌ bench_boost_suggestion (chip_confidence_low)
├─ ❌ free_hit_suggestion (chip_confidence_low)
├─ ❌ wildcard_suggestion (chip_confidence_low)
├─ ❌ aggressive_triple_captain (chip_confidence_low)
├─ ❌ multi_transfer_plan (free_transfer_confidence_low)
├─ ❌ aggressive_transfer_plan (free_transfer_confidence_low)
├─ ❌ lineup_suggestion (team_state_unknown)
└─ ❌ captain_suggestion (team_state_unknown)

Authority Level: 1/3 (Limited)

Output to User:
⚠️  WARNINGS
  • Chip status unknown. Enable chip decisions by updating team_config.json
  • Free transfer count unknown. Enable transfer planning by updating team_config.json
  • Both chip and team state uncertain. System in safe mode (no aggressive actions)

🚫 BLOCKED ACTIONS
  • bench_boost_suggestion: chip_confidence_low
  • free_hit_suggestion: chip_confidence_low
  • ... (8 total blocked)

💡 SUGGESTIONS TO UNLOCK
  • Update team_config.json with your chip status
  • Update team_config.json with manual_free_transfers value
  • Provide your FPL team ID to sync team state
```

## Example Scenario: Partial Known (Mixed Authority)

```
Input State:
├─ Chip data from API: [WC, BB available]  ✅
├─ FT count from API: None
├─ FT count from config: 2                  ✅
└─ Team state from API: None

Resolution Results:
├─ ChipState: KNOWN_API (confidence: HIGH)
│  └─ Available: Wildcard, Bench Boost
├─ FTState: KNOWN_MANUAL (confidence: MED)
│  └─ Count: 2
└─ TeamState: UNKNOWN (confidence: LOW)

Restrictions Applied:
├─ ✅ Chip suggestions enabled
├─ ✅ Transfer planning enabled (up to 2 FTs)
└─ ❌ Lineup suggestions disabled (team_state_unknown)

Authority Level: 2/3 (Normal)

Output to User:
⚠️  WARNINGS
  • Team state unknown. Lineup and captain suggestions disabled.

🚫 BLOCKED ACTIONS
  • lineup_suggestion: team_state_unknown | team_state_confidence_low
  • captain_suggestion: team_state_unknown | team_state_confidence_low

💡 SUGGESTIONS TO UNLOCK
  • Provide your FPL team ID to sync team state for lineup suggestions
```

## Example Scenario: Full Authority

```
Input State:
├─ Chip data from API: [WC, BB available]  ✅
├─ FT count from API: 2                    ✅
└─ Team state from API: [squad data]       ✅

Resolution Results:
├─ ChipState: KNOWN_API (confidence: HIGH)
├─ FTState: KNOWN_API (confidence: HIGH)
└─ TeamState: KNOWN_API (confidence: HIGH)

Restrictions Applied:
└─ (none - all checks pass)

Authority Level: 3/3 (Full)

Output to User:
✅ No restrictions. System running at full authority.
```

## Key Properties

1. **No Prompts**: All resolution happens without `input()` calls
2. **Safe Defaults**: UNKNOWN states default to conservative behavior
3. **Explicit Restrictions**: Every blocked action has a reason
4. **Clear Suggestions**: Users know how to unlock each feature
5. **Auditable**: Every decision is logged with tri-state
6. **Progressive Authority**: Authority scales from 1-3 based on data quality
7. **Degradation Without Panic**: Low data → Limited authority, not crash

## Integration Checklist

- [ ] Import resolvers in `FPLSageIntegration`
- [ ] Call resolvers with API data + current GW
- [ ] Pass FullRunStateResolution to coordinator
- [ ] Store restrictions in run context
- [ ] Display restrictions in output
- [ ] Check restrictions before suggesting actions
- [ ] Return authority level in summary
- [ ] Test with missing API data (safe mode)
- [ ] Test with partial data (mixed authority)
- [ ] Test with full data (full authority)
