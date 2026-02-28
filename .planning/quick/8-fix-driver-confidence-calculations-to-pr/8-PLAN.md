---
phase: quick-8
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/models/index.js
autonomous: true
requirements: [QUICK-8]

must_haves:
  truths:
    - "shotEnvironment, emptyNet, totalFragility per-driver confidence values differ between games with different input deltas"
    - "NHL composite confidence is derived purely from weighted driver scores with no additive baseline offset from mockModels.NHL.confidence"
    - "NHL prediction direction follows net driver bias (weightedSum > 0.5 = HOME) not raw odds comparison"
    - "getInference NBA fallback derives confidence from computeNBADriverCards output rather than mockModels.NBA.confidence constant"
  artifacts:
    - path: "apps/worker/src/models/index.js"
      provides: "Updated computeNHLDriverCards and computeNHLDrivers with driver-derived confidence and direction"
      contains: "clamp.*Math.abs.*score.*0.5"
  key_links:
    - from: "computeNHLDrivers"
      to: "confidence output"
      via: "weightedSum clamped directly, no baselineConfidence offset"
      pattern: "clamp\\(weightedSum"
    - from: "computeNHLDriverCards shotEnvironment block"
      to: "conf variable"
      via: "clamp expression using d.score deviation"
      pattern: "clamp.*score.*0.5"
---

<objective>
Fix hardcoded confidence values in computeNHLDriverCards and the NHL composite model in computeNHLDrivers so each game produces differentiated output based on actual input deltas.

Purpose: Cards currently show the same confidence regardless of how strong the underlying signal is, making tier badges and play suggestions meaningless. Every driver already computes a score from real inputs — the confidence just needs to reflect that score's deviation from neutral (0.5). Additionally, the NHL prediction direction ignores all driver signals and the NHL composite baseline pins everything to 0.65.

Output: Updated apps/worker/src/models/index.js with four targeted fixes and no new data sources introduced.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/models/index.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Fix per-driver hardcoded confidence in computeNHLDriverCards</name>
  <files>apps/worker/src/models/index.js</files>
  <action>
In computeNHLDriverCards, replace three hardcoded confidence constants with expressions that scale from the driver's own score deviation from neutral (0.5). The goalie and pdoRegression blocks already do this correctly — apply the same pattern to the three that don't.

Change 1 — shotEnvironment block (locate by `const conf = 0.65;` inside the shotEnvironment block):
  Before: `const conf = 0.65;`
  After:  `const conf = clamp(0.60 + Math.abs(d.score - 0.5) * 0.3, 0.60, 0.75);`
  Why: xGF% delta is a real signal; larger spread between home/away xGF% = stronger shot quality edge = higher confidence. Floor 0.60, ceiling 0.75.

Change 2 — emptyNet block (locate by `const conf = 0.60;` inside the emptyNet if-block):
  Before: `const conf = 0.60;`
  After:  `const conf = clamp(0.58 + Math.abs(d.score - 0.5) * 0.3, 0.58, 0.72);`
  Why: Pull timing is a weaker signal; starts below WATCH at 0.58 and scales up for meaningful pull-time deltas. No change to the ev_threshold_passed expression.

Change 3 — totalFragility block (locate by `const conf = 0.60;` inside the totalFragility block):
  Before: `const conf = 0.60;`
  After:  `const conf = clamp(0.58 + d.score * 0.2, 0.58, 0.78);`
  Why: totalFragilityScore is already proportional — score near 1.0 means the total sits right on a key number (5.5 or 6.5), which is high fragility = high confidence. Use score directly (not deviation from 0.5) because high score = meaningful signal.

Do NOT change the welcomeHome block — venueIntensity and rest are intentional documented placeholders; the conf expression there already derives from the live score variable.
  </action>
  <verify>
Run from repo root:
  node -e "
    const m = require('./apps/worker/src/models/index.js');
    const strong = { raw_data: JSON.stringify({ xgf_home_pct: 58, xgf_away_pct: 42, empty_net_pull_home_sec: 20, empty_net_pull_away_sec: 90 }), total: 5.5 };
    const weak   = { raw_data: JSON.stringify({ xgf_home_pct: 51, xgf_away_pct: 49, empty_net_pull_home_sec: 58, empty_net_pull_away_sec: 62 }), total: 6.2 };
    const c1 = m.computeNHLDriverCards('g1', strong);
    const c2 = m.computeNHLDriverCards('g2', weak);
    ['shotEnvironment','emptyNet','totalFragility'].forEach(k => {
      const a = c1.find(c => c.driverKey === k)?.confidence;
      const b = c2.find(c => c.driverKey === k)?.confidence;
      console.log(k + ': strong=' + a?.toFixed(3) + ' weak=' + b?.toFixed(3) + ' differentiated=' + (a !== b));
    });
  "
