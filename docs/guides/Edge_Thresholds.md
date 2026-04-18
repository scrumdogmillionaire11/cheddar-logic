# Edge Threshold Definitions

**Last Updated:** April 17, 2026

This document is the canonical reference for all edge classifications and their thresholds across the system. All implementations should reference these definitions.

---

## 📊 Betting Decision Classifications

These are the three primary betting decision tiers emitted in the `decision_v2.official_status` field:

### 🟢 PLAY (Official/Strong)
- **Meaning:** Clear edge with high confidence — actionable bet
- **When emitted:** `support_score >= play_support_threshold` AND `edge >= play_edge_min`
- **Symbol:** 🟢 (green in Discord)

### 🟡 LEAN (Slight Edge)
- **Meaning:** Measurable but thin edge — worth monitoring, lower confidence
- **When emitted:** `support_score >= lean_support_threshold` AND `edge >= lean_edge_min` AND `edge < play_edge_min`
- **Symbol:** 🟡 (yellow in Discord)

### ⚪ PASS (No Edge)
- **Meaning:** No edge detected or watchdog blocking
- **When emitted:** All other cases (insufficient edge, blocked by watchdog, stale market, etc.)
- **Symbol:** ⚪ (white in Discord)

### Verification Blocker Contract (User-Facing)

When a candidate is held or passed due to market verification or integrity checks,
user-facing outputs must use explicit blocker reasons instead of generic process terms.

Canonical blocker reasons:

- `LINE_NOT_CONFIRMED` → line/price not yet confirmed
- `EDGE_RECHECK_PENDING` → edge requires refresh before action
- `EDGE_NO_LONGER_CONFIRMED` → recheck no longer clears threshold
- `MARKET_DATA_STALE` → market snapshot stale
- `PRICE_SYNC_PENDING` → line and price not yet synchronized

Legacy `EDGE_VERIFICATION_REQUIRED` is sunset and must not be emitted by any pipeline or model path.
It may appear in stored DB records predating this migration and is recognized only for backward-compatible
rendering of persisted cards; it is not accepted as a new emission value.

---

## 🎯 Edge & Support Thresholds by Sport/Market

**Source:** [`packages/models/src/decision-pipeline-v2-edge-config.js`](../../packages/models/src/decision-pipeline-v2-edge-config.js)

### Default Thresholds (Fallback)
```
Edge minimum:    6.0% (PLAY)  | 3.0% (LEAN)
Support minimum: 60% (PLAY)   | 45% (LEAN)
```

### Sport-Market Specific Thresholds (Wave 1)

#### NBA
| Market | PLAY Edge Min | LEAN Edge Min | PLAY Support | LEAN Support |
|--------|---------------|---------------|-------------|-------------|
| SPREAD | 7.0% | 3.5% | 68% | 56% |
| TOTAL | 6.2% | 3.1% | 58% | 47% |
| MONEYLINE | 6.0% | 3.0% | 62% | 49% |

#### NHL
| Market | PLAY Edge Min | LEAN Edge Min | PLAY Support | LEAN Support |
|--------|---------------|---------------|-------------|-------------|
| SPREAD | 5.8% | 2.9% | 57% | 45% |
| TOTAL | 5.0% | 2.5% | 52% | 42% |
| MONEYLINE | 5.8% | 2.9% | 57% | 45% |
| PUCKLINE | 6.5% | 3.2% | 59% | 46% |
| FIRST_PERIOD | 5.0% | 2.5% | 52% | 42% |

**Note:** Thresholds are controlled by `FLAGS.ENABLE_MARKET_THRESHOLDS_V2` in code. When disabled, defaults apply.

---

## 🎬 NHL Player Shots Edge Tiers

These classification tiers appear in the NHL player shots model and represent the magnitude of edge between model projection and market line.

