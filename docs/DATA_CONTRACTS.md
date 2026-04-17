# Data Contracts — Cheddar Logic Monorepo

This document defines data schemas, table structures, and payload contracts for both product domains.

**Domains:**
1. **Betting Engine** — NBA/NHL/MLB/NFL betting models in the current worker package; soccer material is retained separately as design reference
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
  card_type TEXT NOT NULL,                -- 'nhl-totals-call' | 'nba-base-projection' | 'welcome-home-v2'
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

**Card Type Naming Convention (Current Runtime):**
- Betting play producers: `*-totals-call`, `*-spread-call`, `*-moneyline-call`, plus `nhl-pace-1p`
- Betting evidence/driver cards: `*-base-projection`, `*-rest-advantage`, `*-total-projection`, `welcome-home-v2`, etc.
- Legacy aliases kept for compatibility: `nhl-model-output`, `nba-model-output`, `nhl-welcome-home`, `ncaam-ft-spread`
- FPL uses dedicated backend surfaces and should not be served from betting routes

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

**`metadata.market_period_token` — persisted period classification (WI-0607):**

| Field | Values | Notes |
|---|---|---|
| `metadata.market_period_token` | `'1P'` \| `'FULL_GAME'` | Written at settlement time by `settle_pending_cards.js`; backfillable via `job:backfill-period-token` for historical rows |

- **Writer:** `apps/worker/src/jobs/settle_pending_cards.js` — merged into `card_results.metadata` at successful settlement time.
- **Backfill:** `apps/worker/src/jobs/backfill_period_token.js` — updates only `card_results.metadata` for already-settled rows missing the token; supports `--dry-run` mode. Run: `npm --prefix apps/worker run job:backfill-period-token:dry-run`.
- **Reader:** `/api/results` prefers `json_extract(cr.metadata, '$.market_period_token')` when present; falls back to the derived CASE expression when absent (backward-compatible during partial rollout).
- **Invariant:** Backfill never re-grades cards — `result`, `pnl_units`, and `settled_at` are untouched.

---

### Betting Card Payload Structure

**Applies to:** all worker-written betting cards in `card_payloads` (play + evidence rows).

**Baseline payload JSON (validator-required fields):**

```json
{
  "prediction": "AWAY",
  "confidence": 0.68,
  "recommended_bet_type": "moneyline",
  "generated_at": "2026-02-27T16:00:00Z",
  "odds_context": {
    "h2h_home": -150,
    "h2h_away": 130
  }
}
```

**Required Fields:**

- `prediction` (string, non-empty)
- `confidence` (number between `0` and `1`)
- `recommended_bet_type` (`moneyline` | `spread` | `puck_line` | `total` | `unknown`)
- `generated_at` (ISO-parseable date string)
- `odds_context` (object; additional keys allowed)

**Compatibility notes:**
- `meta.model_endpoint` may appear in payload metadata for legacy client compatibility.
- Web routes keep read compatibility for older rows but active read surfaces are `/api/games` and `/api/cards`.

### Decision Pipeline v2 (Wave-1 Game Lines)

For wave-1 betting rows, worker-emitted `decision_v2` is canonical and required:

- Sports: `NBA`, `NHL`, `NCAAM`
- Markets: `MONEYLINE`, `SPREAD`, `TOTAL`, `PUCKLINE`, `TEAM_TOTAL`
- Consumer rule: web/API/UI are pure consumers and must not recompute or repair verdicts
- Canonical verdict fields:
  - `decision_v2.official_status` (`PLAY/LEAN/PASS`)
  - `decision_v2.play_tier` (`BEST` | `GOOD` | `OK` | `BAD`)
  - `decision_v2.primary_reason_code` (single top-level reason)

Projection input contract (worker-emitted card payload metadata):

- `projection_inputs_complete` (boolean)
- `missing_inputs` (string[])
- `pipeline_state` (per-game stage checkpoints attached to emitted wave-1 card payloads)

Worker execution gate:

- If `projection_inputs_complete` is `false`, the worker must block downstream driver/pricing emission for that game in the run.
- When `missing_inputs` is present, `decision_v2.missing_data.missing_fields` may include normalized projection entries (for example `projection.home_avg_goals_for`) and `watchdog_reason_codes` should include `WATCHDOG_CONSISTENCY_MISSING`.

`decision_v2` shape:

