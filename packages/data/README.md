# @cheddar-logic/data

Shared data layer for cheddar-logic monorepo.

Contains:
- **Schema**: SQLite database with migrations for job_runs, games, odds_snapshots
- **DB Client**: High-level query functions
- **Migration Runner**: Applies schema changes on startup

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Run Migrations

```bash
npm run migrate
```

This creates the SQLite database at `$DATABASE_PATH` (or `/tmp/cheddar-logic/cheddar.db` by default) and creates all tables.

## Schema

### job_runs
Tracks execution of scheduled and manual jobs for idempotency and debugging.

```sql
id TEXT PRIMARY KEY
job_name TEXT NOT NULL
status TEXT NOT NULL DEFAULT 'running'  -- 'running', 'success', 'failed'
started_at TEXT NOT NULL                -- ISO 8601 UTC
ended_at TEXT                           -- ISO 8601 UTC (when status != 'running')
error_message TEXT
created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
```

**Example:**
```javascript
const { insertJobRun, markJobRunSuccess } = require('@cheddar-logic/data');

const jobRunId = 'run-2026-02-27-07-00-00-abc123';
insertJobRun('pull_odds_hourly', jobRunId);

// ... do work ...

markJobRunSuccess(jobRunId);
```

### games
Game metadata (teams, start times, sport).

```sql
id TEXT PRIMARY KEY
sport TEXT NOT NULL
game_id TEXT NOT NULL UNIQUE
home_team TEXT NOT NULL
away_team TEXT NOT NULL
game_time_utc TEXT NOT NULL              -- ISO 8601 UTC
status TEXT NOT NULL DEFAULT 'scheduled' -- 'scheduled', 'live', 'final'
created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
```

### odds_snapshots
Point-in-time odds captures. Each row is a snapshot of odds at a specific moment.

```sql
id TEXT PRIMARY KEY
game_id TEXT NOT NULL                    -- Foreign key to games
sport TEXT NOT NULL
captured_at TEXT NOT NULL                -- ISO 8601 UTC
h2h_home REAL
h2h_away REAL
total REAL
spread_home REAL
spread_away REAL
moneyline_home INTEGER
moneyline_away INTEGER
raw_data TEXT                            -- Full odds JSON (stringified)
job_run_id TEXT                          -- Foreign key to job_runs
created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
```

**Example:**
```javascript
const { insertOddsSnapshot, getLatestOdds } = require('@cheddar-logic/data');

// Insert a snapshot
insertOddsSnapshot({
  id: 'snap-abc123',
  gameId: 'nhl-2026-02-27-det-vs-col',
  sport: 'NHL',
  capturedAt: new Date().toISOString(),
  h2hHome: -120,
  h2hAway: 100,
  total: 6.5,
  jobRunId: 'run-2026-02-27-07-00-00-abc123'
});

// Query latest
const latest = getLatestOdds('nhl-2026-02-27-det-vs-col');
console.log(latest.h2h_home); // -120
```

### model_outputs
Inference outputs from sport models (NHL, NBA, FPL). Each row is a point-in-time model prediction.

```sql
id TEXT PRIMARY KEY
game_id TEXT NOT NULL                    -- Foreign key to games
sport TEXT NOT NULL
model_name TEXT NOT NULL                 -- e.g., 'nhl-model-v1'
model_version TEXT NOT NULL
prediction_type TEXT NOT NULL            -- e.g., 'moneyline', 'spread', 'total'
predicted_at TEXT NOT NULL               -- ISO 8601 UTC
confidence REAL                          -- 0-1 confidence score
output_data TEXT NOT NULL                -- Full output (JSON stringified)
odds_snapshot_id TEXT                    -- Foreign key to odds_snapshots (which odds this was based on)
job_run_id TEXT                          -- Foreign key to job_runs
created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
```

**Example:**
```javascript
const { insertModelOutput, getLatestModelOutput } = require('@cheddar-logic/data');

// Insert model output
insertModelOutput({
  id: 'mo-abc123',
  gameId: 'nhl-2026-02-27-det-vs-col',
  sport: 'NHL',
  modelName: 'nhl-moneyline-v1',
  modelVersion: '1.0.0',
  predictionType: 'moneyline',
  predictedAt: new Date().toISOString(),
  confidence: 0.72,
  outputData: { prediction: 'home', value: -120 },
  oddsSnapshotId: 'snap-abc123'
});

// Get latest
const latest = getLatestModelOutput('nhl-2026-02-27-det-vs-col', 'nhl-moneyline-v1');
console.log(latest.confidence); // 0.72
```

### card_payloads
Rendered cards ready for web display. One game can have multiple cards (CLV analysis, picks, line movement, etc).

