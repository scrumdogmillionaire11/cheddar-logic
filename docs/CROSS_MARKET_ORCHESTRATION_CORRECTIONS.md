# Cross-Market Orchestration Architecture — CORRECTIONS APPLIED

**Status:** Design Phase (pre-implementation, corrected)  
**Date:** February 27, 2026  
**Owner:** @ajcolubiale

**NOTE:** This document replaces the earlier draft with corrections for:
- Math semantics (signed signals vs probability confusion)
- Driver scoping (rest, goalie, pace/PDO placement)
- Edge unit comparability (score-based vs direct edge comparison)
- Explicit definitions (conflict math, penalties, engine template)

---

## Problem Statement

Currently, drivers are blended globally across all markets (TOTAL, SPREAD, ML), which causes:

- **Driver mismatch** — totals drivers (PDO, pace) shouldn't influence side picks
- **Math confusion** — using [0,1] scores that represent probability vs. directional push
- **No driver contradiction model** — can't express when drivers disagree
- **Unexplainable picks** — "why did it pick the spread over the total?" is unanswerable

---

## Solution: Market Stratification + Cross-Market Orchestration

**Core idea:**
1. **Signed signals** per driver ([-1, +1], not probability-like [0, 1])
2. **Market-local netting** — each market computes independently using only relevant drivers
3. **Conflict measurement** — detect when drivers contradict
4. **Cross-market orchestration** via score (not edge unit comparison)
5. **Explainable rankings** with one pick per game

---

## Level 1: Fixed Math Contract

### DriverSignal (corrected)

```typescript
type DriverSignal = {
  driverKey: string;                             // e.g. "goalie_quality", "welcomeHomeFade"
  weight: number;                                // [0, 1], sums to 1.0 among eligible drivers
  eligible: boolean;                             // Is this driver active for this market/game?
  signal: number;                                // [-1, +1], signed directional push
  contrib: number;                               // signal * weight (contribution to net)
  status: "ok" | "partial" | "missing";
  note?: string;
};
```

**Key change:** `signal` is signed [-1, +1], not a probability [0, 1]. Use `eligible` flag to gate whether driver contributes.

### MarketDecision (corrected)

```typescript
type MarketDecision = {
  // Identity
  market: Market;

  // Best candidate in this market
  best_candidate: {
    side: "OVER" | "UNDER" | "HOME" | "AWAY";
    line?: number;
    price?: number;
  };

  // Signal strength (all dimensionless scalars)
  status: "FIRE" | "WATCH" | "PASS";
  score: number;                                 // Post-penalty scalar, not probability
  net: number;                                   // Pre-penalty signed sum [-1, +1]
  conflict: number;                              // Driver polarization [0, 0.5]
  coverage: number;                              // Data completeness [0, 1]

  // Edge & value (for audit only, not cross-market comparison)
  edge?: number;                                 // Market-specific: points (Spread/Total) or EV% (ML)
  fair_price?: number;                           // For ML: computed fair odds

  // Deep dive
  drivers: DriverSignal[];
  risk_flags: string[];                          // e.g. ["KEY_NUMBER_6.5", "LOW_COVERAGE"]

  // Debug
  reasoning: string;
};
```

### ExpressionChoice (unchanged, now with corrected schema)

```typescript
type ExpressionChoice = {
  chosen_market: Market;
  chosen: MarketDecision;

  rejected: Array<{
    market: Market;
    decision: MarketDecision;
    rejection_reason: string;
  }>;

  why_this_market: string;
  story: {
    chosen_narrative: string;
    alternatives: Record<Market, string>;
  };
};
```

---

## Level 2: Corrected Driver Scoping

### TOTAL Market Drivers

**Used for:** Over/Under line selection

- `goalie_quality` — Save-quality tier delta (directional for totals)
- `empty_net_propensity` — Late-game pull aggressiveness (accelerant, directional)
- `pace` — Pace of play (game speed)
- `powerPlayEnv` — PP/PK scoring environment
- `pdoRegression` — PDO pressure toward mean
- `shotQuality` — xGF% (shot quality)
- `rest` — **lightly weighted** (affects pace + defensive execution, ~0.08 weight)
- **Risk-only:** `totalFragility` — key number sensitivity (signal=0, appears in risk_flags)

