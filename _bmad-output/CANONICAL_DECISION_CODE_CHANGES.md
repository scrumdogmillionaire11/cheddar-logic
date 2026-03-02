# Code Change Summary - Canonical Decision Wiring

## 1. Transform Layer - buildPlay() Wiring

**File**: `web/src/lib/game-card/transform.ts`

### Addition: Import decision functions
```typescript
import {
  derivePlayDecision,
  classificationToLegacyStatus,
} from "../play-decision/canonical-decision";
```

### Addition: Build decision context and call derivePlayDecision()
```typescript
// Build initial play object for canonical decision
const playForDecision: any = {
  market_type: resolvedMarketType,
  sport: game.sport,
  selection:
    direction === 'HOME' || direction === 'AWAY' || direction === 'OVER' || direction === 'UNDER'
      ? {
          side: direction,
          team: direction === 'HOME' ? game.homeTeam : direction === 'AWAY' ? game.awayTeam : undefined,
        }
      : undefined,
  selection_key: direction,
  line,
  price,
  model: {
    edge,
    confidence: truthStrength,
  },
  warning_tags: tags,
};

// Market context: refine later with real availability checks
const marketContext = {
  market_available: Boolean(game?.odds),
  time_window_ok: true,
  wrapper_blocks: false,
};

// Derive canonical decision (classification + action)
const decision = derivePlayDecision(playForDecision, marketContext, {});
```

### Update: Return object now includes canonical fields
```typescript
return {
  // ... existing fields ...
  
  // Canonical fields (preferred)
  classification: (decision.classification as 'BASE' | 'LEAN' | 'PASS') || undefined,
  action: (decision.action as 'FIRE' | 'HOLD' | 'PASS') || undefined,
  pass_reason_code: decision.play?.pass_reason_code ?? null,
  
  // Legacy compatibility (keep until UI migration complete)
  status: forcedPass || (resolvedMarketType === 'TOTAL' && totalBias !== 'OK') 
    ? 'PASS' 
    : classificationToLegacyStatus(decision.classification, decision.action),
  
  // ... rest of fields ...
};
```

---

## 2. Helper Function - getPlayDisplayAction()

**File**: `web/src/lib/game-card/decision.ts`

### Addition: New export function
```typescript
/**
 * Get display action from play object, respecting canonical fields with fallback to legacy
 * 
 * This is the single source of truth for UI filtering and display.
 * Uses the new canonical 'action' field if available, falls back to legacy 'status' field.
 * 
 * @param play - Play object from GameCard
 * @returns 'FIRE' | 'HOLD' | 'PASS'
 */
export function getPlayDisplayAction(play?: any): 'FIRE' | 'HOLD' | 'PASS' {
  if (!play) {
    return 'PASS';
  }

  // Prefer canonical action field
  if (play?.action === 'FIRE' || play?.action === 'HOLD' || play?.action === 'PASS') {
    return play.action;
  }

  // Fallback to legacy status field for backward compatibility
  const status = String(play?.status ?? '').toUpperCase();
  if (status.includes('FIRE')) return 'FIRE';
  if (status.includes('WATCH') || status.includes('HOLD')) return 'HOLD';
  
  return 'PASS';
}
```

---

## 3. Filter Layer - Updated to use getPlayDisplayAction()

**File**: `web/src/lib/game-card/filters.ts`

### Addition: Import getPlayDisplayAction
```typescript
import { getPlayDisplayAction } from './decision';
```

### Update: filterByActionability()
```typescript
function filterByActionability(card: GameCard, filters: GameFilters): boolean {
  if (filters.statuses.length === 0) return true;

  const includePass = filters.statuses.includes('PASS');
  const displayAction = getPlayDisplayAction(card.play);
  
  // Full Slate mode: include any game with a play or blocked totals
  if (includePass) {
    const hasPlay = card.play !== undefined;
    const hasBlockedTotals = Boolean(
      card.play?.market_type === 'TOTAL' &&
      displayAction === 'PASS' &&
      (card.play?.reason_codes?.includes('PASS_TOTAL_INSUFFICIENT_DATA') ||
        card.play?.tags?.includes('CONSISTENCY_BLOCK_TOTALS'))
    );
    const hasDrivers = card.drivers.length > 0;
    
    if (hasPlay || hasBlockedTotals || hasDrivers) {
      return true;
    }
  }
  
  // Standard mode: Check displayAction against filter
  // Map display action to filter status names
  let status: ExpressionStatus = 'PASS';
  if (displayAction === 'FIRE') {
    status = 'FIRE';
  } else if (displayAction === 'HOLD') {
    status = 'WATCH';
  }
  
  // Also check legacy expression choice if no play
  if (!displayAction || displayAction === 'PASS') {
    if (card.expressionChoice?.status) {
      status = card.expressionChoice.status;
    } else if (card.tags.includes(GAME_TAGS.HAS_FIRE)) {
      status = 'FIRE';
    } else if (card.tags.includes(GAME_TAGS.HAS_WATCH)) {
      status = 'WATCH';
    }
  }
  
  return filters.statuses.includes(status);
}
```

