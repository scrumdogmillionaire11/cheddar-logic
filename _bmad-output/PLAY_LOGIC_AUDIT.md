# Play Logic Audit — Full System Documentation

## Overview

The **Play** object represents a **canonical decision point** for a game — a single betting recommendation with market type, side, odds, status, and reasoning. It aggregates drivers into one authoritative pick.

---

## 1. PLAY TYPE DEFINITION

### File: [web/src/lib/types/game-card.ts](web/src/lib/types/game-card.ts#L173-L221)

```typescript
export interface Play {
  // CANONICAL FIELDS (preferred if present):
  market_type?: CanonicalMarketType;  // MONEYLINE, SPREAD, TOTAL, PUCKLINE, TEAM_TOTAL, PROP, INFO
  selection?: Selection;               // { side: 'HOME'|'AWAY'|'OVER'|'UNDER'|'FAV'|'DOG', team?: string }
  reason_codes?: (PassReasonCode | string)[];  // Deterministic blockers
  tags?: (RiskTag | string)[];        // Risk flags, inference markers
  kind?: 'PLAY' | 'EVIDENCE';         // Type indicator
  evidence_count?: number;            // Linked evidence count
  consistency?: {
    total_bias?: 'OK' | 'INSUFFICIENT_DATA' | 'CONFLICTING_SIGNALS' | 'VOLATILE_ENV' | 'UNKNOWN';
  };
  
  // LEGACY FIELDS (for backward compatibility):
  status: ExpressionStatus;           // FIRE | WATCH | PASS
  market: Market | 'NONE';            // TOTAL | SPREAD | ML | NONE
  pick: string;                       // "TeamName ML +110" or "NO PLAY"
  lean: string;                       // Team name or direction lean
  side: Direction | null;             // HOME | AWAY | OVER | UNDER | NEUTRAL
  
  // DECISION MECHANICS:
  truthStatus: TruthStatus;           // STRONG | MEDIUM | WEAK (driver consensus)
  truthStrength: number;              // 0.5..0.8 (consensus strength)
  conflict: number;                   // 0..1 (opposing driver ratio)
  modelProb?: number;                 // 0..1 (edge model probability)
  impliedProb?: number;               // 0..1 (from American odds)
  edge?: number;                      // ModelProb - ImpliedProb (positive = value)
  valueStatus: ValueStatus;           // GOOD | OK | BAD (edge quality)
  betAction: BetAction;               // BET | NO_PLAY
  
  // PRICE/LINE DATA:
  line?: number;                      // Spread or total line
  price?: number;                     // American odds (ML)
  priceFlags: PriceFlag[];            // PRICE_TOO_STEEP | COINFLIP | CHASED_LINE | VIG_HEAVY
  
  // METADATA:
  updatedAt: string;                  // ISO timestamp (odds capturedAt or created_at)
  whyCode: string;                    // Reason code for UI (e.g., 'KEY_NUMBER_FRAGILITY_TOTAL')
  whyText: string;                    // Human-readable why explanation
}
```

### Related Types:

**CanonicalMarketType:**
```typescript
'MONEYLINE' | 'SPREAD' | 'TOTAL' | 'PUCKLINE' | 'TEAM_TOTAL' | 'PROP' | 'INFO'
```

**Market (Legacy):**
```typescript
'TOTAL' | 'SPREAD' | 'ML' | 'RISK' | 'UNKNOWN'
```

**PassReasonCode:**
```typescript
'PASS_MISSING_KIND'
'PASS_MISSING_MARKET_TYPE'
'PASS_MISSING_EDGE'
'PASS_MISSING_LINE'
'PASS_MISSING_SELECTION'
'PASS_MISSING_PRICE'
'PASS_NO_MARKET_PRICE'
'PASS_TOTAL_INSUFFICIENT_DATA'
'PASS_NO_QUALIFIED_PLAYS'
'KEY_NUMBER_FRAGILITY_TOTAL'
'EDGE_FOUND_TOTAL'
'EDGE_FOUND_SIDE'
'PRICE_TOO_STEEP'
'MISSING_PRICE_EDGE'
'NO_VALUE_AT_PRICE'
'INSUFFICIENT_DATA'
// ... and others
```

**Selection:**
```typescript
interface Selection {
  side: 'OVER' | 'UNDER' | 'HOME' | 'AWAY' | 'FAV' | 'DOG' | 'NONE';
  team?: string;
}
```

---

## 2. DATA FLOW — PLAY CONSTRUCTION

### File: [web/src/lib/game-card/transform.ts](web/src/lib/game-card/transform.ts#L436-L660)

### **Entry Point: `buildPlay(game: GameData, drivers: DriverRow[]) → Play`**

