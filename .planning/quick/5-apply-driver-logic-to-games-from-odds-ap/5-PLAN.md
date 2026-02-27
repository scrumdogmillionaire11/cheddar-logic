---
phase: quick-5
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - web/src/app/api/games/route.ts
  - web/src/app/cards/page.tsx
autonomous: true
requirements: [QUICK-5]

must_haves:
  truths:
    - "Running the NHL, NBA, and NCAAM model jobs generates driver cards in card_payloads for currently ingested games"
    - "/api/games returns a plays array per game (driver cards from card_payloads) alongside odds"
    - "The /cards page shows play calls (prediction, confidence, tier, reasoning) for each game that has driver cards"
  artifacts:
    - path: "web/src/app/api/games/route.ts"
      provides: "GET /api/games with plays JOIN from card_payloads"
      contains: "card_payloads"
    - path: "web/src/app/cards/page.tsx"
      provides: "Renders play calls per game card"
      contains: "plays"
  key_links:
    - from: "web/src/app/cards/page.tsx"
      to: "/api/games"
      via: "fetch in useEffect"
      pattern: "fetch.*api/games"
    - from: "web/src/app/api/games/route.ts"
      to: "card_payloads"
      via: "LEFT JOIN"
      pattern: "card_payloads"
---

<objective>
Run driver model jobs for active sports (NHL, NBA, NCAAM) against currently ingested games, then surface the generated play calls in the /cards UI.

Purpose: The odds API has 25+ real games ingested. The driver logic (NHL: goalie, special teams, PDO, xGF, etc; NBA: rest, travel, matchup-style, blowout-risk) exists and is correct but produces no visible output in the current /cards page. This task closes that loop — model runs produce cards, cards appear next to each game.

Output: /cards page shows prediction + confidence + tier + reasoning for each game where driver logic fires.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/quick/4-ensure-all-games-from-odds-api-display-a/4-SUMMARY.md

@apps/worker/src/models/index.js
@apps/worker/src/jobs/run_nhl_model.js
@apps/worker/src/jobs/run_nba_model.js
@apps/worker/src/jobs/run_ncaam_model.js
@web/src/app/api/games/route.ts
@web/src/app/cards/page.tsx
</context>

<tasks>

<task type="auto">
  <name>Task 1: Run model jobs for active sports to populate card_payloads</name>
  <files>apps/worker/src/jobs/run_nhl_model.js, apps/worker/src/jobs/run_nba_model.js, apps/worker/src/jobs/run_ncaam_model.js</files>
  <action>
    Run the three active-season model jobs via CLI to populate card_payloads from the currently ingested games in the DB. Each job reads from getOddsWithUpcomingGames(), runs driver logic, and inserts into card_payloads with idempotency (prepareModelAndCardWrite + insertCardPayload).

    Execute from the monorepo root (where package.json scripts exist for each job):

    ```bash
    cd /Users/ajcolubiale/projects/cheddar-logic
    node apps/worker/src/jobs/run_nhl_model.js
    node apps/worker/src/jobs/run_nba_model.js
    node apps/worker/src/jobs/run_ncaam_model.js
    ```

    After each run, log the cardsGenerated count from the result. If a sport returns cardsGenerated: 0 because no upcoming games exist within the 36-hour horizon, that is expected — note it and continue.

    Do NOT modify the job files. Do NOT add dryRun. Just execute as-is.
  </action>
  <verify>
    Each job exits with code 0. At least one of the three produces cardsGenerated > 0. Check by running:
    ```bash
    node -e "
      const { initDb, getDatabase, closeDatabase } = require('./packages/data/src/db.js');
      initDb();
      const db = getDatabase();
      const rows = db.prepare('SELECT sport, card_type, COUNT(*) as cnt FROM card_payloads GROUP BY sport, card_type').all();
      console.log(JSON.stringify(rows, null, 2));
      closeDatabase();
    "
    ```
    Output shows rows for nhl, nba, or ncaam card types.
  </verify>
  <done>card_payloads table has rows for at least one active sport. Model jobs exit 0.</done>
</task>

