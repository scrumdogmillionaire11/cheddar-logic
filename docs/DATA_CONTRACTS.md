# Data Contracts — Cheddar Logic Monorepo

This document defines data schemas, table structures, and payload contracts for both product domains.

**Domains:**
1. **Betting Engine** — NBA/NHL/MLB/Soccer betting models
2. **FPL-SAGE Engine** — Fantasy Premier League tools

**Naming Clarification:** `FPL` is the sport/domain identifier used in shared tables (`sport='FPL'`). The actual FPL recommendation engine is **FPL Sage**.

---

## Shared Tables (Cross-Domain)

### `job_runs` (Idempotency + Audit)

**Purpose:** Track every job execution for idempotency, debugging, and monitoring.

**Schema:**

```sql
CREATE TABLE job_runs (
  id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  job_key TEXT,                          -- Deterministic window key for idempotency
  status TEXT NOT NULL DEFAULT 'running', -- 'running' | 'success' | 'failed'
  started_at TEXT NOT NULL,              -- ISO 8601 UTC
  ended_at TEXT,                          -- ISO 8601 UTC
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_job_runs_name ON job_runs(job_name);
CREATE INDEX idx_job_runs_status ON job_runs(status);
CREATE INDEX idx_job_runs_started_at ON job_runs(started_at);
CREATE INDEX idx_job_runs_job_key ON job_runs(job_key);
CREATE INDEX idx_job_runs_job_key_status ON job_runs(job_key, status);
```

**Job Key Formats (Deterministic):**

Betting domain:
- Fixed runs: `nhl|fixed|YYYY-MM-DD|HHmm` (e.g., `nhl|fixed|2026-02-27|0900`)
- T-minus runs: `nhl|tminus|<game_id>|<minutes>` (e.g., `nhl|tminus|nhl-2026-02-27-van-sea|120`)
- Odds ingestion: `odds|hourly|YYYY-MM-DD|HH` (e.g., `odds|hourly|2026-02-27|15`)

FPL-SAGE domain:
- Daily refresh: `fpl|daily|YYYY-MM-DD`
- Deadline windows: `fpl|deadline|GW<N>|T-<hours>h` (e.g., `fpl|deadline|GW27|T-24h`)

**Idempotency Rule:**
If `job_key` has `status='success'` → skip execution.
If `job_key` has `status='running'` → skip (prevents overlap).
If `job_key` has `status='failed'` → allow retry.

---

### `card_payloads` (Frontend-Ready Cards)

**Purpose:** Store pre-computed, UI-ready cards for both betting and FPL dashboards.

**Schema:**

```sql
CREATE TABLE card_payloads (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  sport TEXT NOT NULL,                    -- 'NBA' | 'NHL' | 'MLB' | 'SOCCER' | 'FPL'
  card_type TEXT NOT NULL,                -- 'nba-model-output' | 'fpl-sage-transfers'
  card_title TEXT NOT NULL,
  payload_data TEXT NOT NULL,             -- JSON string (validated before insert)
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,                        -- ISO 8601 UTC (NULL for FPL cards)
  model_output_ids TEXT                   -- Comma-separated or JSON array
);

CREATE INDEX idx_card_payloads_game_id ON card_payloads(game_id);
CREATE INDEX idx_card_payloads_sport ON card_payloads(sport);
CREATE INDEX idx_card_payloads_card_type ON card_payloads(card_type);
CREATE INDEX idx_card_payloads_expires_at ON card_payloads(expires_at);
CREATE INDEX idx_card_payloads_created_at ON card_payloads(created_at);
```

**Card Type Naming Convention:**
- Betting: `<sport>-model-output` (e.g., `nhl-model-output`, `soccer-epl-model-output`)
- FPL-SAGE: `fpl-sage-<feature>` (e.g., `fpl-sage-transfers`, `fpl-sage-chips`, `fpl-sage-squad-plan`)

---

## Betting Domain Tables

### `games` (Fixtures with Start Times)

**Purpose:** Canonical game schedule for T-minus window calculations.

