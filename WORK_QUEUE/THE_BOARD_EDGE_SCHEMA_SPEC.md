# THE BOARD: Edge Reasoning Schema (Production Spec)

**For:** External Agent implementation of WI-0938-B (Edge Reasoning Layer)  
**Status:** Ready for code generation  
**Integration point:** Decision Publisher + Card Payload

---

## 📋 Context

This schema extends the existing card payload structure with edge reasoning data **without breaking** current routing, watchdog, or decision logic.

All fields are optional (backward compatible). Existing cards continue to work. Cards with `edge_reasoning` populated gain THE BOARD richness.

---

## 🔑 Core Data Model

### `CardPayload.edge_reasoning` (New Top-Level Field)

```typescript
interface EdgeReasoning {
  // 1. MARKET ERROR FRAMING
  market_error: string; // 1-2 sentences: "Vegas anchored to pre-report data"
  
  // 2. EDGE CLASSIFICATION
  edge_types: EdgeTypeClassification[];
  
  // 3. ACTION STATE (THE LOCK)
  action_state: "FIRE" | "WAIT" | "PASS";
  
  // 4. TRIGGER SYSTEM
  triggers: ActionTrigger[];
  
  // 5. QUALITY SCORING
  quality_score: number; // 0-10
  quality_drivers: QualityDriver[];
  
  // 6. PATTERN CONTEXT (optional)
  pattern_context?: PatternReference;
  
  // 7. RISK FACTORS
  risk_factors: RiskFactor[];
}
```

---

## 📐 Detailed Field Specifications

### 1. Market Error Framing

```typescript
market_error: string;

// Examples:
"Vegas anchored to outdated pace assumptions from pre-report data"
"Market hasn't priced in defensive lineup change vs last 5 games"
"Public favorites overbet; sharp books still showing respect"
"Information gap: injury status not yet confirmed in line movement"
```

**Why it matters:**
- Users understand *why* the edge exists (not just that it does)
- Builds trust (specific reason > vague disagreement)
- Enables learning (user recognizes pattern type)

---

### 2. Edge Type Classification

```typescript
interface EdgeTypeClassification {
  edge_type: "STALE_PRICE" | "INFORMATION" | "STRUCTURAL" | "BEHAVIORAL" | "TIMING";
  role: "PRIMARY" | "SECONDARY"; // PRIMARY carries most conviction
  brief_explanation: string; // max 1 sentence
}

// Example output:
{
  edge_types: [
    {
      edge_type: "STALE_PRICE",
      role: "PRIMARY",
      brief_explanation: "Vegas line hasn't moved since pre-report pace data (still uses old assumptions)"
    },
    {
      edge_type: "STRUCTURAL",
      role: "SECONDARY",
      brief_explanation: "Back-to-back game + fatigue in total model (under bias)"
    }
  ]
}
```

**Edge Type Reference:**

| Type | Meaning | Example |
| --- | --- | --- |
| **STALE_PRICE** | Vegas line anchored to outdated info | Line set pre-lineup release |
| **INFORMATION** | Market missing key data point | Injury confirmation TBD |
| **STRUCTURAL** | Model detects role/pace/game state mismatch | Back-to-back fatigue effect |
| **BEHAVIORAL** | Fade-the-Public or narrative bias | Heavy favorites overpriced |
| **TIMING** | Pre-live vs live, early mover advantage | Line moves sharply at tip-off |

---

### 3. Action State (The Decision Lock)

```typescript
action_state: "FIRE" | "WAIT" | "PASS";

// FIRE: All conditions met, user should bet NOW
// WAIT: Strong edge, but waiting for confirmation (see triggers)
// PASS: Edge exists but not actionable due to unknown variables
```

**Rules:**
- Every opportunity MUST have exactly one action_state
- No ambiguity = no overthinking by user
- State only changes when triggers are resolved

---

### 4. Trigger System (Unlock Conditions)