**Excluded:**
- Welcome home (side-only driver)
- Matchup style (directional, side-only)

### SPREAD Market Drivers

**Used for:** Home/Away side selection

- `powerRating` — Net power rating (team strength)
- `rest` — Rest advantage (fresher team likely wins)
- `matchupStyle` — Matchup advantage
- `welcomeHomeFade` — Visitor edge (eligible=false unless 2+ game road trip active)
- `recentTrend` — Last 10 games momentum
- **Risk-only:** `spreadFragility` — bad number risk (signal=0)
- **Risk-only:** `pace`, `pdoRegression` — variance/chaos overlay (signal=0, ineligible for direction)

**Excluded:**
- Goalie quality, empty net pulls (irrelevant to margin)

### ML Market Drivers

**Used for:** Moneyline pick (directional only)

- `powerRating` — Team strength → win prob
- `rest` — Affects win prob
- `matchupStyle` — Affects win prob
- `welcomeHomeFade` — Visitor edge (eligible=false unless active)
- `recentTrend` — Momentum
- **Risk-only:** `pace`, `pdoRegression` — variance overlay (signal=0)

**Excluded:**
- Goalie, empty net volume (irrelevant to winner)
- Power play environment (volume, not winners)

---

## Level 3: Conflict Definition (NEW)

**Apply consistently across all markets:**

```typescript
function computeConflict(drivers: DriverSignal[]): number {
  let support = 0;
  let oppose = 0;
  
  for (const d of drivers.filter(d => d.eligible)) {
    if (d.signal > +0.10) support += d.weight;
    if (d.signal < -0.10) oppose += d.weight;
  }
  
  const conflict = Math.min(support, oppose);  // [0, 0.5]
  return conflict;
}
```

**Explanation:**
- Drivers with `signal > +0.10` are "supporting" the candidate
- Drivers with `signal < -0.10` are "opposing" the candidate
- Conflict is the lesser of the two (both sides present = high conflict)
- Example: support=0.60, oppose=0.20 → conflict=0.20 (mostly aligned)
- Example: support=0.50, oppose=0.50 → conflict=0.50 (complete cacophony)

---

## Level 4: Market Engine Template

Apply this structure identically to TOTAL, SPREAD, ML:

```
1) Build candidates for this market
   E.g., for TOTAL: {side: "OVER"}, {side: "UNDER"}
   E.g., for SPREAD: {side: "HOME"}, {side: "AWAY"}

2) For each candidate:

   a) Filter drivers to eligible set (market-scoped only)
   b) Renormalize weights over eligible drivers (sum to 1.0)
   
   c) net = Σ(signal * weight) over eligible
      → net ∈ [-1, +1]
   
   d) Compute conflict = min(support, oppose)
      → conflict ∈ [0, 0.5]
   
   e) Compute penalties (market-specific):
      penalty_fragility + penalty_coverage + penalty_chase + penalty_latency + penalty_risk
      → sum_penalties ∈ [0, 1.0]
   
   f) score = net - sum_penalties
      → score typicallly ∈ [-0.4, +0.6], depends on penalty tuning
   
   g) status assignment:
      - FIRE: score >= t_fire AND conflict <= conflict_cap AND coverage >= min_coverage
      - WATCH: score >= t_watch AND coverage >= min_watch
      - PASS: else

3) Choose best candidate only if |net| >= t_dir
   (if net is too close to zero, can't pick; emit PASS instead)

4) Return MarketDecision with chosen candidate + top pro/contra drivers
```

**Key:**
- `net` is pre-penalty, showing raw driver agreement
- `score` is post-penalty, shows final signal strength
- `|net| >= t_dir` gates the actual pick (prevents neutral fades)

---

## Level 5: Conflict-Driven Penalties

**New rule:** If `conflict > conflict_cap`, cap status to WATCH or PASS:

```
if conflict > conflict_cap:
  max_allowed_status = WATCH  (downgrade from FIRE if conflict too high)
  
if conflict > 0.30:
  max_allowed_status = PASS   (abort if completely divided)
```

This prevents a pick when drivers are in genuine disagreement.

---

## Level 6: Market-Specific Thresholds

### TOTAL Decision Engine

