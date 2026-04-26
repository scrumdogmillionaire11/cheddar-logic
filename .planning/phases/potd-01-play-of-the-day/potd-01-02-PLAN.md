---
phase: potd-01
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/jobs/potd/signal-engine.js
  - apps/worker/src/jobs/potd/__tests__/signal-engine.test.js
autonomous: true

must_haves:
  truths:
    - "the signal engine generates candidate picks for spreads, totals, and moneylines from normalized odds"
    - "candidate scoring uses only lineValue and marketConsensus with weights 0.625 and 0.375"
    - "selectBestPlay() returns the top safe positive-edge candidate above HIGH threshold"
    - "kellySize() computes quarter-Kelly with a 20% bankroll cap"
    - "confidence labels are ELITE >= 0.75 and HIGH >= 0.50"
  artifacts:
    - path: "apps/worker/src/jobs/potd/signal-engine.js"
      provides: "candidate generation, scoring, selection, and Kelly sizing exports"
      exports: ["buildCandidates", "scoreCandidate", "selectBestPlay", "kellySize"]
    - path: "apps/worker/src/jobs/potd/__tests__/signal-engine.test.js"
      provides: "Unit tests for signal engine"
      contains: "describe.*signal"
  key_links:
    - from: "signal-engine.js"
      to: "fetchOdds output"
      via: "buildCandidates takes normalized game objects from @cheddar-logic/odds"
      pattern: "markets\\.(h2h|spreads|totals)"
---

<objective>
Build the pure POTD signal engine: candidate generation, scoring, selection, and Kelly sizing. This module must accept normalized odds data and produce a publishable candidate without any DB or network access.

Purpose: The signal engine is the POTD decision layer. It must work across the real market shapes in this repo, including NHL totals-only games.
Output: A tested JS module at `apps/worker/src/jobs/potd/signal-engine.js` with unit tests.
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/phases/potd-01-play-of-the-day/potd-01-RESEARCH.md
@packages/odds/src/config.js
@packages/odds/src/normalize.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create signal-engine.js with candidate generation, scoring, selection, and Kelly sizing</name>
  <files>apps/worker/src/jobs/potd/signal-engine.js</files>
  <action>
Create `apps/worker/src/jobs/potd/signal-engine.js`. This is a pure computation module with no DB, fetch, or side effects.

Exports:
- `buildCandidates(game)` → candidate array
- `scoreCandidate(candidate)` → scored candidate
- `selectBestPlay(scoredCandidates, { minConfidence })` → best candidate or `null`
- `kellySize({ edgePct, impliedProb, bankroll, kellyFraction, maxWagerPct })`
- helpers as needed (`americanToImplied`, `removeVig`, etc.)

Implementation requirements:

1. `buildCandidates(game)` must generate:
```javascript
{
  gameId, sport, home_team, away_team, commence_time,
  marketType: 'SPREAD' | 'TOTAL' | 'MONEYLINE',
  selection: 'HOME' | 'AWAY' | 'OVER' | 'UNDER',
  selectionLabel: string,
  line: number | null,
  price: number,
  oddsContext: object,
  consensusLine: number | null,
  consensusPrice: number | null
}
```
Generate every actionable candidate supported by the game’s markets:
- spreads → `HOME` and `AWAY`
- totals → `OVER` and `UNDER`
- moneyline → `HOME` and `AWAY`
Skip malformed or price-missing rows.

2. `scoreCandidate(candidate)` must compute:
- `lineValue`: bettor-favorable best line/price versus consensus for the exact outcome
- `marketConsensus`: low cross-book dispersion on that same outcome
- `totalScore = lineValue * 0.625 + marketConsensus * 0.375`
- `modelWinProb`: vig-removed fair probability from consensus price
- `impliedProb`: locked-book implied probability from the chosen price
- `edgePct = modelWinProb - impliedProb`
- `confidenceLabel`: `ELITE >= 0.75`, `HIGH >= 0.50`, else rejectable/low

Line-value guidance:
- For spreads/totals, prefer better numbers first, then better prices when numbers tie.
- For moneyline, compare best price against consensus price directly.
- Convert prices to implied probability and normalize value to a bounded 0-1 scale. Document the chosen normalization in comments/tests.

Market-consensus guidance:
- Use dispersion/tightness across the candidate’s comparable book rows, not simple vote-counting on favorites.
- Lower dispersion should produce a higher score.

3. `selectBestPlay(...)` must:
- discard non-positive-edge candidates
- discard candidates below minimum confidence
- sort by `totalScore` desc, then `edgePct` desc
- return the top candidate or `null`

4. `kellySize(...)` must implement quarter-Kelly capped at 20% bankroll and return zero for non-positive edge or invalid implied probability.
  </action>
  <verify>Run `node -e "const se = require('./apps/worker/src/jobs/potd/signal-engine'); console.log(Object.keys(se));"` and confirm the candidate/scoring/Kelly exports exist.</verify>
  <done>The module supports totals, spreads, and moneyline candidates and does not require DB/network access.</done>
</task>

<task type="auto">
  <name>Task 2: Write unit tests for signal engine</name>
  <files>apps/worker/src/jobs/potd/__tests__/signal-engine.test.js</files>
  <action>
Create unit tests at `apps/worker/src/jobs/potd/__tests__/signal-engine.test.js`. Use the existing test runner (jest, based on the `__tests__` convention in the worker jobs directory).

Cover at least:
- spread candidate generation
- total candidate generation
- moneyline candidate generation
- malformed game with no actionable markets returns empty array
- positive-edge candidate beats negative-edge candidate
- HIGH and ELITE thresholds
- Kelly zero-floor and 20% cap
- a realistic NHL totals-only game path
  </action>
  <verify>Run `npx jest apps/worker/src/jobs/potd/__tests__/signal-engine.test.js --verbose` — all tests pass.</verify>
  <done>Tests prove candidate generation and scoring behave correctly across spread, total, and moneyline inputs.</done>
</task>

</tasks>

<verification>
```bash
npx jest apps/worker/src/jobs/potd/__tests__/signal-engine.test.js --verbose
```
All tests green, no warnings.
</verification>

<success_criteria>
- the engine can score the actual market shapes available in this repo
- totals-only NHL games remain eligible for POTD
- positive-edge filtering and Kelly guardrails are covered by tests
</success_criteria>

<output>
After completion, create `.planning/phases/potd-01-play-of-the-day/potd-01-02-SUMMARY.md`
</output>
