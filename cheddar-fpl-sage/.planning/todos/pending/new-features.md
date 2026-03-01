# FPL Sage - New Features & Enhancements

**Last Updated:** February 9, 2026  
**Status:** Planning / Backlog

---

## Feature 1: Blank Gameweek Strategic Planning

### Priority: HIGH
**User Value:** Massive - Blank gameweeks (e.g., GW31) are critical decision points that can swing 50+ ranks if handled well or poorly.

### Problem Statement

FPL Sage currently lacks proactive strategic planning for blank gameweeks. While it detects which teams have no fixtures, it doesn't:
- Warn managers about upcoming blanks 2-3 weeks in advance
- Recommend transitioning dead-team players out before blanks
- Compare "Free Hit through the blank" vs "Sell before + rebuild after"
- Plan multi-GW transfer sequences around fixture schedules

### Current State Analysis

**What works ✅**
- `slate_builder.py` detects `blank_teams` and `double_teams` per GW
- `chip_analyzer.py` has `has_upcoming_special_window()` (3 GW lookahead)
- Free Hit chip exists in decision framework

**What's missing ❌**
- No proactive blank GW warnings in recommendations
- No multi-GW strategic transfer planning
- Free Hit optimized only for emergencies, not fixture capitalization
- No cost-benefit analysis: "FH vs gradual transition"

### User Scenarios

#### Scenario A: Gradual Transition Strategy
```
GW29: Current team has 3 Man City players (Haaland, Foden, Ederson)
GW31: Man City blank (no fixture)
GW32: Man City returns

Recommendation:
- GW29: Transfer out Foden (lowest priority) → Target with good GW29-32 fixtures
- GW30: Transfer out Ederson → Target keeper with better fixtures
- GW31: Keep Haaland (essential), bench if needed, use transfers elsewhere
- GW32: Assess if re-buying City assets makes sense
```

#### Scenario B: Free Hit Strategy
```
GW29: Team has 5 blank GW players (City, Arsenal, etc.)
GW31: Multiple teams blank

Recommendation:
- GW29-30: Hold transfers, bank 2 FT
- GW31: Activate FREE HIT → Build optimal 11 from teams WITH fixtures
- GW32: Team reverts, resume normal planning
- Cost: 1 chip, Benefit: Keep strong base team intact
```

#### Scenario C: Hybrid Strategy
```
GW29: Team has 2 City players (both premium and performing)
GW31: City blank

Recommendation:
- GW29-30: Transfer out 1-2 non-performers on blank teams
- GW31: Bench City assets (or use Free Hit if 4+ blank players)
- Risk-posture aware: Conservative = sell more, Aggressive = hold + FH
```

---

## Implementation Plan

### Phase 1: Blank GW Detection & Warnings (2-3 hours)
**Deliverable:** System outputs clear warnings when blank GWs detected in horizon

**Files to modify:**
- `src/cheddar_fpl_sage/analysis/decision_framework/chip_analyzer.py`
- `src/cheddar_fpl_sage/transformers/slate_builder.py`

**Tasks:**
1. Extend `slate_builder.py` to return blank GW metadata:
   ```python
   {
     'target_gw': 31,
     'blank_teams': [6, 14],  # Man City, Arsenal
     'team_names': ['Man City', 'Arsenal'],
     'affected_squad_count': 4  # How many of user's players
   }
   ```

2. Add method to `chip_analyzer.py`:
   ```python
   def detect_upcoming_blanks(self, current_gw: int, fixtures: List, 
                              squad: List, lookahead: int = 6) -> List[Dict]:
       """
       Scan next 6 GWs for blank gameweeks.
       Return list of blank GW events with impacted squad members.
       """
   ```

3. Output format in analysis summary:
   ```
   ⚠️  BLANK GAMEWEEK ALERT
   GW31 (3 weeks away): Man City, Arsenal have NO fixtures
   Your affected players (4):
   - Haaland (MCI) - Essential, high value
   - Foden (MCI) - Medium priority
   - Saka (ARS) - Essential, high value  
   - White (ARS) - Low priority

   → See "Blank GW Strategy" section below for options
   ```

### Phase 2: Strategic Options Engine (4-6 hours)
**Deliverable:** System presents 2-3 strategic options with expected point impacts

**New module:** `src/cheddar_fpl_sage/analysis/blank_gw_strategy.py`