```typescript
interface ActionTrigger {
  trigger_type: "CONDITION_MET" | "CONDITION_REQUIRED" | "BLOCKER";
  state_applies_to: "FIRE" | "WAIT" | "PASS";
  description: string; // User-facing
  threshold?: string; // e.g., "line ≤ 216" or "confirmed"
  data_dependency?: string; // e.g., "goalie_status" or "lineup_confirmation"
  estimated_resolution_time?: string; // "6:30 PM ET"
}

// Example: WAIT scenario
{
  action_state: "WAIT",
  triggers: [
    {
      trigger_type: "CONDITION_REQUIRED",
      state_applies_to: "FIRE",
      description: "Both starting goalies must be confirmed",
      data_dependency: "confirmed_goalie_matchup",
      estimated_resolution_time: "6:15 PM ET"
    },
    {
      trigger_type: "CONDITION_MET",
      state_applies_to: "FIRE",
      description: "Line must remain ≤ 6.0",
      threshold: "line ≤ 6.0"
    },
    {
      trigger_type: "BLOCKER",
      state_applies_to: "PASS",
      description: "If backup starter confirmed → edge breaks",
      data_dependency: "confirmed_backup_starter"
    }
  ]
}
```

**Trigger Types:**

| Type | Meaning | Action |
| --- | --- | --- |
| **CONDITION_MET** | User already has this info | Evaluate immediately |
| **CONDITION_REQUIRED** | Need data point to unlock | Wait for confirmation |
| **BLOCKER** | This would kill the edge | Recalculate if triggered |

---

### 5. Edge Quality Score (Deterministic)

```typescript
interface QualityScore {
  quality_score: number; // 0-10
  quality_drivers: QualityDriver[];
}

interface QualityDriver {
  factor: string; // e.g., "Multi-source edge"
  direction: "POSITIVE" | "NEGATIVE";
  weight: number; // 0-3 (contribution to score)
  explanation: string; // "Both price + structural drivers present"
}

// Example scoring breakdown:
{
  quality_score: 8.2,
  quality_drivers: [
    {
      factor: "Multi-source edge",
      direction: "POSITIVE",
      weight: 3,
      explanation: "Stale price + structural = independent confirmation"
    },
    {
      factor: "Confirmed lineup data",
      direction: "POSITIVE",
      weight: 2,
      explanation: "No key uncertainty in primary driver"
    },
    {
      factor: "Historical pattern success",
      direction: "POSITIVE",
      weight: 2,
      explanation: "Back-to-back unders: 66% hit rate, +8.4% ROI"
    },
    {
      factor: "Goalie status TBD",
      direction: "NEGATIVE",
      weight: -1,
      explanation: "Pace model assumption breaks if backup confirmed"
    },
    {
      factor: "Line already moved",
      direction: "NEGATIVE",
      weight: -1,
      explanation: "Sharp books catching up; chase risk present"
    }
  ]
}

// Score formula (suggested):
// base = 5.0
// sum(positive weights) + sum(negative weights) 
// clamped to 0-10
```

**Quality Score Interpretation:**
- 9-10: Rare, multi-source, historically proven, minimal unknowns
- 7-8: Good (primary use case), stable inputs
- 5-6: Moderate (wait for confirmation or higher conviction)
- 3-4: Weak (likely PASS candidates)
- 0-2: Blocked/suppressed (edge quality too fragile)

---

### 6. Pattern Context (Optional but Valuable)

```typescript
interface PatternReference {
  pattern_name: string;
  // e.g., "Back-to-back unders w/ stale pace data"
  
  historical_record: {
    wins: number;
    total: number;
    win_rate: number; // 0-1
  };
  
  roi: number; // positive/negative return
  trend: "IMPROVING" | "STABLE" | "DETERIORATING";
  lookback_period: string; // "last 90 days" or "2024-25 season"
}

// Example:
{
  pattern_context: {
    pattern_name: "Back-to-back unders w/ stale pace",
    historical_record: {
      wins: 58,
      total: 87,
      win_rate: 0.667
    },
    roi: 0.084,
    trend: "IMPROVING",
    lookback_period: "2024-25 season"
  }
}
```