```ts
type DecisionV2 = {
  direction: 'HOME'|'AWAY'|'OVER'|'UNDER'|'NONE';
  support_score: number;
  conflict_score: number;
  drivers_used: string[];
  driver_reasons: string[];

  watchdog_status: 'OK'|'CAUTION'|'BLOCKED';
  watchdog_reason_codes: string[];
  missing_data: {
    missing_fields: string[];
    source_attempts: Array<{
      field: string;
      source: string;
      result: 'FOUND'|'MISSING'|'ERROR';
      note?: string;
    }>;
    severity: 'INFO'|'WARNING'|'BLOCKING';
  };

  consistency: {
    pace_tier: string;
    event_env: string;
    event_direction_tag: string;
    vol_env: string;
    total_bias: string;
  };

  fair_prob: number | null;
  implied_prob: number | null;
  edge_pct: number | null;

  sharp_price_status: 'CHEDDAR'|'COTTAGE'|'UNPRICED'|'PENDING_VERIFICATION';
  price_reason_codes: string[];

  official_status: 'PLAY'|'LEAN'|'PASS';
  play_tier: 'BEST'|'GOOD'|'OK'|'BAD';
  primary_reason_code: string;

  pipeline_version: 'v2';
  decided_at: string;
};
```

`pipeline_state` shape:

```ts
type PipelineState = {
  ingested: boolean;
  team_mapping_ok: boolean;
  odds_ok: boolean;
  market_lines_ok: boolean;
  projection_ready: boolean;
  drivers_ready: boolean;
  pricing_ready: boolean;
  card_ready: boolean;
  blocking_reason_codes: string[];
};
```

`pipeline_state` rules:

- Stage keys are fixed for wave-1 and must be emitted exactly as:
  - `ingested`
  - `team_mapping_ok`
  - `odds_ok`
  - `market_lines_ok`
  - `projection_ready`
  - `drivers_ready`
  - `pricing_ready`
  - `card_ready`

### NHL Orchestrated Market-Call Contract

For worker-written NHL market-call rows (`nhl-totals-call`, `nhl-spread-call`, `nhl-moneyline-call`):

- `expression_choice` is required on new writes
- `market_narrative` is required on new writes
- `expression_choice.chosen_market` is the canonical selector winner for the game
- when `USE_ORCHESTRATED_MARKET=true`, worker output must emit at most one NHL market-call row per `game_id`
- when `USE_ORCHESTRATED_MARKET=false`, legacy multi-card behavior may emit multiple FIRE/WATCH market-call rows, but every emitted row must still carry orchestration metadata for audit and read-surface consistency
- `blocking_reason_codes` must be deterministic, unique, and reuse existing worker reason vocab when applicable (for example `WATCHDOG_CONSISTENCY_MISSING`, `WATCHDOG_MARKET_UNAVAILABLE`, `MARKET_PRICE_MISSING`, `NO_EDGE_AT_PRICE`, `EXACT_WAGER_MISMATCH`).
- Verification blocker compatibility:
  - canonical user-facing verification blockers are `LINE_NOT_CONFIRMED`, `EDGE_RECHECK_PENDING`, `EDGE_NO_LONGER_CONFIRMED`, `MARKET_DATA_STALE`, and `PRICE_SYNC_PENDING`
  - legacy `EDGE_VERIFICATION_REQUIRED` may be accepted as input alias during migration but should not be emitted as the primary user-facing blocker
  - normalized `reason_codes` and `blocking_reason_codes` must remain deterministic and de-duplicated
- `pipeline_state` is additive metadata only. It must not change `decision_v2`, `action`, `status`, `classification`, or other existing consumer-facing fields.
- Wave-1 worker jobs emit per-game `pipeline_state` in two places:
  - attached to emitted per-game card payloads
  - included in end-of-run job summaries/log output
- No partial mid-run publish of per-game pipeline summary is allowed.

Fixed constants for wave-1 (must remain deterministic across worker/API/UI):

- stale caution: `5m..30m`
- stale block: `>30m`
- LEAN edge/support: `0.03` / `0.45`
- PLAY edge/support: `0.06` / `0.60`
- BEST edge: `0.10`

Reason precedence for `primary_reason_code` (exact order):

1. blocking watchdog reason
2. price failure reason
3. qualification reason

No-play behavior is explicit: if watchdog blocks, price is `UNPRICED`/`COTTAGE`, or support thresholds fail, final status is `PASS`.

**Consumer Contract (Wave-1):**