**Schema:**

```sql
CREATE TABLE games (
  id TEXT PRIMARY KEY,                    -- e.g., 'nhl-2026-02-27-van-sea'
  sport TEXT NOT NULL,                    -- 'NBA' | 'NHL' | 'MLB' | 'SOCCER'
  league TEXT,                            -- 'EPL' | 'MLS' | 'UCL' (for soccer)
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  game_time_utc TEXT NOT NULL,           -- ISO 8601 UTC
  status TEXT DEFAULT 'scheduled',        -- 'scheduled' | 'in_progress' | 'final'
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_games_sport ON games(sport);
CREATE INDEX idx_games_game_time_utc ON games(game_time_utc);
CREATE INDEX idx_games_status ON games(status);
```

**Usage:**
- Populated by odds pull or separate fixtures job
- Scheduler queries for games starting in next 4 hours to compute T-minus windows

---

### `odds_snapshots` (Betting Lines)

**Purpose:** Time-series odds data for inference inputs.

**Schema:**

```sql
CREATE TABLE odds_snapshots (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  sport TEXT NOT NULL,
  captured_at TEXT NOT NULL,             -- ISO 8601 UTC
  h2h_home REAL,                          -- Moneyline home
  h2h_away REAL,                          -- Moneyline away
  spread_home REAL,
  spread_away REAL,
  total REAL,
  moneyline_home REAL,
  moneyline_away REAL,
  game_time_utc TEXT,                     -- ISO 8601 UTC
  raw_data TEXT,                          -- Full JSON from adapter
  job_run_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(job_run_id) REFERENCES job_runs(id)
);

CREATE INDEX idx_odds_sport ON odds_snapshots(sport);
CREATE INDEX idx_odds_game_id ON odds_snapshots(game_id);
CREATE INDEX idx_odds_captured_at ON odds_snapshots(captured_at);
```

---

### `model_outputs` (Betting Predictions)

**Purpose:** Store raw inference results (predictions, confidence, drivers).

**Schema:**

```sql
CREATE TABLE model_outputs (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  sport TEXT NOT NULL,
  model_name TEXT NOT NULL,              -- 'nhl-model-v1'
  model_version TEXT NOT NULL,
  prediction_type TEXT NOT NULL,         -- 'moneyline' | 'spread' | 'total'
  predicted_at TEXT NOT NULL,            -- ISO 8601 UTC
  confidence REAL NOT NULL,
  output_data TEXT,                       -- Full JSON (reasoning, drivers, meta)
  odds_snapshot_id TEXT,
  job_run_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_model_outputs_game_id ON model_outputs(game_id);
CREATE INDEX idx_model_outputs_sport ON model_outputs(sport);
CREATE INDEX idx_model_outputs_model_name ON model_outputs(model_name);
```

**Output Data JSON (Betting Models):**

```json
{
  "prediction": "HOME" | "AWAY",
  "confidence": 0.65,
  "reasoning": "Strong home record, injuries favor home...",
  "drivers": ["home_advantage", "injury_impact"],
  "ev_threshold_passed": true,
  "meta": {
    "inference_source": "remote" | "mock",
    "model_endpoint": "https://ml.example.com/v1/nhl" | null,
    "is_mock": false
  }
}
```

---

### `card_results` (Settlement Outcomes)

**Purpose:** Track settlement state and P&L for each generated card.

**Schema:**

```sql
CREATE TABLE card_results (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL UNIQUE,
  game_id TEXT NOT NULL,
  sport TEXT NOT NULL,
  card_type TEXT NOT NULL,
  recommended_bet_type TEXT NOT NULL,  -- 'moneyline' | 'spread' | 'puck_line' | 'total' | 'unknown'
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  settled_at TEXT,
  pnl_units REAL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_card_results_game_id ON card_results(game_id);
CREATE INDEX idx_card_results_status ON card_results(status);
CREATE INDEX idx_card_results_sport ON card_results(sport);
CREATE INDEX idx_card_results_settled_at ON card_results(settled_at);
```

---

### Betting Card Payload Structure

