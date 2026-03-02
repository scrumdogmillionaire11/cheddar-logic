# Fix Summary: Canonical Decision Contract Violations

**Date**: March 2, 2026  
**Status**: ✅ PARTIALLY FIXED  
**Test Date**: Before/after deployment testing required

---

## What Was Wrong

### The Contradiction You Saw

Your screenshot showed:
- **Label**: "LEAN: Nashville Predators"  
- **Badge**: "FIRE"

This **violates the canonical contract** because:
- `classification = LEAN` should pair with `action = HOLD`
- `action = FIRE` should pair with `classification = BASE`
- **They cannot both be true simultaneously**

### Root Causes

#### 1. **API didn't extract canonical fields**

The `/api/games` endpoint had the field **definitions** in the Play interface but **never read them from payloads**:

```typescript
// Line 76-78: Interface defined these fields
interface Play {
  classification?: 'BASE' | 'LEAN' | 'PASS';
  action?: 'FIRE' | 'HOLD' | 'PASS';
  pass_reason_code?: string | null;
}

// Lines 200-350: But extraction code ignored them
const play: Play = {
  // ... other fields ...
  status: payload.status,           // ← Read legacy field
  // ❌ MISSING: classification, action, pass_reason_code
};
```

**Result**: API responses had `status` field (legacy) but ZERO canonical fields

#### 2. **UI displayed legacy fields instead of canonical**

In `cards-page-client.tsx`:

```tsx
// WRONG: Shows team name, not classification
<span className="text-lg font-bold">{displayPlay.lean}</span>

// WRONG: Shows status badge, not action
{getStatusBadge(displayPlay.status)}
```

Even though `card.play` (computed by `buildPlay()`) **DID have the canonical fields**, the UI ignored them.

#### 3. **"LEAN" label was misleading**

The UI label "LEAN: Nashville Predators" made it look like:
- "LEAN" = the decision type
- "Nashville Predators" = additional context

But actually:
- `playLean` = the direction/team (direction = 'HOME')
- `classification` = the decision (BASE/LEAN/PASS)
- `action` = the execution (FIRE/HOLD/PASS)

---

## What Was Fixed

### Fix 1: API Now Extracts Canonical Fields ✅

