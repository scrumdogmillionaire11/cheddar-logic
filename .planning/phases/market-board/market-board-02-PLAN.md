---
phase: market-board
plan: 02
type: execute
wave: 2
depends_on: [market-board-01]
files_modified:
  - web/src/app/board/page.tsx
  - web/src/app/api/board/route.ts
  - web/src/components/board/BoardPage.tsx
  - web/src/components/board/BestPriceTab.tsx
  - web/src/components/board/DisagreementTab.tsx
  - web/src/components/board/OpportunitiesTab.tsx
  - web/src/components/board/MoversTab.tsx
  - web/src/app/page.tsx
  - web/src/components/global-stale-asset-guard.tsx
  - web/src/lib/api-security/validation.ts
autonomous: false
requirements: [BOARD-01, BOARD-02, BOARD-03, BOARD-04]

must_haves:
  truths:
    - "User can navigate to /board and see today's games with best current price per market per side"
    - "User can identify which book has the cheapest vig / best number without opening multiple sportsbooks"
    - "User can see where sharp money (Circa) and public money disagree on the same game"
    - "User can see which lines have moved since opening and in which direction"
    - "User can see misprice / outlier book flags for stale or anomalous lines"
    - "All signals are clearly timestamped — user knows when data was last captured"
    - "Page is useful even when zero play calls exist (model PASS day still has board value)"
  artifacts:
    - path: "web/src/app/api/board/route.ts"
      provides: "GET /api/board — normalized board data for all active sports"
      exports: ["GET"]
    - path: "web/src/app/board/page.tsx"
      provides: "Cheddar Board server page"
      contains: "BoardPage"
    - path: "web/src/components/board/BoardPage.tsx"
      provides: "4-tab client component"
      contains: "BestPrice|Movers|Disagreement|Opportunities"
  key_links:
    - from: "web/src/components/board/BoardPage.tsx"
      to: "/api/board"
      via: "client-side fetch on mount"
      pattern: "fetch.*api/board"
    - from: "web/src/app/api/board/route.ts"
      to: "@cheddar-logic/data"
      via: "getOddsWithUpcomingGames + getOddsSnapshots"
      pattern: "getOddsWithUpcomingGames|getOddsSnapshots"
---

<objective>
Build the Cheddar Board — a 4-tab market intelligence surface at /board that shows where value, movement, and disagreement exist across today's games, independently of any model pick.

Purpose: Give users actionable market-state intelligence on days the model says PASS. A bettor can find the best available line, spot sharp vs. public divergence, and identify stale or mispriced numbers — all without relying on our model's opinion.
Output: /board page with Best Price, Movers, Disagreement, and Opportunities tabs backed by a new /api/board endpoint.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@web/src/app/api/market-pulse/route.ts
@packages/data/src/db/odds.js
@packages/odds/src/config.js

<interfaces>
From packages/data/src/db/odds.js — key functions available:

```js
// Latest snapshot per game joined to games table — use for current board state
getOddsWithUpcomingGames(sport, nowUtc, horizonUtc)
// Returns rows with all odds_snapshots columns + game_time_utc, home_team, away_team
// Key columns for the board:
//   game_id, sport, captured_at, home_team, away_team, game_time_utc
//   h2h_home, h2h_away, h2h_home_book, h2h_away_book
//   total_line_over, total_line_over_book, total_price_over, total_price_over_book
//   total_line_under, total_line_under_book, total_price_under, total_price_under_book
//   spread_home, spread_home_book, spread_price_home, spread_price_home_book
//   spread_away, spread_away_book, spread_price_away, spread_price_away_book
//   spread_consensus_line, spread_consensus_confidence
//   total_consensus_line, total_consensus_confidence
//   h2h_consensus_home, h2h_consensus_away, h2h_consensus_confidence
//   spread_is_mispriced, spread_misprice_type, spread_outlier_book, spread_outlier_delta
//   total_is_mispriced, total_misprice_type, total_outlier_book, total_outlier_delta
//   public_bets_pct_home, public_bets_pct_away
//   public_handle_pct_home, public_handle_pct_away
//   public_tickets_pct_home, public_tickets_pct_away
//   circa_handle_pct_home, circa_handle_pct_away
//   circa_tickets_pct_home, circa_tickets_pct_away

// All snapshots in a time window — use for line movement history
getOddsSnapshots(sport, sinceUtc)
// Returns all snapshots ordered by game_id, captured_at DESC
```