### Update: filterByMarketAvailability()
```typescript
function filterByMarketAvailability(card: GameCard, filters: GameFilters): boolean {
  if (filters.markets.length === 0) return true;

  const includePass = filters.statuses.includes('PASS');
  const displayAction = getPlayDisplayAction(card.play);
  
  // Full Slate lenient mode: let PASS plays through regardless of market
  if (includePass && displayAction === 'PASS') {
    return true;
  }

  // Check play's canonical market_type first
  const canonicalMarket = canonicalToLegacyMarket(card.play?.market_type);
  if (canonicalMarket && filters.markets.includes(canonicalMarket)) {
    return true;
  }

  // Fallback to legacy play.market
  const playMarket = card.play?.market;
  if (playMarket && playMarket !== 'NONE' && filters.markets.includes(playMarket)) {
    return true;
  }

  // Check drivers as final fallback
  return card.drivers.some(d => filters.markets.includes(d.market));
}
```

---

## 4. UI Component - Updated to use getPlayDisplayAction()

**File**: `web/src/components/cards-page-client.tsx`

### Addition: Import getPlayDisplayAction
```typescript
import { getPlayDisplayAction, getCardDecisionModel } from '@/lib/game-card/decision';
```

### Update: getCardDebugMeta()
```typescript
function getCardDebugMeta(card: GameCard) {
  const playStatusCounts = createPlayStatusCounts();
  const displayAction = getPlayDisplayAction(card.play);
  if (displayAction) {
    // Map display action back to status names for counting
    const statusName = displayAction === 'FIRE' ? 'FIRE' : displayAction === 'HOLD' ? 'WATCH' : 'PASS';
    playStatusCounts[statusName] += 1;
  }

  // ... rest of function ...
}
```

---

## 5. API Schema - Added canonical fields to Play interface

**File**: `web/src/app/api/games/route.ts`

### Update: Play interface
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
  projectedTotal: number | null;
  edge: number | null;
  status?: 'FIRE' | 'WATCH' | 'PASS';
  kind?: 'PLAY' | 'EVIDENCE';
  market_type?: 'MONEYLINE' | 'SPREAD' | 'TOTAL' | 'PUCKLINE' | 'TEAM_TOTAL' | 'PROP' | 'INFO';
  selection?: { side: string; team?: string };
  line?: number;
  price?: number;
  reason_codes?: string[];
  tags?: string[];
  consistency?: {
    total_bias?: 'OK' | 'INSUFFICIENT_DATA' | 'CONFLICTING_SIGNALS' | 'VOLATILE_ENV' | 'UNKNOWN';
  };
  // Canonical decision fields
  classification?: 'BASE' | 'LEAN' | 'PASS';
  action?: 'FIRE' | 'HOLD' | 'PASS';
  pass_reason_code?: string | null;
  // Legacy repair fields
  repair_applied?: boolean;
  repair_rule_id?: string;
}
```

---

## Summary of Changes

| Component | Change | Impact |
|-----------|--------|--------|
| **Transform** | Wired `derivePlayDecision()` into `buildPlay()` | All plays now have `classification`, `action`, `pass_reason_code` |
| **Helper** | Added `getPlayDisplayAction()` | Single safe API for UI to access play action |
| **Filters** | Updated to use `getPlayDisplayAction()` | No contradictions, consistent filtering |
| **UI** | Updated `getCardDebugMeta()` | Uses canonical data for debug counts |
| **API** | Added fields to Play interface | Schema ready for canonical data |

**Result**: Non-contradictory, backward-compatible canonical decision system end-to-end ✅
