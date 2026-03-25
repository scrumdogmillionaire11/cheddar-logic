---
phase: mlb-model-port
plan: 02
type: execute
wave: 2
depends_on: [mlb-01]
files_modified:
  - apps/worker/src/models/mlb-model.js
autonomous: true
must_haves:
  truths:
    - "projectStrikeouts(pitcherStats, line, overlays) returns { prediction, edge, confidence, ev_threshold_passed, reasoning } using 70/30 weighted k9 + all 7 overlays."
    - "projectF5Total(homePitcher, awayPitcher) returns { prediction, edge, confidence, ev_threshold_passed, reasoning } using ERA-based formula + 4 overlays."
    - "computeMLBDriverCards(gameId, oddsSnapshot) returns array of card descriptors matching NBA driver card shape."
    - "OVER threshold: edge >= +1.0 AND confidence >= 8 for strikeouts; edge >= +0.5 for F5. UNDER: edge <= -1.0 / -0.7."
    - "Low-line guard: strikeout lines < 5.0 flagged as CAUTION (pass, reasoning includes flag)."
  artifacts:
    - path: "apps/worker/src/models/mlb-model.js"
      provides: "Pure arithmetic MLB model — no DB calls, no network, testable in isolation"
---

<objective>
Port the Python MLB model to a pure-arithmetic JS module.

Purpose: Replicate backtest-validated formulas for strikeout props and F5 totals. No ML, no API calls — pure math on pitcher stats read from oddsSnapshot.raw_data.mlb.
Output: apps/worker/src/models/mlb-model.js with three exported functions.
</objective>

<context>
@apps/worker/src/models/index.js
@apps/worker/src/models/nba-pace-synergy.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Implement projectStrikeouts</name>
  <files>apps/worker/src/models/mlb-model.js</files>
  <action>Create mlb-model.js. Implement projectStrikeouts:

```
function projectStrikeouts(pitcherStats, line, overlays = {}) {
  // Weighted K/9
  const seasonK9 = pitcherStats.k_per_9 ?? null;
  const recentK9 = pitcherStats.recent_k_per_9 ?? seasonK9;
  if (seasonK9 === null) return null; // no stats yet

  const k9 = 0.7 * seasonK9 + 0.3 * recentK9;
  const expectedIp = pitcherStats.recent_ip ?? 5.5;
  const opponentFactor = overlays.opponent_factor ?? 1.0;
  let base = (k9 * expectedIp) / 9 * opponentFactor;

  // Overlays (multiplicative, applied to base)
  const umpireFactor = overlays.umpire_factor ?? 1.0;
  if (umpireFactor > 1.08) base *= 1.05;
  else if (umpireFactor < 0.92) base *= 0.95;

  const trend = recentK9 / seasonK9; // recent vs season ratio
  if (trend > 1.15) base *= 1.03;
  else if (trend < 0.85) base *= 0.97;

  const wind = overlays.wind_mph ?? 0;
  if (wind > 15) base *= 1.02;

  const temp = overlays.temp_f ?? 72;
  if (temp < 50) base *= 1.02;
  else if (temp > 85) base *= 0.98;

  const edge = base - line;

  // Confidence 1-10
  let confidence = 5;
  const absEdge = Math.abs(edge);
  if (absEdge > 2.0) confidence += 3;
  else if (absEdge > 1.0) confidence += 2;
  else if (absEdge > 0.5) confidence += 1;

  const activeOverlays = [umpireFactor !== 1.0, trend > 1.15 || trend < 0.85, wind > 15, temp < 50 || temp > 85].filter(Boolean).length;
  confidence += Math.min(activeOverlays, 2);

  // Low-line caution
  if (line < 5.0) {
    return {
      prediction: 'PASS',
      edge,
      projected: base,
      confidence,
      ev_threshold_passed: false,
      reasoning: `CAUTION: low line (${line}) — accuracy degrades below 5.0K`,
    };
  }

  // Thresholds (backtest validated)
  const isOver = edge >= 1.0 && confidence >= 8;
  const isUnder = edge <= -1.0 && confidence >= 8;
  const prediction = isOver ? 'OVER' : isUnder ? 'UNDER' : 'PASS';

  return {
    prediction,
    edge,
    projected: base,
    confidence,
    ev_threshold_passed: isOver || isUnder,
    reasoning: `K/9=${k9.toFixed(2)} × IP=${expectedIp} → projected ${base.toFixed(1)} vs line ${line} (edge ${edge >= 0 ? '+' : ''}${edge.toFixed(1)}, conf ${confidence}/10)`,
  };
}
```</action>
  <verify>node -e "const {projectStrikeouts}=require('./apps/worker/src/models/mlb-model'); const r=projectStrikeouts({k_per_9:10,recent_k_per_9:11,recent_ip:6},6.5); console.log(r.prediction, r.ev_threshold_passed)"</verify>
  <done>Returns OVER with ev_threshold_passed=true for a dominant pitcher vs 6.5K line.</done>
