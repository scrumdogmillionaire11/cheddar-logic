---
phase: 13-import-nba-pace-model-from-cheddar-nba-2
plan: 013
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/models/nba-pace-synergy.js
  - apps/worker/src/models/index.js
  - apps/worker/src/jobs/run_nba_model.js
autonomous: true
requirements: [NBA-PACE-01]

must_haves:
  truths:
    - "NBA games with two fast-paced teams produce a paceMatchup card with an OVER/UNDER signal"
    - "NBA games with two slow-paced teams produce a paceMatchup card recommending UNDER"
    - "NBA games with mixed or no meaningful pace synergy produce no paceMatchup card (filtered out)"
    - "Pace synergy cards appear on /cards page alongside existing NBA driver cards"
  artifacts:
    - path: "apps/worker/src/models/nba-pace-synergy.js"
      provides: "JS port of Python PaceSynergyService.analyze_synergy() using 2025-26 season reference range for percentile computation"
      exports: ["analyzePaceSynergy"]
    - path: "apps/worker/src/models/index.js"
      provides: "computeNBADriverCards extended with paceMatchup driver calling analyzePaceSynergy"
      contains: "paceMatchup"
    - path: "apps/worker/src/jobs/run_nba_model.js"
      provides: "NBA_DRIVER_WEIGHTS updated to include paceMatchup weight"
      contains: "paceMatchup"
  key_links:
    - from: "apps/worker/src/models/index.js"
      to: "apps/worker/src/models/nba-pace-synergy.js"
      via: "require('./nba-pace-synergy')"
      pattern: "require.*nba-pace-synergy"
    - from: "apps/worker/src/models/index.js"
      to: "computeNBADriverCards"
      via: "paceMatchup driver block added after matchupStyle driver"
      pattern: "paceMatchup"
---

<objective>
Port the NBA pace synergy model from cheddar-nba-2.0 (Python) into cheddar-logic (JavaScript) and wire it as a new `paceMatchup` driver card in the existing NBA model pipeline.

Purpose: The Python pace_synergy.py models FAST×FAST (totals acceleration) and SLOW×SLOW (totals suppression) matchup effects that are richer than the naive pace multiplier already in projections.js. This gives /cards an additional NBA signal — totals-oriented rather than moneyline-oriented.

Output: New nba-pace-synergy.js module + paceMatchup driver integrated into computeNBADriverCards() + card_payloads writing `nba-pace-matchup` cards automatically on next scheduler tick.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/quick/13-import-nba-pace-model-from-cheddar-nba-2/013-PLAN.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create nba-pace-synergy.js — JS port of PaceSynergyService</name>
  <files>apps/worker/src/models/nba-pace-synergy.js</files>
  <action>
Create a new CommonJS module that ports the core logic of
`/Users/ajcolubiale/projects/cheddar-nba-2.0/src/services/pace_synergy.py`
into JavaScript.

**Key translation decisions:**

1. **Percentile computation without live league distribution**: The Python service
   takes `home_pace_pct` / `away_pace_pct` as pre-computed inputs. In JS we must
   derive percentiles from raw pace values using the 2025-26 season reference range
   from the Python constants file:
   - League range: 99.3 (min) – 107.8 (max), median ~104.0
   - Formula: `pct = (pace - 99.3) / (107.8 - 99.3) * 100`, clamped [0, 100]
   - This is a linear approximation acceptable for driver signal generation.

2. **Efficiency inputs**: The Python service takes `home_off_eff` / `away_off_eff`
   (offensive rating / ORtg). In cheddar-logic the ESPN-enriched odds snapshot
   exposes `raw.espn_metrics.home.metrics.avgPoints` which serves as the ORtg proxy.
   League median off eff constant from Python: `113.0`.

3. **Pace data availability**: `raw.espn_metrics.home.metrics.pace` is computed as
   `avgPoints * 0.92` in team-metrics.js. If pace is null but avgPoints is present,
   derive pace as `avgPoints * 0.92`.

**Module structure:**

```js
'use strict';

// 2025-26 season reference range (from cheddar-nba-2.0 pace_synergy.py)
const PACE_MIN = 99.3;
const PACE_MAX = 107.8;
const FAST_THRESHOLD_PCT    = 70.0;
const VERY_FAST_THRESHOLD   = 80.0;
const SLOW_THRESHOLD_PCT    = 30.0;
const VERY_SLOW_THRESHOLD   = 20.0;
const PACE_CLASH_THRESHOLD  = 40.0;
const LEAGUE_MEDIAN_OFF_EFF = 113.0;

// Adjustments (possessions, capped ±2.0) — from Python constants
const FAST_FAST_BOOST_FULL      = 0.6;
const FAST_FAST_BOOST_HALF      = 0.3;
const VERY_FAST_BOOST_FULL      = 1.2;
const VERY_FAST_BOOST_HALF      = 0.6;
const SLOW_SLOW_PENALTY         = -0.6;
const VERY_SLOW_SLOW_PENALTY    = -1.2;

function paceToPct(pace) {
  if (pace === null || pace === undefined) return null;
  const pct = (pace - PACE_MIN) / (PACE_MAX - PACE_MIN) * 100;
  return Math.max(0, Math.min(100, pct));
}

/**
 * Analyze pace synergy between two NBA teams.
 *
 * @param {number|null} homePace - raw pace value (possessions/game proxy)
 * @param {number|null} awayPace
 * @param {number|null} homeOffEff - offensive rating proxy (avgPoints)
 * @param {number|null} awayOffEff
 * @returns {object|null} synergy result or null if insufficient data
 *   Shape: { synergyType, paceAdjustment, bettingSignal, homePacePct, awayPacePct, reasoning }
 */
function analyzePaceSynergy(homePace, awayPace, homeOffEff, awayOffEff) { ... }

module.exports = { analyzePaceSynergy };
```

