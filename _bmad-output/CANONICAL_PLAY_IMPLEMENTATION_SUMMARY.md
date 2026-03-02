# Canonical Play Logic - Implementation Summary

## ✅ Completed

### 1. Type System
- **File**: `web/src/lib/types/canonical-play.ts`
- Unified `CanonicalPlay` interface for all sports (NBA, NHL, SOCCER)
- Explicit market types: MONEYLINE, SPREAD, TOTAL, PUCKLINE, TEAM_TOTAL, PROP, INFO
- Explicit selection keys: HOME_WIN, AWAY_WIN, OVER, UNDER, HOME_SPREAD, etc.
- Two-layer decision: `classification` (BASE|LEAN|PASS) + `action` (FIRE|HOLD|PASS)
- Sport-specific metadata (isolated from core logic)

### 2. Decision Logic 
- **File**: `web/src/lib/play-decision/canonical-decision.js`
- **Layer 1**: `deriveClassification()` - model truth (ignores market/time)
- **Layer 2**: `deriveAction()` - execution decision (considers market/time/wrappers)
- **Unified**: `derivePlayDecision()` - combines both layers
- Threshold tables by market type (explicit, not scattered)

### 3. Test Suite
- **File**: `web/src/__tests__/canonical-play-decision.test.js`
- 27 comprehensive tests, all passing ✅
- Tests cover: hard vetoes, edge evaluation, thresholds, sport-specific behavior
- Integration scenarios: NBA, NHL, SOCCER flows
- npm script: `npm run test:decision:canonical`

## 🔄 Next Steps

### Step 1: Update API Emission

**Target**: `web/src/app/api/games/route.ts`

Ensure plays emit:
- `market_type`: Always present (canonical)
- `selection_key`: Explicit (HOME_WIN, OVER, etc.)
- `model.edge` and `model.confidence`: Computed values
- `warning_tags`: Hard veto flags

### Step 2: Update Transform Pipeline

**Target**: `web/src/lib/game-card/transform.ts`

After building Play object:
```javascript
const decision = derivePlayDecision(play, marketContext, wrapperContext);
play.classification = decision.classification;
play.action = decision.action;
play.status = classificationToLegacyStatus(classification, action);  // Legacy compat
```

### Step 3: Update Filters

**Target**: `web/src/lib/game-card/filters.ts`

Rules:
- Filter by `action`, not `status`
- Never recompute classification/action in filters
- Filters are pure visibility predicates
- FIRE tab: `action === 'FIRE'`
- HOLD tab: `action === 'HOLD'`
- PASS tab: `action === 'PASS'`

### Step 4: Sport-Specific Wrappers

**New file**: `web/src/lib/play-decision/wrappers.ts`

NHL Example:
```javascript
export function getNHLWrapperContext(play, nhlContext) {
  const blockers = [];
  if (nhlContext.require_confirmed_goalie && 
      nhlContext.goalie_status !== 'CONFIRMED') {
    blockers.push('GOALIE_UNCONFIRMED');
  }
  return { sport: 'NHL', enforced_blockers: blockers };
}
```

SOCCER Example:
```javascript
export function getSoccerWrapperContext(play, mode) {
  const allowedMarkets = ['TSOA', 'DOUBLE_CHANCE', 'DRAW_NO_BET', 'MONEYLINE'];
  const blockers = [];
  if (mode === 'RESTRICTED' && !allowedMarkets.includes(play.market_type)) {
    blockers.push('OUT_OF_SCOPE_MARKET');
  }
  return { sport: 'SOCCER', enforced_blockers: blockers };
}
```

### Step 5: Update UI Components

Replace references to `status` with `action`:
- Keep `classification` for tooltips/debug
- Use `action` for display (FIRE, HOLD, PASS)
- Filter tabs use `action` value

## 🎯 Key Principles

1. **Separation of Concerns**
   - Classification = model endorsement (ignores everything else)
   - Action = execution decision (considers all constraints)
   - Filters = visibility only (never recompute)

