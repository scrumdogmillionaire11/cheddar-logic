---
phase: potd-01
plan: 05
type: execute
wave: 4
depends_on: ["potd-01-01", "potd-01-03", "potd-01-04"]
files_modified:
  - web/src/app/api/potd/route.ts
  - web/src/app/play-of-the-day/page.tsx
  - web/src/components/play-of-the-day-client.tsx
  - web/src/app/page.tsx
  - web/src/__tests__/api-potd.test.js
  - web/src/__tests__/ui-potd-smoke.test.js
autonomous: true

must_haves:
  truths:
    - "GET /api/potd returns today's play, history, bankroll summary, and a deterministic schedule object from read-only DB queries"
    - "/play-of-the-day renders empty, posted, and settled-history states without any web-side DB writes"
    - "homepage navigation links to /play-of-the-day"
    - "potd-call remains visible on the existing cards surface"
  artifacts:
    - path: "web/src/app/api/potd/route.ts"
      provides: "read-only POTD API route"
      contains: "export async function GET"
    - path: "web/src/app/play-of-the-day/page.tsx"
      provides: "POTD page entrypoint"
      contains: "force-dynamic"
    - path: "web/src/components/play-of-the-day-client.tsx"
      provides: "POTD client rendering"
      contains: "use client"
  key_links:
    - from: "route.ts"
      to: "potd_plays"
      via: "read-only SQL query"
      pattern: "potd_plays"
    - from: "route.ts"
      to: "potd_bankroll"
      via: "bankroll summary query"
      pattern: "potd_bankroll"
    - from: "route.ts"
      to: "games table or read-only upcoming-games query"
      via: "schedule object is computed from today's eligible games when no play row exists yet"
      pattern: "games"
---

<objective>
Build the web read surface for POTD: a new API route, a new page, and homepage navigation.

Purpose: POTD is worker-written and web-read-only. This plan exposes the data without introducing any web-side DB writes or auth work.
Output: `/api/potd`, `/play-of-the-day`, a homepage link, and focused web tests with a locked schedule contract.
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/phases/potd-01-play-of-the-day/potd-01-RESEARCH.md
@web/src/app/cards/page.tsx
@web/src/app/api/cards/route.ts
@web/src/components/sticky-back-button.tsx
@web/src/app/page.tsx
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add read-only /api/potd route</name>
  <files>web/src/app/api/potd/route.ts, web/src/__tests__/api-potd.test.js</files>
  <action>
Create `web/src/app/api/potd/route.ts` following the existing App Router API pattern:
- `runtime = 'nodejs'`
- security checks via the existing API-security helpers
- `ensureDbReady()`
- `getDatabaseReadOnly()` with `closeReadOnlyInstance(...)` in `finally`

Response shape:
```json
{
  "success": true,
  "data": {
    "today": {},
    "history": [],
    "bankroll": {
      "current": 10,
      "startingBankroll": 10,
      "totalReturnPct": 0,
      "record": { "wins": 0, "losses": 0, "pushes": 0 }
    },
    "schedule": {
      "playDate": "YYYY-MM-DD",
      "targetPostTimeEt": "2026-04-08T16:00:00.000-04:00",
      "status": "pending|posted|no_play|no_games"
    }
  }
}
```

Implementation notes:
- `today` should return the current ET play row if one exists
- `history` should return recent POTD rows ordered descending by `play_date`
- `bankroll` should derive current balance from the latest ledger row and record from `potd_plays.result`
- `schedule` must be computed deterministically on every request using the same rule as the scheduler:
  - derive today’s earliest eligible active-sport game in ET
  - compute `targetPostTimeEt = clamp(earliest_game_et - 90m, 12:00, 16:00)`
  - if there are no eligible games today, return `targetPostTimeEt = null` and `status = 'no_games'`
  - if today already has a `potd_plays` row, return `status = 'posted'`
  - if there is no row and current ET time is before `targetPostTimeEt`, return `status = 'pending'`
  - if there is no row and current ET time is at/after `targetPostTimeEt`, return `status = 'no_play'`

Add `web/src/__tests__/api-potd.test.js` to cover:
- empty DB / no-play-yet response
- posted play response
- settled history / bankroll summary response
- no-games schedule response
- pending vs no_play schedule state around the computed target time
  </action>
  <verify>Run `node web/src/__tests__/api-potd.test.js` and confirm the route returns the documented JSON shape for empty and seeded states.</verify>
  <done>The API route is read-only, closes DB handles correctly, and returns a stable POTD response contract.</done>
</task>

<task type="auto">
  <name>Task 2: Add /play-of-the-day page and homepage navigation</name>
  <files>web/src/app/play-of-the-day/page.tsx, web/src/components/play-of-the-day-client.tsx, web/src/app/page.tsx, web/src/__tests__/ui-potd-smoke.test.js</files>
  <action>
Create the page and client rendering:

1. `web/src/app/play-of-the-day/page.tsx`
- mirror the existing cards-page pattern with `runtime = 'nodejs'` and `dynamic = 'force-dynamic'`
- return a dedicated POTD client component
- use `closeDatabaseReadOnly()` in `finally`

2. `web/src/components/play-of-the-day-client.tsx`
- client component that fetches `/api/potd`
- render:
  - sticky back button
  - today’s play card when present
  - “No play yet today” / no-play state
  - bankroll summary and record
  - history table/list for recent POTD rows
- use the existing site palette/panel styles already present in the cards/results surfaces

3. `web/src/app/page.tsx`
- add a homepage nav link to `/play-of-the-day`

4. `web/src/__tests__/ui-potd-smoke.test.js`
- smoke test empty state
- smoke test posted-state rendering
- smoke test settled-history rendering

Do not introduce auth, feature walls, or web-side writes. POTD should coexist with the current cards surface rather than replacing it.
  </action>
  <verify>Run `node web/src/__tests__/ui-potd-smoke.test.js` and `npm --prefix web run test:ui:cards`.</verify>
  <done>The page is reachable from home, renders POTD data cleanly, and leaves the rest of the cards surface intact.</done>
</task>

</tasks>

<verification>
```bash
node web/src/__tests__/api-potd.test.js
node web/src/__tests__/ui-potd-smoke.test.js
npm --prefix web run test:ui:cards
```
</verification>

<success_criteria>
- `/api/potd` is a stable, read-only JSON surface
- `/play-of-the-day` renders current play, empty state, bankroll, and history
- homepage links to the new page
- no auth or web-side DB writes are added
</success_criteria>

<output>
After completion, create `.planning/phases/potd-01-play-of-the-day/potd-01-05-SUMMARY.md`
</output>