**Source:** [`apps/worker/src/models/nhl-player-shots.js`](../../apps/worker/src/models/nhl-player-shots.js#L147-L175)

### HOT (Strong Edge)
- **Threshold:** `|edge| >= 0.8 shots AND confidence >= 0.50`
- **Meaning:** Significant discrepancy between projection and market line
- **Example:** Model projects 3.2 SOG, market line is 2.5 SOG → edge = 0.7 (below HOT)

### WATCH (Moderate Edge)
- **Threshold:** `|edge| >= 0.5 shots AND confidence >= 0.50`
- **Meaning:** Noticeable but smaller discrepancy; warrants monitoring
- **Example:** Model projects 3.1 SOG, market line is 2.5 SOG → edge = 0.6 (WATCH tier)

### COLD (No/Low Edge)
- **Threshold:** Everything else (below 0.5 shots OR confidence < 0.50)
- **Meaning:** Market pricing appears efficient; no actionable signal
- **Example:** Model projects 2.6 SOG, market line is 2.5 SOG → edge = 0.1 (COLD)

**Notes:**
- Confidence metric (0-1) reflects data quality; thresholds require both edge magnitude AND sufficient confidence
- Tier classification is separate from betting decision classification (PLAY/LEAN/PASS)
- These tiers are used internally; not all are exposed to betting decisions

---

## 📐 Common Concepts

### Edge (Unit: Decimal Fraction)
- **Definition:** Difference between model probability and market implied probability
- **Formula:** `model_prob - market_prob`
- **Range:** -1.0 to 1.0 (or sometimes expressed as -100% to 100%)
- **Example:** If model thinks 55% and market implies 52%, edge = 0.03 (3%)

### Support Score (Unit: Percentage)
- **Definition:** Confidence metric derived from model consistency/driver alignment
- **Range:** 0-1 (expressed as 0-100%)
- **Thresholds:** Used to gate PLAY (typically 0.55-0.68) and LEAN (typically 0.42-0.56)

### Confidence (Unit: 0-1)
- **Definition:** Data quality/freshness metric (specific to projection models like NHL shots)
- **Used for:** Gating edge tier classifications to avoid noise-driven false signals

---

## 🔗 Where These Are Used

### Decision Pipeline
- **Decision Logic:** [`packages/models/src/decision-pipeline-v2.js`](../../packages/models/src/decision-pipeline-v2.js#L908)
  - `computeOfficialStatus()` applies thresholds to determine PLAY/LEAN/PASS
  - `resolveThresholdProfile()` loads sport/market specific thresholds
  
### Payload Emission
- **Discord Cards:** [`apps/worker/src/jobs/post_discord_cards.js`](../../apps/worker/src/jobs/post_discord_cards.js)
  - Displays official_status as 🟢/🟡/⚪ emoji
  
- **Card Payload:** [`packages/data/src/validators/card-payload.js`](../../packages/data/src/validators/card-payload.js)
  - Validates `decision_v2.official_status` enum

### Testing
- **Decision Tests:** [`packages/models/src/__tests__/decision-pipeline-v2*.test.js`](../../packages/models/src/__tests__/)
  - Tests edge cases and threshold boundaries
  
- **NHL Shots Tests:** [`apps/worker/src/models/__tests__/nhl-player-shots*.test.js`](../../apps/worker/src/models/__tests__/)
  - Tests tier classification with edge/confidence combinations

---

## 🎓 Examples

### Example 1: NBA Spread with PLAY Threshold
```
Sport: NBA
Market: SPREAD
Model: 52% (implies -1.5 spread is undervalued)
Market: 48% (implies -1.5 is correctly valued)
Edge: 4.0% (0.04)

Thresholds for NBA SPREAD:
  PLAY: edge >= 7.0% AND support >= 68%
  LEAN: edge >= 3.5% AND support >= 56%

Result:
  - Edge (4.0%) < PLAY threshold (7.0%) → NOT PLAY
  - Edge (4.0%) >= LEAN threshold (3.5%) → LEAN (if support >= 56%)
  - Final: LEAN (if watchdog OK and support sufficient)
```

### Example 2: NHL SOG with WATCH Tier
```
Player: Connor McDavid (Edmonton)
Model Projection: 3.4 SOG (based on L5 data, opponent factor, home boost)
Market Line: 2.9 SOG
Edge: 0.5 SOG
Confidence: 0.65 (high; recent data, clear trends)

Classification:
  |0.5| >= 0.5 shots? YES
  Confidence 0.65 >= 0.50? YES
  Result: WATCH tier

→ Card emitted with tier=WATCH, direction=OVER, edge=0.5
```

### Example 3: Thin Edge Blocked
```
Model: 50.5% (barely positive)
Market: 50.0%
Edge: 0.5% (0.005)

Thresholds: LEAN minimum = 3.0%
Evaluation: 0.5% < 3.0% minimum
Result: PASS (no edge)

Reason: "Thin edges are not edges — they are noise."
```

---

## ⚙️ Configuration

### Enabling Market-Specific Thresholds
```javascript
FLAGS.ENABLE_MARKET_THRESHOLDS_V2 = true
```
When enabled, sport/market specific thresholds from `SPORT_MARKET_THRESHOLDS_V2` are used.
When disabled, `DEFAULT_EDGE_THRESHOLDS` apply to all markets.

### Quarantine Logic (Special Case)
**NBA Totals Quarantine** (WI-0588):
- When `FLAGS.QUARANTINE_NBA_TOTAL = true`
- NBA TOTAL market decisions are demoted one tier:
  - PLAY → LEAN
  - LEAN → PASS
- Added for risk management during calibration periods

---

## 📝 Related Documentation

- [Probabilistic_Thinking.md](./Probabilistic_Thinking.md) — Conceptual foundation
- [Understanding_EV.md](./Understanding_EV.md) — EV and value concepts
- [ADR-0005 (Decision Classification)](../decisions/ADR-0005.md) — Decision framework architecture
- [NHL_PLAYER_SHOTS_PROP_MARKET.md](../NHL_PLAYER_SHOTS_PROP_MARKET.md) — SOG model detail

---

## 🔄 Historical Notes

- **Feb 2026:** NHL shots thresholds calibrated (HOT: 0.8, WATCH: 0.5)
- **v2 Pipeline:** Sport/market thresholds finalized (Wave 1: NBA, NHL)
- **WI-0814:** Fallback sigma can cap PLAY to LEAN under uncertainty
- **WI-0588:** NBA Total quarantine mode added for risk management

---

## ❓ FAQ

**Q: Why are thresholds different by sport/market?**
A: Calibration against historical performance. Different markets have different volatility and signal quality. NBA spreads have higher edge requirements than NHL totals because spreads are more efficient.

**Q: Can I override thresholds locally?**
A: Yes, via the `FLAGS` system or by calling `resolveThresholdProfile()` with custom inputs. But changes should be ADR-backed for production.

**Q: What's the difference between "edge" and "tier"?**
A: "Tier" (PLAY/LEAN/PASS) is the betting recommendation. "Edge" is the raw probability difference. Tiers incorporate support, watchdog status, and other gates; edge is just math.

**Q: Why 0.8 and 0.5 for NHL SOG tiers?**
A: Backtest-calibrated against actual player performance. 0.8 shots correlation empirically predicts profitable overs/unders; 0.5 is the minimum to reduce noise.

**Q: Are WATCH/COLD tiers emitted to API?**
A: Not always. The NHL shots `classifyEdge()` function always computes them, but only cards with HOT tier are typically inserted into `card_payloads`. WATCH/COLD are internal telemetry.

---

*Canonical source. All threshold changes must be tracked in work items and committed with rationale.*

## 🎨 Discord Display Labels

These are the **visual descriptors** shown inline on Discord cards in the "Edge: +X.XX" line.

**Source:** [`apps/worker/src/jobs/post_discord_cards.js`](../../apps/worker/src/jobs/post_discord_cards.js#L920-L926) (lines 920-926)

### strong

- **Threshold:** `|edge| >= 0.2` (absolute value ≥ 20%)
- **Example:** `Edge: +0.21 (strong)` or `Edge: -0.22 (strong)`
- **Usage:** Shown on WATCH cards to indicate substantial edge
- **⚠️ Known Issue:** Floating-point precision can cause +0.20 to display as "thin" when >= 0.2 is intended (stored as 0.199999...)

### thin

- **Threshold:** `0.05 <= |edge| < 0.2` (absolute value between 5% and 20%)
- **Example:** `Edge: +0.07 (thin)` or `Edge: +0.18 (thin)`
- **Usage:** Shown on WATCH cards to indicate marginal edge

### (no label)

- **Threshold:** `|edge| < 0.05` (absolute value below 5%)
- **Meaning:** Too small to display as a meaningful edge
- **Usage:** Edge displayed without descriptor

---

## 🚨 FRAGMENTATION ISSUE

**Currently, three separate systems define edge magnitude independently:**

| System | File | Thresholds | Purpose |
|--------|------|-----------|---------|
| **Betting Decisions** | `decision-pipeline-v2-edge-config.js` | 3-7% (sport/market) | Determine PLAY/LEAN/PASS |
| **Discord Labels** | `post_discord_cards.js` lines 920-926 | 5%, 20% | Visual descriptors |
| **NHL SOG Tiers** | `nhl-player-shots.js` lines 147-175 | 50bp, 80bp | Classify projections |

**Problem:** Thresholds are hardcoded in different files. When you need to adjust edge magnitude bands, you must find and update multiple locations. Risk of divergence and bugs.

---

## ✅ SOLUTION: Unified Display & Projection Tier Configuration

**Principle:** Separate **official classification** from **display/descriptive logic**.

### The Architectural Contract

**KEEP SEPARATE:**
- **Decision thresholds** (PLAY/LEAN/PASS) live in `decision-pipeline-v2-edge-config.js`
- These are sport/market calibrated — example: NBA SPREAD needs 7.0% edge, LEAN needs 3.5%
- These drive official status through `computeOfficialStatus()` → non-negotiable

**UNIFY:**
- **Discord display labels** ("strong", "thin") — currently hardcoded at 0.2 and 0.05
- **NHL SOG projection tiers** (HOT, WATCH, COLD) — currently hardcoded at 0.8 and 0.5 shots
- These are *descriptive*, not classification — they annotate already-computed decisions

**Why the boundary matters:**
- Display logic cannot change official status (PLAY stays PLAY whether labeled "strong" or "thin")
- Projection tiers are unit-separate from betting edges (shots ≠ probability %)
- Conflating them invites bugs: "Let me 'tune' the WATCH threshold... oops, broke LEAN classification"

### Implementation: `edge-thresholds-config.js`

Create new file: [`packages/models/src/edge-thresholds-config.js`](../../packages/models/src/edge-thresholds-config.js)

**Scope:** Display labels + NHL SOG tiers ONLY. Nothing more.

```javascript
// packages/models/src/edge-thresholds-config.js

/**
 * Centralized display and projection tier thresholds.
 * 
 * CRITICAL: This file is for DISPLAY and PROJECTION TIERS only.
 * Official PLAY/LEAN/PASS thresholds remain in decision-pipeline-v2-edge-config.js
 * 
 * Unit separation:
 * - discord bands: decimal fraction (e.g., 0.2 = 20% edge)
 * - nhl_shots bands: shots (e.g., 0.8 SOG)
 */
export const EDGE_MAGNITUDE_TIERS = Object.freeze({
  discord: {
    strong_min: 0.2,      // 20% — display as "(strong)"
    thin_min: 0.05,       // 5%  — display as "(thin)"
  },
  nhl_shots: {
    hot_min: 0.8,         // 0.8 SOG — clear edge
    watch_min: 0.5,       // 0.5 SOG — moderate edge
  },
});

/**
 * Normalize edge for band classification (handles floating-point precision).
 * Rounds to 4 decimal places to avoid 0.199999... ≠ 0.2 bugs.
 * 
 * @param {number} edgeAbs - Absolute value of edge
 * @returns {number} Normalized edge
 */
export function normalizeEdgeForBand(edgeAbs) {
  if (!Number.isFinite(edgeAbs)) return 0;
  return Number(edgeAbs.toFixed(4));
}

/**
 * Classify edge magnitude descriptor for Discord display.
 * 
 * Returns "strong", "thin", or null. Used ONLY for visual labels on cards.
 * Does NOT affect PLAY/LEAN/PASS classification.
 * 
 * @param {number} edgeAbs - Absolute value of edge
 * @returns {string|null} "strong", "thin", or null
 */
export function describeEdgeMagnitude(edgeAbs) {
  const normalized = normalizeEdgeForBand(Math.abs(edgeAbs));
  if (normalized >= EDGE_MAGNITUDE_TIERS.discord.strong_min) return 'strong';
  if (normalized >= EDGE_MAGNITUDE_TIERS.discord.thin_min) return 'thin';
  return null;
}

/**
 * Classify NHL SOG edge tier (HOT / WATCH / COLD).
 * 
 * Input: projection-model edge in shots (not probability %).
 * Confidence gate: any edge < 0.5 confidence → COLD (noise filtering).
 * 
 * Unit: This ONLY applies to SOG/projection models. Do NOT use for bet classification.
 * 
 * @param {number} edgeAbs - Absolute value of SOG edge (in shots)
 * @param {number} confidence - Data quality confidence (0-1)
 * @returns {string} "HOT", "WATCH", or "COLD"
 */
export function classifyNhlSogTier(edgeAbs, confidence) {
  if (!Number.isFinite(confidence) || confidence < 0.5) return 'COLD';
  const normalized = normalizeEdgeForBand(Math.abs(edgeAbs));
  if (normalized >= EDGE_MAGNITUDE_TIERS.nhl_shots.hot_min) return 'HOT';
  if (normalized >= EDGE_MAGNITUDE_TIERS.nhl_shots.watch_min) return 'WATCH';
  return 'COLD';
}
```

### Refactoring Steps

1. **Create** `packages/models/src/edge-thresholds-config.js` with code above

2. **Update** `apps/worker/src/jobs/post_discord_cards.js`:
   - Add import: `import { describeEdgeMagnitude } from '@cheddar-logic/models';`
   - Lines 920-926: Replace with:
     ```javascript
     const edgeBand = describeEdgeMagnitude(Math.abs(edgeRaw2));
     ```

3. **Update** `apps/worker/src/models/nhl-player-shots.js`:
   - Add import: `import { classifyNhlSogTier } from './edge-thresholds-config';`
   - Refactor `classifyEdge()`: Replace threshold logic with `classifyNhlSogTier(Math.abs(edge), confidence)`

4. **DO NOT MOVE** decision thresholds from `decision-pipeline-v2-edge-config.js`
   - These stay where they are (sport/market calibrated)
   - `computeOfficialStatus()` uses them, not the new file

5. **Export** from `packages/models/src/index.js`:
   ```javascript
   export { describeEdgeMagnitude, classifyNhlSogTier, EDGE_MAGNITUDE_TIERS } from './edge-thresholds-config.js';
   ```

### Tests Required

**In `packages/models/src/__tests__/edge-thresholds-config.test.js`:**

```javascript
describe('describeEdgeMagnitude', () => {
  test('0.04 → null (below thin)', () => {
    expect(describeEdgeMagnitude(0.04)).toBe(null);
  });
  test('0.05 → thin (exactly at threshold)', () => {
    expect(describeEdgeMagnitude(0.05)).toBe('thin');
  });
  test('0.1999 → thin (just below strong)', () => {
    expect(describeEdgeMagnitude(0.1999)).toBe('thin');
  });
  test('0.2 → strong (exactly at threshold)', () => {
    expect(describeEdgeMagnitude(0.2)).toBe('strong');
  });
  test('0.199999999 → strong after normalization (precision fix)', () => {
    // This is the actual bug case
    expect(describeEdgeMagnitude(0.199999999)).toBe('strong');
  });
  test('negative edge uses absolute value', () => {
    expect(describeEdgeMagnitude(-0.25)).toBe('strong');
  });
  test('NaN/null returns null safely', () => {
    expect(describeEdgeMagnitude(NaN)).toBe(null);
    expect(describeEdgeMagnitude(null)).toBe(null);
  });
});

describe('classifyNhlSogTier', () => {
  test('(0.8, 0.5) → HOT', () => {
    expect(classifyNhlSogTier(0.8, 0.5)).toBe('HOT');
  });
  test('(0.5, 0.5) → WATCH', () => {
    expect(classifyNhlSogTier(0.5, 0.5)).toBe('WATCH');
  });
  test('(0.49, 0.8) → COLD (below watch)', () => {
    expect(classifyNhlSogTier(0.49, 0.8)).toBe('COLD');
  });
  test('(0.9, 0.49) → COLD (confidence gate wins)', () => {
    expect(classifyNhlSogTier(0.9, 0.49)).toBe('COLD');
  });
  test('(0.8, 0.5) negative edge → HOT (uses absolute)', () => {
    expect(classifyNhlSogTier(-0.8, 0.5)).toBe('HOT');
  });
});
```

### Failure Mode Guards

**Guard 1: Decision thresholds don't drift**
- Document: `edge-thresholds-config.js` is NOT authoritative for PLAY/LEAN/PASS
- Test: Keep existing `decision-pipeline-v2` threshold tests as-is, verify they still pass

**Guard 2: Display labels don't affect status**
- Document: "This file contains annotations only. Official status is computed first, labels applied after."
- Test: Add test that verifies card with "thin" label still has correct official_status

**Guard 3: Unit separation holds**
- Document: `classifyNhlSogTier()` inputs are in SHOTS, not percentage edge. Never mix units.
- Name guard: Keep function names explicit. `classifyNhlSogTier()` not `classifyEdgeTier()`.

**Guard 4: Floating-point bugs don't resurface**
- Add precision test: 0.199999999 must normalize to strong
- Add regression test: If anyone removes `normalizeEdgeForBand()`, the test fails

### Benefits

- **Single source for display logic** — Change "thin" threshold once, updates Discord everywhere
- **Explicit boundary** — Anyone reading the code sees: "official classification ≠ display labels"
- **Precision fix** — Normalization eliminates the +0.20 → "thin" bug
- **Safe to tune** — Adjusting display bands doesn't risk PLAY/LEAN/PASS logic
- **Auditable** — Git history shows when/why descriptive thresholds changed
- **No more search-and-replace** — One file, one source of truth (for display tiers)