**Card Type:** `<sport>-model-output` (e.g., `nhl-model-output`)

**Payload JSON:**

```json
{
  "game_id": "nhl-2026-02-27-van-sea",
  "sport": "NHL",
  "model_version": "nhl-model-v1",
  "prediction": "AWAY",
  "confidence": 0.68,
  "recommended_bet_type": "moneyline",
  "reasoning": "Vancouver strong on road...",
  "odds_context": {
    "h2h_home": -150,
    "h2h_away": 130,
    "spread_home": -1.5,
    "spread_away": 1.5,
    "total": 6.0,
    "captured_at": "2026-02-27T15:30:00Z"
  },
  "ev_passed": true,
  "disclaimer": "Analysis provided for educational purposes. Not a recommendation.",
  "generated_at": "2026-02-27T16:00:00Z",
  "meta": {
    "inference_source": "mock",
    "model_endpoint": null,
    "is_mock": true
  }
}
```

**Required Fields:**

- `meta.is_mock` (boolean) — MUST be true if inference came from mock fallback
- `meta.inference_source` (string) — "remote" | "mock"
- `confidence` (number) — Must be between 0 and 1
- `prediction` (string) — Enum depends on sport/market
- `recommended_bet_type` (string) — "moneyline" | "spread" | "puck_line" | "total" | "unknown"

**FPL Compatibility Rule (Shared Contract):**

- FPL cards may still carry `recommended_bet_type` for cross-sport schema compatibility.
- If `recommended_bet_type` is missing or unknown, recommendation maps to `PASS` with reason `No market line available`.
- This does **not** mean FPL Sage is a betting model; it is a temporary compatibility bridge while FPL-native card types are finalized.

**Expiry Rule:**
Betting cards expire 1 hour before game start (`expires_at` set by job).

---

## FPL-SAGE Domain Tables

### `fpl_user_squads` (User Inputs)

**Purpose:** Store user-entered FPL squads for analysis.

**Schema (Proposed):**

```sql
CREATE TABLE fpl_user_squads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,                 -- From auth or session
  gameweek INTEGER NOT NULL,
  squad_data TEXT NOT NULL,              -- JSON with 15 player IDs + positions
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

CREATE INDEX idx_fpl_user_squads_user_id ON fpl_user_squads(user_id);
CREATE INDEX idx_fpl_user_squads_gameweek ON fpl_user_squads(gameweek);
```

---

### `fpl_deadlines` (Gameweek Deadlines)

**Purpose:** Track FPL gameweek deadlines for deadline-relative scheduling.

**Schema (Proposed):**

```sql
CREATE TABLE fpl_deadlines (
  id TEXT PRIMARY KEY,
  gameweek INTEGER NOT NULL UNIQUE,
  deadline_utc TEXT NOT NULL,            -- ISO 8601 UTC
  season TEXT NOT NULL,                  -- '2025-26'
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_fpl_deadlines_deadline_utc ON fpl_deadlines(deadline_utc);
CREATE INDEX idx_fpl_deadlines_gameweek ON fpl_deadlines(gameweek);
```

---

### `fpl_player_snapshots` (Player Data Time-Series)

**Purpose:** Track player prices, form, minutes for recommendation engine.

**Schema (Proposed):**

```sql
CREATE TABLE fpl_player_snapshots (
  id TEXT PRIMARY KEY,
  player_id INTEGER NOT NULL,            -- FPL API player ID
  gameweek INTEGER NOT NULL,
  snapshot_at TEXT NOT NULL,             -- ISO 8601 UTC
  price INTEGER NOT NULL,                -- In FPL currency (e.g., 95 = £9.5m)
  form REAL,
  minutes_played INTEGER,
  expected_goals REAL,                   -- xG
  expected_assists REAL,                 -- xA
  raw_data TEXT,                          -- Full FPL API player object
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_fpl_player_snapshots_player_id ON fpl_player_snapshots(player_id);
CREATE INDEX idx_fpl_player_snapshots_gameweek ON fpl_player_snapshots(gameweek);
CREATE INDEX idx_fpl_player_snapshots_snapshot_at ON fpl_player_snapshots(snapshot_at);
```

