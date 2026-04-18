# ADR-0017: Vig Accounting — Edge Semantics in Execution Gate

**Status**: Accepted  
**Date**: 2026-04-18  
**Work item**: WI-1031

---

## Context

`execution-gate.js` was computing:

```js
netEdge = rawEdge - VIG_COST_STANDARD(0.045) - SLIPPAGE_ESTIMATE(0.005)
```

The question is what `rawEdge` represents. Tracing every call site:

- `edge-calculator.js` → `computeMoneylineEdge`, `computeSpreadEdge`, `computeTotalEdge`: all use `noVigImplied(priceHome, priceAway)` to devig the market before computing `edge = modelProb − noVigFairProb`.
- `run_mlb_model.js` line ~2002: `edge = pFair - americanOddsToImpliedProbability(price)` (single-side fallback when opposite price unavailable; vig-inclusive implied, so the edge is slightly understated but still net of friction in expectation).
- `run_nhl_model.js`, `run_nba_model.js`: both consume `edge` from `edge-calculator.js` outputs via their model layers.

**Conclusion**: `rawEdge` consistently represents `modelProb − fairMarketProb` where `fairMarketProb` is vig-removed (or vig-inclusive as a conservative bound). This IS the bettor's net EV — no additional vig deduction is needed.

Subtracting `vigCost = 4.5%` again effectively required `rawEdge > 5%` before any bet was allowed, suppressing all plays with genuine 2–4% true edge.

---

## Decision

Remove the `vigCost` and `slippageCost` deduction from `netEdge`:

```js
// Before (incorrect — double-deduction):
netEdge = rawEdge - vigCost - slippageCost;

// After (correct):
netEdge = rawEdge;
```

`VIG_COST_STANDARD` and `SLIPPAGE_ESTIMATE` constants are kept as deprecated no-ops for one release cycle so any external callers passing them do not break. The `minNetEdge` parameter remains as a pure noise floor (not a friction deduction).

---

## Consequences

- Plays with 2–4% genuine edge against the fair market price now correctly pass the gate.
- The `minNetEdge` default (0.025) acts as the noise floor only — callers may tighten it for specific markets.
- POTD path is unaffected (it never calls `execution-gate`; it uses `resolveNoiseFloor` from `signal-engine.js`).
- All existing `execution-gate.test.js` tests updated to match new `netEdge = rawEdge` semantics.

---

## Alternatives Considered

1. **Keep deduction, fix callers**: Callers would need to pass a raw `modelProb − impliedFromViggedPrice` edge (not devigged). This would require touching all three model files and would make the semantics inconsistent with `edge-calculator.js`.
2. **Remove `minNetEdge` as well**: Rejected — some noise floor is still needed to prevent near-zero edge plays; the floor is just no longer inflated by double-counting vig.