**Why:**
- Users see historical validation of this specific edge type
- Builds confidence in action
- Enables pattern learning (what types work vs don't)

---

### 7. Risk Factors

```typescript
interface RiskFactor {
  factor_name: string;
  severity: "LOW" | "MODERATE" | "HIGH";
  description: string;
  impact_on_edge: string; // how this breaks/changes the edge
}

// Example:
{
  risk_factors: [
    {
      factor_name: "Goalie confirmation pending",
      severity: "HIGH",
      description: "Backup starter changes pace model assumptions",
      impact_on_edge: "Edge reverses if backup starts (pace ↑)"
    },
    {
      factor_name: "Line already moved",
      severity: "MODERATE",
      description: "Sharp books catching up; chase risk if you wait",
      impact_on_edge: "ROI degrades if line moves beyond ½"
    },
    {
      factor_name: "High volatility environment",
      severity: "LOW",
      description: "Normal playoff behavior; doesn't break model",
      impact_on_edge: "Confidence decreases slightly due to variance"
    }
  ]
}
```

---

## 🔄 Integration Points (No Breaking Changes)

### 1. Decision Publisher Output

**Current flow:**
```
Model Runner → Router → Watchdog → Decision Publisher → Discord/Web
```

**New layer (inserted cleanly):**
```
Model Runner → Router → Watchdog → [EdgeReasoning enricher] → Decision Publisher → Discord/Web
```

**What needs to happen:**
- After watchdog validates edge (but before publishing)
- EdgeReasoning enricher populates `edge_reasoning` fields
- Falls back to NULL if data unavailable (backward compatible)

---

### 2. Web UI Rendering

**Opportunities Tab reads:**
```typescript
// Pull from card payload:
card.edge_reasoning.market_error
card.edge_reasoning.edge_types[]
card.edge_reasoning.action_state
card.edge_reasoning.triggers[]
card.edge_reasoning.quality_score
card.edge_reasoning.quality_drivers[]
card.edge_reasoning.risk_factors[]
card.edge_reasoning.pattern_context (optional)
```

**Blocked Edges Tab reads:**
```typescript
// Same payload structure, but filtered by:
card.action_state === "PASS" 
&& card.edge_reasoning.quality_score >= 5.0  // not noise
&& card.edge_reasoning.triggers.length > 0   // has unlock conditions
```

---

### 3. Edge Type Tracker Aggregation

```typescript
// Poll published cards, group by:
GROUP BY edge_types[0].edge_type
COUNT wins/losses by tracking settlement
CALCULATE ROI = (wins * avg_edge) - (losses * avg_loss)
TREND = last_30_days vs prior_60_days
```

---

## 🛠️ Implementation Checklist

### Phase 1: Schema Integration

- [ ] Add `edge_reasoning` field to CardPayload interface
- [ ] Create EdgeReasoning type definitions
- [ ] Update decision-publisher.js to accept edge_reasoning data
- [ ] Ensure backward compatibility (null/optional)
- [ ] Unit test: card with edge_reasoning parses correctly

### Phase 2: Enricher Function

- [ ] Create `computeEdgeReasoning(card, modelOutputs)` function
- [ ] Implement market error framing (inputs: model vs market prices)
- [ ] Implement edge type classification (based on decision drivers)
- [ ] Implement quality scoring (deterministic formula)
- [ ] Implement action state logic (FIRE/WAIT/PASS rules)
- [ ] Implement trigger system (unlock conditions)
- [ ] Unit test: each edge type gets correct classification

### Phase 3: API/Web Integration

- [ ] Add `/api/board/opportunities` endpoint (returns cards with edge_reasoning)
- [ ] Add `/api/board/blocked-edges` endpoint (filters PASS cards + triggers)
- [ ] Add `/api/board/edge-types` endpoint (aggregates pattern tracker)
- [ ] Web UI: Opportunities Card component renders edge_reasoning
- [ ] Web UI: Blocked Edges component renders triggers
- [ ] Web UI: Edge Type Tracker shows historical performance

### Phase 4: Discord Output

- [ ] Update Discord formatter to include market error + action state
- [ ] Format trigger conditions readably for Discord
- [ ] Link to THE BOARD web URL for full details

---

## 📊 Example Payload (Complete)

```javascript
{
  id: "card_12345",
  sport: "NHL",
  game: "BOS @ NYR",
  market: "Total",
  line: 6.0,
  
  // NEW: EDGE REASONING
  edge_reasoning: {
    market_error: "Vegas anchored to outdated pace assumptions from pre-report lineup data",
    
    edge_types: [
      {
        edge_type: "STALE_PRICE",
        role: "PRIMARY",
        brief_explanation: "Line set pre-lineup; market hasn't priced in confirmed high-pace roster"
      },
      {
        edge_type: "STRUCTURAL",
        role: "SECONDARY",
        brief_explanation: "Back-to-back game + fatigue; total model predicts slower pace"
      }
    ],
    
    action_state: "WAIT",
    
    triggers: [
      {
        trigger_type: "CONDITION_REQUIRED",
        state_applies_to: "FIRE",
        description: "Both starting goalies must be confirmed",
        data_dependency: "confirmed_goalie_matchup",
        estimated_resolution_time: "6:15 PM ET"
      },
      {
        trigger_type: "CONDITION_MET",
        state_applies_to: "FIRE",
        description: "Line must hold ≤ 6.0",
        threshold: "line ≤ 6.0"
      },
      {
        trigger_type: "BLOCKER",
        state_applies_to: "PASS",
        description: "If backup starter confirmed → edge breaks (pace model assumption invalid)",
        data_dependency: "confirmed_backup_starter"
      }
    ],
    
    quality_score: 8.2,
    quality_drivers: [
      {
        factor: "Multi-source edge",
        direction: "POSITIVE",
        weight: 3,
        explanation: "Both stale price + structural drivers present"
      },
      {
        factor: "Confirmed lineup data",
        direction: "POSITIVE",
        weight: 2,
        explanation: "Primary driver inputs fully validated"
      },
      {
        factor: "Historical pattern success",
        direction: "POSITIVE",
        weight: 2,
        explanation: "Back-to-back unders: 58 wins, 87 total (66% | +8.4% ROI)"
      },
      {
        factor: "Goalie confirmation pending",
        direction: "NEGATIVE",
        weight: -1,
        explanation: "Backup starter changes pace model"
      },
      {
        factor: "Line already moved 6.5 → 6.0",
        direction: "NEGATIVE",
        weight: -1,
        explanation: "Sharp books catching up; chase risk"
      }
    ],
    
    risk_factors: [
      {
        factor_name: "Goalie status TBD",
        severity: "HIGH",
        description: "Backup starter would invalidate pace model",
        impact_on_edge: "Edge reverses if backup starts"
      },
      {
        factor_name: "Line already moved",
        severity: "MODERATE",
        description: "Sharp books catching up in real-time",
        impact_on_edge: "ROI degrades each tick the line moves"
      }
    ],
    
    pattern_context: {
      pattern_name: "Back-to-back unders w/ stale pace",
      historical_record: {
        wins: 58,
        total: 87,
        win_rate: 0.667
      },
      roi: 0.084,
      trend: "IMPROVING",
      lookback_period: "2024-25 season"
    }
  }
}
```

---

## 🚨 Non-Negotiable Rules

1. **Edge Quality Score must be deterministic and explainable**
   - Not: "I fed it through a neural net"
   - Yes: "3pt for multi-source + 2pt for confirmed inputs - 1pt for unknowns = 8.2"

2. **Triggers must be actionable (not vague)**
   - Not: "Wait for clarity"
   - Yes: "FIRE if goalie confirmed + line ≤ 6.0"

3. **Action State has no third option**
   - FIRE | WAIT | PASS, only
   - User should never read a card and think "so... what?"

4. **Pattern Context is historical only**
   - Back-test data only, never forward-looking projection
   - Explicitly state lookback period

5. **Blocked Edges tab builds trust**
   - Show edges where quality_score > 5.0 but action_state = PASS
   - These are your "we're not gambling" proof points

---

## 📝 Notes for Agent

This schema is:
- ✅ Backward compatible (all fields optional)
- ✅ Non-breaking (inserted between watchdog + publisher)
- ✅ User-facing (feeds directly to web + Discord)
- ✅ Retention-driving (pattern learning + trust)
- ✅ Testable (deterministic formulas)

It does NOT require:
- ✅ Changes to model runners
- ✅ Changes to routing logic
- ✅ Changes to watchdog validation
- ✅ Changes to settlement/grading

It DOES require:
- ✅ New enricher function (computeEdgeReasoning)
- ✅ API endpoints for board tabs
- ✅ Web UI components
- ✅ Discord formatter updates