#### Step 1: Extract and Categorize Source Plays
```typescript
const playCandidates = game.plays.filter(isPlayItem);          // kind === 'PLAY'
const evidenceCandidates = game.plays.filter(isEvidenceItem);  // kind === 'EVIDENCE'
const inferredPlays = playCandidates.map(play => ({
  sourcePlay: play,
  inference: inferMarketFromPlay(play)  // Infer market_type from available fields
}));
```

#### Step 2: Pick Truth Driver (Primary Decision Driver)
```typescript
const truthDriver = pickTruthDriver(drivers);
// Returns first non-NEUTRAL driver (filtered from risk-only drivers)

if (!truthDriver) {
  return {
    status: 'PASS',
    market: 'NONE',
    pick: 'NO PLAY',
    reason_codes: ['PASS_NO_QUALIFIED_PLAYS'],
    // ... minimal play
  };
}
```

#### Step 3: Calculate Driver Consensus Metrics
```typescript
const truthDirection = truthDriver.direction;                           // HOME | AWAY | OVER | UNDER
const oppositeDirection = OPPOSITE_DIRECTION[truthDirection];
const supportScore = directionScore(drivers, truthDirection);          // Sum of TIER_SCORE for drivers in direction
const opposeScore = directionScore(drivers, oppositeDirection);        // Sum for opposing direction
const totalScore = supportScore + opposeScore;
const net = (supportScore - opposeScore) / totalScore;                 // -1..1 balance
const conflict = opposeScore / totalScore;                             // 0..1 opposition ratio
const truthStrength = clamp(0.5 + net * 0.3, 0.5, 0.8);               // 0.5 weak to 0.8 strong
const truthStatus = truthStatusFromStrength(truthStrength);            // WEAK | MEDIUM | STRONG
```

#### Step 4: Select Market Based on Truth Direction + Available Odds
```typescript
const market = selectExpressionMarket(truthDirection, truthStatus, truthDriver, game.odds);
// Logic:
// - If OVER/UNDER and have total odds → TOTAL
// - If HOME/AWAY with spread hint and has spread odds → SPREAD
// - If HOME/AWAY and has ML odds → ML
// - Otherwise → NONE
```

#### Step 5: Build Pick String and Extract Odds
```typescript
let pick = 'NO PLAY';
let price: number | undefined;
let line: number | undefined;

if (market === 'ML') {
  price = game.odds?.[direction === 'HOME' ? 'h2hHome' : 'h2hAway'];
  pick = price ? `${teamName} ML ${priceStr}` : `${teamName} ML (Price N/A)`;
}
else if (market === 'SPREAD') {
  line = game.odds?.[direction === 'HOME' ? 'spreadHome' : 'spreadAway'];
  pick = line !== undefined ? `${teamName} ${lineStr}` : `${teamName} Spread (Line N/A)`;
}
else if (market === 'TOTAL') {
  line = game.odds?.total;
  pick = line !== undefined ? `${direction === 'OVER' ? 'Over' : 'Under'} ${line}` : `${direction} (Line N/A)`;
}
```

#### Step 6: Calculate Edge and Value Status
```typescript
const impliedProb = market === 'ML' ? americanToImpliedProbability(price) : undefined;
const modelProb = clamp(0.5 + (truthStrength - 0.5) * 0.9 - conflict * 0.12, 0.5, 0.78);
const edge = impliedProb !== undefined ? modelProb - impliedProb : undefined;
const valueStatus = getValueStatus(edge);
  // GOOD if edge >= 0.04
  // OK if edge >= 0.015
  // BAD otherwise
```

#### Step 7: Determine Bet Action (Decision)
```typescript
let betAction: 'BET' | 'NO_PLAY' = 'NO_PLAY';

// Check edge threshold (adjusted for weak consensus, conflict, steep favorites)
let edgeThreshold = 0.02;
if (truthStatus === 'WEAK') edgeThreshold += 0.015;      // Need 3.5% edge
if (conflict >= 0.35) edgeThreshold += 0.01;             // Need 3% edge
if (needsSteepFavoritePremium) edgeThreshold += 0.02;    // Need 4% edge for -240+

if (market !== 'NONE' && edge !== undefined && edge >= edgeThreshold) {
  betAction = 'BET';
}

// Price too steep penalty
if (priceFlags.includes('PRICE_TOO_STEEP') && (edge === undefined || edge < 0.06)) {
  betAction = 'NO_PLAY';
}

// No edge = no bet
if (edge === undefined) {
  betAction = 'NO_PLAY';
}
```

