# Phase potd-01: Play of the Day — Research

**Researched:** 2026-04-08
**Domain:** Next.js App Router + worker scheduler + better-sqlite3 + The Odds API + Discord webhook
**Confidence:** HIGH — all findings verified directly from codebase source files

---

## Summary

The codebase is more mature and more constrained than the phase description implies. The "existing prototype" in `cheddar-picker-v1.jsx` is a standalone React component with no wiring to any production system. The production stack is:

- **DB:** better-sqlite3 (NOT sql.js — the wrapper comments say "sql.js" but it was migrated; `sqlite-wrapper.js` uses `require('better-sqlite3')`). WAL mode enabled. Migration runner in `packages/data/src/migrate.js`.
- **Web:** Next.js App Router (`web/src/app/`). Strictly read-only against the DB. Worker owns all writes.
- **Worker:** Minute-tick scheduler in `apps/worker/src/schedulers/main.js` using `isFixedDue(nowEt, 'HH:MM')` to fire jobs at clock-exact times. Already fires `post_discord_cards` at 10:30, 12:30, and 18:00 ET when env flag is enabled.
- **Odds API:** `packages/odds/src/index.js` exposes `fetchOdds({ sport, hoursAhead })`. NBA and NHL are active; MLB is currently `active: false` in `config.js` (comment says "no odds-backed MLB model" as of April 2026). The `fetchOdds` function calls `https://api.the-odds-api.com/v4/sports/{apiKey}/odds` with `regions: 'us'`, `oddsFormat: 'american'`, and the configured bookmakers. Returns normalized games array.
- **Discord:** `post_discord_cards.js` already has a working `sendDiscordMessages()` function that POSTs `{ content: string }` to `DISCORD_CARD_WEBHOOK_URL`. The existing job is a card-snapshot dump, not a single-play publisher — we need a new job.

**Primary recommendation:** Build a new `potd` job family alongside the existing card system. Use two new DB tables (021_create_potd_plays.sql and 022_create_potd_bankroll.sql). Add a worker job `run_potd_engine.js`. Add a web API route `/api/potd/route.ts` and a page `web/src/app/play-of-the-day/page.tsx`. Gate the daily post on a date-keyed job key (`potd|{date}`) using the existing `shouldRunJobKey` idempotency system.

---

## Codebase Findings

### Web: App Router (not Pages Router)
- Location: `web/src/app/`
- New page goes at: `web/src/app/play-of-the-day/page.tsx`
- New API route goes at: `web/src/app/api/potd/route.ts`
- Runtime: `export const runtime = 'nodejs'` and `export const dynamic = 'force-dynamic'` (see `cards/page.tsx` pattern)
- Layout: root layout in `web/src/app/layout.tsx` uses `bg-night text-cloud` Tailwind classes and Barlow Condensed-like font stack
- Nav: `web/src/app/page.tsx` has the homepage nav; a "Play of the Day" link card should be added there

### Existing API Route Pattern
All routes follow this pattern (from `/api/cards/route.ts` and `/api/model-outputs/route.ts`):
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getDatabaseReadOnly, closeReadOnlyInstance } from '@cheddar-logic/data';
import { ensureDbReady } from '@/lib/db-init';
import { performSecurityChecks, addRateLimitHeaders } from '../../../lib/api-security';

