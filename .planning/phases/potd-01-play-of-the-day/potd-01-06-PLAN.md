---
phase: potd-01-play-of-the-day
plan: "06"
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/jobs/potd/settlement-mirror.js
  - apps/worker/package.json
  - .env
  - .env.example
autonomous: true
gap_closure: true

must_haves:
  truths:
    - "settlement-mirror.js can be invoked directly via node src/jobs/potd/settlement-mirror.js"
    - "npm run job:run-potd-engine triggers run_potd_engine.js directly"
    - "npm run job:potd-settlement-mirror triggers settlement-mirror.js directly"
    - "ENABLE_POTD=true in .env so scheduler POTD block activates"
    - "DISCORD_POTD_WEBHOOK_URL stub exists in .env.example as a reminder"
  artifacts:
    - path: "apps/worker/src/jobs/potd/settlement-mirror.js"
      provides: "require.main guard for direct invocation"
      contains: "require.main === module"
    - path: "apps/worker/package.json"
      provides: "job:run-potd-engine and job:potd-settlement-mirror scripts"
    - path: ".env"
      provides: "ENABLE_POTD=true"
    - path: ".env.example"
      provides: "ENABLE_POTD and DISCORD_POTD_WEBHOOK_URL stubs"
  key_links:
    - from: "package.json job:run-potd-engine"
      to: "src/jobs/potd/run_potd_engine.js"
      via: "node invocation"
    - from: "package.json job:potd-settlement-mirror"
      to: "src/jobs/potd/settlement-mirror.js"
      via: "node invocation"
    - from: "ENABLE_POTD=true"
      to: "schedulers/main.js POTD block"
      via: "process.env.ENABLE_POTD === 'true'"
---

<objective>
Close three missing wiring gaps that block POTD going live: settlement-mirror can't be triggered manually, the npm scripts don't exist, and the scheduler kill-switch env var is unset.

Purpose: Without these, ENABLE_POTD is always false so the scheduler never fires the engine, and there's no way to trigger either POTD job manually for smoke testing.
Output: Both POTD jobs invocable via npm, ENABLE_POTD active in dev, .env.example documents the two new vars.
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/phases/potd-01-play-of-the-day/potd-01-VERIFICATION.md
@apps/worker/src/jobs/potd/run_potd_engine.js
@apps/worker/src/jobs/potd/settlement-mirror.js
@apps/worker/package.json
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add require.main guard to settlement-mirror.js + npm scripts</name>
  <files>
    apps/worker/src/jobs/potd/settlement-mirror.js
    apps/worker/package.json
  </files>
  <action>
    1. In `settlement-mirror.js`, add a `require.main === module` guard immediately before `module.exports`:

    ```js
    if (require.main === module) {
      mirrorPotdSettlement().then(console.log).catch(console.error);
    }
    ```

    NOTE: `settlement-mirror.js` does NOT import `createJob` — use the inline invocation above. Do not add a `createJob` import; it is not part of this file's pattern.

    2. In `apps/worker/package.json`, add two scripts alongside the existing `job:settle-*` entries (after `job:settle-cards`):
    ```json
    "job:run-potd-engine": "node src/jobs/potd/run_potd_engine.js",
    "job:potd-settlement-mirror": "node src/jobs/potd/settlement-mirror.js",
    ```
  </action>
  <verify>
    node -e "require('./apps/worker/src/jobs/potd/settlement-mirror.js')" — no crash
    grep "job:run-potd-engine\|job:potd-settlement-mirror" apps/worker/package.json — both present
  </verify>
  <done>
    Both scripts exist in package.json. settlement-mirror.js has a require.main guard. npm run job:run-potd-engine and npm run job:potd-settlement-mirror resolve without "not found" errors.
  </done>
</task>

<task type="auto">
  <name>Task 2: Set ENABLE_POTD in .env and create .env.example stubs</name>
  <files>
    .env
    .env.example
  </files>
  <action>
    1. In `.env`, append after the existing `DISCORD_CARD_WEBHOOK_*` block (around line 92):
    ```
    ENABLE_POTD=true
    DISCORD_POTD_WEBHOOK_URL=
    ```
    Leave `DISCORD_POTD_WEBHOOK_URL` blank — it's non-fatal if unset; the actual webhook URL is a secret the human provides.

    2. Create `.env.example` (it doesn't exist yet) with just the two POTD vars as a stub. Do NOT copy secrets from `.env` — this file is for documentation only:
    ```
    # POTD (Play of the Day)
    # Set to true to enable the scheduler's POTD block
    ENABLE_POTD=false
    # Discord webhook for POTD announcements — non-fatal if unset
    DISCORD_POTD_WEBHOOK_URL=
    ```
  </action>
  <verify>
    grep "ENABLE_POTD" .env — returns "ENABLE_POTD=true"
    cat .env.example — shows both POTD vars, no secrets
  </verify>
  <done>
    ENABLE_POTD=true is in .env. .env.example exists with POTD stubs and no secrets. Scheduler will now enter the POTD block on next run.
  </done>
</task>

</tasks>

<verification>
set -a; source .env; set +a
grep "ENABLE_POTD" .env
grep "job:run-potd-engine\|job:potd-settlement-mirror" apps/worker/package.json
grep "require.main" apps/worker/src/jobs/potd/settlement-mirror.js
npm --prefix apps/worker run job:run-potd-engine -- --dry-run 2>&1 | head -5
</verification>

<success_criteria>
- Both npm scripts present and invoke correct files
- settlement-mirror.js has require.main guard
- ENABLE_POTD=true in .env
- .env.example exists with POTD stubs (no secrets)
- Scheduler log line "ENABLE_POTD=true" visible when main.js starts
</success_criteria>

<output>
After completion, create `.planning/phases/potd-01-play-of-the-day/potd-01-06-SUMMARY.md`
</output>
