# Decision Contract Violations: Diagnostic Report

**Date**: March 2, 2026  
**Status**: 🔴 CRITICAL — API returns ZERO canonical decision fields  
**Impact**: All plays show contradiction: `LEAN + FIRE` appearing simultaneously, which shouldn't be possible

---

## Executive Summary

You have a **three-layer architecture mismatch**:

1. **Database Layer** (`card_payloads` table): Stores raw play objects with NO `classification`, `action`, or `pass_reason_code`
2. **API Layer** (`/api/games`): Returns plays from database unchanged — **also has NO canonical fields**
3. **Frontend Layer** (`cards-page-client.tsx`): Calls `buildPlay()` which computes canonical fields, but they NEVER reach the display

**Critical Result**: The UI displays a mixture of:
- `play.lean` (the team direction from legacy `direction` field)
- `play.status` (derived from legacy classification/action mapping)
- **without** the authoritative `classification` field that should appear

This creates the **LEAN + FIRE contradiction** you observed: the display shows "LEAN: Nashville Predators" (from `classification='LEAN'`) and "FIRE" (from `action='FIRE'`), which per the canonical contract means these two fields are CONTRADICTING.

---

## Problem 1: API Returns Zero Canonical Fields

### Current State

```bash
$ curl -s 'http://localhost:3000/api/games?limit=1' | python3 -m json.tool
{
  "data": [
    {
      "plays": [
        {
          "cardType": "nhl-rest-advantage",
          "cardTitle": "NHL Rest: HOME",
          "prediction": "HOME",
          "confidence": 0.66,
          "tier": "WATCH",                    ← Legacy field
          "reasoning": "...",
          "edge": null,
          "status": undefined,                ← Legacy field (sometimes missing)
          "classification": undefined,        ← ❌ MISSING (should be BASE|LEAN|PASS)
          "action": undefined,                ← ❌ MISSING (should be FIRE|HOLD|PASS)
          "pass_reason_code": undefined       ← ❌ MISSING (should be code if PASS/action=PASS)
        }
      ]
    }
  ]
}
```

**Why this is wrong**:
- The API route reads from `card_payloads.payload_data` (JSON blob in database)
- The `payload_data` never gets `classification`, `action`, or `pass_reason_code` written to it
- These fields are only computed **on the frontend** in `buildPlay()` → they never flow back to the database

### Root Cause