- `/api/games` and web transforms consume `decision_v2` as-is for verdict/tier/reason.
- Wave-1 rows must not use repair metadata or legacy status/action/classification fallback.
- If a wave-1 row has no `decision_v2`, it is not eligible for wave-1 verdict projection.

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
  prediction: string;                     // non-empty
  confidence: number;                     // [0, 1]
  recommended_bet_type: 'moneyline' | 'spread' | 'puck_line' | 'total' | 'unknown';
  generated_at: string;                   // ISO-parsable datetime
  odds_context: {
    h2h_home?: number;
    h2h_away?: number;
    spread_home?: number;
    spread_away?: number;
    total?: number;
    captured_at?: string | null;
  };
  // Additional fields are intentionally allowed and consumed by specific cards/routes.
  [key: string]: unknown;
}
```

**Validation:**
- `prediction` must be non-empty string
- `confidence` must be in `[0, 1]`
- `recommended_bet_type` must be one of the supported enum values
- `generated_at` must parse as date
- `odds_context` must be an object
- Market/selection contract is validated through `deriveLockedMarketContext(...)` (parser boundary guard)

### NHL Legacy Model-Output Payload (Historical Compatibility)

`card_type='nhl-model-output'` is retained for compatibility with existing/historical rows and evidence rendering.
New writes should prefer current NHL card families (`nhl-*-call`, `nhl-base-projection`, `nhl-pace-*`, etc.).

### MLB Pitcher-K Payload (`card_type='mlb-pitcher-k'`)

Current runtime emits projection-only PASS rows for MLB pitcher strikeouts. Live line fields are intentionally null until a separate free-line sourcing WI ships. See ADR-0008.

```typescript
interface MlbPitcherKPayload {
  prediction: 'PASS';
  confidence: number;
  recommended_bet_type: 'total';
  generated_at: string;
  odds_context: Record<string, unknown>;

  basis: 'PROJECTION_ONLY';
  tags: Array<'no_odds_mode' | string>;
  status: 'PASS';
  action: 'PASS';
  classification: 'PASS';
  ev_passed: false;
  status_cap: 'PASS';

  line: null;
  line_source?: null;
  over_price?: null;
  under_price?: null;
  best_line_bookmaker?: null;
  margin?: null;

  projection_source: 'FULL_MODEL' | 'DEGRADED_MODEL' | 'SYNTHETIC_FALLBACK';
  missing_inputs: string[];
  reason_codes: string[];
  pass_reason_code?: string;

  playability?: {
    over_playable_at_or_below: number | null;
    under_playable_at_or_above: number | null;
  };

  projection: {
    k_mean: number;
    projected_ip: number;
    batters_per_inning: number;
    bf_exp: number;
    k_interaction: number;
    k_leash_mult: number;
    starter_k_pct: number;
    starter_swstr_pct?: number | null;
    whiff_proxy_pct?: number | null;
    opp_k_pct_vs_hand: number;
    probability_ladder: {
      p_5_plus: number;
      p_6_plus: number;
      p_7_plus: number;
    };
    fair_prices: {
      k_5_plus: number;
      k_6_plus: number;
      k_7_plus: number;
    };
  };
}
```

Contract rules:

- Active worker runtime must not emit `basis='ODDS_BACKED'` for `mlb-pitcher-k`.
- `projection_source='SYNTHETIC_FALLBACK'` is allowed, but the row must remain PASS-only and must expose `missing_inputs` / `reason_codes`.
- Legacy odds-backed payloads remain validator-compatible for historical rows only.

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

Active public betting read-paths:
- `GET /api/games`
- `GET /api/cards`
- `GET /api/cards/[gameId]`

Deprecated historical references (documentation-only, not active runtime contracts):
- `/api/models/*`
- `/api/betting/projections`
- `/api/soccer/slate`

### GET /api/cards (List Endpoint)

**Query Params:**
- `sport?` (case-insensitive betting sports; FPL rows are excluded here)
- `card_type?` (e.g., `nhl-totals-call`, `nba-total-projection`, `welcome-home-v2`)
- `game_id?` (filter by specific game)
- `dedupe?` (default: latest_per_game_type | none)
- `limit?` (default: 20, max: 100)
- `offset?` (default: 0, max: 1000)
- `lifecycle?` (`pregame` default, optional `active` when lifecycle parity flag is enabled)

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": "card-123",
      "gameId": "nhl-2026-02-27-van-sea",
      "sport": "NHL",
      "cardType": "nhl-totals-call",
      "cardTitle": "NHL Totals Call: OVER",
      "createdAt": "2026-02-27T16:00:00Z",
      "expiresAt": "2026-02-27T19:00:00Z",
      "payloadData": { /* full payload */ },
      "payloadParseError": false,
      "modelOutputIds": null
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
5. For backward compatibility, routes ensure `payloadData.meta.model_endpoint` exists (defaults to `null` when absent)