export async function GET(request: NextRequest) {
  const security = performSecurityChecks(request);
  if (!security.ok) return security.response;
  addRateLimitHeaders(response, security);
  // ...
  await ensureDbReady();
  const db = getDatabaseReadOnly();
  try {
    // db.prepare(...).all() or .get()
    return NextResponse.json({ success: true, data: rows });
  } finally {
    try { closeReadOnlyInstance(); } catch {}
  }
}
```

### Existing Scheduler Pattern
`main.js` scheduler fires jobs using `isFixedDue(nowEt, 'HH:MM')` checked on every minute tick:
```javascript
if (isFixedDue(nowEt, '12:00')) {
  const jobKey = `potd|${nowEt.toISODate()}`;
  jobs.push({ jobName: 'run_potd_engine', jobKey, execute: runPotdEngine, args: { jobKey, dryRun }, reason: 'potd engine (noon ET gate)' });
}
```
The `shouldRunJobKey(jobKey)` call inside the tick loop prevents re-runs of the same key.

However, the POTD needs dynamic timing (12–4PM, 90min before first game). This requires a time-aware variant rather than a fixed slot. The TMINUS_BANDS pattern exists (`windows.js` lines 207+) and shows how to schedule relative to game start. But the simplest approach for POTD is:
- Check every tick from 12:00–15:30 ET
- Find today's earliest game across NBA/NHL/(MLB if enabled)
- Compute target post time = max(12:00, earliest_game - 90min), capped at 16:00
- Fire once per day using a date key

### Odds Package: What's Wired

From `packages/odds/src/config.js`:
| Sport | active | apiKey | markets |
|-------|--------|--------|---------|
| NBA | true | `basketball_nba` | totals, spreads |
| NHL | true | `icehockey_nhl` | totals |
| MLB | **false** | `baseball_mlb` | h2h |

MLB is explicitly disabled as of April 2026 with comment "no odds-backed MLB model." The POTD signal engine needs spread + h2h (moneyline) data. For NHL specifically, only `totals` are fetched in the current config — **spreads/moneyline are NOT being pulled for NHL**. NBA gets spreads. This is a gap: the signal engine scoreGame() uses moneyline (avgHomeML) and spread data, but NHL only has totals in the odds package today.

`fetchOdds({ sport, hoursAhead })` returns:
```javascript
{
  games: [
    {
      gameId, sport, matchup, home_team, away_team, commence_time,
      markets: {
        h2h: [{ book, home, away }],        // moneyline
        totals: [{ book, line, over, under }],
        spreads: [{ book, home_line, home_price, away_line, away_price }]
      }
    }
  ],
  errors: [],
  rawCount: number,
  windowRawCount: number,
  remainingTokens: number | null
}
```

The POTD signal engine can call `fetchOdds` directly (it does NOT write to DB — that's the pull_odds_hourly job's responsibility). For POTD, calling fetchOdds inline within run_potd_engine is fine and avoids DB coupling.

### Discord: Existing Webhook Implementation

`post_discord_cards.js` has a fully working send function:
```javascript
async function sendDiscordMessages({ webhookUrl, messages, fetchImpl = fetch }) {
  for (const message of messages) {
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
    if (!response.ok) throw new Error(`Discord webhook failed (${response.status})`);
  }
}
```
Payload is `{ content: string }` — plain text/markdown, max 2000 chars (enforced by `DISCORD_HARD_LIMIT = 2000`).

The existing job uses `DISCORD_CARD_WEBHOOK_URL`. POTD should use a separate env var `DISCORD_POTD_WEBHOOK_URL` to allow routing to a different Discord channel (e.g., a #play-of-the-day channel vs. the #cards channel).

### Persistence: better-sqlite3, NOT sql.js

The comment in `packages/data/README.md` says "sql.js" but `src/sqlite-wrapper.js` is a `better-sqlite3` wrapper (synchronous, WAL mode). This matters because:
- All DB calls in worker are synchronous (no `await` needed on queries)
- Writes are durable immediately on `stmt.run()`
- The web layer opens a separate read-only connection via `getDatabaseReadOnly()`
- Worker owns ALL writes (web is strictly read-only)

### Existing Job Idempotency Pattern

All jobs use a deterministic key string stored in `job_runs`:
```javascript
const jobKey = `potd|${nowEt.toISODate()}`; // e.g. "potd|2026-04-08"
shouldRunJobKey(jobKey); // returns false if already completed/running today
```
This is the one-play gate. No additional logic needed — the existing `shouldRunJobKey` + `job_runs` table already enforces run-once semantics per key.

### Existing Card Payload Model

The `card_payloads` table is the primary output surface for the web. It stores:
- `game_id`, `sport`, `card_type`, `card_title`
- `payload_data` (JSON string — arbitrary shape)
- `expires_at` for lifecycle management

POTD could write a `card_payloads` row with `card_type = 'potd'`. However this creates ambiguity with the existing cards system (settlement, display log, etc.). Separate POTD-specific tables are cleaner and avoid entanglement with settlement workflows.

---

## Data Model Recommendation

### Migration 063: `potd_plays` table

```sql
-- Migration 063: Create potd_plays table
-- Stores the single best play selected each day

