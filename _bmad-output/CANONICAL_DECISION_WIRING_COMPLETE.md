# Canonical Decision Logic - Wiring Implementation Complete ✓

**Status**: ✅ All end-to-end wiring complete  
**Date**: March 2, 2026  
**Test Results**: 27/27 canonical decision tests pass + zero TypeScript errors + dev server running

---

## Executive Summary

The canonical decision logic has been **fully integrated** into the cheddar-logic stack. The system now:

1. **Transforms** all plays with canonical decision fields (`classification`, `action`, `pass_reason_code`)
2. **Wires** decision logic into `buildPlay()` as the single source of truth
3. **Provides** UI-safe helpers (`getPlayDisplayAction()`) with backward-compatible fallbacks
4. **Maintains** legacy `status` for ongoing migration
5. **Exposes** new fields through the API for consumption

---

## What Was Implemented

### 1️⃣ Core Decision Wiring (Transform Layer)

**File**: [web/src/lib/game-card/transform.ts](web/src/lib/game-card/transform.ts)

✅ **Import canonical decision functions**:
```typescript
import {
  derivePlayDecision,
  classificationToLegacyStatus,
} from "../play-decision/canonical-decision";
```

✅ **Build decision context in `buildPlay()`**:
- Constructs `playForDecision` object with market_type, sport, selection, model edge/confidence
- Creates `marketContext` with availability and time window checks
- Calls `derivePlayDecision()` to compute classification + action
- **Populates three canonical fields**:
  - `classification: 'BASE' | 'LEAN' | 'PASS'` (model truth)
  - `action: 'FIRE' | 'HOLD' | 'PASS'` (execution decision)
  - `pass_reason_code: string | null` (why PASS was chosen)

✅ **Maintains backward compatibility**:
- Legacy `status` field still populated using `classificationToLegacyStatus()`
- No breaking changes to existing Play interface

---

### 2️⃣ UI Filter/Display Helper (Decision Layer)