### GET /api/cards/[gameId] (Per-Game Cards)

**Query Params:**
- `cardType?` or `card_type?`
- `dedupe?` (default `latest_per_game_type`, optional `none`)
- `limit?` (default: 10, max: 100)
- `offset?` (default: 0, max: 1000)
- `lifecycle?` (`pregame` default, optional `active` when lifecycle parity flag is enabled)

**Contract notes:**
- Returns only betting cards for the requested game id.
- Same payload parsing + compatibility behavior as `/api/cards`.

### GET /api/games (Game + Play Aggregation)

**Query Params:**
- `lifecycle?` (`pregame` default, optional `active`)

**Contract notes:**
- Canonical game/plays aggregation route for current runtime.
- Returns games even when no card payload rows exist for a game.
- Play-vs-evidence enforcement is driven by explicit per-sport card-type contracts in route code.

---

## Validator Contracts

### Betting Card Validation (Zod)

Location: `packages/data/src/validators/card-payload.js`

**Rules:**
- `confidence` must be number in [0, 1]
- `prediction` must be non-empty
- `recommended_bet_type` must be one of: `moneyline`, `spread`, `puck_line`, `total`, `unknown`
- `generated_at` must parse as date
- `odds_context` must be an object
- Card types are explicitly mapped by runtime family (NBA/NHL/NCAAM + soccer/base jobs)
- Unknown card types fall back to baseline payload schema
- Actionable play payloads are checked against market/selection contract via `deriveLockedMarketContext(...)`
- **Validator-to-route alignment:** `card-payload.js` is the single write-path validation boundary. Active read surfaces (`/api/games`, `/api/cards`, `/api/cards/[gameId]`) consume `card_payloads` rows validated by this boundary. No other validation path exists for card writes.

### Legacy Alias Policy (Keep vs Deprecate)

| Card Type / Alias | Status | Policy |
| --- | --- | --- |
| `nhl-model-output` | keep | Continue to validate and read for compatibility/evidence rendering |
| `ncaam-ft-spread` | keep | Continue to validate; current pipeline still includes it for compatibility |
| `nba-model-output` | deprecated alias | Continue to validate/read historical rows; do not emit new writes |
| `nhl-welcome-home` | deprecated alias | Continue to validate/read historical rows; canonical replacement is `welcome-home-v2` |

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
| **Card Types** | `nhl-totals-call`, `nhl-spread-call`, `nba-totals-call`, `nba-base-projection`, `welcome-home-v2`, etc. | FPL cards are served from the dedicated FPL backend |
| **Expiry** | 1 hour before game start | Gameweek deadline |
| **Timezone** | ET for fixed, UTC for T-minus | UTC (FPL deadlines are UTC) |

**Non-Negotiable:** These are separate domains. Soccer betting belongs to Betting domain. FPL belongs to FPL-SAGE domain. No mixing.

---

## Record Lineage Map

Every canonical play record must be traceable from ingest through projection, card generation, and settlement/result. This section documents the full lifecycle, per-stage lineage fields, segmentation bucket sources, and all known gaps.

### Canonical Lifecycle Diagram

```text
ingest (odds_snapshots + games)
  -> projection (model_outputs, written by run_nhl/nba/ncaam_model.js, keyed by job_run_id)
  -> card generation (card_payloads, written by worker jobs, payload_data includes decision_v2)
     -> auto-enrollment: insertCardPayload() creates card_results row with status='pending'
  -> settlement Phase 1: settle_game_results.js -> game_results (final scores from ESPN)
  -> settlement Phase 2: settle_pending_cards.js -> card_results (win/loss/push + pnl_units)
  -> aggregation: incrementTrackingStat() -> tracking_stats (segmented analytics)
```

### Per-Stage Lineage Fields Table

