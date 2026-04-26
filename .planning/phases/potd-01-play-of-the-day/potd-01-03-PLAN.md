---
phase: potd-01
plan: 03
type: execute
wave: 2
depends_on: ["potd-01-01", "potd-01-02"]
files_modified:
  - apps/worker/src/jobs/potd/run_potd_engine.js
  - apps/worker/src/jobs/potd/format-discord.js
  - apps/worker/src/jobs/potd/settlement-mirror.js
  - apps/worker/src/jobs/post_discord_cards.js
  - apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js
  - apps/worker/src/jobs/potd/__tests__/settlement-mirror.test.js
  - apps/worker/src/jobs/__tests__/post_discord_cards.test.js
autonomous: true

must_haves:
  truths:
    - "runPotdEngine fetches active-sport odds, scores candidates, writes potd tables, publishes a settlement-compatible potd-call, and posts Discord"
    - "the worker uses insertCardPayload, not raw card_payloads SQL, so the existing lock + card_results contract is preserved"
    - "bankroll is auto-seeded to $10 on first run if no bankroll rows exist"
    - "Discord posts use DISCORD_POTD_WEBHOOK_URL"
    - "generic Discord snapshot publishing excludes potd-call to avoid duplicate POTD posts"
    - "no-play days exit cleanly without writing a POTD row"
    - "settlement-mirror updates potd_plays and potd_bankroll from settled card_results rather than regrading games itself"
  artifacts:
    - path: "apps/worker/src/jobs/potd/run_potd_engine.js"
      provides: "runPotdEngine job function"
      exports: ["runPotdEngine"]
    - path: "apps/worker/src/jobs/potd/format-discord.js"
      provides: "formatPotdDiscordMessage"
      exports: ["formatPotdDiscordMessage"]
    - path: "apps/worker/src/jobs/potd/settlement-mirror.js"
      provides: "mirrorPotdSettlement job function"
      exports: ["mirrorPotdSettlement"]
  key_links:
    - from: "run_potd_engine.js"
      to: "@cheddar-logic/odds"
      via: "fetchOdds({ sport, hoursAhead: 24 })"
      pattern: "fetchOdds"
    - from: "run_potd_engine.js"
      to: "signal-engine.js"
      via: "require('./signal-engine')"
      pattern: "buildCandidates|scoreCandidate|selectBestPlay|kellySize"
    - from: "run_potd_engine.js"
      to: "potd_plays table"
      via: "db.prepare INSERT"
      pattern: "INSERT INTO potd_plays"
    - from: "run_potd_engine.js"
      to: "potd_bankroll table"
      via: "db.prepare INSERT"
      pattern: "INSERT INTO potd_bankroll"
    - from: "run_potd_engine.js"
      to: "@cheddar-logic/data"
      via: "insertCardPayload"
      pattern: "insertCardPayload"
    - from: "run_potd_engine.js"
      to: "post_discord_cards.js"
      via: "sendDiscordMessages({ webhookUrl, messages })"
      pattern: "sendDiscordMessages"
    - from: "post_discord_cards.js"
      to: "potd-call"
      via: "display filter excludes POTD-specific cards from generic snapshots"
      pattern: "potd-call"
---

<objective>
Build the worker-side POTD publish path and settlement mirror. The publish job creates the daily play and compatible `potd-call`; the mirror job copies settled `card_results` outcomes back into POTD tables.

Purpose: POTD must plug into the repo’s real settlement contract, not invent a parallel grading path.
Output: `run_potd_engine.js`, `format-discord.js`, `settlement-mirror.js`, the generic Discord exclusion update, and targeted worker tests.
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/phases/potd-01-play-of-the-day/potd-01-RESEARCH.md
@apps/worker/src/jobs/post_discord_cards.js (lines 645-660 for sendDiscordMessages pattern, lines 860-920 for job runner pattern)
@packages/odds/src/index.js (fetchOdds API)
@packages/odds/src/config.js (SPORTS_CONFIG for getActiveSports)
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create Discord formatter and publish job with explicit market-contract payloads</name>
  <files>apps/worker/src/jobs/potd/format-discord.js, apps/worker/src/jobs/potd/run_potd_engine.js</files>
  <action>
Create `apps/worker/src/jobs/potd/format-discord.js` and `apps/worker/src/jobs/potd/run_potd_engine.js`.

`formatPotdDiscordMessage(play)`:
- render a plain-text Discord message under 1800 chars
- show sport, matchup, pick, market/line/price, confidence, edge, wager, bankroll, and ET game time
- support `TOTAL`, `SPREAD`, and `MONEYLINE` picks

`runPotdEngine({ jobKey, dryRun = false })`:
- import active sports from `@cheddar-logic/odds/src/config`
- fetch `fetchOdds({ sport, hoursAhead: 24 })` for active sports only
- build and score candidates with plan 02 exports
- select best candidate at `HIGH` or above
- seed bankroll with an `initial` event if `potd_bankroll` is empty
- compute wager amount with quarter-Kelly / 20% cap
- on no-play or zero-wager, mark job success and exit without inserting a POTD row

When publishing a real play:
- insert a `potd_plays` row and zero-change `play_posted` bankroll row in one transaction
- create a settlement-compatible `potd-call` via `insertCardPayload`
- use `card_type='potd-call'`
- populate payload fields required by the existing market contract:
  `prediction`, `confidence`, `recommended_bet_type`, `generated_at`, `home_team`, `away_team`, `selection.side`, `market_type`, `line`, `price`, `odds_context`