Expected: all three lines print `differentiated=true` with strong confidence > weak confidence.
  </verify>
  <done>shotEnvironment, emptyNet, totalFragility confidence values vary between games with strong vs weak input deltas. No hardcoded constant appears in those three blocks.</done>
</task>

<task type="auto">
  <name>Task 2: Fix NHL composite confidence baseline and prediction direction in computeNHLDrivers</name>
  <files>apps/worker/src/models/index.js</files>
  <action>
In computeNHLDrivers, two lines anchor output to mockModels constants instead of using driver signals.

Change 1 — Remove the mockModels.NHL baseline (lines ~167-169):
  Before:
    const baselineConfidence = mockModels.NHL.confidence;
    const confidenceAdjustment = (weightedSum - 0.5) * 0.22;
    const confidence = clamp(baselineConfidence + confidenceAdjustment, 0.56, 0.78);
  After:
    const confidence = clamp(weightedSum, 0.50, 0.85);
  Why: weightedSum is already the sum of (score * weight) for all drivers. When all drivers are neutral (score=0.5) the weighted sum equals 0.5 exactly. Strong HOME signals push it above 0.5; strong AWAY signals push it below. Adding a baseline of 0.65 was shifting everything upward regardless of signal quality. The new clamp range is 0.50–0.85 to allow the full signal range to express.

Change 2 — Fix prediction direction (lines ~171-173):
  Before:
    const prediction = homeOdds !== null && awayOdds !== null
      ? (homeOdds < awayOdds ? 'HOME' : 'AWAY')
      : (confidence >= 0.64 ? 'HOME' : 'AWAY');
  After:
    const prediction = weightedSum > 0.5 ? 'HOME' : weightedSum < 0.5 ? 'AWAY' : 'NEUTRAL';
  Why: weightedSum encodes the net directional bias from all drivers. Values above 0.5 indicate HOME lean; below 0.5 indicate AWAY lean. The old logic used raw moneyline comparison which has nothing to do with driver signals.

These two changes are in computeNHLDrivers only. computeNHLDriverCards calls computeNHLDrivers so it will automatically benefit from the corrected composite result.
  </action>
  <verify>
Run from repo root:
  node -e "
    const m = require('./apps/worker/src/models/index.js');
    // Two games: one with strong HOME goalie delta, one with strong AWAY goalie delta
    const homeSnap = { raw_data: JSON.stringify({ goalie_home_gsax: 2.5, goalie_away_gsax: -1.0 }), h2h_home: 1.85, h2h_away: 2.10 };
    const awaySnap = { raw_data: JSON.stringify({ goalie_home_gsax: -1.5, goalie_away_gsax: 2.0 }), h2h_home: 1.85, h2h_away: 2.10 };
    const neutralSnap = {};
    const r1 = m.computeNHLDriverCards('g1', homeSnap)[0];
    const r2 = m.computeNHLDriverCards('g2', awaySnap)[0];
    const rn = m.computeNHLDriverCards('g3', neutralSnap);
    // Check composite via getInference
    const { getInference } = m;
    getInference('NHL', 'g1', homeSnap).then(r => console.log('HOME snap prediction:', r.prediction, 'conf:', r.confidence.toFixed(3)));
    getInference('NHL', 'g2', awaySnap).then(r => console.log('AWAY snap prediction:', r.prediction, 'conf:', r.confidence.toFixed(3)));
  "
Expected: HOME snap prints prediction HOME, AWAY snap prints prediction AWAY, and confidence values differ between the two.
  </verify>
  <done>computeNHLDrivers produces prediction and confidence derived entirely from weighted driver scores. mockModels.NHL.confidence is no longer referenced in the confidence calculation. The baselineConfidence and confidenceAdjustment variables are removed.</done>
</task>

<task type="auto">
  <name>Task 3: Fix getInference NBA fallback to use driver-derived confidence</name>
  <files>apps/worker/src/models/index.js</files>
  <action>