- Eligible drivers: goalie_quality, empty_net_propensity, pace, powerPlayEnv, pdoRegression, shotQuality, rest (lightly weighted)
- Candidates: OVER, UNDER
- t_dir = 0.10
- Penalties:
  - totalFragility (key number 5.5, 6.5): -0.08
  - line moved >1pt from open: -0.05
  - coverage < 60%: -0.05
- t_fire = 0.40, t_watch = 0.20
- conflict_cap = 0.25

### SPREAD Decision Engine

- Eligible drivers: powerRating, rest, matchupStyle, welcomeHomeFade (if active), recentTrend
- Candidates: HOME, AWAY
- t_dir = 0.12
- Penalties:
  - better side on -3.5 or worse: -0.08
  - line moved >1pt: -0.05
  - bad line quality: -0.03
- t_fire = 0.45, t_watch = 0.25
- conflict_cap = 0.20

### ML Decision Engine

- Eligible drivers: powerRating, rest, matchupStyle, welcomeHomeFade (if active), recentTrend
- Candidates: HOME, AWAY
- t_dir = 0.08
- Edge logic: compare model win prob to implied prob from odds
  - If model_prob_ev > 1.5%: edge exists
- Penalties:
  - if in coinflip zone (45%–55% implied) AND edge exists: penalty=0 (value favorable)
  - else if weak edge: -0.05
  - line movement >2%: -0.03
- t_fire = 0.35, t_watch = 0.15
- conflict_cap = 0.20

---

## Level 7: Expression Selector (Corrected)

### Eligibility Gates

```
1. Cannot select a PASS market
2. Cannot select if coverage < min_coverage_for_status
3. Cannot select if DO_NOT_CHASE flag set
→ If all markets fail: return no recommendation
```

### Selection Rules (Deterministic Order)

**Rule 1: Prefer highest status**
```
FIRE > WATCH > PASS

If one market is FIRE and others are WATCH/PASS: pick FIRE.
```

**Rule 2: Among same status, prefer highest score**
```
score_diff = max_score - second_max_score

If score_diff > 0.10: choose higher scorer
Else: apply Rule 3 (market preference tie-break)
```

**Rule 3: Market preference tie-break (within 0.10 score gap)**
```
TOTAL > SPREAD > ML

Only used when status + score are tied.
```

**Rule 4: ML vs Spread value realism (within same status, tight score gap)**
```
IF abs(SPREAD.score - ML.score) <= 0.05
  AND spread number is "bad" (e.g., -3.5 or steeper)
  AND ML odds are in coinflip zone (45%–55% implied) or better (plus)
  AND ML.edge > 0
THEN prefer ML (better value)

ELSE pick higher score
```

**Key:** Never compare edge units directly (points vs %). Use score for cross-market, apply value realism only for ML vs Spread tie-breaker.

---

## Level 8: Welcome Home Fade (Mechanical, Not Override)

Welcome Home Fade is an **injected driver in SPREAD and ML engines only**, not a selector hack:

```
WelcomeHomeFade = {
  driverKey: "welcomeHomeFade",
  weight: 0.10–0.15,
  eligible: if (2+ game road trip return AND data confirms):
            true,
           else:
            false,
  signal: [-0.5, +0.5]  (favors AWAY),
  contrib: signal * weight
}
```

**Behavior:**
- When `eligible=true`: contributes to SPREAD/ML net naturally → improves side scores
- When `eligible=false`: signal=0, cannot distort weights
- Does NOT override selector rules
- Selector picks best score; Welcome Home just influences that score

---

## Level 9: Card Output Schema (Updated)

```typescript
payloadData: {
  // ... existing fields ...

  // NEW: Cross-market decision
  expression_choice: {
    chosen_market: "TOTAL" | "SPREAD" | "ML";
    pick: string;                                // "Over 6.5" / "Home -2.5" / "Away +115"
    status: "FIRE" | "WATCH" | "PASS";
    score: number;                               // Dimensionless scalar, not probability
    net: number;                                 // Pre-penalty for transparency
    edge: number;                                // Market-specific points or EV%
  };

  // NEW: Why this market
  market_narrative: {
    chosen_story: string;                        // "Goalie + rest align on OVER"
    alternatives?: {
      TOTAL?: string;
      SPREAD?: string;
      ML?: string;
    };
    orchestration: string;                       // Rule that fired or tie reason
  };

  // NEW: Full audit trail
  all_markets?: {
    TOTAL?: MarketDecision;
    SPREAD?: MarketDecision;
    ML?: MarketDecision;
  };
};
```