| Stage | Table | Lineage Fields Written | Carried Forward As |
|-------|-------|----------------------|-------------------|
| Ingest | odds_snapshots | sport, game_id, job_run_id | odds_snapshot_id in model_outputs |
| Projection | model_outputs | sport, prediction_type, confidence, output_data (decision_v2), job_run_id | model_output_ids in card_payloads |
| Card Gen | card_payloads | sport, card_type, payload_data (decision_v2, meta, projection_inputs_complete) | card_id in card_results |
| Settlement | card_results | sport, card_type, recommended_bet_type, result, pnl_units, metadata | stat_key in tracking_stats |
| Analytics | tracking_stats | sport, market_type, direction, confidence_tier, driver_key, time_period | stat_key |

### Segmentation Bucket Enumeration

All segmentation dimensions from `TRACKING_DIMENSIONS.md`, with source-of-truth DB column and current coverage status:

| Dimension | Source-of-Truth Column | Status |
|-----------|----------------------|--------|
| sport | card_results.sport | PRESENT — 100% coverage |
| market_type | card_results.recommended_bet_type (normalized via normalizeMarketType) | PRESENT — 100% on wave-1 call cards |
| direction | payload_data.decision_v2.direction (read from card_payloads at query time) | WRITE-PATH GAP — not persisted to card_results.metadata |
| confidence_tier | derived from payload_data.confidence at read time | WRITE-PATH GAP — not pre-bucketed |
| driver | payload_data.decision_v2.drivers_used[0] (read from card_payloads) | WRITE-PATH GAP — not persisted to card_results.metadata |
| inference_source | payload_data.meta.inference_source (read from card_payloads) | READ-PATH GAP — not exposed in /api/results response |
| time_period | derived from card_results.settled_at at query time | PRESENT — computable from existing column |
| ev_threshold | payload_data.decision_v2.edge_pct vs threshold | WRITE-PATH GAP — not pre-computed into card_results.metadata |

**Implicit segmentation note:** The `/api/results` route uses `card_type LIKE` pattern matching to derive `card_category` (`call` vs `driver`) at read time. This is not a stored field. Fix: persist `card_category` to `card_results.metadata` at settlement time.

### Gap Classification Table

Gaps identified from `node scripts/audit-lineage.js` run against production data (2026-03-14). Baseline at audit: `call_action` 33%, `driver_context` 33%, `projection_source` 91%, `sport` 100%, `market_type` 100%.

| Gap ID | Field | Stage | Classification | Fix Recommendation |
|--------|-------|-------|---------------|-------------------|
| GAP-01 | direction | card_results | write-path gap | Write decision_v2.direction to card_results.metadata at settlement time in settle_pending_cards.js |
| GAP-02 | confidence_tier | card_results | write-path gap | Bucket confidence at settlement time and persist to card_results.metadata |
| GAP-03 | driver_key | card_results | write-path gap | Write drivers_used[0] to card_results.metadata during settlement in settle_pending_cards.js |
| GAP-04 | inference_source | card_results | read-path gap | Expose meta.inference_source from card_payloads.payload_data in /api/results ledger response |
| GAP-05 | call_action (decision_v2.official_status) | card_results | write-path gap | 67% of records lack decision_v2 (evidence/driver cards pre-dating wave-1); write official_status to card_results.metadata for call-type cards at settlement |
| GAP-06 | driver_context (decision_v2.drivers_used) | card_results | write-path gap | Same root cause as GAP-05; write to card_results.metadata at settlement for call-type cards |
| GAP-07 | projection_source (model_output_ids / meta.inference_source) | card_payloads | write-path gap | 9% of cards have null model_output_ids and no meta.inference_source; ensure insertCardPayload() callers always pass model_output_ids |
| GAP-08 | card_type vs recommended_bet_type vs prediction_type | all stages | naming drift | Three names for market across stages: card_type (card_payloads, e.g. nhl-totals-call), recommended_bet_type (card_results, e.g. total), prediction_type (model_outputs, e.g. total). normalizeMarketType() bridges card_type to recommended_bet_type. Mapping is intentional but must remain explicit. |
| GAP-09 | ev_threshold | card_results | write-path gap | edge_pct from decision_v2 not pre-bucketed into card_results.metadata; persist as boolean ev_passed at settlement |

### Reproducible Audit Command

```bash
# From repo root
node scripts/audit-lineage.js

# Redirect to file for evidence:
node scripts/audit-lineage.js > /tmp/lineage-audit-$(date +%Y%m%d).txt
```

See `docs/ops-runbook.md` — **Lineage Audit Procedure** section for triage guidance.