#### Step 8: Derive Play Status (FIRE, WATCH, PASS)
```typescript
const status = deriveBetStatus(betAction, truthStatus, valueStatus);

function deriveBetStatus(betAction, truthStatus, valueStatus) {
  if (betAction === 'NO_PLAY') return 'PASS';
  if (truthStatus === 'STRONG' && valueStatus === 'GOOD') return 'FIRE';
  return 'WATCH';
}
```

#### Step 9: Build Reason Codes and Tags
```typescript
const reasonCodes: string[] = [...sourceInference.reasonCodes];

// Add blockers for missing data
if (!sourcePlay?.kind) reasonCodes.push('PASS_MISSING_KIND');
if (!sourceInference.canonical) reasonCodes.push('PASS_MISSING_MARKET_TYPE');
if (sourceInference.canonical === 'TOTAL' && line === undefined) reasonCodes.push('PASS_MISSING_LINE');
if ((sourceInference.canonical === 'SPREAD' || 'MONEYLINE') && direction === 'NEUTRAL') {
  reasonCodes.push('PASS_MISSING_SELECTION');
}
if (price === undefined && isDecidableMarket) {
  reasonCodes.push('PASS_NO_MARKET_PRICE');
}
if (edge === undefined) reasonCodes.push('PASS_MISSING_EDGE');

// Add risk tags
const riskTags = getRiskTagsFromText(sourcePlay.cardTitle, sourcePlay.reasoning, ...);
const tags = [...new Set([...(sourceInference.tags ?? []), ...riskTags])];

// Check total consistency
const totalBias = game.consistency?.total_bias ?? 'UNKNOWN';
if (resolvedMarketType === 'TOTAL' && totalBias !== 'OK') {
  reasonCodes.push('PASS_TOTAL_INSUFFICIENT_DATA');
  tags.push('CONSISTENCY_BLOCK_TOTALS');
}
```

#### Step 10: Validate Market Invariants
```typescript
const hasTotalInvariantViolation = 
  resolvedMarketType === 'TOTAL' && 
  !((direction === 'OVER' || direction === 'UNDER') && typeof line === 'number');

const hasSpreadInvariantViolation = 
  resolvedMarketType === 'SPREAD' && 
  !((direction === 'HOME' || direction === 'AWAY') && typeof line === 'number');

const hasMoneylineInvariantViolation = 
  resolvedMarketType === 'MONEYLINE' && 
  !((direction === 'HOME' || direction === 'AWAY'));

if (hasTotalInvariantViolation || hasSpreadInvariantViolation || hasMoneylineInvariantViolation) {
  pick = 'NO PLAY';
  status = 'PASS';
  // Add specific reason codes
}
```

#### Step 11: Return final Play object
All fields fully populated.

---

## 3. HELPER FUNCTIONS FOR PLAY CONSTRUCTION

### File: [web/src/lib/game-card/transform.ts](web/src/lib/game-card/transform.ts)

### **Market Inference: `inferMarketFromPlay(play: ApiPlay) → { market, canonical, reasonCodes, tags }`**

```typescript
// Lines 147-214
function inferMarketFromPlay(play: ApiPlay) {
  const reasonCodes = [...(play.reason_codes ?? [])];
  const tags = [...(play.tags ?? [])];

  // If not a PLAY, return INFO
  if (!isPlayItem(play)) {
    return { market: 'UNKNOWN', canonical: 'INFO', reasonCodes, tags };
  }

  // 1. Use explicit market_type if present
  if (play.market_type) {
    return {
      market: mapCanonicalToLegacyMarket(play.market_type),
      canonical: play.market_type,
      reasonCodes,
      tags,
    };
  }

  // 2. Infer from secondary sources (selection, recommendation, etc.)
  const secondary = inferCanonicalFromSecondary(play);  // Looks at play.selection, play.recommendation
  if (secondary) {
    return {
      market: mapCanonicalToLegacyMarket(secondary),
      canonical: secondary,
      reasonCodes,
      tags,
    };
  }

  // 3. Infer from selection + odds availability
  const side = play.selection?.side || play.prediction;
  if ((side === 'OVER' || side === 'UNDER') && typeof play.line === 'number') {
    return { market: 'TOTAL', canonical: 'TOTAL', reasonCodes, tags };
  }
  if ((side === 'HOME' || side === 'AWAY') && typeof play.line === 'number') {
    return { market: 'SPREAD', canonical: 'SPREAD', reasonCodes, tags };
  }
  if ((side === 'HOME' || side === 'AWAY') && typeof play.price === 'number') {
    return { market: 'ML', canonical: 'MONEYLINE', reasonCodes, tags };
  }

  // 4. Fallback: inference from cardTitle
  const fallbackMarket = inferMarketFromCardTitle(play.cardTitle);
  reasonCodes.push('LEGACY_TITLE_INFERENCE_USED');
  return {
    market: fallbackMarket,
    canonical: fallbackMarket === 'TOTAL' ? 'TOTAL' : fallbackMarket === 'SPREAD' ? 'SPREAD' : 'MONEYLINE',
    reasonCodes,
    tags,
  };
}
```