From packages/odds/src/config.js — configured bookmakers:
```
NHL: ['betmgm', 'draftkings', 'fanduel', 'williamhill_us', 'espnbet', 'fliff']
NBA: ['betmgm', 'draftkings', 'fanduel', 'williamhill_us', 'espnbet', 'fliff']
MLB: ['betmgm', 'draftkings', 'fanduel', 'williamhill_us', 'espnbet', 'fliff']
```

From web/src/app/api/market-pulse/route.ts — precedent for raw_data parsing pattern:
```ts
const raw = JSON.parse(snapshot.raw_data ?? '{}');
const markets = raw.markets ? raw.markets : raw;
// markets.spreads[], markets.totals[], markets.h2h[] — each entry has { book, line/price }
```

Security precedent (match this pattern):
```ts
import { performSecurityChecks } from '@/lib/api-security/validation';
const securityCheck = performSecurityChecks(request, '/api/board');
if (!securityCheck.ok) return securityCheck.response;
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Build GET /api/board — normalized board data endpoint</name>
  <files>web/src/app/api/board/route.ts, web/src/lib/api-security/validation.ts</files>
  <action>
    Create web/src/app/api/board/route.ts.

    Query params:
    - sport (optional): 'NBA' | 'MLB' | 'NHL' | 'ALL' (default: 'ALL')
    - horizon (optional): hours ahead to look (default: 24)

    Data pipeline:
    1. Call getOddsWithUpcomingGames for each requested sport with nowUtc and horizonUtc (now + horizon hours).
       This gives one row per game with the latest snapshot + team/gametime metadata.

    2. Call getOddsSnapshots for each sport with sinceUtc = 8 hours ago.
       Group results by game_id. For each game, find the OLDEST snapshot in the window.
       Compute movement delta: latest.total - oldest.total, latest.spread_home - oldest.spread_home, latest.h2h_home - oldest.h2h_home.

    3. For each game, build a BoardGame object:
    ```ts
    interface BoardGame {
      gameId: string;
      sport: string;
      gameTimeUtc: string;
      homeTeam: string;
      awayTeam: string;
      snapshotAge: number; // minutes since captured_at

      bestPrice: {
        moneyline: { home: number | null; homeBook: string | null; away: number | null; awayBook: string | null };
        total: { line: number | null; overPrice: number | null; overBook: string | null; underPrice: number | null; underBook: string | null };
        spread: { home: number | null; homeBook: string | null; homePrice: number | null; homePriceBook: string | null; away: number | null; awayBook: string | null };
      };

      consensus: {
        spread: number | null; spreadConfidence: string | null;
        total: number | null; totalConfidence: string | null;
        mlHome: number | null; mlAway: number | null; mlConfidence: string | null;
      };

      movement: {
        totalDelta: number | null; spreadDelta: number | null; mlHomeDelta: number | null;
        windowHours: number;
        direction: 'up' | 'down' | 'flat' | null; // based on total movement
      };

      splits: {
        publicBetsHome: number | null; publicBetsAway: number | null;
        publicHandleHome: number | null; publicHandleAway: number | null;
        sharpHandleHome: number | null; sharpHandleAway: number | null; // circa
        sharpTicketsHome: number | null; sharpTicketsAway: number | null;
        // derived: sharpSide = 'HOME' | 'AWAY' | null (circa handle > 60% + diverges from public)
        sharpSide: 'HOME' | 'AWAY' | null;
        splitAlert: boolean; // true when sharp and public disagree by > 25ppt on handle
      };

      signals: {
        spreadMispriced: boolean; spreadOutlierBook: string | null; spreadOutlierDelta: number | null; spreadMispriceType: string | null;
        totalMispriced: boolean; totalOutlierBook: string | null; totalOutlierDelta: number | null;
        isStale: boolean; // snapshotAge > 90 minutes before game
        staleness: 'FRESH' | 'AGING' | 'STALE'; // <30min = FRESH, 30-90 = AGING, >90 = STALE
      };
    }
    ```

    Response shape:
    ```ts
    {
      scannedAt: string; // ISO
      sport: string;
      horizonHours: number;
      games: BoardGame[];
      meta: { gamesCount: number; sportsScanned: string[]; staleCount: number; mispricedCount: number; splitAlertCount: number; }
    }
    ```

    staleness logic: snapshotAge > 90 → STALE, > 30 → AGING, else FRESH
    sharpSide logic: if circa_handle_pct_home >= 60 AND public_bets_pct_home < 45 → sharpSide = 'HOME'
                     if circa_handle_pct_away >= 60 AND public_bets_pct_away < 45 → sharpSide = 'AWAY'
                     else null

    Server-side in-memory cache: 90-second TTL keyed by `${sport}:${horizon}`.
    Apply performSecurityChecks(request, '/api/board') before processing.
    Use getDatabaseReadOnly() — never write to DB.
    Add /api/board to validation.ts allowed params: ['sport', 'horizon'].

    runtime = 'nodejs', no edge runtime.
  </action>
  <verify>
    curl -s 'http://localhost:3000/api/board?sport=NHL' | jq -e 'has("games") and (.games|type=="array") and has("meta") and (if (.games|length)>0 then (.games[0]|has("bestPrice") and has("signals") and has("movement")) else true end)'
  </verify>
  <done>
    /api/board returns valid JSON with games array. Each game has bestPrice, consensus, splits, signals, movement fields. No DB write calls. Response under 1s from cache.
  </done>
</task>

<task type="auto">
  <name>Task 2: Build /board page + 4-tab BoardPage component</name>
  <files>
    web/src/app/board/page.tsx,
    web/src/components/board/BoardPage.tsx,
    web/src/components/board/BestPriceTab.tsx,
    web/src/components/board/MoversTab.tsx,
    web/src/components/board/DisagreementTab.tsx,
    web/src/components/board/OpportunitiesTab.tsx,
    web/src/app/page.tsx,
    web/src/components/global-stale-asset-guard.tsx
  </files>
  <action>
    1. CREATE web/src/app/board/page.tsx — server page wrapper:
       - metadata.title: 'Cheddar Board | Cheddar Logic'
       - metadata.description: 'Market intelligence: best prices, line movement, sharp vs. public disagreement, and mispriced lines across today\'s games.'
       - runtime = 'nodejs', dynamic = 'force-dynamic'
       - Renders <BoardPage /> (client component)
       - closeDatabaseReadOnly() in finally block

    2. CREATE web/src/components/board/BoardPage.tsx — main client component:
       - Add Cheddar Board nav link in web/src/app/page.tsx now that /board exists
       - Extend global stale guard to include pathname?.startsWith('/board')
       - Fetches /api/board?sport=ALL on mount and every 90 seconds
       - Sport filter tabs at top: ALL | NBA | MLB | NHL (refetches with ?sport=X on switch)
       - Four content tabs: Best Price | Movers | Disagreement | Opportunities
       - Header: "🧀 Cheddar Board" with scannedAt timestamp ("Updated X min ago")
       - Loading skeleton + error state
       - Empty state: "No upcoming games in the next 24 hours" with last scan time
       - Passes filtered games[] to active tab component

    3. CREATE web/src/components/board/BestPriceTab.tsx:
       - One row per game. Columns: Game (away @ home + time), Moneyline (best away/home + book badge), Spread (best home line + price + book), Total (best over/under line + price + book)
       - Book badges: short label (DK, FD, MGM, CZS, ESPN, FLF)
       - Staleness badge on game row: green FRESH / yellow AGING / red STALE
       - Sort by game_time_utc ascending
       - Tooltip or inline: consensus line shown in muted text next to best line for spread/total

    4. CREATE web/src/components/board/MoversTab.tsx:
       - Only show games where |totalDelta| >= 0.5 OR |spreadDelta| >= 0.5 OR |mlHomeDelta| >= 10
       - Columns: Game, Market, Movement (delta with arrow ↑↓), Window
       - Sort by absolute delta descending
       - Empty state: "No significant line movement in the last 8 hours"

    5. CREATE web/src/components/board/DisagreementTab.tsx:
       - Only show games where splits data exists (circa or public non-null)
       - For each game: two rows — Sharp (Circa handle %) vs Public (Action Network bets %)
       - Visual bar showing sharp side vs public side split
       - splitAlert games highlighted with amber border
       - sharpSide badge: "SHARP: HOME" or "SHARP: AWAY" in amber
       - Empty state: "No splits data available — splits are collected ~2 hours before game time"

    6. CREATE web/src/components/board/OpportunitiesTab.tsx:
       - Three sections: Mispriced Lines | Stale Numbers | Outlier Books
       - Mispriced Lines: games where signals.spreadMispriced or signals.totalMispriced = true
         Show: game, market, outlier book, delta (how far off consensus)
       - Stale Numbers: games where signals.staleness = 'STALE'
         Show: game, minutes since last update, stale markets
       - Outlier Books: pull spreadOutlierBook / totalOutlierBook and group by book name
         Show: book name, how many games it's the outlier on today
       - Each item has an "Informational only — verify before betting" disclaimer badge
       - Empty state per section: "No [mispriced lines / stale lines / outlier books] detected"

    Styling: match existing dark theme (bg-night, text-cloud, border-white/20, surface). 
    Tabs use the same pattern as CardsModeTabs.tsx.
    No hardcoded mock data — all sourced from /api/board response.
  </action>
  <verify>
    npm --prefix web run build (no TypeScript errors)
    Manually: http://localhost:3000/board loads, shows sport filter + 4 tabs, no console errors
  </verify>
  <done>
    /board renders with real data from /api/board. All 4 tabs render without crashing. Empty states display correctly when no data for that tab. TypeScript build passes.
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Checkpoint: Verify board behavior and wedge continuity</name>
  <files>web/src/app/board/page.tsx, web/src/app/wedge/page.tsx, web/src/app/cards/page.tsx, web/src/app/page.tsx</files>
  <action>Run the manual verification flow after Tasks 1-2 complete and confirm route and UI behavior.</action>
  <what-built>
    Cheddar Board at /board with 4 tabs: Best Price, Movers, Disagreement, Opportunities.
    Backed by /api/board pulling real odds snapshot data from the DB.
  </what-built>
  <how-to-verify>
    1. Open http://localhost:3000/board
    2. Confirm header shows "🧀 Cheddar Board" with a timestamp
    3. Best Price tab: confirm games appear with book badges (DK, FD, MGM, etc.)
    4. Disagreement tab: if splits data available, confirm sharp/public bars render
    5. Opportunities tab: if any misprice flags exist, confirm they appear
    6. Switch sport filter from ALL → NHL → confirm only NHL games shown
    7. Open http://localhost:3000/wedge — confirm picks page still works
    8. Open http://localhost:3000/cards — confirm it redirects to /wedge
    9. Home page: confirm both "Cheddar Board" and "The Wedge" nav links present
  </how-to-verify>
  <verify>npm --prefix web run build</verify>
  <done>User confirms approved behavior or provides defects by tab/route.</done>
  <resume-signal>Type "approved" or describe which tab/section has issues</resume-signal>
</task>

</tasks>

<verification>
- npm --prefix web run build passes with no type errors
- /api/board returns valid BoardGame[] JSON with correct data shapes
- /board renders in browser without JS errors
- /wedge functional (picks page)
- /cards redirects to /wedge
- Homepage nav has both entries
</verification>

<success_criteria>
- Cheddar Board is a functional standalone surface independent of model picks
- Best Price tab shows which book has the best line for every active game
- Disagreement tab surfaces sharp vs public divergence where splits data is populated
- Opportunities tab flags misprice/stale lines using signals already computed at ingest
- Movers tab shows meaningful line movement (threshold-filtered)
- All signals clearly labeled "Informational only" — no fake bet recommendations
- Page is useful on a zero-play-call day
</success_criteria>

<output>
After completion, create .planning/phases/market-board/market-board-02-SUMMARY.md
</output>