**Core logic:**
```python
class BlankGWStrategist:
    def analyze_blank_gw_options(
        self, 
        blank_gw: int,
        affected_players: List[Dict],
        available_chips: List[str],
        free_transfers: int,
        risk_posture: str
    ) -> List[StrategyOption]:
        """
        Generate 2-3 strategic options for handling blank GW.
        
        Options:
        1. "Gradual Transition" - Sell over 2-3 weeks
        2. "Free Hit" - Keep team, FH through blank
        3. "Wildcard Reset" - Major rebuild (if WC available)
        
        For each option, calculate:
        - Transfer cost (hits)
        - Expected points preserved/lost
        - Team strength after blank
        - Risk level (Conservative/Balanced/Aggressive fit)
        """
        
@dataclass
class StrategyOption:
    name: str  # "Free Hit Strategy", "Gradual Transition", etc.
    description: str
    weekly_plan: List[WeeklyAction]
    total_hit_cost: int
    expected_points_delta: int  # vs doing nothing
    risk_level: str
    chip_usage: List[str]
    recommendation_strength: str  # "Recommended", "Alternative", "Not Advised"
```

**Strategy comparison logic:**
```python
def compare_strategies(self, options: List[StrategyOption]) -> StrategyOption:
    """
    Score each option based on:
    - Expected points (40% weight)
    - Chip value preservation (30% weight) 
    - Team structure resilience (20% weight)
    - Risk-posture alignment (10% weight)
    
    Return highest-scored option as primary recommendation.
    """
```

### Phase 3: Multi-GW Transfer Sequencing (3-4 hours)
**Deliverable:** System plans 2-4 GW transfer sequences, not just single GW

**Enhancement to:** `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py`

**New capability:**
```python
def plan_multi_gw_transfers(
    self,
    current_gw: int,
    horizon: int = 4,
    blank_gws: List[int] = None
) -> MultiGWPlan:
    """
    Plan optimal transfer sequence across multiple gameweeks.
    
    Considers:
    - Fixture difficulty for next N gameweeks
    - Blank GW impacts
    - Price changes
    - Form trends
    
    Returns prioritized transfer sequence:
    GW29: Transfer A → B (Reason: Blank prep + form)
    GW30: Transfer C → D (Reason: Final blank prep)  
    GW31: Use Free Hit / bench blank players
    GW32: Transfer E → F (Reason: Post-blank value)
    """
```

**Output format:**
```
=== MULTI-GAMEWEEK PLAN (GW29-32) ===

⚠️  Target: Navigate GW31 blank (Man City, Arsenal out)

RECOMMENDED STRATEGY: Gradual Transition + Free Hit Backup
Expected value: +12 points vs no action, -4 hit cost = +8 net

GW29 Actions:
  Transfer 1: Foden (MCI) → Palmer (CHE)
  Reason: Foden blanks GW31, Palmer has great GW29-32 fixtures
  Confidence: HIGH (Form + fixtures aligned)

GW30 Actions:
  Transfer 2: Ederson (MCI) → Raya (ARS) 
  ⚠️  WAIT - Raya also blanks GW31!
  Better option: → Onana (MUN) for GW30-33 coverage
  Reason: Keeper rotation, Man Utd play GW31

GW31 Actions:
  Option A: Bench Haaland + Saka (if 2 FT banked)
  Option B: Activate FREE HIT if 3+ blank players remain
  Decision point: Reassess GW30 based on injuries/form

GW32 Post-Blank:
  Monitor: Haaland fitness, City form return
  Hold: 2 FT if possible for flexibility
  Targets: Assess if re-buying City makes sense (fixtures GW32-35)
```

### Phase 4: Free Hit Optimization (2-3 hours)
**Deliverable:** Free Hit recommended for fixture optimization, not just emergencies

**Enhancement to:** `chip_analyzer.py`

**New logic:**
```python
def should_use_free_hit_strategically(
    self,
    current_gw: int,
    squad: List[Dict],
    upcoming_fixtures: List[Dict],
    available_chips: List[str]
) -> Tuple[bool, str, Dict]:
    """
    Recommend Free Hit for strategic fixture optimization.
    
    Triggers:
    1. 4+ squad players blank this GW
    2. Next 2 GWs have good fixtures (post-FH team stays strong)
    3. Free Hit available
    4. Expected gain > 10 points vs benching
    
    Returns:
    - should_use: bool
    - reasoning: str
    - optimal_fh_team: Dict (if True)
    """
```