---

### `fpl_recommendations` (Transfer/Chip Suggestions)

**Purpose:** Store computed recommendations (alternative to using `card_payloads`).

**Schema (Proposed):**

```sql
CREATE TABLE fpl_recommendations (
  id TEXT PRIMARY KEY,
  user_id TEXT,                          -- NULL for global recommendations
  gameweek INTEGER NOT NULL,
  recommendation_type TEXT NOT NULL,     -- 'transfer' | 'captain' | 'chip'
  recommendation_data TEXT NOT NULL,     -- JSON
  confidence REAL,
  generated_at TEXT NOT NULL,
  expires_at TEXT,                        -- Deadline or next refresh
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_fpl_recommendations_user_id ON fpl_recommendations(user_id);
CREATE INDEX idx_fpl_recommendations_gameweek ON fpl_recommendations(gameweek);
CREATE INDEX idx_fpl_recommendations_type ON fpl_recommendations(recommendation_type);
```

---

### FPL Card Payload Structure (Alternative)

If using `card_payloads` table instead of `fpl_recommendations`:

**Card Type:** `fpl-sage-<feature>` (e.g., `fpl-sage-transfers`, `fpl-sage-chips`)

**Payload JSON Example (Transfers):**

```json
{
  "gameweek": 27,
  "recommendation_type": "transfer",
  "transfers": [
    {
      "out": {"player_id": 123, "name": "Player A", "price": 95},
      "in": {"player_id": 456, "name": "Player B", "price": 93},
      "reasoning": "Better fixtures, price drop expected",
      "priority": "high"
    }
  ],
  "confidence": 0.75,
  "deadline_utc": "2026-03-01T11:00:00Z",
  "generated_at": "2026-02-27T16:00:00Z",
  "meta": {
    "engine_version": "fpl-sage-v1",
    "is_mock": false
  }
}
```

**Expiry Rule:**
FPL cards expire at gameweek deadline (not 1 hour before like betting cards).

---

## Betting Domain Payload Contracts

### Betting Card Payload (All Sports)

**Required Fields:**

```typescript
interface BettingCardPayload {
  game_id: string;
  sport: 'NBA' | 'NHL' | 'MLB' | 'SOCCER';
  model_version: string;
  prediction: 'HOME' | 'AWAY' | string;  // Enum varies by market
  confidence: number;                     // [0, 1]
  recommended_bet_type: 'moneyline' | 'spread' | 'puck_line' | 'total' | 'unknown';
  reasoning: string;
  odds_context: {
    h2h_home?: number;
    h2h_away?: number;
    spread_home?: number;
    spread_away?: number;
    total?: number;
    captured_at: string;                  // ISO 8601 UTC
  };
  ev_passed: boolean;
  disclaimer: string;
  generated_at: string;                   // ISO 8601 UTC
  meta: {
    inference_source: 'remote' | 'mock';
    model_endpoint: string | null;
    is_mock: boolean;                     // MUST be true if mock
  };
  drivers?: Record<string, unknown>;      // Sport-specific + global drivers
  driver_summary?: {
    game_id: string;
    weighted_confidence: number;
    top_drivers: string[];
  } | null;
}
```

**Validation:**
- `meta.is_mock` must match `meta.inference_source === 'mock'`
- `confidence` must be in [0, 1] range
- `expires_at` (table column) must be set to 1 hour before game start

### NHL Driver Payload (Strict)

For `sport='NHL'` and `card_type='nhl-model-output'`, `payload.drivers` must contain exactly:

- `goalie`
- `specialTeams`
- `shotEnvironment`
- `emptyNet`
- `totalFragility`
- `pdoRegression`

Each NHL driver object must match:

```typescript
interface DriverNode {
  score: number;                          // [0, 1]
  weight: number;                         // [0, 1], weights sum approx 1
  status: 'ok' | 'partial' | 'missing';
  inputs: Record<string, number | string | null>;
  note: string;
}

interface NHLDrivers {
  goalie: DriverNode;
  specialTeams: DriverNode;
  shotEnvironment: DriverNode;
  emptyNet: DriverNode;
  totalFragility: DriverNode;
  pdoRegression: DriverNode;
}
```

### Global Driver: `welcomeHome` (All Sports)

`welcomeHome` is a global meta-driver contract applied to all betting sports where home/away context exists.

```typescript
interface WelcomeHomeDriver {
  score: number;                          // [0, 1]
  status: 'PASS' | 'FAIL' | 'NA';
  direction: 'HOME' | 'NEUTRAL';
  edge: number;                           // model_margin_home - market_spread_home
  reason_codes: string[];                 // e.g. EDGE_IMPLAUSIBLE_SANITY_FAIL
  components: {
    rest: number;                         // [0, 1]
    travel_fatigue: number;               // [0, 1]
    homecoming: number;                   // [0, 1]
    lineup_certainty: number;             // [0, 1]
    market_corroboration: number;         // [0, 1]
    venue_intensity: number;              // [0, 1]
  };
  threshold_used: number;
  min_edge_used: number;
}
```

Placement in payload:

- `payload.drivers.welcomeHome = WelcomeHomeDriver`

Notes:

- For sports without home/away spread semantics, set `status='NA'` and `direction='NEUTRAL'`.
- Hard fail examples: `EDGE_IMPLAUSIBLE_SANITY_FAIL`, `LOW_DATA_QUALITY_FAIL`, `MARKET_CONTRADICTION_FAIL`.

---

## FPL-SAGE Domain Payload Contracts

### FPL Transfer Recommendation

**Required Fields:**

```typescript
interface FPLTransferPayload {
  gameweek: number;
  recommendation_type: 'transfer';
  transfers: Array<{
    out: { player_id: number; name: string; price: number };
    in: { player_id: number; name: string; price: number };
    reasoning: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  confidence?: number;
  deadline_utc: string;                   // ISO 8601 UTC
  generated_at: string;                   // ISO 8601 UTC
  meta: {
    engine_version: string;
    is_mock: boolean;
  };
}
```

### FPL Chip Recommendation

**Required Fields:**

```typescript
interface FPLChipPayload {
  gameweek: number;
  recommendation_type: 'chip';
  chip_type: 'wildcard' | 'free_hit' | 'bench_boost' | 'triple_captain';
  reasoning: string;
  confidence?: number;
  deadline_utc: string;
  generated_at: string;
  meta: {
    engine_version: string;
    is_mock: boolean;
  };
}
```

---

## Job Key Determinism Rules

### Betting Domain

**Fixed Windows:**
- Job key: `<sport>|fixed|<date>|<time>`
- Example: `nhl|fixed|2026-02-27|0900`
- Triggers: Once per day per sport at 09:00 ET and 12:00 ET
- Timezone: America/New_York (converted to UTC for storage)

**T-minus Windows:**
- Job key: `<sport>|tminus|<game_id>|<minutes>`
- Example: `nhl|tminus|nhl-2026-02-27-van-sea|120`
- Triggers: When delta between now and game start is within ±5 minutes of target (120/90/60/30)
- Timezone: UTC (game start times stored in UTC)

**Odds Ingestion:**
- Job key: `odds|hourly|<date>|<hour>`
- Example: `odds|hourly|2026-02-27|15`
- Triggers: Once per hour (hour bucket in UTC)

### FPL-SAGE Domain

**Daily Refresh:**
- Job key: `fpl|daily|<date>`
- Example: `fpl|daily|2026-02-27`
- Triggers: Once per day at 03:00 ET

**Deadline Windows:**
- Job key: `fpl|deadline|GW<N>|T-<hours>h`
- Example: `fpl|deadline|GW27|T-24h`
- Triggers: T-48h, T-24h, T-6h before gameweek deadline
- Timezone: UTC (deadlines from FPL API are UTC)

---

## API Read-Path Contracts

### GET /api/cards (List Endpoint)