**Synergy classification logic** (direct port from Python):

- Both >= VERY_FAST: call _handleVeryFastFast
  - passes gate (both offEff >= 113.0): adjustment=+1.2, signal='ELITE_OVER'
  - fails gate: adjustment=+0.6, signal='ATTACK_OVER'
- Both >= FAST: call _handleFastFast
  - passes gate: adjustment=+0.6, signal='ATTACK_OVER'
  - fails gate: adjustment=+0.3, signal='LEAN_OVER'
- Both <= VERY_SLOW: adjustment=-1.2, signal='BEST_UNDER'
- Both <= SLOW: adjustment=-0.6, signal='STRONG_UNDER'
- Pace gap >= 40: synergyType='PACE_CLASH', adjustment=0, signal='NO_EDGE'
- Otherwise: synergyType='NONE', signal='NO_EDGE'

Return null if either pace is null (cannot compute percentile).

Do NOT call this function from within the module — it is consumed by index.js.
  </action>
  <verify>
node -e "const { analyzePaceSynergy } = require('./apps/worker/src/models/nba-pace-synergy'); console.log(analyzePaceSynergy(106, 105, 115, 114)); console.log(analyzePaceSynergy(101, 100, 110, 109)); console.log(analyzePaceSynergy(null, 105, 115, 114));"
  </verify>
  <done>
    - FAST×FAST case (pace ~106/105, both offEff >= 113) returns { synergyType: 'FAST×FAST', bettingSignal: 'ATTACK_OVER', paceAdjustment: 0.6, ... }
    - SLOW×SLOW case (pace ~101/100) returns { synergyType: 'SLOW×SLOW', bettingSignal: 'STRONG_UNDER', paceAdjustment: -0.6, ... }
    - null pace returns null
  </done>
</task>

<task type="auto">
  <name>Task 2: Wire paceMatchup driver into computeNBADriverCards and update weights</name>
  <files>
    apps/worker/src/models/index.js
    apps/worker/src/jobs/run_nba_model.js
  </files>
  <action>
**In apps/worker/src/models/index.js:**

1. Add require at top of file (with other requires):
   ```js
   const { analyzePaceSynergy } = require('./nba-pace-synergy');
   ```

2. In `computeNBADriverCards()`, after the Blowout Risk driver block, add a new
   `--- Pace Matchup Driver (Synergy Model) ---` block:

   ```js
   // --- Pace Matchup Driver (Synergy Model) ---
   // Reads pace from espn_metrics; falls back to avgPoints * 0.92 derivation
   {
     const homePace = toNumber(raw?.espn_metrics?.home?.metrics?.pace ?? null);
     const awayPace = toNumber(raw?.espn_metrics?.away?.metrics?.pace ?? null);
     const homeOffEff = toNumber(raw?.espn_metrics?.home?.metrics?.avgPoints ?? null);
     const awayOffEff = toNumber(raw?.espn_metrics?.away?.metrics?.avgPoints ?? null);

     const synergy = analyzePaceSynergy(homePace, awayPace, homeOffEff, awayOffEff);

     if (synergy && synergy.bettingSignal !== 'NO_EDGE') {
       // Map synergy signal to prediction (all pace signals are totals-oriented)
       const predictionMap = {
         'ELITE_OVER': 'OVER',
         'ATTACK_OVER': 'OVER',
         'LEAN_OVER':   'OVER',
         'STRONG_UNDER': 'UNDER',
         'BEST_UNDER':   'UNDER'
       };
       const prediction = predictionMap[synergy.bettingSignal] ?? 'NEUTRAL';

       // Confidence: ELITE_OVER=0.75, ATTACK_OVER=0.70, LEAN_OVER=0.63, STRONG_UNDER=0.70, BEST_UNDER=0.75
       const confidenceMap = {
         'ELITE_OVER': 0.75,
         'ATTACK_OVER': 0.70,
         'LEAN_OVER': 0.63,
         'STRONG_UNDER': 0.70,
         'BEST_UNDER': 0.75
       };
       const confidence = confidenceMap[synergy.bettingSignal] ?? 0.60;

       descriptors.push({
         cardType: 'nba-pace-matchup',
         cardTitle: `NBA Pace: ${synergy.synergyType} — ${prediction}`,
         confidence,
         tier: determineTier(confidence),
         prediction,
         reasoning: synergy.reasoning,
         ev_threshold_passed: confidence > 0.60,
         driverKey: 'paceMatchup',
         driverInputs: {
           home_pace: homePace,
           away_pace: awayPace,
           home_pace_pct: synergy.homePacePct,
           away_pace_pct: synergy.awayPacePct,
           home_off_eff: homeOffEff,
           away_off_eff: awayOffEff,
           synergy_type: synergy.synergyType,
           pace_adjustment: synergy.paceAdjustment
         },
         driverScore: prediction === 'OVER' ? 0.75 : prediction === 'UNDER' ? 0.25 : 0.5,
         driverStatus: 'ok',
         inference_source: 'driver',
         is_mock: false
       });
     }
   }
   ```

