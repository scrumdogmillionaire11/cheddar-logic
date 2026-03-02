# Top-Level Play Selection Spec

## Play Object Shape (from card_payloads row)

```typescript
interface CardPayloadRow {
  id: string;                    // card_payloads.id
  card_id: string;               // in settle_pending_cards context  
  game_id: string;               // to group/filter
  sport: string;
  created_at: string;            // ISO timestamp, for tie-break
  payload_data: string;          // JSON string, will be parsed
}

interface ParsedPayload {
  prediction: 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NEUTRAL';
  confidence: number;            // [0, 1] range (0.00 to 1.00)
  tier: 'SUPER' | 'BEST' | 'WATCH' | null;
  ev_passed: boolean;
  edge?: number;                 // Optional, [0, 0.2] range or null
  recommendation?: { type: string; ... };
  // ... other fields not needed for ranking
}
```

## Sorting Function (JavaScript)

**Input:** `cards: CardPayloadRow[]` (all cards for a single game, same `game_id`)

**Output:** `selectedCard: CardPayloadRow | null` (the "top level" card, or null if all PASS/no plays)

```javascript
function selectTopLevelPlay(cardsForGame) {
  if (!cardsForGame || cardsForGame.length === 0) return null;

  // Parse payloads
  const cardsWithPayload = cardsForGame
    .map(card => {
      try {
        const payload = typeof card.payload_data === 'string'
          ? JSON.parse(card.payload_data)
          : card.payload_data;
        return { card, payload };
      } catch (e) {
        console.warn(`selectTopLevelPlay: failed to parse payload for card ${card.id}`);
        return null;
      }
    })
    .filter(x => x !== null);

  if (cardsWithPayload.length === 0) return null;

  // Filter: skip PASS recommendations
  const playableCards = cardsWithPayload.filter(({ payload }) => {
    return payload.recommendation?.type !== 'PASS'
      && payload.prediction !== 'NEUTRAL';
  });

  if (playableCards.length === 0) return null;

  // Tier priority (lower index = higher priority)
  const TIER_PRIORITY = {
    'SUPER': 0,
    'BEST': 1,
    'WATCH': 2,
    null: 3,
  };

  // Sort by:
  // 1. Tier (SUPER > BEST > WATCH > null)
  // 2. Confidence (descending, 1.0 first)
  // 3. EV-passed (true first)
  // 4. Edge (descending, null last)
  // 5. Created at (ascending, oldest first for stability)
  const sorted = playableCards.sort(({ card: a, payload: payloadA }, { card: b, payload: payloadB }) => {
    // 1. Tier priority
    const tierA = TIER_PRIORITY[payloadA.tier] ?? 4;
    const tierB = TIER_PRIORITY[payloadB.tier] ?? 4;
    if (tierA !== tierB) return tierA - tierB;

    // 2. Confidence (descending)
    const confA = Number(payloadA.confidence) || 0;
    const confB = Number(payloadB.confidence) || 0;
    if (confA !== confB) return confB - confA;

    // 3. EV-passed (true first)
    const evA = payloadA.ev_passed ? 1 : 0;
    const evB = payloadB.ev_passed ? 1 : 0;
    if (evA !== evB) return evB - evA;

    // 4. Edge (descending, null = 0 for comparison)
    const edgeA = Number(payloadA.edge) || 0;
    const edgeB = Number(payloadB.edge) || 0;
    if (edgeA !== edgeB) return edgeB - edgeA;

    // 5. Created at (ascending, stable tie-break)
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  return sorted[0]?.card || null; // Return highest-ranked card
}

// Usage in settle_pending_cards.js:
/*
const cardsForThisGame = pendingRows.filter(r => r.game_id === gameId);
const topLevelCard = selectTopLevelPlay(cardsForThisGame);

if (!topLevelCard) {
  console.log(`[SettleCards] Game ${gameId}: no playable cards found`);
  continue;
}

// ... settlement logic for `topLevelCard` ONLY
const actualPlay = extractActualPlay(topLevelCard.payload_data);
// etc.
*/
```

---

## Test Cases

**Test 1:** Deterministic ranking  
Input: Same game, 3 cards:
- Card A: tier=BEST, confidence=0.85, ev_passed=true
- Card B: tier=SUPER, confidence=0.70, ev_passed=false
- Card C: tier=WATCH, confidence=0.92, ev_passed=true

Expected output: **Card B** (SUPER tier wins, even with lower confidence)

---

**Test 2:** Confidence breaks tier tie  
Input: Same game, 2 cards:
- Card A: tier=BEST, confidence=0.65, ev_passed=true
- Card B: tier=BEST, confidence=0.88, ev_passed=false

Expected output: **Card B** (same tier, but 0.88 > 0.65)

---

**Test 3:** EV-passed breaks confidence tie  
Input: Same game, 2 cards:
- Card A: tier=BEST, confidence=0.85, ev_passed=false
- Card B: tier=BEST, confidence=0.85, ev_passed=true

Expected output: **Card B** (ev_passed=true > false)

---

**Test 4:** Stable tie-break  
Input: Same game, 2 cards with all fields identical except created_at:
- Card A: created_at="2026-03-02T10:00:00Z"
- Card B: created_at="2026-03-02T10:05:00Z"

Expected output: **Card A** (oldest first, stable tie-break)

---

**Test 5:** Filter out PASS/NEUTRAL  
Input: Same game, 2 cards:
- Card A: prediction='NEUTRAL', tier=BEST
- Card B: prediction='HOME', tier=WATCH

Expected output: **Card B** (NEUTRAL filtered, only B is playable)

---

## Integration Points

1. **settle_pending_cards.js**
   - Import or define `selectTopLevelPlay()`
   - Change loop from: `for (const row of pendingRows)`
   - To: `for (const gameId of new Set(pendingRows.map(r => r.game_id)))`
   - Inside: `const topLevelCard = selectTopLevelPlay(pendingRows.filter(r => r.game_id === gameId))`
   - Settle only `topLevelCard`, skip others

2. **Tests (apps/worker/__tests__/)**
   - Add `selectTopLevelPlay.test.js`
   - Run 5 test cases above
   - Add scenario: "multiple cards per game → exactly one settled"

3. **Database cleanup**
   - After settlement runs with new logic, `card_results` will have 1 row per game_id (uniqueness)
   - Optionally add UNIQUE constraint: `ALTER TABLE card_results ADD UNIQUE(game_id, settled_at)`

---

## Notes

- **Tier priority is deterministic:** SUPER always beats BEST, regardless of confidence.
- **Null tier ranks last:** nil/null tier is lowest priority (catch-all for unranked plays).
- **Null edge treated as 0:** Missing edge doesn't invalidate a card, just doesn't contribute to ranking.
- **Null confidence treated as 0:** Similarly, missing confidence doesn't break ranking.