### **Title Inference: `inferMarketFromCardTitle(title: string) → Market`**

```typescript
// Lines 108-137
function inferMarketFromCardTitle(cardTitle: string): Market {
  const lower = cardTitle.toLowerCase();
  
  if (lower.match(/total|o\/u|over|under|point/)) return 'TOTAL';
  if (lower.match(/spread|line|ats|point spread/)) return 'SPREAD';
  if (lower.match(/moneyline|ml|h2h|head to head|winner/)) return 'ML';
  if (lower.match(/risk|fragility|blowout|key number/)) return 'RISK';
  
  return 'UNKNOWN';
}
```

### **Canonical-to-Legacy Mapping:**

```typescript
function mapCanonicalToLegacyMarket(canonical?: CanonicalMarketType): Market | 'NONE' {
  if (!canonical) return 'NONE';
  if (canonical === 'TOTAL' || canonical === 'TEAM_TOTAL') return 'TOTAL';
  if (canonical === 'SPREAD' || canonical === 'PUCKLINE') return 'SPREAD';
  if (canonical === 'MONEYLINE') return 'ML';
  return 'UNKNOWN';
}
```

### **Direction Scoring: `directionScore(drivers, direction) → number`**

```typescript
// Sums TIER_SCORE for drivers in that direction
const TIER_SCORE = { BEST: 1, SUPER: 0.72, WATCH: 0.52 };

function directionScore(drivers, direction) {
  return drivers
    .filter(d => d.direction === direction)
    .reduce((sum, d) => sum + (TIER_SCORE[d.tier] || 0), 0);
}
```

### **Truth Status Derivation:**

```typescript
function truthStatusFromStrength(strength: number): TruthStatus {
  if (strength >= 0.7) return 'STRONG';
  if (strength >= 0.6) return 'MEDIUM';
  return 'WEAK';
}
```

### **Value Status:**

```typescript
function getValueStatus(edge?: number): ValueStatus {
  if (edge === undefined) return 'BAD';
  if (edge >= 0.04) return 'GOOD';      // 4% edge
  if (edge >= 0.015) return 'OK';       // 1.5% edge
  return 'BAD';
}
```

### **Price Flags:**

```typescript
function getPriceFlags(direction: Direction | null, price?: number): PriceFlag[] {
  if (direction !== 'HOME' && direction !== 'AWAY') return [];
  if (price === undefined) return ['VIG_HEAVY'];
  
  const flags = new Set<PriceFlag>();
  if (Math.abs(price) <= 120) flags.add('COINFLIP');        // Within 120 of even
  if (price <= -240) flags.add('PRICE_TOO_STEEP');          // Heavy favorite
  return Array.from(flags);
}
```

---

## 4. PLAY FILTERING (When displaying on cards page)

### File: [web/src/lib/game-card/filters.ts](web/src/lib/game-card/filters.ts)

### **Market Availability Filter:**

```typescript
function filterByMarketAvailability(card: GameCard, filters: GameFilters): boolean {
  if (filters.markets.length === 0) return true;

  const includePass = filters.statuses.includes('PASS');
  
  // LENIENT MODE: Allow PASS plays through regardless of market
  if (includePass && card.play?.status === 'PASS') {
    return true;
  }

  // Check canonical market_type
  const canonicalMarket = canonicalToLegacyMarket(card.play?.market_type);
  if (canonicalMarket && filters.markets.includes(canonicalMarket)) {
    return true;
  }

  // Fallback to legacy play.market
  const playMarket = card.play?.market;
  if (playMarket && playMarket !== 'NONE' && filters.markets.includes(playMarket)) {
    return true;
  }

  // Check drivers
  return card.drivers.some(d => filters.markets.includes(d.market));
}
```

### **Actionability Filter (Lenient for Full Slate):**

```typescript
function filterByActionability(card: GameCard, filters: GameFilters): boolean {
  if (filters.statuses.length === 0) return true;

  const includePass = filters.statuses.includes('PASS');
  
  // LENIENT MODE: Include any game with a play OR drivers
  if (includePass) {
    const hasPlay = card.play !== undefined;
    const hasBlockedTotals = Boolean(
      card.play?.market_type === 'TOTAL' &&
      card.play?.status === 'PASS' &&
      (card.play?.reason_codes?.includes('PASS_TOTAL_INSUFFICIENT_DATA') ||
        card.play?.tags?.includes('CONSISTENCY_BLOCK_TOTALS'))
    );
    const hasDrivers = card.drivers.length > 0;
    
    if (hasPlay || hasBlockedTotals || hasDrivers) {
      return true;
    }
  }
  
  // STANDARD MODE: Exact status match
  let status = card.play?.status || card.expressionChoice?.status || 'PASS';
  return filters.statuses.includes(status);
}
```