CREATE TABLE potd_plays (
  id TEXT PRIMARY KEY,                  -- UUID
  play_date TEXT NOT NULL UNIQUE,       -- ISO date: "2026-04-08" (one-play gate)
  sport TEXT NOT NULL,                  -- "NBA" | "NHL" | "MLB"
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  recommended_team TEXT NOT NULL,
  recommended_side TEXT NOT NULL,       -- "home" | "away"
  bet_type TEXT NOT NULL,               -- "spread" | "moneyline"
  line REAL,                            -- spread number (null for moneyline-only)
  moneyline INTEGER NOT NULL,           -- American odds e.g. -110
  confidence_label TEXT NOT NULL,       -- "ELITE" | "HIGH"
  total_score REAL NOT NULL,            -- 0-1 signal score
  signal_type TEXT NOT NULL,            -- "Reverse Line Move" | "Sharp Money" | etc.
  model_win_prob REAL NOT NULL,
  implied_prob REAL NOT NULL,
  edge_pct REAL NOT NULL,               -- model_win_prob - implied_prob
  score_breakdown TEXT NOT NULL,        -- JSON: { lineValue, consensus, lineMovement, publicFade }
  wager_amount REAL NOT NULL,           -- Quarter-Kelly dollar amount
  bankroll_at_post REAL NOT NULL,       -- Bankroll snapshot when play was posted
  kelly_fraction REAL NOT NULL,
  game_time_utc TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  discord_posted INTEGER NOT NULL DEFAULT 0,  -- 0 | 1
  discord_posted_at TEXT,
  result TEXT,                          -- "win" | "loss" | "push" | null (pending)
  settled_at TEXT,
  pnl_dollars REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_potd_plays_play_date ON potd_plays(play_date DESC);
CREATE INDEX idx_potd_plays_sport ON potd_plays(sport);
CREATE INDEX idx_potd_plays_result ON potd_plays(result);
```

### Migration 064: `potd_bankroll` table

```sql
-- Migration 064: Create potd_bankroll ledger

CREATE TABLE potd_bankroll (
  id TEXT PRIMARY KEY,
  event_date TEXT NOT NULL,             -- ISO date
  event_type TEXT NOT NULL,             -- "initial" | "play_posted" | "result_settled"
  play_id TEXT,                         -- FK to potd_plays.id (null for initial)
  amount_before REAL NOT NULL,
  amount_change REAL NOT NULL,          -- negative for loss, positive for win
  amount_after REAL NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (play_id) REFERENCES potd_plays(id)
);

CREATE INDEX idx_potd_bankroll_event_date ON potd_bankroll(event_date DESC);
```

**Starting bankroll:** $10.00 seeded via a one-time migration or `initial` event row.
**Bankroll cap:** 20% max wager per play (hard cap in engine, not enforced by DB).

---

## Integration Points

### Odds API: How to Call It

Use `fetchOdds` from `packages/odds/src/index.js` directly within the POTD job:

```javascript
const { fetchOdds } = require('@cheddar-logic/odds/src/index');

async function fetchPotdOdds() {
  const results = await Promise.allSettled([
    fetchOdds({ sport: 'NBA', hoursAhead: 24 }),
    fetchOdds({ sport: 'NHL', hoursAhead: 24 }),
    // fetchOdds({ sport: 'MLB', hoursAhead: 24 }), // MLB disabled April 2026
  ]);
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value.games);
}
```

**Market gap for NHL:** Current NHL config only fetches `totals`. The signal engine needs moneyline (h2h) for the `publicFade` and `lineValue` signals, and spreads for the spread recommendation. The POTD job can either:
1. Call the Odds API directly (bypassing the config's market restriction) with `markets: 'h2h,spreads'` for NHL
2. Add `h2h` and `spreads` to the NHL config (risk: increases token cost by 2 tokens per fetch)

Option 1 is safer — the POTD job makes its own targeted call outside the recurring pull_odds_hourly budget. The POTD runs once per day; 3 sports × 3 markets = 9 tokens, negligible against the monthly 2000-token budget.

**API key env vars already present:** `ODDS_API_KEY` and `BACKUP_ODDS_API_KEY` (failover built into `fetchFromOddsAPI`).

### Discord: Webhook Format

Send a plain markdown message (≤2000 chars) to `DISCORD_POTD_WEBHOOK_URL`:

```
POST https://discord.com/api/webhooks/{id}/{token}
Content-Type: application/json
{ "content": "**message text**" }
```

Message template (from prototype `formatDiscordMessage`):
```
**🧀 CHEDDAR LOGIC — PLAY OF THE DAY**
━━━━━━━━━━━━━━━━━━━━━━
🏀 **GSW Warriors vs LAL Lakers**
📌 **GSW Warriors** · Spread -3.5 · ML -145
🔍 Signal: Reverse Line Move
📊 Confidence: ELITE (74/100)
💰 Wager: $1.23 of $12.45 bankroll
📈 Edge: +4.2%
⏰ Game: 10:30 PM ET
━━━━━━━━━━━━━━━━━━━━━━
*One play. One day. Build the roll.* 🧀
```

### Scheduler: How to Add the Daily Job

In `apps/worker/src/schedulers/main.js`, import the new job and add a new block in `computeDueJobs`:

```javascript
// In imports
const { runPotdEngine } = require('../jobs/run_potd_engine');