**Query Params:**
- `sport?` (NBA|NHL|MLB|SOCCER|FPL)
- `card_type?` (e.g., nhl-model-output, fpl-sage-transfers)
- `game_id?` (filter by specific game)
- `include_expired?` (default: false)
- `dedupe?` (default: latest_per_game_type | none)
- `limit?` (default: 20, max: 100)
- `offset?` (default: 0, max: 1000)

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "card-123",
      "gameId": "nhl-2026-02-27-van-sea",
      "sport": "NHL",
      "cardType": "nhl-model-output",
      "cardTitle": "NHL Model: AWAY",
      "createdAt": "2026-02-27T16:00:00Z",
      "expiresAt": "2026-02-27T19:00:00Z",
      "payloadData": { /* full payload */ },
      "payloadParseError": false,
      "modelOutputIds": "model-123"
    }
  ]
}
```

**Default Dedupe Behavior:**
Returns latest card per `(game_id, card_type)` using window function:

```sql
WITH ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY game_id, card_type ORDER BY created_at DESC) AS rn
  FROM card_payloads
  WHERE <filters>
)
SELECT * FROM ranked WHERE rn = 1
```

**Invariants (DO NOT REFACTOR):**
1. Default dedupe = `latest_per_game_type` (prevents showing stale duplicates)
2. `dedupe=none` returns full history
3. `payloadParseError` flag set if JSON parse fails (never throw 500)
4. Mock inference must be visible: `payloadData.meta.is_mock` exposed

---

## Validator Contracts

### Betting Card Validation (Zod)

Location: `packages/data/src/validators/card-payload.js`

**Rules:**
- `confidence` must be number in [0, 1]
- `meta.is_mock` must be boolean
- `meta.inference_source` must be 'remote' or 'mock'
- If `meta.is_mock === true`, then `meta.model_endpoint` must be null

### FPL Payload Validation (Future)

Location: `packages/data/src/validators/fpl-payload.js`

**Rules:**
- `gameweek` must be positive integer
- `deadline_utc` must be valid ISO 8601
- `transfers` array must have valid player IDs

---

## Migration Ordering

**Existing (Applied):**
1. `001_create_job_runs.sql`
2. `002_create_games.sql`
3. `003_create_odds_snapshots.sql`
4. `004_create_model_outputs.sql`
5. `005_create_card_payloads.sql`
6. `006_add_job_key_to_job_runs.sql`
7. `007_create_card_results.sql`

**Future (FPL-SAGE Domain):**
7. `007_create_fpl_user_squads.sql`
8. `008_create_fpl_deadlines.sql`
9. `009_create_fpl_player_snapshots.sql`
10. `010_create_fpl_recommendations.sql` (if not using card_payloads)

---

## Summary: Betting vs FPL-SAGE

| Aspect | Betting Domain | FPL-SAGE Domain |
|--------|----------------|-----------------|
| **Products** | Betting dashboard | FPL tools |
| **Sports** | NBA, NHL, MLB, Soccer (EPL/MLS/UCL) | Fantasy Premier League |
| **Data Source** | Odds snapshots + injuries/lineups | FPL API + user squads |
| **Scheduling** | Fixed (09:00, 12:00 ET) + T-minus (120/90/60/30) | Deadline-relative (T-48h, T-24h, T-6h) |
| **Job Keys** | `nhl\|fixed\|date\|time`, `nhl\|tminus\|game_id\|mins` | `fpl\|daily\|date`, `fpl\|deadline\|GW\|window` |
| **Output Tables** | `model_outputs`, `card_payloads`, `card_results` | `fpl_recommendations`, `card_payloads` |
| **Card Types** | `nhl-model-output` | `fpl-sage-transfers` |
| **Expiry** | 1 hour before game start | Gameweek deadline |
| **Timezone** | ET for fixed, UTC for T-minus | UTC (FPL deadlines are UTC) |

**Non-Negotiable:** These are separate domains. Soccer betting belongs to Betting domain. FPL belongs to FPL-SAGE domain. No mixing.