---

## 5. PLAY DISPLAY & DECISION MODEL (For UI)

### File: [web/src/lib/game-card/decision.ts](web/src/lib/game-card/decision.ts)

### **Decision Model Construction:**

```typescript
export function getCardDecisionModel(card: GameCard, odds: Odds | null): DecisionModel {
  // 1. Deduplicate drivers
  const baseDrivers = Array.isArray(card.drivers) ? card.drivers : [];
  const drivers = deduplicateDrivers(baseDrivers);
  
  // 2. Select primary play (expression choice > play > drivers)
  const primaryPlay = selectPrimaryPlay(card, odds, drivers);
  
  // 3. Derive status and risk codes
  const status = primaryPlay.status;
  const riskCodes = deriveRiskCodes(card, drivers, primaryPlay.market);
  
  // 4. Generate why explanation
  const whyReason = getWhyReason(status, riskCodes, primaryPlay.market, drivers);
  
  // 5. Pick top 3 contributors (pro/contra)
  const topContributors = pickTopContributors(drivers, primaryPlay);

  return {
    status,
    primaryPlay,
    whyReason,
    riskCodes,
    topContributors,
    allDrivers: drivers,
  };
}
```

### **Primary Play Selection Priority:**

```typescript
function selectPrimaryPlay(card, odds, drivers): DecisionModel['primaryPlay'] {
  // 1. Expression choice (orchestrated decision)
  if (card.expressionChoice?.pick) {
    return {
      source: 'expressionChoice',
      market: card.expressionChoice.chosenMarket,
      status: card.expressionChoice.status,
      pick: card.expressionChoice.pick,
      direction: null,
      tier: null,
      confidence: null,
    };
  }

  // 2. Pre-built play (buildPlay output)
  if (card.play) {
    return {
      source: 'play',
      market: card.play.market,
      status: card.play.status,
      pick: card.play.pick,
      direction: card.play.side,
      tier: null,
      confidence: null,
    };
  }

  // 3. Derive from drivers (market-first logic)
  const { market, driver } = determineBestMarket(drivers, odds);
  if (market === 'NONE' || !driver) {
    return { source: 'none', market: 'NONE', status: 'PASS', pick: 'NO PLAY', ... };
  }

  const status = deriveStatus(card, drivers, market);
  const { pick } = buildPickString(market, driver.direction, ...);
  
  return {
    source: 'drivers',
    market,
    status,
    pick,
    direction: driver.direction,
    tier: driver.tier,
    confidence: driver.confidence ?? null,
  };
}
```

---

## 6. KEY DECISION LOGIC RULES

### **Edge Threshold (When to BET):**
- **Base threshold:** 2.0% edge
- **+1.5%** if truthStatus === 'WEAK' (need 3.5% edge)
- **+1.0%** if conflict >= 0.35 (opposing drivers, need 3% edge)
- **+2.0%** if price <= -240 (steep favorite, need 4% edge)

### **Status Rules:**
- `FIRE` = BET, STRONG consensus, GOOD value
- `WATCH` = BET, MEDIUM/WEAK consensus or OK value
- `PASS` = NO_PLAY, insufficient edge/value, or missing data

### **Total Bias Blocking:**
- If `market_type === 'TOTAL'` AND `totalBias !== 'OK'`:
  - Status forced to PASS
  - Reason: `PASS_TOTAL_INSUFFICIENT_DATA`
  - Tag: `CONSISTENCY_BLOCK_TOTALS`
  - These are votable items but not actionable

### **Market Selection (from truth driver):**
- **OVER/UNDER** → TOTAL *(if odds.total exists)*
- **HOME/AWAY** with spread hint → SPREAD *(if spread odds exist, and not WEAK)*
- **HOME/AWAY** with heavy ML (-240+) → SPREAD *(if has STRONG and spread odds)*
- **HOME/AWAY** → ML *(if ML odds exist)*
- Otherwise → NONE

---

## 7. API EMISSION & DATA PERSISTENCE

### File: [web/src/app/api/games/route.ts](web/src/app/api/games/route.ts#L66-L105)

The Play object is emitted from `/api/games` endpoint. Key fields validated:

```typescript
interface Play {
  cardType: string;
  cardTitle: string;
  prediction: 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NEUTRAL';
  confidence: number;
  tier: 'SUPER' | 'BEST' | 'WATCH' | null;
  reasoning: string;
  evPassed: boolean;
  driverKey: string;
  
  // Canonical fields  
  projectedTotal: number | null;
  edge: number | null;
  status?: 'FIRE' | 'WATCH' | 'PASS';
  kind?: 'PLAY' | 'EVIDENCE';
  market_type?: CanonicalMarketType;
  selection?: { side: string; team?: string };
  line?: number;
  price?: number;
  reason_codes?: string[];
  tags?: string[];
  consistency?: {
    total_bias?: 'OK' | 'INSUFFICIENT_DATA' | 'CONFLICTING_SIGNALS' | 'VOLATILE_ENV' | 'UNKNOWN';
  };
  repair_applied?: boolean;
  repair_rule_id?: string;
}
```

---

## 8. TRANSFORMATION PIPELINE (Bird's Eye View)

```
API Response (raw plays)
    ↓
transformToGameCard()
    ├─ Convert plays → drivers (playToDriver)
    ├─ Deduplicate drivers (deduplicateDrivers)
    ├─ Build canonical Play (buildPlay)
    │   ├─ Pick truth driver (pickTruthDriver)
    │   ├─ Calculate consensus (supportScore, conflict, truthStrength)
    │   ├─ Select market (selectExpressionMarket)
    │   ├─ Infer market from play (inferMarketFromPlay)
    │   ├─ Build pick string (buildPickString)
    │   ├─ Calculate edge (modelProb - impliedProb)
    │   ├─ Determine bet action (BET vs NO_PLAY)
    │   ├─ Derive status (FIRE, WATCH, PASS)
    │   ├─ Collect reason codes and tags
    │   └─ Validate market invariants
    └─ Enrich with tags (enrichCards)
    
GameCard (with Play + Drivers)
    ↓
Apply Filters
    ├─ filterByActionability (status match + lenient PASS)
    ├─ filterByMarketAvailability (canonical + legacy + drivers)
    └─ Other filters (sport, timeWindow, etc.)
    
Filtered GameCard[] → Display on page
    ↓
getCardDecisionModel()
    ├─ Deduplicate drivers
    ├─ Select primary play (expression > play > drivers)
    ├─ Derive risk codes (market-scoped)
    ├─ Build why explanation
    └─ Pick top 3 contributors
    
UI Renders Decision Model
```

---

## WORKING EXAMPLE FLOW

### **Scenario: NBA Game with No Totals Projection**

1. **API emits 5 plays:**
   - Play 1: `market_type='MONEYLINE', prediction='HOME', tier='BEST'`, price given
   - Play 2: `market_type='SPREAD', prediction='HOME', tier='WATCH'`
   - Play 3: `market_type='TOTAL', prediction='OVER', status='PASS', reason_codes=['PASS_TOTAL_INSUFFICIENT_DATA']`
   - Play 4-5: Evidence items (kind='EVIDENCE')

2. **Transform:**
   - Convert plays 1-3 to drivers (Play 4-5 become evidence)
   - Deduplicate drivers (pick strongest per market/side)
   - buildPlay() called:
     - pickTruthDriver → Play 1 (BEST tier, non-neutral)
     - directionScore(HOME) = 1.0 (BEST) + 0.52 (WATCH spread) = 1.52
     - truthStrength = 0.65 (MEDIUM)
     - selectExpressionMarket(HOME, MEDIUM, Play1.BEST) → has ML odds → returns 'ML'
     - price = +110 (example), impliedProb = 0.476
     - modelProb = 0.60
     - edge = 0.60 - 0.476 = 0.124 (12.4% edge!) → GOOD
     - betAction = BET (edge 12.4% > 2% threshold)
     - status = FIRE (BEST + GOOD)
     - pick = "Team ML +110"
     - market_type = 'MONEYLINE'
     - reason_codes = [] (no blockers)
     - kind = 'PLAY'

3. **Filter (Full Slate with PASS included):**
   - filterByActionability: status=FIRE, PASS included → PASS (true)
   - filterByMarketAvailability: market_type=MONEYLINE → canonical=ML → included → PASS (true)

4. **Display:**
   - getCardDecisionModel:
     - primaryPlay: source='play', market=ML, status=FIRE, pick="Team ML +110"
     - whyReason: "EDGE_FOUND_SIDE"
     - topContributors: [Play1 (BEST, pro), Play2 (WATCH, pro)]

---

## ITEMS TO AUDIT

1. **Market Inference:** How is market_type determined from incomplete data?
2. **Edge Calculation:** How is modelProb calculated? Where does it come from?
3. **Status Derivation:** When should it be FIRE vs WATCH vs PASS?
4. **Invariant Validation:** Which market+selection+line combinations are invalid?
5. **Total Bias Blocking:** When should totals be forced to PASS?
6. **Risk Tag Classification:** Which tags block which markets?
7. **Reason Code Semantics:** What do reason codes mean to the user?
8. **Price/Line Handling:** What values are acceptable? When is N/A shown?




