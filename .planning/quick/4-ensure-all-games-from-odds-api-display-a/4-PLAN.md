---
phase: quick-4
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - web/src/app/api/games/route.ts
  - web/src/app/cards/page.tsx
autonomous: true
requirements: [QUICK-4]

must_haves:
  truths:
    - "All games from the odds API (games table) appear on the /cards page"
    - "Each game card shows sport, home team, away team, game time, and latest odds"
    - "Games with no card_payloads still appear (as odds-only cards)"
    - "Games display sorted by game_time_utc ascending"
  artifacts:
    - path: "web/src/app/api/games/route.ts"
      provides: "GET /api/games — joins games + latest odds_snapshot, returns all upcoming games"
      exports: ["GET"]
    - path: "web/src/app/cards/page.tsx"
      provides: "Updated /cards page fetching from /api/games instead of /api/cards"
      contains: "fetch('/api/games"
  key_links:
    - from: "web/src/app/cards/page.tsx"
      to: "/api/games"
      via: "fetch in useEffect"
      pattern: "fetch.*api/games"
    - from: "web/src/app/api/games/route.ts"
      to: "games + odds_snapshots tables"
      via: "LEFT JOIN SQL query"
      pattern: "LEFT JOIN odds_snapshots"
---

<objective>
Show every game ingested from the odds API as a card on the /cards page.

Purpose: The /cards page currently only shows games that have model outputs (card_payloads rows). With 25 games in the DB and only some having card_payloads, most games are invisible. The user wants visibility into all ingested games.

Output: A new GET /api/games route that queries the games table with latest odds, and an updated /cards page that renders all games as cards.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@web/src/app/api/cards/route.ts
@web/src/app/cards/page.tsx
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create GET /api/games route</name>
  <files>web/src/app/api/games/route.ts</files>
  <action>
Create `web/src/app/api/games/route.ts` as a Next.js App Router route handler.

Query: LEFT JOIN games with the latest odds_snapshot per game (using a subquery or ROW_NUMBER window). Return all games with game_time_utc in the future (or within 24 hours past, to catch in-progress games). Sort by game_time_utc ASC. Limit 200.

Use `initDb`, `getDatabase`, `closeDatabase` from `@cheddar-logic/data` (same pattern as the existing /api/cards/route.ts).

SQL approach — use a CTE to get latest odds per game:
```sql
WITH latest_odds AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY captured_at DESC) AS rn
  FROM odds_snapshots
)
SELECT
  g.id,
  g.game_id,
  g.sport,
  g.home_team,
  g.away_team,
  g.game_time_utc,
  g.status,
  g.created_at,
  o.h2h_home,
  o.h2h_away,
  o.total,
  o.spread_home,
  o.spread_away,
  o.captured_at AS odds_captured_at
FROM games g
LEFT JOIN latest_odds o ON o.game_id = g.game_id AND o.rn = 1
WHERE g.game_time_utc >= datetime('now', '-24 hours')
ORDER BY g.game_time_utc ASC
LIMIT 200
```

Response shape:
```ts
{
  success: boolean,
  data: Array<{
    id: string,
    gameId: string,
    sport: string,
    homeTeam: string,
    awayTeam: string,
    gameTimeUtc: string,
    status: string,
    createdAt: string,
    odds: {
      h2hHome: number | null,
      h2hAway: number | null,
      total: number | null,
      spreadHome: number | null,
      spreadAway: number | null,
      capturedAt: string | null,
    } | null,
  }>,
  error?: string,
}
```

TypeScript interfaces for all rows. Wrap in try/catch, return 500 on error. Close DB in finally block.

Do NOT filter by sport != FPL (games table has no FPL data; that boundary only matters for card_payloads).
  </action>
  <verify>
curl -s http://localhost:3000/api/games | jq '.success, (.data | length)'
Expected: true, N (where N > 0 matching the games in DB — should be ~25)
  </verify>
  <done>GET /api/games returns success=true with an array of game objects each containing gameId, sport, homeTeam, awayTeam, gameTimeUtc, and an odds object (null if no snapshot exists)</done>
</task>

<task type="auto">
  <name>Task 2: Update /cards page to display all games from /api/games</name>
  <files>web/src/app/cards/page.tsx</files>
  <action>
Replace the fetch call in `web/src/app/cards/page.tsx` from `/api/cards?limit=100` to `/api/games`.

Update the TypeScript interfaces to match the new response shape from /api/games:
```ts
interface GameData {
  id: string;
  gameId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  gameTimeUtc: string;
  status: string;
  createdAt: string;
  odds: {
    h2hHome: number | null;
    h2hAway: number | null;
    total: number | null;
    spreadHome: number | null;
    spreadAway: number | null;
    capturedAt: string | null;
  } | null;
}
```

Update the card rendering to show:
- Header: "{away_team} @ {home_team}" as the card title
- Sport badge (uppercase), Status badge if not 'scheduled'
- Game time formatted as local time (use existing formatDate helper)
- Odds section (only if odds exist): show moneyline h2h_home / h2h_away, total line
- "No odds data" note if odds is null
- Keep the same dark card styling: `border border-white/10 rounded-lg p-4 bg-surface/30 hover:bg-surface/50 transition`

Update the page title from "Card Payloads" to "Games" and the subtitle to show count of games.

Remove the `isMock` / `payloadParseError` badge logic (not applicable for game rows).

Keep the 30-second auto-refresh interval.
  </action>
  <verify>
1. Run `npm run dev` in the web directory (or confirm it's already running)
2. Visit http://localhost:3000/cards
3. Confirm all games appear as cards (count should match `games` table count minus games older than 24h)
4. Confirm each card shows matchup, sport, game time, and odds when available
  </verify>
  <done>The /cards page displays all ingested games (not just those with model card_payloads), each showing matchup name, sport, game time, and odds data when available</done>
</task>

</tasks>

<verification>
After both tasks:
- `curl -s http://localhost:3000/api/games | jq '.data | length'` returns a count matching the games table (expected ~22-25)
- Visit http://localhost:3000/cards — all games visible as cards, no "No cards found" message
- Each card shows "{away} @ {home}", sport badge, game time, and odds (or "No odds data")
- 30-second refresh still works (no console errors)
</verification>

<success_criteria>
All games ingested from the odds API appear as cards on /cards. The page is no longer gated behind model card_payloads existing. Count on page matches count in DB.
</success_criteria>

<output>
After completion, create `.planning/quick/4-ensure-all-games-from-odds-api-display-a/4-SUMMARY.md` with:
- What was built
- File paths created/modified
- Key decisions made
- Verification results
Then update `.planning/STATE.md` quick tasks table with this task entry.
</output>