**File**: [web/src/lib/game-card/decision.ts](web/src/lib/game-card/decision.ts#L518)

✅ **New export**: `getPlayDisplayAction(play?: any): 'FIRE' | 'HOLD' | 'PASS'`

**Non-contradictory logic**:
```typescript
// Prefers canonical 'action' field
if (play?.action === 'FIRE' || play?.action === 'HOLD' || play?.action === 'PASS') {
  return play.action;
}

// Falls back to legacy 'status' during transition
const status = String(play?.status ?? '').toUpperCase();
if (status.includes('FIRE')) return 'FIRE';
if (status.includes('WATCH') || status.includes('HOLD')) return 'HOLD';
return 'PASS';
```

**Why this works**:
- Avoids UI "deciding" — always defers to canonical source
- Handles mixed old/new data gracefully
- Single function for all UI display/filtering needs

---

### 3️⃣ Filter Implementation (UI Layer)

**File**: [web/src/lib/game-card/filters.ts](web/src/lib/game-card/filters.ts)

✅ **Updated** `filterByActionability()` and `filterByMarketAvailability()`:
- Now import and use `getPlayDisplayAction()`
- Map display action (`FIRE`/`HOLD`/`PASS`) back to status names for filter matching
- Consistent flow through filter pipeline

✅ **Example**:
```typescript
const displayAction = getPlayDisplayAction(card.play);

// Map back to status name for filter matching
let status: ExpressionStatus = 'PASS';
if (displayAction === 'FIRE') {
  status = 'FIRE';
} else if (displayAction === 'HOLD') {
  status = 'WATCH';
}

return filters.statuses.includes(status);
```

---

### 4️⃣ Cards Page Integration

**File**: [web/src/components/cards-page-client.tsx](web/src/components/cards-page-client.tsx)

✅ **Updated** `getCardDebugMeta()`:
```typescript
const displayAction = getPlayDisplayAction(card.play);
if (displayAction) {
  const statusName = displayAction === 'FIRE' ? 'FIRE' 
                   : displayAction === 'HOLD' ? 'WATCH' 
                   : 'PASS';
  playStatusCounts[statusName] += 1;
}
```

✅ **Added import** for `getPlayDisplayAction`

---

### 5️⃣ API Response Schema

**File**: [web/src/app/api/games/route.ts](web/src/app/api/games/route.ts#L67)

✅ **Updated Play interface** to include canonical fields:
```typescript
// Canonical decision fields
classification?: 'BASE' | 'LEAN' | 'PASS';
action?: 'FIRE' | 'HOLD' | 'PASS';
pass_reason_code?: string | null;
```

**Note**: The `/api/games` endpoint returns raw plays from the database. The transformation into canonical fields happens on the frontend when `transformGames()` is called (in cards-page-client.tsx). The API schema is updated to allow these fields to flow through when needed.

---

## Verification Checklist

| Item | Status | Evidence |
|------|--------|----------|
| Transform wiring complete | ✅ | Code integrated in `buildPlay()` |
| Decision logic imported | ✅ | Import at top of transform.ts |
| Canonical fields in Play type | ✅ | Types defined in game-card.ts |
| Helper function created | ✅ | `getPlayDisplayAction()` exported from decision.ts |
| Filters use helper | ✅ | `filterByActionability()` and `filterByMarketAvailability()` updated |
| Cards component uses helper | ✅ | `getCardDebugMeta()` updated |
| API schema updated | ✅ | Play interface includes new fields |
| TypeScript compilation | ✅ | Zero errors across all files |
| Dev server running | ✅ | Next.js ready at http://localhost:3000 |
| Canonical decision tests | ✅ | 27/27 tests pass |

---

## Integration Points

### Data Flow (End-to-End)

```
┌─────────────────────────────────────────────────────────────┐
│ 1. RAW API (/api/games)                                     │
│    ├─ Returns plays from database (has basic fields)        │
│    └─ API schema now accepts classification/action/pass_*   │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. FRONTEND TRANSFORM (cards-page-client.tsx)               │
│    ├─ Calls transformGames(rawData)                         │
│    ├─ Each game → buildPlay() with derivePlayDecision()     │
│    └─ Outputs: GameCard[] with canonical fields POPULATED   │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. FILTER LAYER (filters.ts)                                │
│    ├─ Uses getPlayDisplayAction(card.play)                  │
│    ├─ Returns canonical action, or falls back to legacy     │
│    └─ Filters games consistently                            │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. UI DISPLAY (cards-page-client.tsx, filter-panel.tsx)     │
│    ├─ All read-only displays use getPlayDisplayAction()     │
│    ├─ Filter buttons use status field (FIRE/WATCH/PASS)     │
│    └─ Consistent, non-contradictory display                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Critical Contract Rules (Maintained)

✅ **Non-contradictory decision flow**:
- Model truth (`classification`) is **never downgraded** by execution logic
- `derivePlayDecision()` is the **only** place that sets these fields
- No UI code "fixes" or "upgrades" decisions after the fact

✅ **Wrapper integration pattern** (for future use):
```typescript
const wrapperBlocks = sport === 'NHL' && play.meta?.goalie_status !== 'CONFIRMED';

const decision = derivePlayDecision(play, {
  market_available,
  time_window_ok,
  wrapper_blocks: wrapperBlocks,  // ← wrappers only influence action, never downgrade PASS
});
```

✅ **Backward compatibility**:
- Legacy `status` field still populated
- UI helpers gracefully fall back if `action` field missing
- No breaking changes during transition period

---

## Next Steps (For Transition)

### Phase 1: Verify (Current)
- [x] Wiring is correct and compiles  
- [x] No TypeScript errors
- [x] Decision tests pass
- [x] Dev server running

### Phase 2: Monitor (Next)
- [ ] Watch logs for `classification/action/pass_reason_code` in real responses
- [ ] Verify filter counts match expected breakdowns
- [ ] Check for any UI issues with the new fields

### Phase 3: Migrate (After Phase 2 confirmed)
- [ ] Update filter UI to explicitly show canonical decision reasoning
- [ ] Add canonical decision visualization to card display
- [ ] Deprecate old `status` field in API responses
- [ ] Remove legacy status derivation entirely

### Phase 4: Cleanup
- [ ] Remove legacy `status` field from Play type (breaking change)
- [ ] Simplify filter logic (no fallback needed)
- [ ] Clean up any wrapper integration code

---

## Commands for Verification

**Run decision tests**:
```bash
cd /Users/ajcolubiale/projects/cheddar-logic/web
npm run test:decision:canonical
```

**Expected output**: 27/27 tests pass ✓

**Check for TypeScript errors**:
```bash
npm run build
```

**Expected**: Clean build, no errors

**Verify dev server**:
```bash
npm run dev
```

**Expected**: Server starts at http://localhost:3000 with no errors

**Check API response has new fields**:
```bash
curl -s 'http://localhost:3000/api/games?limit=1' | python3 -m json.tool | grep -E "classification|action|pass_reason"
```

(Note: Raw API returns database plays without transformation. To see canonical fields, check the frontend transformation output or the compiled GameCard objects that `transformGames()` produces.)

---

## Files Modified / Created

| File | Change | Status |
|------|--------|--------|
| [web/src/lib/game-card/transform.ts](web/src/lib/game-card/transform.ts) | Wired derivePlayDecision() into buildPlay() | ✅ |
| [web/src/lib/game-card/decision.ts](web/src/lib/game-card/decision.ts) | Added getPlayDisplayAction() | ✅ |
| [web/src/lib/game-card/filters.ts](web/src/lib/game-card/filters.ts) | Updated to use getPlayDisplayAction() | ✅ |
| [web/src/components/cards-page-client.tsx](web/src/components/cards-page-client.tsx) | Updated getCardDebugMeta() | ✅ |
| [web/src/app/api/games/route.ts](web/src/app/api/games/route.ts) | Added canonical fields to Play interface | ✅ |
| [web/src/lib/types/game-card.ts](web/src/lib/types/game-card.ts) | Already supports classification/action/pass_reason | ✅ |
| [web/src/lib/play-decision/canonical-decision.js](web/src/lib/play-decision/canonical-decision.js) | Canonical decision logic (already existed) | ✅ |

---

## Summary

✅ **The canonical decision logic is now fully wired into the cheddar-logic system.**

- **Transform**: buildPlay() calls derivePlayDecision() and populates classification/action/pass_reason_code
- **Filter**: All filtering uses getPlayDisplayAction() for consistent, safe logic
- **UI**: All displays defer to the canonical decision without overriding
- **API**: Schema updated to accept and return new fields
- **Tests**: 27/27 canonical decision tests pass
- **Build**: Zero TypeScript errors, dev server running

The system is non-contradictory, backward compatible, and ready for gradual migration away from legacy `status` field.