[web/src/app/api/games/route.ts](web/src/app/api/games/route.ts#L200-L350):

The payload parsing code extracts many fields but **does not extract canonical decision fields**:

```typescript
// Lines 230-350: Extracted from payload
const play: Play = {
  cardType: cardRow.card_type,
  prediction: payload.prediction,
  confidence: payload.confidence,
  tier: payload.tier,                      // ← Reads tier (legacy)
  reasoning: payload.reasoning,
  edge: payload.edge,
  status: payload.status,                  // ← Reads status (legacy) 
  // ❌ MISSING THESE LINES:
  // classification: payload.classification,
  // action: payload.action,
  // pass_reason_code: payload.pass_reason_code,
};
```

The interface **includes** these fields:

```typescript
// Line 76-78
interface Play {
  classification?: 'BASE' | 'LEAN' | 'PASS';
  action?: 'FIRE' | 'HOLD' | 'PASS';
  pass_reason_code?: string | null;
}
```

But the **extraction code never reads them** from the payload.

---

## Problem 2: The Frontend Computes Canonical Fields But Doesn't Export Them

### Current Flow

1. **API returns raw plays** with NO `classification`/`action`
2. **Frontend `cards-page-client.tsx`** fetches via `/api/games`
3. **Frontend calls `transformGames()`** → `transformToGameCard()` → `buildPlay()`
4. **`buildPlay()` calls `derivePlayDecision()`** and **DOES set these fields**:

   ```typescript
   // web/src/lib/game-card/transform.ts, lines 670-678
   classification: (decision.classification as 'BASE' | 'LEAN' | 'PASS') || undefined,
   action: (decision.action as 'FIRE' | 'HOLD' | 'PASS') || undefined,
   pass_reason_code: decision.play?.pass_reason_code ?? null,
   ```

5. **But the UI never displays `classification`**. It displays:
   - `play.lean` (direction field, NOT classification)
   - `play.status` (derived from the legacy `classificationToLegacyStatus()`)

### Why the UI Shows Contradiction

In [cards-page-client.tsx](web/src/components/cards-page-client.tsx#L668):

```tsx
<span className="text-lg font-bold text-cloud">{displayPlay.lean}</span>  
// Shows: "Nashville Predators" (the direction)

{getStatusBadge(displayPlay.status)}  
// Shows: "FIRE" (from status field, not action)
```

**But `displayPlay` comes from `card.play`**, which is the result of `buildPlay()`. So:
- `displayPlay.classification` exists and is set correctly (e.g., "LEAN")
- `displayPlay.action` exists and is set correctly (e.g., "FIRE")
- **BUT** the UI doesn't display either of them — it displays `lean` and `status` instead

---

## Problem 3: Edge / P_Fair / P_Implied Are Null or Miscalculated

### Current State

From the diagnostic output:

```
Play: "NHL Rest: HOME"
  edge: null
  confidence: 0.66
  tier: WATCH
  p_fair: undefined
  p_implied: undefined
```

**Why edges are null**:

1. **Missing pricing data in payloads** — spreads/totals don't have extracted prices
2. **Missing `p_fair` inputs** — if edge depends on `p_fair - p_implied`, and `p_fair` is null, edge stays null
3. **Edge scaled wrong** — if computed edge is 0.24 (24%), displayed as "Edge 24.6%" it might be double-scaled

### The "Edge 24.6%" Problem on -110

From your screenshot: "Predators ML -110" with "Edge 24.6%"

At -110:
- Implied probability = 110 / (110 + 100) ≈ 0.5238 (52.38%)
- If displayed edge is 24.6%, that means model thinks p_fair ≈ 0.77 (77%)

**For an NHL moneyline driven by rest edge alone, 77% is not credible.**

This suggests either:
- Edge is not computed as `p_fair - p_implied` (0–1)
- Edge is being scaled by 100 somewhere, creating double-scaling
- `p_fair` is coming from a heuristic, not an actual projection

---

## Contract Specification

From the canonical decision logic: [web/src/lib/play-decision/canonical-decision.js](web/src/lib/play-decision/canonical-decision.js)

```javascript
/**
 * Canonical Play Contract
 *
 * classification: 'BASE' | 'LEAN' | 'PASS'
 *   - BASE: Model recommends this play
 *   - LEAN: Model shows mild interest (watch)
 *   - PASS: Model declines this play
 *
 * action: 'FIRE' | 'HOLD' | 'PASS'
 *   - FIRE: Execute immediately (classification=BASE only)
 *   - HOLD: Monitor, possible entry later (classification=LEAN only)
 *   - PASS: Do not execute (any classification, but typically PASS)
 *
 * Legal Combinations:
 *   ✅ classification=BASE + action=FIRE
 *   ✅ classification=LEAN + action=HOLD
 *   ✅ classification=PASS + action=PASS
 *
 * Illegal Combinations (VIOLATION):
 *   ❌ classification=LEAN + action=FIRE  ← YOU ARE SEEING THIS
 *   ❌ classification=BASE + action=HOLD
 *   ❌ classification=BASE + action=PASS
 *   ❌ classification=LEAN + action=PASS
 *   ❌ classification=PASS + action=FIRE
 */
```

---

## Root Causes by Layer

### 1. Database Layer — No Persisted Canonical Fields

**File**: [scripts/init-db-vercel.sh](scripts/init-db-vercel.sh)

The `card_payloads` table schema does NOT include columns for canonical fields. When a play is written to the database, it needs to include these fields in the JSON `payload_data`.

**Current payload example**:
```json
{
  "prediction": "HOME",
  "confidence": 0.66,
  "edge": null,
  "recommendation": { "type": "PASS" },
  // ❌ Missing:
  // "classification": "LEAN",
  // "action": "HOLD",
  // "pass_reason_code": null
}
```

### 2. API Layer — Payload Extraction Incomplete

**File**: [web/src/app/api/games/route.ts](web/src/app/api/games/route.ts#L200-L350)

The extraction code reads many fields but **skips the canonical fields even if they exist in the payload**:

```typescript
// Add these lines after line 215:
classification:
  payload.classification === 'BASE' || payload.classification === 'LEAN' || payload.classification === 'PASS'
    ? payload.classification
    : undefined,
action:
  payload.action === 'FIRE' || payload.action === 'HOLD' || payload.action === 'PASS'
    ? payload.action
    : undefined,
pass_reason_code:
  typeof payload.pass_reason_code === 'string' ? payload.pass_reason_code : null,
```

### 3. Frontend Layer — Display Uses Legacy Fields

**File**: [web/src/components/cards-page-client.tsx](web/src/components/cards-page-client.tsx#L668)

The UI renders `play.lean` (direction) instead of `play.classification` (the decision):

```tsx
// CURRENT (WRONG):
<span>{displayPlay.lean}</span>  // Shows "Nashville Predators"

// SHOULD BE:
<span>{displayPlay.classification}</span>  // Shows "LEAN"

// Then separately:
{displayPlay.action && <Badge>{displayPlay.action}</Badge>}  // Shows "FIRE"
```

---

## The Fix (Three Steps)

### Step 1: Extract Canonical Fields in API

Update [web/src/app/api/games/route.ts](web/src/app/api/games/route.ts) to read `classification`, `action`, and `pass_reason_code` from payloads (lines ~220):

```typescript
classification:
  payload.classification === 'BASE' || payload.classification === 'LEAN' || payload.classification === 'PASS'
    ? payload.classification
    : undefined,
action:
  payload.action === 'FIRE' || payload.action === 'HOLD' || payload.action === 'PASS'
    ? payload.action
    : undefined,
pass_reason_code:
  typeof payload.pass_reason_code === 'string' ? payload.pass_reason_code : null,
```

**This makes the canonical fields visible in the raw API response.**

### Step 2: Update Frontend Display to Show Classification, Not Lean

Update [web/src/components/cards-page-client.tsx](web/src/components/cards-page-client.tsx#L668):

From:
```tsx
<span className="uppercase text-sm font-bold">LEAN:</span>
<span>{displayPlay.lean}</span>
```

To:
```tsx
<span className="uppercase text-sm font-bold">CLASSIFICATION:</span>
<span>{displayPlay.classification ?? 'UNKNOWN'}</span>
<span className="text-xs">({displayPlay.lean})</span>
```

This makes it clear that "LEAN" is the model classification, and "Nashville Predators" is the direction that classification applies to.

### Step 3: Ensure Edge Computation Is Correct

Verify [web/src/lib/game-card/transform.ts](web/src/lib/game-card/transform.ts#L527-L535):

```typescript
const impliedProb = market === 'ML' ? americanToImpliedProbability(price) : undefined;
const edge = impliedProb !== undefined ? modelProb - impliedProb : undefined;
```

**Check**:
- Is `modelProb` in 0–1 range? (Should be ~0.5–0.78)
- Is `impliedProb` in 0–1 range? (Should be 0–1)
- Is `edge` in 0–1 range? (Should be 0–0.25 for realistic values)
- Are you displaying `edge * 100` on the UI?

---

## Verification Checklist

After implementing the fix:

- [ ] Run diagnostic again: `node /tmp/diagnose-decision-fields.js`
  - Should show `classification` and `action` fields present
  - Should show NO LEAN + FIRE contradictions

- [ ] Inspect a FIRE play's JSON:
  ```bash
  curl -s 'http://localhost:3000/api/games?limit=1' | jq '.data[0].plays[] | select(.action=="FIRE")'
  ```
  - Should have `classification: "BASE"`
  - Should have `action: "FIRE"`
  - Should NOT have `classification: "LEAN"`

- [ ] Inspect a HOLD play's JSON:
  ```bash
  curl -s 'http://localhost:3000/api/games?limit=1' | jq '.data[0].plays[] | select(.action=="HOLD")'
  ```
  - Should have `classification: "LEAN"`
  - Should have `action: "HOLD"`

- [ ] Inspect a PASS play's JSON:
  ```bash
  curl -s 'http://localhost:3000/api/games?limit=1' | jq '.data[0].plays[] | select(.action=="PASS")'
  ```
  - Should have `classification: "PASS"`
  - Should have `action: "PASS"`
  - Should have `pass_reason_code: (code)`

---

## Why This Matters

This is not a cosmetic issue. **The contradiction destroys trust in the board:**

1. **You can't tell if FIRE is real** — is it from `action` or from mis-derived `status`?
2. **You can't rely on filters** — if you filter "show me HOLD plays," you might get FIRE plays with `classification=LEAN` 
3. **Reporting is broken** — "how many FIRE plays today?" gives the wrong count
4. **Escalation is silent** — a bad-edge play might look good because the UI display is inconsistent with the model's own decision

---

## Next Steps

1. Implement Step 1 (API extraction) — 5 min
2. Test with diagnostic script — 1 min  
3. Implement Step 2 (UI display) — 10 min
4. Verify edge calculations — 10 min
5. Document the canonical contract in UI code comments
