# Settlement Logic — Card Results P&L Calculation

## Overview

This document defines how `settle_cards.js` computes outcomes and P&L for each bet type.

---

## Core Formula: American Odds to P&L

### Positive Odds (Underdog)
If odds are **+150**:
- **Win:** Profit = stake × (odds / 100)
  - Example: 1 unit × (150/100) = **+1.50 units**
- **Loss:** -1.00 unit

### Negative Odds (Favorite)
If odds are **-120**:
- **Win:** Profit = stake × (100 / abs(odds))
  - Example: 1 unit × (100/120) = **+0.83 units**
- **Loss:** -1.00 unit

### Push (Tie)
- P&L = **0.00 units** (stake returned)

---

## Settlement by Bet Type

### 1. Moneyline

**Inputs:**
- `card.payloadData.prediction` → "HOME" or "AWAY"
- `card.payloadData.odds_context.h2h_home` → home odds
- `card.payloadData.odds_context.h2h_away` → away odds
- `game_results.final_score_home` → actual score
- `game_results.final_score_away` → actual score

**Logic:**
```javascript
function settleMoneyl (prediction, oddsContext, gameResult) {
  const { final_score_home, final_score_away } = gameResult;
  
  // Determine actual winner
  let actualWinner = null;
  if (final_score_home > final_score_away) actualWinner = 'HOME';
  else if (final_score_away > final_score_home) actualWinner = 'AWAY';
  else return { result: 'push', pnl_units: 0.0 }; // Tie (rare in hockey/basketball)
  
  // Check if prediction matches
  const isWin = (prediction === actualWinner);
  
  // Get applicable odds
  const odds = prediction === 'HOME' ? oddsContext.h2h_home : oddsContext.h2h_away;
  
  // Calculate P&L
  if (isWin) {
    const pnl = odds > 0 ? (odds / 100) : (100 / Math.abs(odds));
    return { result: 'win', pnl_units: pnl };
  } else {
    return { result: 'loss', pnl_units: -1.0 };
  }
}
```

---

### 2. Spread (Point Spread / Puck Line)

**Inputs:**
- `card.payloadData.prediction` → "HOME" or "AWAY"
- `card.payloadData.odds_context.spread_home` → home spread (e.g., -1.5)
- `card.payloadData.odds_context.spread_away` → away spread (e.g., +1.5)
- Standard odds on spreads are typically **-110** (or from odds_context if available)

**Logic:**
```javascript
function settleSpread(prediction, oddsContext, gameResult) {
  const { final_score_home, final_score_away } = gameResult;
  const spread = prediction === 'HOME' ? oddsContext.spread_home : oddsContext.spread_away;
  
  // Apply spread to predicted team's score
  const adjustedScore = prediction === 'HOME' 
    ? final_score_home + spread 
    : final_score_away + spread;
  
  const opponentScore = prediction === 'HOME' ? final_score_away : final_score_home;
  
  // Determine outcome
  if (adjustedScore > opponentScore) {
    return { result: 'win', pnl_units: (100 / 110) }; // Standard -110 odds
  } else if (adjustedScore < opponentScore) {
    return { result: 'loss', pnl_units: -1.0 };
  } else {
    return { result: 'push', pnl_units: 0.0 }; // Exactly on the spread
  }
}
```

**Note:** If spread odds are stored in `odds_context`, use actual odds instead of -110 default.

---

### 3. Total (Over/Under)

**Inputs:**
- `card.payloadData.prediction` → "OVER" or "UNDER"
- `card.payloadData.odds_context.total` → total line (e.g., 6.5)
- Standard odds typically **-110**

**Logic:**
```javascript
function settleTotal(prediction, oddsContext, gameResult) {
  const { final_score_home, final_score_away } = gameResult;
  const actualTotal = final_score_home + final_score_away;
  const line = oddsContext.total;
  
  // Determine outcome
  if (actualTotal > line && prediction === 'OVER') {
    return { result: 'win', pnl_units: (100 / 110) };
  } else if (actualTotal < line && prediction === 'UNDER') {
    return { result: 'win', pnl_units: (100 / 110) };
  } else if (actualTotal === line) {
    return { result: 'push', pnl_units: 0.0 };
  } else {
    return { result: 'loss', pnl_units: -1.0 };
  }
}
```

---

## Edge Cases

### Cancelled/Postponed Games
- **Action:** Set `card_results.result = 'void'`, `pnl_units = 0.0`
- **Reason:** No result to settle against

### Missing Odds Context
- **Action:** Set `card_results.result = 'error'`, `pnl_units = NULL`
- **Metadata:** Log error reason (e.g., "odds_context missing h2h_home")

### Half-Point Spreads/Totals
- No pushes possible (e.g., -1.5 spread, 6.5 total)
- Always resolves to win or loss

---

## Settlement Job Flow

```
1. Query game_results WHERE status='final' AND settled_at > last_run
2. For each game_id:
   a. Fetch card_results WHERE game_id AND status='pending'
   b. For each card:
      i.   Fetch card_payloads.payload_data (for odds_context + prediction)
      ii.  Determine bet type from recommended_bet_type
      iii. Call appropriate settlement function
      iv.  UPDATE card_results SET result, pnl_units, settled_at, status='settled'
   c. Save checkpoint (last_run timestamp)
3. Log summary: X cards settled, Y wins, Z losses

Idempotency: Skip cards WHERE status='settled' (allow re-settlement if status reset to 'pending')
```

---

## Example Calculations

### NHL Moneyline Win (Underdog)
```
Prediction: AWAY (+150)
Odds Context: h2h_away = 150
Game Result: HOME 2, AWAY 3
Outcome: AWAY wins
P&L: 1 × (150/100) = +1.50 units
```

### NBA Spread Loss (Favorite)
```
Prediction: HOME (-4.5 at -110)
Odds Context: spread_home = -4.5
Game Result: HOME 105, AWAY 102
Adjusted: 105 + (-4.5) = 100.5 vs 102
Outcome: Spread not covered
P&L: -1.00 unit
```

### NHL Total Push (Exact Line)
```
Prediction: OVER (6.0)
Game Result: HOME 3, AWAY 3
Actual Total: 6.0
Outcome: Push
P&L: 0.00 units
```

---

## Implementation Checklist

- [ ] Implement `settleMoneyl()` in settle_cards.js
- [ ] Implement `settleSpread()` in settle_cards.js
- [ ] Implement `settleTotal()` in settle_cards.js
- [ ] Add edge case handlers (void, error)
- [ ] Add unit tests for each bet type + edge cases
- [ ] Verify odds conversion matches sportsbook calculators
- [ ] Add rollback mechanism (reset status='pending' if re-settlement needed)

---

## References

- American Odds Conversion: https://www.sportsbookreview.com/betting-calculators/odds-converter/
- Standard Juice: -110 (4.55% hold)
- Stake Assumption: 1 unit per card (adjust via Kelly sizing later)
