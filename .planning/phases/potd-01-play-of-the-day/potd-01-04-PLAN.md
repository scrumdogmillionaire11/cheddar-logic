---
phase: potd-01
plan: 04
type: execute
wave: 3
depends_on: ["potd-01-03"]
files_modified:
  - apps/worker/src/schedulers/main.js
  - apps/worker/.env.example
  - apps/worker/src/__tests__/scheduler-windows.test.js
autonomous: true

must_haves:
  truths:
    - "POTD engine enqueues once per day only after the computed dynamic target time is reached inside the 12:00-16:00 ET window"
    - "POTD job is completely disabled when ENABLE_POTD is absent or not 'true'"
    - "shouldRunJobKey with date-keyed job key prevents duplicate same-day publishes"
    - "settlement mirror runs downstream of canonical settlement jobs"
    - "new env vars are documented in .env.example"
  artifacts:
    - path: "apps/worker/src/schedulers/main.js"
      provides: "POTD job scheduling in computeDueJobs"
      contains: "run_potd_engine"
    - path: "apps/worker/.env.example"
      provides: "POTD env var documentation"
      contains: "ENABLE_POTD"
  key_links:
    - from: "main.js"
      to: "run_potd_engine.js"
      via: "require('../jobs/potd/run_potd_engine')"
      pattern: "runPotdEngine"
    - from: "main.js"
      to: "settlement-mirror.js"
      via: "require('../jobs/potd/settlement-mirror')"
      pattern: "mirrorPotdSettlement"
    - from: "main.js"
      to: "shouldRunJobKey"
      via: "potd|YYYY-MM-DD job key"
      pattern: "potd\\|"
---

<objective>
Wire the POTD publish job and settlement mirror into the scheduler. Preserve the user’s dynamic 12–4 PM ET timing rather than collapsing to a fixed noon post.

Purpose: Scheduler timing is a product contract for POTD, not an implementation detail.
Output: Updated main.js with POTD scheduling block + documented env vars.
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/phases/potd-01-play-of-the-day/potd-01-RESEARCH.md
@apps/worker/src/schedulers/main.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add dynamic POTD publish + mirror scheduling to main.js</name>
  <files>apps/worker/src/schedulers/main.js</files>
  <action>
Make the following changes to `apps/worker/src/schedulers/main.js`:

1. Add imports for:
```javascript
const { runPotdEngine } = require('../jobs/potd/run_potd_engine');
const { mirrorPotdSettlement } = require('../jobs/potd/settlement-mirror');
```

2. Add `ENABLE_POTD` near the other env-derived flags:
```javascript
const ENABLE_POTD = process.env.ENABLE_POTD === 'true';
```

3. Add a helper in `main.js` or a local computation block that:
- inspects `games` already passed into `computeDueJobs`
- filters to sports returned by `enabledSports()` / active odds-backed sports
- derives the earliest game today in ET
- computes `target_post_time_et = clamp(earliest_game_et - 90 minutes, 12:00, 16:00)`
- returns `null` if there is no eligible game for today

4. In `computeDueJobs()`, enqueue `run_potd_engine` only when:
- `ENABLE_POTD`
- a target post time exists
- `nowEt >= target_post_time_et`
- `nowEt <= 16:00 ET`

Use job key:
```javascript
const jobKey = `potd|${nowEt.toISODate()}`;
```

Pass the computed schedule metadata into the job args so logging can report the target/actual post time.

5. Register the settlement mirror after `computeSettlementDueJobs(...)` has contributed its jobs. Use a date/hour-scoped key so the mirror can run repeatedly after settlement windows without colliding with publish keys.

6. Add POTD status to the startup banner:
```javascript
  console.log(`  ENABLE_POTD=${ENABLE_POTD}`);
```

Write scheduler-window tests in `apps/worker/src/__tests__/scheduler-windows.test.js` covering:
- before computed target time -> POTD publish job NOT in due jobs
- exactly at target time -> POTD publish job IS in due jobs
- after target time but before 16:00 ET -> POTD publish job IS in due jobs if not yet successful
- after a successful same-day publish -> no duplicate POTD publish enqueue
- settlement mirror job queued only after canonical settlement jobs are due
  </action>
  <verify>npm --prefix apps/worker run test:scheduler:windows</verify>
  <done>Scheduler behavior matches the dynamic publish contract instead of a simplified fixed noon post.</done>
</task>

<task type="auto">
  <name>Task 2: Document new env vars in .env.example</name>
  <files>apps/worker/.env.example</files>
  <action>
Add the following block to `apps/worker/.env.example` (at the end, or in a logical section near other feature flags):

```bash
# ── POTD (Play of the Day) ──────────────────────────────
ENABLE_POTD=false
DISCORD_POTD_WEBHOOK_URL=
POTD_KELLY_FRACTION=0.25
POTD_MAX_WAGER_PCT=0.20
POTD_STARTING_BANKROLL=10.00
```

If the file doesn't exist, check for `.env.example` at the project root and add there instead. If neither exists, create `apps/worker/.env.example` with just this block plus a comment header.

Also check if `web/.env.example` or a root `.env.example` exists — if so, add `ENABLE_POTD=false` and `DISCORD_POTD_WEBHOOK_URL=` there too (these are worker vars but documenting them centrally is helpful).
  </action>
  <verify>Run `grep ENABLE_POTD apps/worker/.env.example` — should find the line.</verify>
  <done>All POTD env vars are documented with defaults and no unrelated env config changes are made.</done>
</task>

</tasks>

<verification>
1. Scheduler loads without errors: `node -e "require('./apps/worker/src/schedulers/main')"`
2. Before target time, due jobs do NOT include `run_potd_engine`
3. At target time, due jobs DO include `run_potd_engine`
4. After same-day success, due jobs do NOT include a duplicate publish
5. Existing scheduler tests still pass: `npm --prefix apps/worker run test:scheduler:windows`
</verification>

<success_criteria>
- POTD fires only after the dynamic target time within the 12-4PM ET window
- POTD completely absent when ENABLE_POTD is not 'true'
- Date-keyed publish key prevents duplicate same-day posts
- Settlement mirror runs downstream of canonical settlement
- Env vars documented
</success_criteria>

<output>
After completion, create `.planning/phases/potd-01-play-of-the-day/potd-01-04-SUMMARY.md`
</output>