In getInference, the NBA fallback path (inside the `if (sport === 'NHL')` else branch) returns mockConfig.confidence directly. Since computeNBADriverCards already derives per-driver confidence from live signals (rest days, spread, lineup status), the fallback should aggregate those instead.

Change — Replace the non-NHL mock fallback with a driver-based path for NBA (and leave other sports as-is since they have no driver compute functions):

  Before (lines ~735-746):
    const confidence = mockConfig.confidence;
    const predictHome = homeOdds < awayOdds;
    return {
      prediction: predictHome ? 'HOME' : 'AWAY',
      confidence,
      ev_threshold_passed: confidence > 0.55,
      reasoning: `Model prefers ${predictHome ? 'HOME' : 'AWAY'} team at ${confidence.toFixed(2)} confidence`,
      inference_source: 'mock',
      model_endpoint: null,
      is_mock: true
    };

  After:
    if (sport === 'NBA') {
      const nbaCards = computeNBADriverCards(gameId, oddsSnapshot);
      if (nbaCards.length > 0) {
        // Aggregate: take the highest-confidence card as the representative signal
        const best = nbaCards.reduce((a, b) => b.confidence > a.confidence ? b : a);
        return {
          prediction: best.prediction,
          confidence: best.confidence,
          ev_threshold_passed: best.ev_threshold_passed,
          reasoning: best.reasoning,
          drivers: nbaCards,
          inference_source: 'mock',
          model_endpoint: null,
          is_mock: true
        };
      }
    }
    // Remaining sports (NFL, MLB, FPL) — keep mock constant fallback
    const confidence = mockConfig.confidence;
    const predictHome = homeOdds < awayOdds;
    return {
      prediction: predictHome ? 'HOME' : 'AWAY',
      confidence,
      ev_threshold_passed: confidence > 0.55,
      reasoning: `Model prefers ${predictHome ? 'HOME' : 'AWAY'} team at ${confidence.toFixed(2)} confidence`,
      inference_source: 'mock',
      model_endpoint: null,
      is_mock: true
    };

Note: The NBA runner (run_nba_model.js) calls computeNBADriverCards directly and does NOT use getInference — this change only affects any caller that goes through getInference('NBA', ...). It does NOT change how run_nba_model.js produces cards.
  </action>
  <verify>
Run from repo root:
  node -e "
    const { getInference } = require('./apps/worker/src/models/index.js');
    // NBA snap with B2B rest signal
    const snap = { raw_data: JSON.stringify({ rest_days_home: 2, rest_days_away: 0 }), spread_home: -3 };
    getInference('NBA', 'g1', snap).then(r => {
      console.log('NBA pred:', r.prediction, 'conf:', r.confidence.toFixed(3), 'is_mock:', r.is_mock);
      console.log('confidence is not 0.62:', r.confidence !== 0.62);
    });
  "
Expected: confidence does not equal 0.62 (the old hardcoded mockModels.NBA.confidence), and prediction reflects the driver signal direction.
  </verify>
  <done>getInference for NBA returns confidence derived from computeNBADriverCards output when driver signals are present. mockModels.NBA.confidence (0.62) is no longer used as the NBA return value in the mock fallback path.</done>
</task>

</tasks>

<verification>
Run existing model tests to confirm no regressions:
  cd /Users/ajcolubiale/projects/cheddar-logic && npx jest apps/worker/src/jobs/__tests__/run_nhl_model.test.js apps/worker/src/jobs/__tests__/run_nba_model.test.js --no-coverage 2>&1 | tail -20

All tests must pass. If tests assert exact confidence values that were previously hardcoded, update the assertions to accept a range (e.g., `toBeGreaterThan(0.50)`) rather than a specific constant.
</verification>

<success_criteria>
- computeNHLDriverCards: shotEnvironment, emptyNet, totalFragility all produce different confidence values for different input deltas
- computeNHLDrivers: confidence = clamp(weightedSum, 0.50, 0.85) with no mockModels.NHL.confidence reference in that calculation
- computeNHLDrivers: prediction = weightedSum > 0.5 ? 'HOME' : 'AWAY' (not odds comparison)
- getInference('NBA'): returns driver-derived confidence when NBA driver cards fire, not 0.62
- All existing jest tests pass
</success_criteria>

<output>
After completion, create .planning/quick/8-fix-driver-confidence-calculations-to-pr/8-SUMMARY.md
</output>