- lock the payload shape exactly as follows:

For `TOTAL`:
```javascript
{
  prediction: 'OVER' | 'UNDER',
  confidence: <0..1>,
  recommended_bet_type: 'total',
  market_type: 'TOTAL',
  selection: { side: 'OVER' | 'UNDER' },
  line: <number>,
  price: <american odds>,
  odds_context: {
    total: <consensus or locked total>,
    total_price_over: <price>,
    total_price_under: <price>,
    captured_at: <iso>
  }
}
```

For `SPREAD`:
```javascript
{
  prediction: 'HOME' | 'AWAY',
  confidence: <0..1>,
  recommended_bet_type: 'spread',
  market_type: 'SPREAD',
  selection: { side: 'HOME' | 'AWAY', team: <home or away team name> },
  line: <number>,
  price: <american odds>,
  odds_context: {
    spread_home: <number>,
    spread_away: <number>,
    spread_price_home: <price>,
    spread_price_away: <price>,
    captured_at: <iso>
  }
}
```

For `MONEYLINE`:
```javascript
{
  prediction: 'HOME' | 'AWAY',
  confidence: <0..1>,
  recommended_bet_type: 'moneyline',
  market_type: 'MONEYLINE',
  selection: { side: 'HOME' | 'AWAY', team: <home or away team name> },
  line: null,
  price: <american odds>,
  odds_context: {
    h2h_home: <price>,
    h2h_away: <price>,
    captured_at: <iso>
  }
}
```

- keep `market_type` / `selection.side` valid for totals (`OVER`/`UNDER`) and side markets (`HOME`/`AWAY`)
- store the created card id in `potd_plays.card_id`
- post to Discord after DB commit; Discord failure is non-fatal and only affects the posted flags

Do not insert into `card_payloads` directly. Use the data package helper so `card_results` and locked market metadata stay correct.

Add a contract-focused test in `run-potd-engine.test.js` that publishes one POTD play for each supported market type and proves the resulting `card_results` row has the expected `market_type`, `selection`, `line`, and `locked_price`.
  </action>
  <verify>Load the module with `node -e "const m = require('./apps/worker/src/jobs/potd/run_potd_engine'); console.log(typeof m.runPotdEngine)"` and run the targeted publish-job test file.</verify>
  <done>The publish path writes POTD tables and a real `potd-call` through the existing data-layer contract.</done>
</task>

<task type="auto">
  <name>Task 2: Create settlement mirror, generic Discord exclusion, and worker regression tests</name>
  <files>apps/worker/src/jobs/potd/settlement-mirror.js, apps/worker/src/jobs/post_discord_cards.js, apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js, apps/worker/src/jobs/potd/__tests__/settlement-mirror.test.js, apps/worker/src/jobs/__tests__/post_discord_cards.test.js</files>
  <action>
Create `apps/worker/src/jobs/potd/settlement-mirror.js`:
- read settled `card_results` joined to `potd_plays` by `card_id`
- only process POTD rows that do not already have `result` / `settled_at`
- map `card_results.result` and `pnl_units`/locked price metadata into `potd_plays.result`, `potd_plays.settled_at`, and `potd_plays.pnl_dollars`
- append exactly one `result_settled` bankroll row per mirrored play
- stay idempotent on reruns

Update `apps/worker/src/jobs/post_discord_cards.js` so the generic card snapshot publisher excludes `card_type='potd-call'`. POTD must publish through `DISCORD_POTD_WEBHOOK_URL` only, never through the generic snapshot webhook.

Write worker tests covering:
- no-play day
- bankroll seed
- successful publish path producing `potd_plays`, `potd_bankroll`, and `potd-call`
- Discord failure stays non-fatal
- settlement mirror updates a published play once and only once
- generic Discord snapshot excludes `potd-call`
  </action>
  <verify>
Run the targeted worker tests for publish, settlement mirror, and generic Discord snapshot filtering. Also load the new modules with `node -e` requires.
  </verify>
  <done>The publish path and settlement mirror are both proven by focused worker tests.</done>
</task>

</tasks>

<verification>
1. Module loads without errors: `node -e "require('./apps/worker/src/jobs/potd/run_potd_engine')"`
2. Format function produces valid output: `node -e "const f = require('./apps/worker/src/jobs/potd/format-discord'); console.log(typeof f.formatPotdDiscordMessage)"`
3. Settlement mirror loads without errors: `node -e "const m = require('./apps/worker/src/jobs/potd/settlement-mirror'); console.log(typeof m.mirrorPotdSettlement)"`
4. `npm --prefix apps/worker run test -- --runInBand src/jobs/potd/__tests__/run-potd-engine.test.js`
5. `npm --prefix apps/worker run test -- --runInBand src/jobs/potd/__tests__/settlement-mirror.test.js`
6. `npm --prefix apps/worker run test -- --runInBand src/jobs/__tests__/post_discord_cards.test.js`
</verification>

<success_criteria>
- publish uses the repo’s actual lock/settlement contract
- POTD persists both its dedicated tables and a real `potd-call`
- settled card outcomes mirror back into POTD tables without double-counting
</success_criteria>

<output>
After completion, create `.planning/phases/potd-01-play-of-the-day/potd-01-03-SUMMARY.md`
</output>