----

UPDATES to Align to

## Canonical Play Logic — Full Scope (NBA + NHL + SOCCER) Without Contradictions

### Non-negotiable separation (this is the whole point)

1. **classification** = model truth (is it +EV / worth listing)
2. **action** = execution decision (should we bet it now)
3. **UI filtering** = visibility only (never changes 1 or 2)

If anything in UI/filters re-derives market/type/status, you will get contradictions again.

---

# 1) Canonical Play Object (works for all sports)

### Play (canonical)

* `play_id` (deterministic hash of: `game_id + market_type + selection_key + line + price + book`)

* `sport` (NBA | NHL | SOCCER)

* `league`

* `game_id`

* `market_type` (enum; sport-agnostic list below)

* `selection_key` (string enum; market-specific)

* `side` (HOME | AWAY | OVER | UNDER | DRAW | NONE)  // optional helper, derived once

* `line` (number | null)

* `price_american` (number | null)

* `book` (string | null)

### Model block (sport-agnostic)

* `model.projection` (number | null)
* `model.edge` (number | null)
* `model.confidence` (0–100 | null)
* `model.ev` (number | null)

### Classification (truth)

* `classification` = BASE | LEAN | PASS

### Action (execution)

* `action` = FIRE | HOLD | PASS

### Governance

* `pass_reason_code` (required if `classification=PASS` OR `action=PASS`)
* `warning_tags` (string[])
* `context_tags` (string[])
* `created_at`, `expires_at`

### Optional sport-specific payload (kept isolated)

* `meta` (object)
  Examples:

  * NBA: `pace_env`, `injury_cloud`, `back_to_back`, `rest_advantage`
  * NHL: `goalie_status`, `starting_goalie`, `travel`, `shot_rate_env`
  * SOCCER: `derby`, `rotation_risk`, `xg_band`

**Invariant:** sport-specific fields never participate in parsing/inference downstream unless explicitly referenced by a single rule in the Decision layer.

---

# 2) Market Types (single enum set)

These are the only allowed market types across the platform:

* `MONEYLINE`
* `SPREAD`
* `TOTAL`
* `TEAM_TOTAL`
* `PROP` (generic bucket; use `meta.prop_type` to specify)
* SOCCER-only (still valid platform-wide):

  * `DOUBLE_CHANCE`
  * `DRAW_NO_BET`
  * `TSOA`
  * `SHOTS_ON_TARGET` (if you support it)
* NHL convenience (still platform-wide):

  * `SOG` (if you treat it as a first-class market, otherwise keep it under PROP)

If you keep NHL SOG as PROP: fine. Just don’t mix both; pick one.

---

# 3) Selection Keys (by market_type) — NBA/NHL/SOCCER coverage

## MONEYLINE

* `HOME_WIN`
* `AWAY_WIN`
* (SOCCER only) `DRAW`

## SPREAD

* `HOME_SPREAD`
* `AWAY_SPREAD`

## TOTAL

* `OVER`
* `UNDER`

## TEAM_TOTAL

* `HOME_TEAM_OVER`
* `HOME_TEAM_UNDER`
* `AWAY_TEAM_OVER`
* `AWAY_TEAM_UNDER`

## DOUBLE_CHANCE (SOCCER)

* `HOME_OR_DRAW`
* `AWAY_OR_DRAW`
* `HOME_OR_AWAY`

## DRAW_NO_BET (SOCCER)

* `HOME_DNB`
* `AWAY_DNB`

## TSOA (SOCCER)

* `HOME_TSOA`
* `AWAY_TSOA`

## PROP (NBA/NHL/SOCCER)

* `PLAYER_OVER`
* `PLAYER_UNDER`
  with required meta:
* `meta.player_id`, `meta.player_name`
* `meta.prop_type` (NBA examples: PRA, REB, AST, PTS; NHL examples: SOG, POINTS; SOCCER examples: SOT, SHOTS)

---

# 4) Classification Logic (Model Truth Layer) — universal

This layer ignores:

* whether the market is currently available
* book selection
* time window
* “do we want to show something”

It only answers: **is the model endorsing this as value?**

### BASE

Must satisfy all:

* edge >= BASE threshold (market-specific threshold table below)
* confidence >= BASE confidence floor
* no hard veto flags

### LEAN

* edge positive but below BASE threshold OR confidence moderate
* and no hard veto flags

### PASS

* edge <= 0
  OR
* hard veto triggered (bias conflict, consistency failure, out-of-scope market, missing required fields)

**Hard veto always yields PASS**. It cannot become LEAN.

---