// In computeDueJobs, after DISCORD SNAPSHOT block
if (process.env.ENABLE_POTD === 'true') {
  // Fire every tick between 12:00 and 16:00 ET — job key enforces once-per-day
  if (nowEt.hour >= 12 && nowEt.hour < 16) {
    const jobKey = `potd|${nowEt.toISODate()}`;
    jobs.push({
      jobName: 'run_potd_engine',
      jobKey,
      execute: runPotdEngine,
      args: { jobKey, dryRun },
      reason: `potd engine (12-4PM window, ${nowEt.toISO()})`
    });
  }
}
```

The existing `shouldRunJobKey(jobKey)` call in the tick loop ensures the job only runs once per day (the date is encoded in the key). The 12–4PM window means the first tick in that window fires the job; subsequent ticks skip it via `shouldRunJobKey`.

**Dynamic timing within the window:** The job itself should compute the correct post time internally. If the first game is at 7:00 PM ET (19:00), 90min buffer = 5:30 PM (17:30), capped at 4:00 PM. So the job would post at 12:00 PM because that's the minimum. If the first game is at 1:00 PM (13:00), buffer = 11:30 AM — capped up to 12:00 PM. The scheduler fires the job at the first eligible tick; the job itself can additionally check "is this the right time to post?" and exit early if the computed post time hasn't been reached yet.

Alternatively: query today's games from the DB first, compute the target post time, and add the job to the queue only once target time is reached. The scheduler already has game data in scope via `getUpcomingGames(...)` at the top of `tick()`.

---

## Persistence Decision

**Use better-sqlite3 (existing stack).** The DB label "sql.js" is a legacy comment — the actual driver is `better-sqlite3` (synchronous, WAL, file-backed). It is fully suitable for POTD:

- Daily play record: one row per day, keyed by `play_date` TEXT UNIQUE
- Bankroll ledger: append-only event log
- History: simple SELECT ordered by `play_date DESC`
- Settlement: UPDATE `result` and `pnl_dollars` when worker detects game result

No Redis, no separate store, no Postgres needed. The web API reads these tables the same way it reads `card_payloads` — `getDatabaseReadOnly()` + prepared statement.

**Migration number:** Next available is 063 (current high-water mark is 062_deduplicate_card_payloads.sql).

**Write ownership:** Worker only. The API route at `/api/potd` is read-only (follows the established pattern).

---

## Page Architecture

### Route
`web/src/app/play-of-the-day/page.tsx`

### Data Fetching Pattern
The page should be a **server component** fetching from its own API route, or a **client component** fetching via `useEffect` from `/api/potd`. Looking at `cards/page.tsx`, the pattern is a thin server wrapper around a client component:

```typescript
// web/src/app/play-of-the-day/page.tsx
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function PlayOfTheDayPage() {
  return <PlayOfTheDayClient />;
}
```

```typescript
// web/src/components/play-of-the-day-client.tsx
'use client';
// fetch /api/potd on mount, render today's play + history
```

### API Route
`web/src/app/api/potd/route.ts` — GET handler returning:
```json
{
  "success": true,
  "data": {
    "today": { /* potd_plays row for today or null if not yet posted */ },
    "history": [ /* last 30 days potd_plays rows */ ],
    "bankroll": {
      "current": 12.45,
      "startingBankroll": 10.00,
      "totalReturn": 24.5
    }
  }
}
```

### UI Components to Reuse
- `bg-night text-cloud` color palette (established in root layout)
- `border border-white/20 bg-surface/80 rounded-xl` card style (homepage nav pattern)
- `StickyBackButton` from `components/sticky-back-button.tsx`
- Sport labels/colors from `post_discord_cards.js` (NBA #C9082A, NHL #000, MLB #002D72 from prototype)

### Homepage Nav Addition
Add a link card in `web/src/app/page.tsx`:
```tsx
<Link href="/play-of-the-day" className="rounded-xl border border-white/20 bg-surface/80 px-8 py-6 text-lg font-semibold transition hover:border-white/40 hover:bg-surface">
  🧀 Play of the Day 🧀
