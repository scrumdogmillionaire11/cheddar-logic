# Canonical Play Logic - Quick Reference & Code Examples

## Files Created & Tested

✅ **Type Definitions**
- `web/src/lib/types/canonical-play.ts` — Universal Play type for all sports
  
✅ **Decision Logic (JavaScript)**
- `web/src/lib/play-decision/canonical-decision.js` — Production-ready logic
  - Export: `deriveClassification(play)`
  - Export: `deriveAction(classification, marketContext, wrapperContext)`
  - Export: `derivePlayDecision(play, marketContext, wrapperContext)`

✅ **Decision Logic (TypeScript)**
- `web/src/lib/play-decision/decision-logic.ts` — TS reference version
  
✅ **Comprehensive Tests**
- `web/src/__tests__/canonical-play-decision.test.js` — 27 tests, all passing
- Run: `npm run test:decision:canonical`

---

## Integration: Copy-Paste Code Examples

### 1. Transform Pipeline Integration

**Goal**: Update `web/src/lib/game-card/transform.ts` to use new decision logic

**Location**: In the `buildPlay()` function, after the play object is constructed

```javascript
// At the top of transform.ts, add import:
import { derivePlayDecision, classificationToLegacyStatus } from '../play-decision/canonical-decision.js';

// In buildPlay() function, after building the play object:
function buildPlay(game, drivers) {
  // ... existing buildPlay logic ...
  
  const play = {
    // ... existing play fields ...
    market_type: 'MONEYLINE',
    selection: { side: 'HOME' },
    model: {
      edge: 0.035,
      confidence: 0.70,
    },
  };
  
  // NEW: Derive full decision
  const marketContext = {
    market_available: Boolean(
      game.odds && 
      (play.market_type === 'MONEYLINE' && game.odds.h2hHome ||
       play.market_type === 'SPREAD' && game.odds.spreadHome ||
       play.market_type === 'TOTAL' && game.odds.total)
    ),
    time_window_ok: isTimeWindowOpen(game.startTime),
  };
  
  const decision = derivePlayDecision(play, marketContext);
  
  // NEW: Update play with decision fields
  play.classification = decision.classification;
  play.action = decision.action;
  play.pass_reason_code = decision.play.pass_reason_code;
  
  // LEGACY: Maintain backward compatibility
  play.status = classificationToLegacyStatus(decision.classification, decision.action);
  
  return play;
}

// Helper function to check if time window is open
function isTimeWindowOpen(startTime) {
  if (!startTime) return true;  // Default to open if unknown
  const now = new Date();
  const gameStart = new Date(startTime);
  const hoursUntilGame = (gameStart - now) / (1000 * 60 * 60);
  return hoursUntilGame > 0;  // True if game hasn't started yet
}
```

---

### 2. Filter Integration

**Goal**: Update `web/src/lib/game-card/filters.ts` to filter by action instead of status

**Location**: In filter functions, change status checks to action checks

```javascript
// BAD (old way - recomputes logic)
export function filterByActionability(card, filters) {
  // WRONG: Don't check market or re-determine status here
  if (isPASS(card)) return false;  // Re-determining!
  return filters.statuses.includes(card.play?.status);
}

// GOOD (new way - pure visibility)
export function filterByActionability(card, filters) {
  // Just check: does user want to see this action?
  // action field is pre-computed, never recomputed in filter
  if (!card.play?.action) return false;
  return filters.statuses.includes(card.play.action);
}

// OLD STATUS VALUES → NEW ACTION VALUES
// 'FIRE' → 'FIRE'
// 'WATCH' → 'HOLD'  (need to map this!)
// 'PASS' → 'PASS'

// Helper: Convert old filter status names to new action names
function mapLegacyStatusToAction(status) {
  switch (status) {
    case 'FIRE': return 'FIRE';
    case 'WATCH': return 'HOLD';
    case 'PASS': return 'PASS';
    default: return status;
  }
}

// Updated filter function:
export function filterByActionability(card, filters) {
  if (!card.play?.action) return false;
  
  // Map user's filter selections from old status names to new action names
  const allowedActions = filters.statuses.map(mapLegacyStatusToAction);
  return allowedActions.includes(card.play.action);
}

// Example: User selects "FIRE" tab
// filters.statuses = ['FIRE']
// allowedActions = ['FIRE']
// Show card only if card.play?.action === 'FIRE'
```

---

### 3. Sport-Specific Wrappers

**Goal**: Create `web/src/lib/play-decision/wrappers.ts` for sport-specific execution gates

**File**: Create new file `web/src/lib/play-decision/wrappers.ts`