2. **No Contradictions**
   - A play cannot have conflicting classification/action
   - PASS classification always → PASS action
   - Classification is immutable (only action can change based on context)

3. **Sport Agnostic**
   - Single Play type works for NBA, NHL, SOCCER, NCAAM
   - Thresholds explicitly defined per market_type
   - Sport-specific logic isolated in wrappers

4. **Backward Compatible**
   - Legacy `status` field kept for migration period
   - Old UI code continues to work
   - Gradual rollout possible

## 📊 Decision Tree

```
Play emitted from API
  ↓
deriveClassification(play)
  ├─ Missing market_type? → PASS
  ├─ Missing selection_key? → PASS
  ├─ Hard veto (bias, scope)? → PASS
  ├─ Missing/negative edge? → PASS
  ├─ Edge >= threshold + confidence >= floor? → BASE
  ├─ Edge > 0 (no veto)? → LEAN
  └─ Otherwise? → PASS
  
  ↓ (classification determined)
  
deriveAction(classification, marketContext, wrapperContext)
  ├─ PASS classification? → return PASS
  ├─ Wrapper blocks? → return HOLD
  ├─ Market unavailable? → return HOLD
  ├─ Time window closed? → return HOLD
  ├─ BASE classification? → return FIRE
  ├─ LEAN classification? → return HOLD
  └─ Otherwise? → return HOLD
  
  ↓ (action determined)
  
UI Display
  ├─ action=FIRE → Show in "🔥 Fire" tab
  ├─ action=HOLD → Show in "⏸️ Hold" tab
  └─ action=PASS → Show in "⛔ Pass" tab
```

## 🧪 Testing Strategy

### Unit Tests (Done ✅)
- `npm run test:decision:canonical` (27 tests)

### Integration Tests (To Be Added)
1. API → Transform → Filter flow
2. Hard veto enforcement
3. Market availability handling
4. Sport-specific wrappers (NHL goalie, SOCCER scope)
5. Classification/action consistency

### Smoke Tests (Update Existing)
- `npm run test:games-filter`
- `npm run test:card-decision`
- `npm run test:transform:market`

## 📋 Files

### Created
- `web/src/lib/types/canonical-play.ts` — Type definitions
- `web/src/lib/play-decision/canonical-decision.js` — Decision logic (JS)
- `web/src/lib/play-decision/decision-logic.ts` — Decision logic (TS, for reference)
- `web/src/__tests__/canonical-play-decision.test.js` — Tests

### To Create
- `web/src/lib/play-decision/wrappers.ts` — Sport wrappers
- `web/src/__tests__/integration-canonical-play.test.js` — Integration tests

### To Modify
- `web/src/lib/game-card/transform.ts` — Call derivePlayDecision()
- `web/src/lib/game-card/filters.ts` — Use action, not status
- `web/src/lib/game-card/decision.ts` — Update primary play selection
- `web/src/app/api/games/route.ts` — Emit canonical fields
- Any UI component using `card.play?.status`

## 🚀 Deployment Checklist

- [ ] Merge types and decision logic
- [ ] Run all existing tests (ensure no regressions)
- [ ] Update API to emit canonical fields
- [ ] Update transform to call derivePlayDecision()
- [ ] Update filters to use action
- [ ] Implement sport wrappers
- [ ] Update UI components
- [ ] Add integration tests
- [ ] Deploy to staging
- [ ] Monitor for 1 week
- [ ] Gradually migrate UI to new system
- [ ] Remove deprecated fields (Phase 2)

## 📞 Quick Reference

| Concept | Old | New | Notes |
|---------|-----|-----|-------|
| Play status | FIRE, WATCH, PASS | classification + action | Separated concerns |
| Market type | Legacy inference | Explicit enum | No guessing |
| Selection | Implicit from title | Explicit key | Type-safe |
| Filtering | By status | By action | Pure visibility |
| Thresholds | Scattered code | Centralized table | Easy to audit |
| Sport specifics | Mixed in core | Wrapper layer | Clean isolation |

