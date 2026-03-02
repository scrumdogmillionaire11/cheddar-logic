# Edge Calculation Implementation Guide

**Status**: Ready for worker job integration  
**Date**: March 2, 2026

---

## Overview

The edge calculator (`packages/models/src/edge-calculator.js`) computes **probability edges** (0-1 scale) for all market types. This replaces the previous "edge = points delta" approach that was incompatible with canonical-decision thresholds.

## Key Principle

**Edge must be probability-based** to align with `canonical-decision.js` thresholds:

```
edge = p_fair - p_implied

THRESHOLDS (from canonical-decision.js):
  TOTAL:     0.02   (2%)
  SPREAD:    0.025  (2.5%)
  MONEYLINE: 0.025  (2.5%)
```

If you compute edges as points deltas (e.g., projection = 238.5, line = 238.0 → edge = 0.5), your play would always exceed thresholds incorrectly.

---

## New Database Schema

### Migration 011: Add Price Columns

```sql
ALTER TABLE odds_snapshots ADD COLUMN spread_price_home INTEGER;
ALTER TABLE odds_snapshots ADD COLUMN spread_price_away INTEGER;
ALTER TABLE odds_snapshots ADD COLUMN total_price_over INTEGER;
ALTER TABLE odds_snapshots ADD COLUMN total_price_under INTEGER;
```

**Run**: `npm --prefix packages/data run migrate`

---

## Normalizer Updates (Already Complete)

The `packages/odds/src/normalize.js` now extracts prices from The Odds API:

```javascript
odds: {
  h2hHome: market.h2h?.[0]?.home,
  h2hAway: market.h2h?.[0]?.away,
  
  total: market.totals?.[0]?.line,
  totalPriceOver: market.totals?.[0]?.over,      // NEW
  totalPriceUnder: market.totals?.[0]?.under,    // NEW
  
  spreadHome: market.spreads?.[0]?.home_line,
  spreadAway: market.spreads?.[0]?.away_line,
  spreadPriceHome: market.spreads?.[0]?.home,    // NEW
  spreadPriceAway: market.spreads?.[0]?.away,    // NEW
  
  monelineHome: market.h2h?.[0]?.home,
  monelineAway: market.h2h?.[0]?.away
}
```

---

## Edge Calculator API

### Import

```javascript
const {
  computeMoneylineEdge,
  computeSpreadEdge,
  computeTotalEdge,
  getSigmaDefaults,
  impliedProbFromAmerican,
  normCdf
} = require('@cheddar-logic/models').edgeCalculator;
```

**File location**: `packages/models/src/edge-calculator.js`

### Function Signatures

#### `computeMoneylineEdge(params)`

```javascript
const result = computeMoneylineEdge({
  projectionWinProbHome: 0.58,    // Your model's fair prob for home (0-1)
  americanOdds: -120,             // h2h_home or h2h_away
  isPredictionHome: true          // true if betting home
});

// Returns:
{
  edge: 0.0342,           // p_fair - p_implied (prob scale)
  p_fair: 0.58,           // Your projection
  p_implied: 0.5454,      // Implied from odds
  confidence: 0.95        // Fixed high for ML
}
```

#### `computeSpreadEdge(params)`

```javascript
const result = computeSpreadEdge({
  projectionMarginHome: 5.2,      // Your model's fair margin (home - away)
  spreadLine: -6.5,               // Spread line (negative = home favored)
  spreadPriceHome: -110,          // Price for home side
  spreadPriceAway: -110,          // Price for away side
  sigmaMargin: 12,                // NBA: 12, NCAAM: 11 (optional, defaults provided)
  isPredictionHome: true          // true if betting home
});

// Returns:
{
  edge: 0.0127,           // Probability edge
  edgePoints: -1.3,       // Optional: margin - threshold (proj - line)
  p_fair: 0.5402,         // Cover prob from projection
  p_implied: 0.5275,      // Cover prob from implied
  confidence: 0.85,       // Slightly lower than ML
  sigma_used: 12
}
```

#### `computeTotalEdge(params)`

```javascript
const result = computeTotalEdge({
  projectionTotal: 238.7,         // Your model's fair total
  totalLine: 238.5,               // Market line
  totalPriceOver: -110,           // Over price
  totalPriceUnder: -110,          // Under price
  sigmaTotal: 14,                 // NBA: 14, NCAAM: 13, NHL: 1.8 (optional)
  isPredictionOver: true          // true if betting over
});

// Returns:
{
  edge: 0.0082,           // Probability edge (lower for totals)
  edgePoints: 0.2,        // Optional: projection - line
  p_fair: 0.5102,         // Over prob from projection
  p_implied: 0.502,       // Over prob from implied
  confidence: 0.88,
  sigma_used: 14
}
```

#### `getSigmaDefaults(sport)`

```javascript
const sigma = getSigmaDefaults('NBA');
// Returns: { margin: 12, total: 14 }

const sigma = getSigmaDefaults('NHL');
// Returns: { margin: 1.8, total: 1.8 }
```

---

## Integration in Worker Jobs

### Example: NBA Model Job

Update `apps/worker/src/jobs/run_nba_model.js` where card payloads are generated:

```javascript
const {
  computeMoneylineEdge,
  computeTotalEdge,
  getSigmaDefaults
} = require('@cheddar-logic/models').edgeCalculator;

function generateNBACards(gameId, driverDescriptors, oddsSnapshot, marketPayload) {
  const sigma = getSigmaDefaults('NBA');
  const now = new Date().toISOString();
  
  return driverDescriptors.map(descriptor => {
    // ... existing code ...
    
    // MONEYLINE edge
    let edge = null, p_fair = null, p_implied = null;
    if (descriptor.cardType.includes('moneyline') || descriptor.recommendation?.type === 'ML_HOME' || descriptor.recommendation?.type === 'ML_AWAY') {
      const isPredictionHome = descriptor.prediction === 'HOME';
      const americanOdds = isPredictionHome ? oddsSnapshot?.h2h_home : oddsSnapshot?.h2h_away;
      
      const edgeResult = computeMoneylineEdge({
        projectionWinProbHome: descriptor.driverInputs?.win_prob_home ?? 0.5,
        americanOdds,
        isPredictionHome
      });
      
      edge = edgeResult.edge;
      p_fair = edgeResult.p_fair;
      p_implied = edgeResult.p_implied;
    }
    
    // TOTAL edge
    if (descriptor.cardType.includes('total') || ['TOTAL_OVER', 'TOTAL_UNDER'].includes(descriptor.recommendation?.type)) {
      const isPredictionOver = descriptor.prediction === 'OVER';
      const totalPriceKey = isPredictionOver ? 'total_price_over' : 'total_price_under';
      
      const edgeResult = computeTotalEdge({
        projectionTotal: descriptor.driverInputs?.projected_total,
        totalLine: oddsSnapshot?.total,
        totalPriceOver: oddsSnapshot?.total_price_over,
        totalPriceUnder: oddsSnapshot?.total_price_under,
        sigmaTotal: sigma.total,
        isPredictionOver
      });
      
      edge = edgeResult.edge;
      p_fair = edgeResult.p_fair;
      p_implied = edgeResult.p_implied;
    }
    
    const payloadData = {
      // ... existing fields ...
      edge,
      p_fair,
      p_implied,
      sigma_used: sigma.margin || sigma.total,
      // ... rest of payload ...
    };
    
    return {
      // ... card structure ...
      payloadData
    };
  });
}
```

### Critical Fields in payload_data

Your card payloads **must** include (for canonical-decision to work):

```javascript
{
  // Market identification
  market_type: 'TOTAL' | 'SPREAD' | 'MONEYLINE',
  prediction: 'OVER' | 'UNDER' | 'HOME' | 'AWAY',
  
  // Edge calculation outputs
  edge: 0.0234,       // Probability edge (0-1 scale)
  p_fair: 0.5234,     // Your projection prob
  p_implied: 0.50,    // Market-implied prob
  
  // Confidence (required for classification)
  confidence: 0.85,   // 0-1 scale
  
  // Optional but recommended
  edge_points: 1.2,   // Points difference (for explainability)
  sigma_used: 14,     // What sigma was used
  
  // Existing fields (keep these)
  projection: { total, margin_home, win_prob_home },
  odds_context: { h2h_home, h2h_away, total, spread_home, spread_away, ... },
  ...
}
```

---

## Testing the Edge Calculator

```javascript
// Test moneyline
const mlEdge = computeMoneylineEdge({
  projectionWinProbHome: 0.60,
  americanOdds: -130,
  isPredictionHome: true
});
console.log(`ML Edge: ${mlEdge.edge.toFixed(4)}`);  // Should print something like 0.0384

// Test total
const totalEdge = computeTotalEdge({
  projectionTotal: 240.0,
  totalLine: 238.5,
  totalPriceOver: -110,
  totalPriceUnder: -110,
  sigmaTotal: 14,
  isPredictionOver: true
});
console.log(`Total Edge: ${totalEdge.edge.toFixed(4)}`);  // Should be small positive
```

---

## Debugging Edge Calculations

If plays show `edge: null` after running model jobs:

1. **Check odds_snapshots** for populated prices:
   ```sql
   SELECT total, total_price_over, total_price_under, 
          spread_home, spread_price_home, spread_price_away
   FROM odds_snapshots LIMIT 5;
   ```

2. **Check card payloads** for populated projections:
   ```sql
   SELECT json_extract(payload_data, '$.projection') as proj,
          json_extract(payload_data, '$.edge') as edge
   FROM card_payloads WHERE sport = 'NBA' LIMIT 5;
   ```

3. **Verify American odds format**: Odds should be negative (favorite) or positive (underdog), not decimal (1.85/2.10).
   - **Wrong**: `h2h_home: 1.85` (decimal)
   - **Correct**: `h2h_home: -110` (American)

---

## Sigma Tuning (Later)

The defaults are DB v1 estimates:

| Sport   | Margin Sigma | Total Sigma | Notes |
|---------|--------------|-------------|-------|
| NBA     | 12           | 14          | Points |
| NCAAM   | 11           | 13          | Points |
| NHL     | 1.8          | 1.8         | Goals |
| NFL     | 14           | 16          | Points |

Once you have historical data, you can backtest and tune these. The calculator passes `sigma_used` back so you can experiment without changing code.

---

## Next Steps

1. **Run migration**: `npm --prefix packages/data run migrate`
2. **Verify schema**: `sqlite3 packages/data/cheddar.db ".schema odds_snapshots"`
3. **Test odds pull**: `npm --prefix apps/worker run job:pull-odds`
4. **Run model job**: `npm --prefix apps/worker run job:run-nba-model`
5. **Inspect cards**: `SELECT json_extract(payload_data, '$.edge') FROM card_payloads LIMIT 10;`

Once edges populate correctly, your plays will classify as BASE/LEAN instead of all PASS.