**UI representation:**
- `score` display: "Index: 0.42" (do NOT call it probability)
- `net` display: "Pre-penalty: +0.48" (for transparency)
- `conflict` display: "Driver alignment: strong" (if conflict < 0.15)

---

## Testing Strategy

### Unit Tests: Driver Math

- [ ] `signal ∈ [-1, +1]` for all drivers
- [ ] `weight` sums to 1.0 when eligible drivers renormalized
- [ ] `contrib = signal * weight` exact
- [ ] `net = Σ(contrib)` matches manual sum
- [ ] `conflict = min(support, oppose)` matches manual calculation

### Unit Tests: Driver Scoping

- [ ] TOTAL engine: pace/PDO used (directional), rest allowed (light weight)
- [ ] SPREAD/ML: pace/PDO NOT used directionally (eligible=false)
- [ ] SPREAD/ML: rest used (normal weight)
- [ ] Empty net NEVER in SPREAD/ML drivers
- [ ] Welcome Home NEVER eligible in TOTAL

### Unit Tests: Market Engines

**TOTAL:**
- [ ] FIRE when drivers aligned (conflict < 0.25) + score > 0.40
- [ ] PASS when net < 0.10 (not directional)

**SPREAD:**
- [ ] FIRE when power + rest strong, edge present, score > 0.45
- [ ] PASS when power is weak

**ML:**
- [ ] FIRE when edge > 1.5% AND score > 0.35
- [ ] WATCH in coinflip zone if edge > 0

### Unit Tests: Expression Selector

| Scenario | TOTAL | SPREAD | ML | Expected | Rule |
|----------|-------|--------|-------|----------|------|
| Totals win | FIRE, 0.50 | WATCH, 0.42 | PASS | TOTAL | Rule 1: status |
| Spread wins | PASS | FIRE, 0.45 | WATCH, 0.40 | SPREAD | Rule 1: status |
| ML value | WATCH, 0.38 | WATCH, 0.40 | WATCH, 0.39 | ML | Rule 4: coinflip value |
| Tie break | FIRE, 0.50 | FIRE, 0.50 | WATCH | TOTAL | Rule 3: preference |
| Welcome Home | WATCH, 0.35 | WATCH, 0.38 | WATCH, 0.39 | ML | Welcome Home pushes ML score |

### Integration Tests

- [ ] All 3 markets compute from same odds snapshot → orchestrator picks one consistently
- [ ] Card output includes all 3 MarketDecisions for audit
- [ ] Rejection reasons are deterministic and repeatable
- [ ] Real odds samples (NHL, NBA, NCAAM) produce sensible picks

---

## Success Criteria

✅ **One pick per game** with explainable market choice  
✅ **Signed math** throughout (drivers push directionally, not as probabilities)  
✅ **Conflict detection** (catches when drivers contradict)  
✅ **No leakage** (totals-only drivers never direct sides; pace/PDO are risk-only in sides)  
✅ **Welcome Home mechanical** (a driver, not a hack)  
✅ **Score-based orchestration** (no direct edge comparisons across unit boundaries)  
✅ **Fully testable** (every rule deterministic, no thresholds hidden)  
✅ **Backward compatible** (output shape doesn't break queries)  

---

## Migration Plan

1. **Dual-run (confidence building):**
   - Orchestrator computes all 3 markets + makes choice
   - Cards still generated per-driver (old path)
   - New `expression_choice` field added (optional in schema)
   - Logs compare old picks to new picks

2. **Gradual cutover:**
   - Week 1: Run orchestrator, log, compare
   - Week 2: Enable new cards for NHL only
   - Week 3: Expand to NBA/NCAAM

3. **Full cutover:**
   - One card per market per game (not per-driver)
   - Old logic deleted

---

## References

- Original [CROSS_MARKET_ORCHESTRATION.md](CROSS_MARKET_ORCHESTRATION.md) (pre-correction version)
- [DATA_CONTRACTS.md](DATA_CONTRACTS.md) — driver definitions
- [apps/worker/src/models/index.js](../../apps/worker/src/models/index.js) — current driver code