```javascript
/**
 * Sport-specific execution gates (wrappers)
 * These affect ACTION but never CLASSIFICATION
 */

/**
 * NHL: Goalie confirmation gate
 * If goalie status is not confirmed, action becomes HOLD
 * But classification stays the same
 */
export function getNHLWrapperContext(play, nhlContext) {
  const blockers = [];
  
  // Check if we require confirmed goalie and don't have it
  if (nhlContext?.require_confirmed_goalie &&
      nhlContext?.goalie_status !== 'CONFIRMED') {
    blockers.push('GOALIE_UNCONFIRMED');
  }
  
  // Example: Could add other NHL-specific gates
  if (nhlContext?.travel === 'BACK_TO_BACK') {
    blockers.push('BACK_TO_BACK');  // Optional gate
  }
  
  return {
    sport: 'NHL',
    goalie_status: nhlContext?.goalie_status,
    enforced_blockers: blockers,
  };
}

/**
 * SOCCER: Scope mode gate
 * If in RESTRICTED scope mode, only allow certain markets
 */
export function getSoccerWrapperContext(play, soccerContext) {
  const allowedMarkets = [
    'TSOA',
    'DOUBLE_CHANCE',
    'DRAW_NO_BET',
    'MONEYLINE',
  ];
  
  const blockers = [];
  
  if (soccerContext?.scope_mode === 'RESTRICTED' &&
      !allowedMarkets.includes(play.market_type)) {
    blockers.push('OUT_OF_SCOPE_MARKET');
  }
  
  return {
    sport: 'SOCCER',
    scope_mode: soccerContext?.scope_mode,
    enforced_blockers: blockers,
  };
}

/**
 * NBA: Injury cloud gate (optional)
 * If key player is questionable, may want to hold
 */
export function getNBAWrapperContext(play, nbaContext) {
  const blockers = [];
  
  if (nbaContext?.has_key_player_q_tag) {
    blockers.push('INJURY_CLOUD');  // Optional
  }
  
  return {
    sport: 'NBA',
    enforced_blockers: blockers,
  };
}

/**
 * Generic wrapper builder
 * Use this if you have a unified context object
 */
export function buildWrapperContext(play, sportContext) {
  switch (play.sport) {
    case 'NHL':
      return getNHLWrapperContext(play, sportContext);
    case 'SOCCER':
      return getSoccerWrapperContext(play, sportContext);
    case 'NBA':
      return getNBAWrapperContext(play, sportContext);
    default:
      return { sport: play.sport, enforced_blockers: [] };
  }
}
```

**Usage in Transform**:
```javascript
import { buildWrapperContext } from '../play-decision/wrappers.js';

function buildPlay(game, drivers, sportContext) {
  // ... build play ...
  
  const wrapperContext = buildWrapperContext(play, sportContext);
  
  const decision = derivePlayDecision(play, marketContext, wrapperContext);
  
  play.classification = decision.classification;
  play.action = decision.action;
  
  return play;
}
```

---

### 4. API Route Update (Optional, if needed)

**Location**: `web/src/app/api/games/route.ts`

Make sure emitted plays have canonical fields:

```javascript
// In the /api/games endpoint, when building the response:

const responsePlay = {
  // Canonical fields (NEW)
  play_id: `${game.id}_${play.market_type}_${play.selection_key}`,
  market_type: 'MONEYLINE',  // Explicit
  selection_key: 'HOME_WIN',  // Explicit
  
  // Model data (NEW)
  model: {
    edge: 0.035,
    confidence: 0.70,
  },
  
  // Decision fields (NEW)
  classification: 'BASE',
  action: 'FIRE',
  pass_reason_code: undefined,
  warning_tags: [],
  
  // Legacy fields (OLD, for backward compat)
  status: 'FIRE',
  market: 'ML',
  pick: 'Lakers ML +110',
  
  // ... other fields ...
};
```

---

## Testing the Integration

### Before Integration
```bash
npm run test:decision:canonical
# ✓ 27 tests passing
```

### After Integration (Update Existing Tests)

Update these test files to ensure new fields work:
```bash
npm run test:transform:market      # Should verify market_type + selection_key
npm run test:card-decision         # Should verify classification + action
npm run test:games-filter          # Should verify filtering by action
```

### New Integration Test File

Create `web/src/__tests__/integration-canonical-play.test.js`:

```javascript
// Quick example
const testScenarios = [
  {
    name: 'Strong NBA signal → FIRE',
    play: {
      sport: 'NBA',
      market_type: 'MONEYLINE',
      selection_key: 'HOME_WIN',
      model: { edge: 0.04, confidence: 0.75 },
    },
    expected: {
      classification: 'BASE',
      action: 'FIRE',
    },
  },
  {
    name: 'Weak signal → LEAN → HOLD',
    play: {
      sport: 'NBA',
      market_type: 'MONEYLINE',
      selection_key: 'HOME_WIN',
      model: { edge: 0.015, confidence: 0.60 },
    },
    expected: {
      classification: 'LEAN',
      action: 'HOLD',
    },
  },
];
```

---

## Verification Checklist

After integrating, verify:

- [ ] `npm run test:decision:canonical` passes (27/27)
- [ ] `npm run test:transform:market` passes (all play have market_type + selection_key)
- [ ] `npm run test:card-decision` passes (all plays have classification + action)
- [ ] `npm run test:games-filter` passes (filtering by action works)
- [ ] `/api/games` endpoint returns plays with new fields
- [ ] No plays show in wrong filter tab
- [ ] Logs show no classification/action mismatches
- [ ] No `undefined` values for required fields

---

## Troubleshooting

### Issue: "market_type is undefined"
**Cause**: API not emitting canonical field
**Fix**: Update `web/src/app/api/games/route.ts` to always set `market_type`

### Issue: "Filter shows FIRE and HOLD mixed"
**Cause**: Still using `status` instead of `action`
**Fix**: Change filter condition from `status` to `action`

### Issue: "Classification is PASS but action is FIRE"
**Cause**: Bug in decision logic (should never happen)
**Fix**: This indicates a problem in deriveAction logic - add assertion to catch

### Issue: "Tests pass but production behaves differently"
**Cause**: Transform not calling derivePlayDecision
**Fix**: Verify buildPlay() includes the new decision logic

---

## Success Criteria

✅ All 27 decision logic tests passing
✅ API emits canonical fields (market_type, selection_key, classification, action)
✅ Transform pipeline calls derivePlayDecision()  
✅ Filters use action value, not status
✅ Sport wrappers (NHL goalie, SOCCER scope) work correctly
✅ Zero contradiction between classification and action
✅ Gradual UI migration possible (old code reads status, new reads action)