```sql
id TEXT PRIMARY KEY
game_id TEXT NOT NULL                    -- Foreign key to games
sport TEXT NOT NULL
card_type TEXT NOT NULL                  -- e.g., 'clv-analysis', 'pick', 'line-movement'
card_title TEXT NOT NULL                 -- Display title
created_at TEXT NOT NULL                 -- ISO 8601 UTC
expires_at TEXT                          -- Optional: when card becomes stale
payload_data TEXT NOT NULL               -- Full card data (JSON stringified), ready for frontend
model_output_ids TEXT                    -- Optional: comma-separated related model IDs
metadata TEXT                            -- Optional: metadata (JSON stringified)
updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
```

**Example:**
```javascript
const { insertCardPayload, getCardPayloads } = require('@cheddar-logic/data');

// Insert card
insertCardPayload({
  id: 'card-abc123',
  gameId: 'nhl-2026-02-27-det-vs-col',
  sport: 'NHL',
  cardType: 'clv-analysis',
  cardTitle: 'Current Line vs Market',
  createdAt: new Date().toISOString(),
  payloadData: {
    closing_line: -120,
    current_line: -115,
    clv: '+5',
    recommendation: 'Home favored'
  },
  modelOutputIds: 'mo-abc123,mo-xyz789'
});

// Get all cards for game
const cards = getCardPayloads('nhl-2026-02-27-det-vs-col');
console.log(cards.length); // e.g., 3 cards
```

## API

### Job Tracking

#### insertJobRun(jobName, id)
Insert a new job run with status 'running'.

#### markJobRunSuccess(jobRunId)
Mark a job run as 'success' and set ended_at.

#### markJobRunFailure(jobRunId, errorMessage)
Mark a job run as 'failed' and set ended_at + error_message.

#### getJobRunHistory(jobName, limit = 10)
Returns recent job runs for a given job name.

#### wasJobRecentlySuccessful(jobName, minutesAgo = 60)
Boolean check: did this job succeed in the last N minutes?

### Odds

#### insertOddsSnapshot(snapshot)
Insert an odds snapshot. `snapshot` object:
- `id`: unique ID
- `gameId`: game ID
- `sport`: sport name
- `capturedAt`: ISO 8601 timestamp
- `h2hHome`, `h2hAway`, `total`, etc.
- `jobRunId`: associated job run

#### getLatestOdds(gameId)
Returns the most recent odds snapshot for a game.

#### getOddsSnapshots(sport, sinceUtc)
Returns all odds snapshots for a sport since a given timestamp.

### Model Outputs

#### insertModelOutput(output)
Insert a model output. `output` object:
- `id`: unique ID
- `gameId`: game ID
- `sport`: sport name
- `modelName`: model identifier
- `modelVersion`: version string
- `predictionType`: prediction type
- `predictedAt`: ISO 8601 timestamp
- `confidence`: 0-1 score (optional)
- `outputData`: inference output object
- `oddsSnapshotId`: reference to odds (optional)
- `jobRunId`: reference to job run (optional)

#### getLatestModelOutput(gameId, modelName)
Returns most recent prediction for a game + model combo.

#### getModelOutputs(gameId)
Returns all model outputs for a game.

#### getModelOutputsBySport(sport, sinceUtc)
Returns all model outputs for a sport since a timestamp.

### Card Payloads

#### insertCardPayload(card)
Insert a card payload. `card` object:
- `id`: unique ID
- `gameId`: game ID
- `sport`: sport name
- `cardType`: card type (e.g., 'clv-analysis')
- `cardTitle`: display title
- `createdAt`: ISO 8601 timestamp
- `expiresAt`: optional expiration timestamp
- `payloadData`: frontend-ready data object
- `modelOutputIds`: optional comma-separated IDs
- `metadata`: optional metadata object

#### getCardPayload(cardId)
Returns a single card by ID.

#### getCardPayloads(gameId)
Returns all non-expired cards for a game.

#### getCardPayloadsByType(cardType, limitDays = 7)
Returns cards of a type from last N days.

#### getCardPayloadsBySport(sport, limitCards = 10)
Returns recent cards for a sport.

#### expireCardPayload(cardId)
Mark a card as expired (sets expires_at to now).

#### deleteExpiredCards(daysOld = 30)
Delete cards older than N days. Returns count deleted.

## Database Connection

The client uses SQLite with a singleton connection.

**Environment variables:**
- `DATABASE_PATH`: Path to SQLite file (default: `/tmp/cheddar-logic/cheddar.db`)
- `CHEDDAR_DATA_DIR`: Data directory (default: `/tmp/cheddar-logic`)

## Datetime Standard

All timestamps (started_at, ended_at, captured_at, predicted_at, created_at, game_time_utc) are stored in **ISO 8601 UTC format**, e.g.:
```
2026-02-27T07:00:00.000Z
```

This ensures consistency across time zones for external client integration (models, web agents, etc.).
