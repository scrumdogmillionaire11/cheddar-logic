---
phase: potd-01
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/data/db/migrations/063_create_potd_plays.sql
  - packages/data/db/migrations/064_create_potd_bankroll.sql
autonomous: true

must_haves:
  truths:
    - "potd_plays exists with play_date UNIQUE and card_id UNIQUE for one published play per day plus one settlement bridge row per card"
    - "potd_bankroll exists as an append-only ledger keyed to play_id/card_id"
    - "migrations run cleanly on a fresh DB and are idempotent"
  artifacts:
    - path: "packages/data/db/migrations/063_create_potd_plays.sql"
      provides: "potd_plays table DDL"
      contains: "CREATE TABLE potd_plays"
    - path: "packages/data/db/migrations/064_create_potd_bankroll.sql"
      provides: "potd_bankroll ledger DDL"
      contains: "CREATE TABLE potd_bankroll"
  key_links:
    - from: "064_create_potd_bankroll.sql"
      to: "063_create_potd_plays.sql"
      via: "FOREIGN KEY (play_id) REFERENCES potd_plays(id)"
      pattern: "FOREIGN KEY.*potd_plays"
---

<objective>
Create the database contract for POTD: `potd_plays` for daily published plays and `potd_bankroll` for bankroll ledger events.

Purpose: These tables are the durable source for `/api/potd`, the settlement mirror, and bankroll history. The worker is the sole writer; the web layer only reads.
Output: Two migration files that apply through the existing `packages/data/src/migrate.js` runner.
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/phases/potd-01-play-of-the-day/potd-01-RESEARCH.md
@packages/data/db/migrations/062_deduplicate_card_payloads.sql
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create migration 063 — potd_plays table</name>
  <files>packages/data/db/migrations/063_create_potd_plays.sql</files>
  <action>
Create the `potd_plays` table migration. This row models the single published play for a day and the card/settlement link that drives later bankroll updates.

Schema:
```sql
CREATE TABLE IF NOT EXISTS potd_plays (
  id TEXT PRIMARY KEY,
  play_date TEXT NOT NULL UNIQUE,
  game_id TEXT NOT NULL,
  card_id TEXT NOT NULL UNIQUE,
  sport TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  market_type TEXT NOT NULL,            -- SPREAD | TOTAL | MONEYLINE
  selection TEXT NOT NULL,              -- HOME | AWAY | OVER | UNDER
  selection_label TEXT NOT NULL,        -- user-facing pick label
  line REAL,
  price INTEGER NOT NULL,
  confidence_label TEXT NOT NULL,       -- 'ELITE' or 'HIGH'
  total_score REAL NOT NULL,
  model_win_prob REAL NOT NULL,
  implied_prob REAL NOT NULL,
  edge_pct REAL NOT NULL,
  score_breakdown TEXT NOT NULL,        -- JSON: { lineValue, marketConsensus }
  wager_amount REAL NOT NULL,
  bankroll_at_post REAL NOT NULL,
  kelly_fraction REAL NOT NULL,
  game_time_utc TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  discord_posted INTEGER NOT NULL DEFAULT 0,
  discord_posted_at TEXT,
  result TEXT,                          -- 'win' | 'loss' | 'push' | null
  settled_at TEXT,
  pnl_dollars REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_potd_plays_play_date ON potd_plays(play_date DESC);
CREATE INDEX IF NOT EXISTS idx_potd_plays_game_id ON potd_plays(game_id);
CREATE INDEX IF NOT EXISTS idx_potd_plays_sport ON potd_plays(sport);
CREATE INDEX IF NOT EXISTS idx_potd_plays_result ON potd_plays(result);
```
  </action>
  <verify>Run `node packages/data/src/migrate.js` — migration 063 should apply without errors. Then verify the table exists: `SELECT name FROM sqlite_master WHERE type='table' AND name='potd_plays';`</verify>
  <done>`potd_plays` exists with `play_date UNIQUE`, `card_id UNIQUE`, game/market/price columns, and settlement columns.</done>
</task>

<task type="auto">
  <name>Task 2: Create migration 064 — potd_bankroll ledger</name>
  <files>packages/data/db/migrations/064_create_potd_bankroll.sql</files>
  <action>
Create the `potd_bankroll` table migration. This is an append-only ledger for bankroll events: initial seed, play posted, and settled result.

Schema:
```sql
CREATE TABLE IF NOT EXISTS potd_bankroll (
  id TEXT PRIMARY KEY,
  event_date TEXT NOT NULL,
  event_type TEXT NOT NULL,             -- initial | play_posted | result_settled
  play_id TEXT,
  card_id TEXT,
  amount_before REAL NOT NULL,
  amount_change REAL NOT NULL,
  amount_after REAL NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (play_id) REFERENCES potd_plays(id)
);

CREATE INDEX IF NOT EXISTS idx_potd_bankroll_event_date ON potd_bankroll(event_date DESC);
CREATE INDEX IF NOT EXISTS idx_potd_bankroll_play_id ON potd_bankroll(play_id);
```
  </action>
  <verify>Run `node packages/data/src/migrate.js` — migration 064 should apply after 063 without errors. Verify: `SELECT name FROM sqlite_master WHERE type='table' AND name='potd_bankroll';`</verify>
  <done>`potd_bankroll` exists with `play_id`, `card_id`, and append-only event fields ready for runtime seeding and settlement mirroring.</done>
</task>

</tasks>

<verification>
Run the full migration suite from a clean state:
```bash
node packages/data/src/migrate.js
```
Then verify both tables exist and have correct schema by running:
```bash
node -e "const db = require('better-sqlite3')(process.env.CHEDDAR_DB_PATH || './cheddar.db'); console.log(db.prepare(\"SELECT sql FROM sqlite_master WHERE name='potd_plays'\").get()); console.log(db.prepare(\"SELECT sql FROM sqlite_master WHERE name='potd_bankroll'\").get());"
```
</verification>

<success_criteria>
- `potd_plays` creates a stable daily/source-of-truth row keyed by day and linked card
- `potd_bankroll` captures the append-only bankroll event ledger
- Both migrations are idempotent and apply in the normal runner
- No seed data is inserted in migrations
</success_criteria>

<output>
After completion, create `.planning/phases/potd-01-play-of-the-day/potd-01-01-SUMMARY.md`
</output>