**In apps/worker/src/jobs/run_nba_model.js:**

Update `NBA_DRIVER_WEIGHTS` to include `paceMatchup`. The existing weights sum to 0.97
(baseProjection=0.35, restAdvantage=0.20, welcomeHomeV2=0.12, matchupStyle=0.20,
blowoutRisk=0.10). Adjust to accommodate paceMatchup at 0.13, reducing restAdvantage
from 0.20 to 0.15 and welcomeHomeV2 from 0.12 to 0.10 (sum stays 1.00 — but note
these weights are for driver_summary display only, not used for selection/confidence):

```js
const NBA_DRIVER_WEIGHTS = {
  baseProjection: 0.35,
  restAdvantage: 0.15,
  welcomeHomeV2: 0.10,
  matchupStyle: 0.20,
  blowoutRisk: 0.07,
  paceMatchup: 0.13
};
```
  </action>
  <verify>
node -e "
const { computeNBADriverCards } = require('./apps/worker/src/models');
// Simulate a FAST×FAST matchup (pace ~106/105)
const snap = {
  raw_data: JSON.stringify({
    espn_metrics: {
      home: { metrics: { pace: 106.0, avgPoints: 116.0, avgPointsAllowed: 112.0, restDays: 1 } },
      away: { metrics: { pace: 105.5, avgPoints: 115.0, avgPointsAllowed: 111.5, restDays: 1 } }
    }
  }),
  h2h_home: -110, h2h_away: -110, spread_home: -2.5, total: 228
};
const cards = computeNBADriverCards('test-game-id', snap);
const paceCard = cards.find(c => c.cardType === 'nba-pace-matchup');
console.log('paceCard:', JSON.stringify(paceCard, null, 2));
"
  </verify>
  <done>
    - `computeNBADriverCards` with FAST×FAST pace data returns a `nba-pace-matchup` card with prediction='OVER', bettingSignal visible in driverInputs.synergy_type
    - `NBA_DRIVER_WEIGHTS` contains `paceMatchup: 0.13`
    - No test failures: `node apps/worker/src/jobs/run_nba_model.js` exits 0 (or logs "No upcoming NBA games" with no error)
  </done>
</task>

</tasks>

<verification>
After both tasks complete:

1. Smoke test the new module in isolation:
   ```
   node -e "const { analyzePaceSynergy } = require('./apps/worker/src/models/nba-pace-synergy'); console.log(analyzePaceSynergy(106, 105, 116, 115));"
   ```
   Expected: object with synergyType 'FAST×FAST', bettingSignal 'ATTACK_OVER'

2. Smoke test full driver pipeline:
   ```
   node -e "const { computeNBADriverCards } = require('./apps/worker/src/models'); const cards = computeNBADriverCards('test', { raw_data: JSON.stringify({ espn_metrics: { home: { metrics: { pace: 106, avgPoints: 116, avgPointsAllowed: 112, restDays: 1 } }, away: { metrics: { pace: 105, avgPoints: 115, avgPointsAllowed: 111, restDays: 1 } } } }), spread_home: -2.5, total: 228 }); console.log(cards.map(c => c.cardType));"
   ```
   Expected: array includes 'nba-pace-matchup'

3. Run NBA model job dry run:
   ```
   DRY_RUN=true node apps/worker/src/jobs/run_nba_model.js
   ```
   Expected: exits 0, logs DRY_RUN mode

4. Confirm existing model tests still pass (if any):
   ```
   ls apps/worker/src/models/__tests__/
   ```
   Run any existing test files with node directly.
</verification>

<success_criteria>
- `analyzePaceSynergy()` correctly classifies FAST×FAST, SLOW×SLOW, PACE_CLASH, NONE based on 2025-26 pace range
- `computeNBADriverCards()` emits `nba-pace-matchup` cards when both teams share a meaningful pace synergy
- NO card emitted when synergy signal is NO_EDGE (PACE_CLASH or NONE) — avoids noise
- `NBA_DRIVER_WEIGHTS` includes `paceMatchup` key so driver_summary in card payloads has correct weight entry
- All existing NBA driver cards (base-projection, rest-advantage, matchup-style, blowout-risk) still emit correctly
</success_criteria>

<output>
After completion, create `.planning/quick/13-import-nba-pace-model-from-cheddar-nba-2/013-SUMMARY.md`
</output>