<task type="auto">
  <name>Task 2: Extend /api/games to return driver play calls per game</name>
  <files>web/src/app/api/games/route.ts</files>
  <action>
    Modify the existing GET handler in `web/src/app/api/games/route.ts` to include driver-generated play calls alongside each game. Add a second query that LEFT JOINs card_payloads to the games result, returning all active (non-expired) play calls grouped per game_id.

    The response shape change: each game object gets a new `plays` field — an array of play call objects (empty array when no cards exist). This is additive and does NOT break the existing odds shape.

    New play object shape (from card_payloads.payload_data JSON):
    ```ts
    {
      cardType: string,           // e.g. "nhl-goalie", "nba-rest-advantage"
      cardTitle: string,
      prediction: 'HOME' | 'AWAY' | 'NEUTRAL',
      confidence: number,         // 0-1
      tier: 'SUPER' | 'BEST' | 'WATCH' | null,
      reasoning: string,
      evPassed: boolean,
      driverKey: string           // from driver.key in payload_data
    }
    ```

    Implementation approach in the route handler:
    1. After the existing CTE+LEFT JOIN games query runs, fetch card_payloads for those game IDs:
       ```sql
       SELECT game_id, card_type, card_title, payload_data
       FROM card_payloads
       WHERE game_id IN (/* game IDs from step 1 */)
         AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY created_at DESC
       ```
    2. Parse `payload_data` JSON (it is stored as a JSON string). Extract: prediction, confidence, tier, reasoning, ev_passed, driver.key.
    3. Group by game_id into a Map. Attach `plays: []` (or the array) to each game in the response.

    Use the same `db.prepare(...).all()` pattern already in the route. Parse payload_data with `JSON.parse()` wrapped in try/catch — skip malformed rows silently.

    The existing `initDb` / `getDatabase` / `closeDatabase` pattern and try/catch/finally block must be preserved exactly.

    TypeScript: add a `Play` interface and add `plays: Play[]` to the `Game` interface in the route file. Do NOT use `any`.
  </action>
  <verify>
    ```bash
    cd /Users/ajcolubiale/projects/cheddar-logic/web && npx tsc --noEmit
    ```
    Zero TypeScript errors in route.ts (pre-existing .next/dev/types error is not in this file).

    Then:
    ```bash
    curl -s http://localhost:3000/api/games | node -e "
      const chunks = [];
      process.stdin.on('data', c => chunks.push(c));
      process.stdin.on('end', () => {
        const r = JSON.parse(Buffer.concat(chunks).toString());
        const withPlays = r.data.filter(g => g.plays && g.plays.length > 0);
        console.log('Games with plays:', withPlays.length);
        if (withPlays[0]) console.log('Sample play:', JSON.stringify(withPlays[0].plays[0], null, 2));
      });
    "
    ```
    At least one game has plays.length > 0.
  </verify>
  <done>GET /api/games returns plays array per game. At least one game has driver play cards. TypeScript compiles clean.</done>
</task>

<task type="auto">
  <name>Task 3: Show play calls on the /cards page</name>
  <files>web/src/app/cards/page.tsx</files>
  <action>
    Update `web/src/app/cards/page.tsx` to render driver play calls for each game card. The `GameData` interface already has the odds shape — extend it with `plays: Play[]`.

    Add `Play` interface to the file:
    ```ts
    interface Play {
      cardType: string;
      cardTitle: string;
      prediction: 'HOME' | 'AWAY' | 'NEUTRAL';
      confidence: number;
      tier: 'SUPER' | 'BEST' | 'WATCH' | null;
      reasoning: string;
      evPassed: boolean;
      driverKey: string;
    }
    ```

    Add `plays: Play[]` to `GameData` (default to empty array if undefined to handle games with no plays).

    In the card render, below the odds section, add a "Plays" section that renders when `game.plays.length > 0`:
    - Section header: "Driver Plays" (small caps or muted label)
    - For each play, show a compact row:
      - Tier badge: SUPER (green), BEST (blue), WATCH (yellow), null (gray/none)
      - Prediction badge: HOME / AWAY / NEUTRAL
      - Confidence as percentage: e.g. "72%"
      - Card title (e.g. "NHL Goalie Edge: HOME")
      - Reasoning text in small/muted font below the title row

    Use Tailwind. Match the existing card styling patterns already in the file (border, rounded, text-sm, text-gray, flex, gap). No new dependencies.

    When `game.plays` is empty (or undefined), show nothing — no "No plays" message needed, the odds card already stands on its own.
  </action>
  <verify>
    ```bash
    cd /Users/ajcolubiale/projects/cheddar-logic/web && npx tsc --noEmit
    ```
    Zero TypeScript errors in page.tsx.

    Visit http://localhost:3000/cards in browser. At least one game card shows a "Driver Plays" section with tier badge, prediction, confidence, and reasoning text visible.
  </verify>
  <done>Play calls are visible on /cards for games with driver cards. Tier color-coded. Confidence shown as %. Reasoning readable. TypeScript clean.</done>
</task>

</tasks>

<verification>
1. `node apps/worker/src/jobs/run_nhl_model.js` exits 0, cardsGenerated logged
2. `node apps/worker/src/jobs/run_nba_model.js` exits 0
3. `node apps/worker/src/jobs/run_ncaam_model.js` exits 0
4. `GET /api/games` response includes `plays` array on each game object
5. At least one game has `plays.length > 0` with prediction, confidence, tier, reasoning
6. `/cards` page renders driver play cards with tier badges and reasoning text
7. `npx tsc --noEmit` clean in both `route.ts` and `page.tsx`
</verification>

<success_criteria>
- Model jobs run against real ingested games and produce card_payloads
- /api/games returns plays alongside odds — additive, no existing fields removed
- /cards page shows driver play calls: tier, prediction, confidence, reasoning
- System end-to-end: odds ingest -> driver model -> card_payloads -> API -> UI
</success_criteria>

<output>
After completion, create `.planning/quick/5-apply-driver-logic-to-games-from-odds-ap/5-SUMMARY.md` following the summary template.
</output>