# 5) Action Logic (Execution Layer) — universal

Action answers: **what should the user do right now?**

Inputs:

* `classification`
* `market_available` (bool)
* `price_acceptable` (bool; optional)
* `time_window_ok` (bool; optional)
* `wrapper_blocks` (bool; from NHL goalie gate, Soccer scope mode, etc.)

### Rules (simple and non-contradictory)

* If `classification=PASS` → `action=PASS`
* Else if `market_available=false` → `action=HOLD`
* Else if `wrapper_blocks=true` → `action=HOLD`
* Else:

  * `classification=BASE` → `action=FIRE`
  * `classification=LEAN` → `action=HOLD`

No rule upgrades PASS to HOLD/FIRE. Ever.

---

# 6) Thresholds (by sport + market_type) — keep it explicit

You already have edge threshold adjustments (weak, conflict, steep favorite). Don’t bury them in scattered code. Make one table.

## A) TOTAL (NBA + NHL)

* Base threshold: **2%** (or your existing baseline)
* Adjustments:

  * weak signal: +1.5%
  * conflict: +1.0%
  * steep favorite: +2.0% (if your framework applies here)
* Hard veto: `total_bias !== OK` → PASS (`TOTAL_BIAS_CONFLICT`)

## B) SPREAD (NBA)

* Use your points-edge framework (projection vs line):

  * BASE if abs(edge_points) >= X
  * LEAN if >0 but <X
* Apply the same adjustments conceptually (conflict, weak, etc.)
* Hard veto examples:

  * missing line or projection
  * “bias block” if you have a spread equivalent (optional)

## C) MONEYLINE (NBA + NHL + SOCCER)

* Edge in % terms (fair prob vs implied prob)
* BASE threshold: explicit % (e.g., 2–3% depending on your risk posture)
* Hard veto:

  * cannot compute implied probability due to missing odds
  * out-of-scope (Soccer mode restriction)

## D) NHL SPECIAL: Goalie Gate (wrapper, not classification)

Goalies are execution risk, not “truth.” Handle in Action layer.

Example:

* If `classification=BASE` but `goalie_status != CONFIRMED` and you require confirmation:

  * `wrapper_blocks=true` → action becomes HOLD
  * add warning tag: `GOALIE_UNCONFIRMED`

Do not downgrade classification. It stays BASE. Execution is what changes.

---

# 7) Sport-specific rules (kept consistent)

## SOCCER scope mode (single-scope)

If in restricted Soccer mode:

* Allowed `market_type`: `TSOA`, `DOUBLE_CHANCE`, `DRAW_NO_BET`, `MONEYLINE`
* Anything else is a hard veto:

  * `classification=PASS`
  * `pass_reason_code=OUT_OF_SCOPE_MARKET`
  * `action=PASS`

## NHL constraints (typical)

* `goalie_status` gate: HOLD if unconfirmed (execution only)
* totals may also have:

  * `PACE_ENVIRONMENT`, `MARKET_STALE_EDGE`, etc. as context tags/drivers
* If you run shot markets:

  * treat as PROP or SOG market_type consistently

## NBA constraints (typical)

* injury cloud gate (execution only if you want):

  * e.g., if key player Q-tag: HOLD, with `INJURY_CLOUD`
* back-to-back/rest can be tags; do not mutate market type or selection

---

# 8) UI Filtering (Display Layer) — one job only

Filtering must be a pure visibility predicate:

* FIRE tab: `action === FIRE`
* HOLD tab: `action === HOLD`
* PASS tab: `action === PASS`

PASS must not require “market match.” PASS exists to explain abstention.

---

# 9) Pass Reasons (enumerate them; stop inventing ad hoc strings)

At minimum:

* `NO_EDGE`
* `MISSING_REQUIRED_FIELDS`
* `TOTAL_BIAS_CONFLICT`
* `OUT_OF_SCOPE_MARKET`
* `CONSISTENCY_FAIL`
* `UNSUPPORTED_MARKET`
* `MODEL_VETO`

If `classification=PASS` and you can’t name a reason, that’s a bug.

---

# 10) The “No Forced Fill” rule (platform-wide)

If no plays are BASE:

* you may show only HOLD (leans)
  If no leans either:
* you may show only PASS
  If even PASS is empty:
* show no plays

The system must tolerate empty output. That’s how you avoid hallucinating “best bets.”

---

## What you should implement (to lock it in)

1. One canonical `Play` type (shared, not duplicated per sport)
2. A single `deriveClassification(play)` (model truth)
3. A single `deriveAction(play, market_ctx, wrapper_ctx)` (execution)
4. UI renders `classification` + `action` and never recomputes anything

That covers SOCCER + NBA + NHL cleanly, without any of the earlier contradictions.