</Link>
```

---

## Environment Variables

### Already Exist
| Var | Purpose |
|-----|---------|
| `ODDS_API_KEY` | Primary Odds API key |
| `BACKUP_ODDS_API_KEY` | Failover key (auto-used by fetchOdds) |
| `DISCORD_CARD_WEBHOOK_URL` | Existing Discord card snapshots webhook |
| `TZ` | Timezone (America/New_York default) |
| `TICK_MS` | Scheduler tick interval |
| `DRY_RUN` | Skip actual execution |
| `CHEDDAR_DB_PATH` | SQLite DB path |

### New Vars Required
| Var | Default | Purpose |
|-----|---------|---------|
| `ENABLE_POTD` | `false` | Feature gate for POTD job |
| `DISCORD_POTD_WEBHOOK_URL` | (empty) | Separate Discord webhook for POTD channel |
| `POTD_STARTING_BANKROLL` | `10.00` | Seed value (used only for initial setup) |
| `POTD_MIN_CONFIDENCE` | `HIGH` | Minimum confidence label to post (ELITE or HIGH) |
| `POTD_KELLY_FRACTION` | `0.25` | Quarter-Kelly divisor |
| `POTD_MAX_WAGER_PCT` | `0.20` | Max bankroll fraction per play |

---

## Gaps / Open Questions

### 1. MLB Odds Status
MLB is `active: false` in `packages/odds/src/config.js` with the comment "no odds-backed MLB model." The phase description includes MLB as in-scope for POTD. This means either:
- POTD makes direct Odds API calls for MLB (bypassing the config), OR
- MLB is also out of scope for POTD until re-enabled

**Decision needed:** Include MLB in POTD scope and make direct API calls, or defer MLB from POTD (NBA + NHL only for now)?

### 2. NHL Markets Gap
NHL odds config only pulls `totals`. The signal engine requires moneyline (h2h) and spreads for full scoring. POTD needs to fetch these additional markets for NHL. This means the POTD engine will make its own direct API calls (separate from pull_odds_hourly), consuming approximately 3 extra tokens per day for NHL (h2h + spreads = 2 additional markets). Given the current ODDS_MONTHLY_LIMIT=2000 budget, 3 tokens/day × 30 days = 90 tokens, which is manageable.

**Decision needed:** Confirm the POTD job is allowed its own direct Odds API calls separate from the hourly pull budget, or should it reuse odds from the DB (which may lack the needed markets for NHL)?

### 3. Signal Engine Adaptation for Live Data
The prototype's `scoreGame()` uses `books[]` (array of per-bookmaker lines), `lineMovement` (simulated), and `homePublicPct` (simulated). The live Odds API response has `markets.spreads[]` and `markets.h2h[]` per bookmaker, but does NOT provide:
- **Line movement:** Not available in a single snapshot. Requires comparing current snapshot to a prior snapshot from the DB.
- **Public betting percentages:** Not available from The Odds API at all. Would require a separate public splits source (VSiN, Action Network, etc.) — `pull_vsin_splits.js` and `pull_public_splits.js` exist as jobs but their data structure needs verification.

For MVP, the signal engine can:
- Score `lineValue` and `marketConsensus` from live multi-book odds (HIGH confidence)
- Score `lineMovement` as 0 (neutral) if no prior snapshot exists, or from DB odds history
- Score `publicFade` as 0 (neutral) until a splits source is wired

**Decision needed:** Is MVP acceptable with `lineMovement` and `publicFade` scoring as neutral (0), producing an effectively 2-signal engine? Or must all 4 signals be live before launch?

### 4. Game Result Settlement
POTD plays need settlement (win/loss) after games complete. The existing `settle_game_results.js` worker handles settlement for `card_results`. POTD can either:
- Reuse the existing settlement pipeline by writing a `card_payloads` row with `card_type='potd'` and a linked `card_results` row
- Build a separate lightweight settlement job specifically for `potd_plays`

The separate approach is cleaner and avoids entanglement with the existing settlement scoring logic (which handles CLV, multiple bet types, etc.). The POTD settlement is simpler: compare recommended team's result to game result, calculate P&L = wager × (ML payout or -wager).

**Decision needed:** Standalone POTD settlement job vs. piggyback on existing card settlement pipeline?

### 5. Bankroll Initialization
The DB needs a seed bankroll event. Should this be:
- A migration that inserts the initial `potd_bankroll` row (`amount_before=0`, `amount_change=10.00`, `amount_after=10.00`)
- Runtime initialization in `run_potd_engine.js` (check if bankroll exists; if not, create the seed row)

Runtime initialization is safer (no hard-coded $10 in a migration that runs everywhere).

---

## Confidence Breakdown

| Area | Level | Reason |
|------|-------|--------|
| Web route structure | HIGH | Verified app router, existing page patterns |
| API route pattern | HIGH | Verified from 2 existing routes |
| Scheduler integration | HIGH | Verified `isFixedDue` + `shouldRunJobKey` patterns |
| DB layer (better-sqlite3) | HIGH | Verified in `sqlite-wrapper.js` |
| Odds API integration | HIGH | Full `fetchOdds` implementation verified |
| Discord webhook format | HIGH | Verified `sendDiscordMessages` in `post_discord_cards.js` |
| Data model (new tables) | MEDIUM | Schema design based on verified patterns; exact fields may need tuning |
| Signal engine adaptation | MEDIUM | Prototype logic is clear; live data gaps (line movement, splits) need resolution |
| MLB in-scope status | LOW | Config says disabled; phase description says in-scope — contradiction |