**Comparison output:**
```
=== FREE HIT DECISION (GW31) ===

Your blank players: 4 (Haaland, Foden, Saka, White)

Option 1: BENCH BLANK PLAYERS
- GW31 Expected: 45 points (with bench players promoted)
- Hit cost: 0
- Team after GW31: Same squad

Option 2: ACTIVATE FREE HIT ✓ RECOMMENDED
- GW31 Expected: 62 points (optimal team from playing teams)
- Hit cost: 1 chip (Free Hit)
- Team after GW31: Reverts to current squad
- Expected gain: +17 points vs benching
- Chip value: HIGH (4 blank players = severe handicap)

Recommendation: ACTIVATE FREE HIT
Confidence: HIGH - This is exactly when Free Hit should be used
```

---

## Testing Strategy

### Unit Tests
1. `test_blank_gw_detection.py` - Verify blank team identification
2. `test_strategy_comparison.py` - Validate option scoring logic
3. `test_multi_gw_planning.py` - Test transfer sequence optimization

### Integration Tests
1. `test_full_blank_gw_flow.py` - End-to-end with real GW31 2025-26 data
2. `test_free_hit_vs_gradual.py` - Compare both strategies with known outcomes

### User Acceptance Tests
1. Run analysis for GW29 with 3+ City/Arsenal players
2. Verify system outputs clear strategy comparison
3. Confirm recommendations align with expert FPL manager thinking

---

## Success Metrics

**User Impact:**
- Blank GW warnings: 100% detection rate (when fixtures available)
- Strategy options: Present 2-3 viable options per blank GW
- Multi-GW planning: 4 GW horizon minimum
- Free Hit precision: Recommend when expected gain > 10 pts

**Technical:**
- Performance: Analysis completes in <5 seconds
- Accuracy: Strategy recommendations match expert consensus 80%+
- Coverage: Handle all blank GW scenarios (single team, multiple teams, DGW+blank combos)

---

## Dependencies & Risks

### Dependencies
- Fixture data must be available 6+ GWs in advance
- Accurate player ownership data for Free Hit team construction
- Form/injury data freshness critical for transition targets

### Risks
- **API Data Lag:** FPL API may not publish blanks until 2-3 weeks before
  - *Mitigation:* Add manual blank GW config override for known fixture clashes
  
- **Complexity Creep:** Multi-GW planning could become unwieldy
  - *Mitigation:* Limit horizon to 4 GWs, focus on blank events only
  
- **Over-Optimization:** System may recommend unnecessary transfers
  - *Mitigation:* Require minimum 8-point expected gain for transition recommendations

---

## Future Enhancements (Post-V1)

1. **Double Gameweek Integration:** Combine blank + DGW planning
2. **Wildcard Timing:** Optimal WC activation around fixture swings
3. **Bench Boost Planning:** Multi-GW bench strength building for BB
4. **Historical Learning:** Train on past blank GWs to improve recommendations
5. **User Preference Learning:** Adapt to manager's historical strategy choices

---

## Implementation Priority

**Sprint Priority:** Next major feature (after current stability work)

**Rationale:**
- High user value (affects all managers, multiple times per season)
- Leverages existing infrastructure (slate_builder, chip_analyzer)
- Clear success criteria (blank GW navigation)
- Competitive differentiator (most tools don't do this well)

**Estimated Effort:** 12-18 hours across 4 phases
**Expected Completion:** 1-2 week sprint

---

## Agent Execution Checklist

When implementing this feature, the agent should:

- [ ] Read existing `slate_builder.py` and `chip_analyzer.py` thoroughly
- [ ] Create new `blank_gw_strategy.py` module with strategy comparison engine
- [ ] Add `detect_upcoming_blanks()` method with 6 GW lookahead
- [ ] Implement `BlankGWStrategist` class with 3 core strategies
- [ ] Enhance `should_use_free_hit()` to include strategic triggers
- [ ] Add multi-GW planning to transfer recommendation engine
- [ ] Create comprehensive test suite (unit + integration)
- [ ] Update output format to include "Blank GW Strategy" section
- [ ] Document strategy comparison methodology in code comments
- [ ] Add configuration options for blank GW sensitivity (conservative/aggressive)
- [ ] Verify with real GW31 2025-26 data before shipping

**Success Criteria:** Manager sees clear multi-GW plan when blank GW detected in horizon, with quantified expected value for each strategic option.