**File**: [web/src/app/api/games/route.ts](web/src/app/api/games/route.ts#L220-L250)

Added extraction of `classification`, `action`, and `pass_reason_code`:

```typescript
classification:
  payload.classification === 'BASE' || payload.classification === 'LEAN' || payload.classification === 'PASS'
    ? (payload.classification as 'BASE' | 'LEAN' | 'PASS')
    : undefined,
action:
  payload.action === 'FIRE' || payload.action === 'HOLD' || payload.action === 'PASS'
    ? (payload.action as 'FIRE' | 'HOLD' | 'PASS')
    : undefined,
pass_reason_code:
  typeof payload.pass_reason_code === 'string' ? payload.pass_reason_code : null,
```

**Effect**: API now **can** return these fields when they're present in payloads

### Fix 2: UI Now Displays Canonical Fields ✅

**File**: [web/src/components/cards-page-client.tsx](web/src/components/cards-page-client.tsx#L668-L690)

Changed display from:
```tsx
<span>LEAN: {displayPlay.lean}</span>          // ← Team name
{getStatusBadge(displayPlay.status)}            // ← Legacy status
```

To:
```tsx
<span>Classification: {displayPlay.classification}</span>  // ← BASE|LEAN|PASS
({displayPlay.lean})  {/*The team direction*/}

{displayPlay.action &&
  <Badge>{displayPlay.action}</Badge>         // ← FIRE|HOLD|PASS
}
```

**Effect**: UI now clearly shows the **canonical decision**, not the legacy status

### Fix 3: Added Fallback for Action Field ✅

**File**: [web/src/components/cards-page-client.tsx](web/src/components/cards-page-client.tsx#L545-L560)

When `card.play` doesn't have canonical fields, we now derive them from the legacy decision model:

```typescript
// Fallback to computing canonical fields from decision
classification: decision.status === 'FIRE' ? 'BASE' 
               : decision.status === 'WATCH' ? 'LEAN' 
               : 'PASS',
action: decision.status === 'FIRE' ? 'FIRE' 
       : decision.status === 'WATCH' ? 'HOLD' 
       : 'PASS',
```

**Effect**: Even if new payloads aren't available, UI shows canonical decisions safely

---

## What Still Needs Work

### Issue 1: No Valid Edge Data Yet

Your screenshot showed multiple plays with `edge: null`. This is **correct gating**, not over-gating, because:

1. **Most plays truly don't have edge**
   - Spread plays need prices (none persisted yet)
   - Total plays need prices (none persisted yet)
   - Without prices, can't compute `p_implied`
   - Without `p_implied`, can't compute `edge`

2. **NBA plays show edge=null on games like Warriors +108**
   - Suggests missing `p_fair` (win probability from model)
   - Can't form edge without model projection

3. **The "Edge 24.6%" on Predators -110**
   - At -110: implied ≈ 0.524
   - If displayed as 24.6%, model thinks win_prob ≈ 0.77
   - For rest edge alone: **not credible**
   - Suggests edge scaling is wrong OR model inputs are missing

### What to Check Next

#### Step A: Verify edge calculation is not double-scaled

In [web/src/lib/game-card/transform.ts](web/src/lib/game-card/transform.ts#L527-535):

```typescript
const impliedProb = market === 'ML' ? americanToImpliedProbability(price) : undefined;
const edge = impliedProb !== undefined ? modelProb - impliedProb : undefined;
```

**Confirms**:
- `modelProb` should be 0.5–0.78 (not 50–78)
- `impliedProb` should be 0.4–0.6 for ML
- `edge` should be –0.1 to 0.25
- **On UI**: if displaying as `edge * 100`, that's correct

#### Step B: Ensure payloads have `projection.win_prob_home`

For NBA/NCAAM, do the model payloads include:
- `projection.win_prob_home`
- `projection.margin_home`
- or other win probability field?

If not, `p_fair` stays null and edge can't be computed.

#### Step C: Populate spread/total prices in snapshots

The `odds_snapshots` table should have:
- `spread_home` / `spread_away`
- `total`

These are needed to compute `p_implied` for spread/total bets.

---

## Verification Checklist

### Does the fix eliminate the LEAN + FIRE contradiction?

Once **new payloads** with canonical fields are written:

```bash
# Should show classification=BASE, action=FIRE (never LEAN+FIRE)
curl -s 'http://localhost:3000/api/games' | jq '.data[0].plays[] | {cardTitle, classification, action}'
```

Expected output: NO plays with `{classification: "LEAN", action: "FIRE"}`

### Does the UI now display canonical fields?

Visit `http://localhost:3000/cards` and verify:

- **Classification badge** shows BASE/LEAN/PASS (not a team name)
- **Action badge** shows FIRE/HOLD/PASS (not a status)
- **Direction** appears in parentheses: "(Nashville Predators)"

### Can the API return canonical fields?

Current state: `null` (because payloads don't have them yet)  
After new payloads: Should have real values

---

## Migration Path

The fix is **backward compatible**:

1. **New payloads** with canonical fields → API returns them
2. **Old payloads** without fields → API returns null
3. **Fallback logic** derives canonical from decision model
4. **UI displays** canonical fields safely in all cases

No database migration needed. No breaking changes.

---

## Files Modified

| File | Change | Impact |
|------|--------|--------|
| [web/src/app/api/games/route.ts](web/src/app/api/games/route.ts#L220-L250) | Added extraction of classification, action, pass_reason_code | API now returns canonical fields |
| [web/src/components/cards-page-client.tsx](web/src/components/cards-page-client.tsx#L668-L690) | Changed UI to display classification (not lean) and action (not status) | UI no longer shows contradiction |
| [web/src/components/cards-page-client.tsx](web/src/components/cards-page-client.tsx#L545-L560) | Added fallback derivation of canonical fields | Safe backward compatibility |

---

## Next Steps

1. **Test in staging**
   - Verify UI shows "Classification: BASE/LEAN/PASS"
   - Verify badge shows "FIRE/HOLD/PASS"
   - Confirm NO more "LEAN + FIRE" visible

2. **Populate new payloads with canonical fields**
   - When plays are built on backend, include classification/action
   - Ensure `p_fair`, `p_implied` are computed correctly
   - Verify edge scaling is 0–0.25, not 0–100

3. **Complete edge calculation checklist**
   - Verify `projection.win_prob_home` is in payloads
   - Add spread/total prices to odds snapshots
   - Test edge computation on 3 sports (NBA, NHL, NCAAM)

4. **Deploy with confidence**
   - The fix is safe for both old and new data
   - No backward breaks
   - Canonical contract is now visible in UI
