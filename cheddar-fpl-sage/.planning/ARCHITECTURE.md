# FPL Sage Architecture

## System Overview

FPL Sage is built as an **orchestrator-as-referee** decision engine, not a monolithic analyzer. Each component has a single responsibility and communicates through well-defined contracts.

## Decision Invariants

These are the non-negotiable principles FPL Sage enforces. These invariants become the **north star** when refactoring or extending the system:

### 1. **No Math in Orchestrator**
- The orchestrator performs zero calculations
- All point projections come from `CanonicalProjectionSet` only
- Decision logic consumes validated projections, never raw API data

### 2. **No Hits Without Positive EV**  
- The engine will never recommend a transfer hit without clear positive expected value
- Conservative -4/-8 rules based on expected point deltas
- Explicit justification required for all point hits

### 3. **No Chips Without Opportunity Cost Analysis**
- The engine will never recommend activating a chip without comparing current vs future windows
- All chip decisions include "best remaining window" analysis
- Prevents panic activation in suboptimal gameweeks

### 4. **No Decisions on Incomplete Projections**
- The engine will never act when projection validation fails
- Empty/invalid projections → System returns HOLD with specific error
- All components validate inputs at boundaries

### 5. **No Captain Outside Starting XI**
- Captain recommendations only consider players in the optimized starting XI
- Formation validation occurs before captaincy decisions
- Prevents recommending benched players as captain

### 6. **No Silent Logic Drift**
- All data contracts are enforced at component boundaries
- Projection shape mismatches cause immediate failures, not degraded behavior
- Clear error messages with resolution paths when contracts violated

### 7. **Process Over Points**
- The engine prefers being silent over being wrong
- Conservative thresholds prevent chasing marginal gains
- Structural team health prioritized over short-term point maximization

These invariants make the system **predictably conservative** rather than unpredictably clever.

## Core Design Principles

### 1. **Orchestrator Does No Math**
- The orchestrator explicitly does no calculations
- It enforces contracts and blocks actions when data is incomplete
- Prevents mixing of decision logic with mathematical operations

### 2. **Single Responsibility Chain**
```
Team Model      → labels structure & weakness
Fixture Model   → defines opportunity & traps  
Projection Engine → gives numbers
Transfer Advisor  → converts to actions
```

### 3. **Disciplined Hit Thresholds**
- Conservative -4/-8 rules based on expected deltas
- Explicit justification required for point hits
- No post-hoc rationalization of transfers

## Data Flow Architecture

### Primary Flow
```
FPL API Data → Enhanced Collector → Team Model → Decision Framework → GPT Integration
```

### Canonical Projection Contract
Post-engine, all components consume `CanonicalPlayerProjection` only:
```python
@dataclass
class CanonicalPlayerProjection:
    player_id: int
    nextGW_pts: float      # Primary decision input
    next6_pts: float       # Horizon planning
    xMins_next: float      # Minutes certainty
    volatility: float      # Risk metric
    ownership_pct: float   # Raw ownership (NOT EO)
    captaincy_rate: Optional[float]  # When available
```

### Contract Enforcement
- Empty/invalid projections → System refuses to act, returns HOLD
- Missing critical data → Explicit error messages, no silent failures
- Validation occurs at component boundaries

## Decision Engine Components

### 1. **Enhanced Decision Framework**
- **Input**: Team data, fixture data, canonical projections
- **Output**: DecisionOutput with reasoning and risk scenarios
- **Responsibility**: Convert data into actionable recommendations

### 2. **Transfer Advisor** 
- **Input**: Canonical projections, current squad, available transfers
- **Output**: Ranked transfer suggestions with expected deltas
- **Constraint**: Must optimize valid formations (3-5 DEF, etc.)

### 3. **Chip Strategy Engine**
- **Input**: Squad analysis, fixture outlook, available chips
- **Output**: Chip timing recommendations with future window comparison
- **Logic**: Only activate if current window ≥ X% of best remaining

### 4. **GPT Integration Layer**
- **Purpose**: Handle API staleness and context-specific decisions
- **Input**: Complete FPL Sage analysis + user's current team state
- **Output**: Contextually-adjusted final recommendations

## Failure Modes & Safeguards

### When System Refuses to Act
1. **Incomplete projections** → Returns HOLD with specific missing data
2. **Invalid formations** → Blocks transfer recommendations 
3. **Extreme uncertainty** → Escalates to manual review
4. **Stale team data** → Flags for GPT verification

### Data Quality Gates
- Projection confidence levels affect decision thresholds
- Multiple validation layers before recommendations
- Explicit confidence scoring in outputs

## Known Limitations & Workarounds

### 1. **FPL API Staleness**
- **Problem**: Team data only reflects last completed GW
- **Solution**: GPT integration with current team verification
- **Workaround**: Manual overrides for configured team only

### 2. **Effective Ownership Calculation**
- **Problem**: API lacks captaincy rate data for true EO
- **Solution**: Use raw ownership with high-ownership warnings
- **Future**: Integrate third-party EO data when available

### 3. **Formation Optimization**
- **Current**: Assumes reasonable starting XI
- **Risk**: May recommend captain who gets benched by projections
- **Fix**: Add explicit XI optimization before transfer recommendations

## Component Contracts

### Data Models
- `CanonicalPlayerProjection` - Post-engine projection format
- `DecisionOutput` - Framework decision with reasoning
- `CanonicalProjectionSet` - Complete projection set with metadata

### Validation Rules
- All projections must pass `validate_projection_set()`
- Transfer recommendations must respect formation constraints
- Chip decisions must include future window comparison

## Integration Points

### External Systems
- **FPL API**: Read-only data source with caching
- **GPT Integration**: Context resolution for stale data
- **Config Management**: Team-specific overrides and preferences

### Internal Communication
- All inter-component communication through typed contracts
- No direct access to raw API responses downstream
- Standardized error handling and logging

## Performance & Scale

### Bottlenecks
- FPL API rate limits (handled with caching)
- Projection computation for 700+ players
- GPT API calls for integration

### Optimization
- Single API call batch fetching
- Cached projections with TTL
- Async processing for independent operations

## Development Guidelines

### Adding New Components
1. Define clear input/output contracts
2. Add validation at component boundaries  
3. Include explicit failure modes
4. Update architecture documentation

### Testing Strategy
- Unit tests for each component boundary
- Integration tests for full decision flows
- Regression tests for edge cases (DGW, blank chaos)

### Debugging Support
- Decision artifact logging per GW
- Confidence scoring in all outputs
- Clear error messages with resolution paths