</task>

<task type="auto">
  <name>Task 2: Implement projectF5Total</name>
  <files>apps/worker/src/models/mlb-model.js</files>
  <action>Add projectF5Total to mlb-model.js:

```
function projectF5Total(homePitcher, awayPitcher) {
  // Both pitchers required
  if (!homePitcher || !awayPitcher) return null;
  if (homePitcher.era == null || awayPitcher.era == null) return null;

  const LEAGUE_AVG_RPG = 4.5;
  const homeExpected = (awayPitcher.era + LEAGUE_AVG_RPG) / 2;
  const awayExpected = (homePitcher.era + LEAGUE_AVG_RPG) / 2;
  let base = (homeExpected + awayExpected) * (5 / 9);

  // WHIP overlay
  const avgWhip = ((homePitcher.whip ?? 1.25) + (awayPitcher.whip ?? 1.25)) / 2;
  if (avgWhip > 1.40) base *= 1.15;
  else if (avgWhip < 1.10) base *= 0.90;

  // K/9 overlay
  const avgK9 = ((homePitcher.k_per_9 ?? 8.5) + (awayPitcher.k_per_9 ?? 8.5)) / 2;
  if (avgK9 > 10.0) base *= 0.92;
  else if (avgK9 < 7.0) base *= 1.08;

  // Confidence 1-10
  let confidence = 5;
  if (homePitcher.era < 3.50 && awayPitcher.era < 3.50) confidence += 2;
  if ((homePitcher.whip ?? 1.25) < 1.20 && (awayPitcher.whip ?? 1.25) < 1.20) confidence += 1;
  if (homePitcher.era > 5.00 || awayPitcher.era > 5.00) confidence -= 2;
  if (Math.abs(homePitcher.era - awayPitcher.era) > 2.0) confidence -= 1;
  confidence = Math.max(1, Math.min(10, confidence));

  return { base, confidence, avgWhip, avgK9 };
}

function projectF5TotalCard(homePitcher, awayPitcher, f5Line) {
  const proj = projectF5Total(homePitcher, awayPitcher);
  if (!proj || f5Line == null) return null;

  const edge = proj.base - f5Line;
  const isOver = edge >= 0.5 && proj.confidence >= 8;
  const isUnder = edge <= -0.7 && proj.confidence >= 8;
  const prediction = isOver ? 'OVER' : isUnder ? 'UNDER' : 'PASS';

  return {
    prediction,
    edge,
    projected: proj.base,
    confidence: proj.confidence,
    ev_threshold_passed: isOver || isUnder,
    reasoning: `F5 projected ${proj.base.toFixed(2)} vs line ${f5Line} (edge ${edge >= 0 ? '+' : ''}${edge.toFixed(2)}, avgWHIP=${proj.avgWhip.toFixed(2)}, avgK9=${proj.avgK9.toFixed(1)}, conf ${proj.confidence}/10)`,
  };
}
```</action>
  <verify>node -e "const {projectF5Total}=require('./apps/worker/src/models/mlb-model'); const r=projectF5Total({era:2.8,whip:1.05,k_per_9:10.5},{era:2.9,whip:1.08,k_per_9:10.2}); console.log(r)"</verify>
  <done>Returns object with base, confidence >= 7 for two elite pitchers.</done>
</task>

<task type="auto">
  <name>Task 3: Implement computeMLBDriverCards</name>
  <files>apps/worker/src/models/mlb-model.js</files>
  <action>Add computeMLBDriverCards and module.exports:

```
function parseRawMlb(oddsSnapshot) {
  try {
    const raw = typeof oddsSnapshot?.raw_data === 'string'
      ? JSON.parse(oddsSnapshot.raw_data)
      : (oddsSnapshot?.raw_data ?? {});
    return raw?.mlb ?? {};
  } catch {
    return {};
  }
}

function computeMLBDriverCards(gameId, oddsSnapshot) {
  const mlb = parseRawMlb(oddsSnapshot);
  const cards = [];

  const homePitcher = mlb.home_pitcher ?? null;
  const awayPitcher = mlb.away_pitcher ?? null;

  // Strikeout card — home pitcher
  if (homePitcher && mlb.strikeout_lines?.home != null) {
    const result = projectStrikeouts(homePitcher, mlb.strikeout_lines.home);
    if (result) {
      cards.push({
        market: 'strikeouts_home',
        pitcher: oddsSnapshot?.home_team,
        prediction: result.prediction,
        confidence: result.confidence / 10, // normalize to 0-1
        ev_threshold_passed: result.ev_threshold_passed,
        reasoning: result.reasoning,
        drivers: [{ type: 'mlb-strikeout', edge: result.edge, projected: result.projected }],
      });
    }
  }

  // Strikeout card — away pitcher
  if (awayPitcher && mlb.strikeout_lines?.away != null) {
    const result = projectStrikeouts(awayPitcher, mlb.strikeout_lines.away);
    if (result) {
      cards.push({
        market: 'strikeouts_away',
        pitcher: oddsSnapshot?.away_team,
        prediction: result.prediction,
        confidence: result.confidence / 10,
        ev_threshold_passed: result.ev_threshold_passed,
        reasoning: result.reasoning,
        drivers: [{ type: 'mlb-strikeout', edge: result.edge, projected: result.projected }],
      });
    }
  }

  // F5 total card
  if (homePitcher && awayPitcher && mlb.f5_line != null) {
    const result = projectF5TotalCard(homePitcher, awayPitcher, mlb.f5_line);
    if (result) {
      cards.push({
        market: 'f5_total',
        prediction: result.prediction,
        confidence: result.confidence / 10,
        ev_threshold_passed: result.ev_threshold_passed,
        reasoning: result.reasoning,
        drivers: [{ type: 'mlb-f5', edge: result.edge, projected: result.projected }],
      });
    }
  }

  return cards;
}

module.exports = {
  projectStrikeouts,
  projectF5Total,
  projectF5TotalCard,
  computeMLBDriverCards,
};
```

Add `'use strict';` at top of file.</action>
  <verify>node -e "const {computeMLBDriverCards}=require('./apps/worker/src/models/mlb-model'); const snap={home_team:'NYY',away_team:'BOS',raw_data:{mlb:{home_pitcher:{k_per_9:10,recent_k_per_9:11,recent_ip:6,era:2.8,whip:1.05},away_pitcher:{k_per_9:7,recent_k_per_9:6.5,recent_ip:5,era:4.5,whip:1.4},strikeout_lines:{home:6.5,away:4.5},f5_line:4.5}}}; const r=computeMLBDriverCards('g1',snap); console.log(r.length, r.map(c=>c.prediction))"</verify>
  <done>Returns array with 3 cards (home K, away K, F5). Home K and/or F5 show OVER/UNDER for dominant home pitcher scenario.</done>
</task>

</tasks>

<verification>
- All three functions load without error
- projectStrikeouts with dominant pitcher (K9=10, line=6.5) → OVER
- projectF5Total with elite duo (ERA ~2.8) → confidence >= 7
- computeMLBDriverCards with full raw_data.mlb → array of cards
</verification>

<success_criteria>
- Pure arithmetic, no require of DB or network modules
- All thresholds match spec exactly (1.0K / 8-conf for Ks; 0.5/-0.7 for F5)
- low-line guard fires for line < 5.0
- confidence normalized to 0-1 in card output (÷10) to match NBA driver card shape
</success_criteria>

<output>
After completion, create `.planning/phases/mlb-model-port/mlb-02-SUMMARY.md`
</output>
